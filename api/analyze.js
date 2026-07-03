export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const { access_token, mode, extra, prefsPrompt, comment, goal } = req.body || {};
    if (!access_token) return res.status(400).json({ error: "No access_token" });

    // ---------- Dates en Europe/Paris (Vercel tourne en UTC) ----------
    const parisNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Paris" }));
    const pad = (n) => String(n).padStart(2, "0");
    const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    const raceDay = new Date(2026, 8, 14); // 14 septembre 2026
    const todayMidnight = new Date(parisNow.getFullYear(), parisNow.getMonth(), parisNow.getDate());
    const daysLeft = Math.max(0, Math.round((raceDay - todayMidnight) / 86400000));

    // Lundi de la semaine en cours (heure de Nice)
    const dow = parisNow.getDay(); // 0=dim, 1=lun, ...
    const monday = new Date(parisNow);
    monday.setDate(parisNow.getDate() + (dow === 0 ? -6 : 1 - dow));
    const mondayStr = dateStr(monday);

    // ---------- Objectif modifiable (minutes, défaut 240 = 4h00) ----------
    const goalMin = Number(goal) > 0 ? Number(goal) : 240;
    const goalLabel = `${Math.floor(goalMin / 60)}h${pad(goalMin % 60)}`;
    const paceSec = Math.round((goalMin * 60) / 42.195);
    const paceLabel = `${Math.floor(paceSec / 60)}'${pad(paceSec % 60)}"/km`;

    // ---------- Strava : 12 semaines d'historique ----------
    const after = Math.floor(Date.now() / 1000) - 84 * 86400;
    const stravaRes = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=100`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    if (!stravaRes.ok) return res.status(401).json({ error: "Strava auth failed" });
    const activitiesRaw = await stravaRes.json();
    if (!Array.isArray(activitiesRaw)) return res.status(502).json({ error: "Réponse Strava invalide" });
    // Avec ?after= Strava renvoie du plus ancien au plus récent → on remet le plus récent d'abord
    const activities = activitiesRaw.slice().sort((a, b) => new Date(b.start_date) - new Date(a.start_date));

    const isRun = (a) => a.type === "Run" || a.type === "TrailRun" || a.sport_type === "Run" || a.sport_type === "TrailRun";
    // start_date_local = date locale de l'activité (évite le bug UTC de Vercel)
    const localDay = (a) => (a.start_date_local || a.start_date || "").slice(0, 10);

    // Runs déjà effectués cette semaine (lundi = début de semaine, dates locales)
    const runsThisWeek = activities.filter((a) => isRun(a) && localDay(a) >= mondayStr);
    const runsThisWeekCount = runsThisWeek.length;
    const weekDoneKm = Math.round(runsThisWeek.reduce((s, a) => s + a.distance, 0) / 100) / 10;

    // Volume course hebdomadaire sur 12 semaines (semaine en cours en dernière position)
    const volume = [];
    for (let i = 11; i >= 0; i--) {
      const wStart = new Date(monday);
      wStart.setDate(monday.getDate() - i * 7);
      const wEnd = new Date(wStart);
      wEnd.setDate(wStart.getDate() + 7);
      const s = dateStr(wStart);
      const e = dateStr(wEnd);
      const km = activities
        .filter((a) => isRun(a) && localDay(a) >= s && localDay(a) < e)
        .reduce((sum, a) => sum + a.distance, 0);
      volume.push({ start: s, km: Math.round(km / 100) / 10 });
    }

    // ---------- Résumé des activités pour le prompt ----------
    const WEEKDAYS_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
    const activitySummary = activities.slice(0, 10).map((a) => {
      const iso = localDay(a);
      const weekday = iso ? WEEKDAYS_FR[new Date(iso + "T00:00:00Z").getUTCDay()] : "";
      const date = new Date(a.start_date).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
      const km = (a.distance / 1000).toFixed(1);
      const pace = a.average_speed > 0
        ? `${Math.floor(1000 / a.average_speed / 60)}'${String(Math.round((1000 / a.average_speed) % 60)).padStart(2, "0")}"/km`
        : "";
      const dp = a.total_elevation_gain ? `D+${Math.round(a.total_elevation_gain)}m` : "";
      const hr = a.average_heartrate ? `FC moy ${Math.round(a.average_heartrate)}bpm` : "";
      const effort = a.suffer_score ? `Effort ${a.suffer_score}` : "";
      return `- ${weekday} ${date} · ${a.type} · ${km}km ${dp} ${pace} ${hr} ${effort}`.trim();
    }).join("\n");

    const modePrompts = {
      session: "Génère la prochaine séance marathon optimale.",
      week: "Génère le programme complet de la semaine (7 jours, Lun à Dim).",
      fatigue: "Yann se sent fatigué. Propose une séance allégée ou repos actif.",
      cross: `Yann vient de faire : ${extra || "un autre sport"}. Adapte la prochaine séance marathon.`,
      bilan: "Fais un bilan honnête et précis de la situation actuelle de l'athlète.",
    };

    // Runs déjà faits cette semaine → instructions explicites et non contradictoires
    const runsWeekPrompt = runsThisWeekCount > 0
      ? `\nSEMAINE EN COURS (depuis lundi ${mondayStr}) : Yann a DÉJÀ effectué ${runsThisWeekCount} séance(s) de course cette semaine, pour ${weekDoneKm} km au total. Dans week[], marque ces jours déjà courus avec "done":true et une "session" décrivant la séance réalisée. Sur les jours restants, planifie uniquement le nombre de séances de course manquantes pour atteindre le total hebdomadaire demandé (total hebdo moins ${runsThisWeekCount} déjà faites).`
      : "";

    // Commentaire utilisateur
    const commentPrompt = comment && comment.trim()
      ? `\nCOMMENTAIRE DE L'ATHLÈTE (à prendre en compte dans l'analyse) : "${comment.trim()}"`
      : "";

    const isBilan = mode === "bilan";

    const schema = isBilan
      ? `{"niveau":"string (ex: Intermédiaire, Bon, Insuffisant)","tendance":"string (ex: En progression, Stable, En baisse)","acquis":["string","string","string"],"atravailler":["string","string","string"],"priorites":["string","string","string"],"verdict":"continuer"|"ameliorer"|"downgrade","verdictDetail":"string (2-3 phrases honnêtes sur l'objectif ${goalLabel})","confidence":75}`
      : `{"headline":"string (3 mots max)","type":"string","distance":"string","pace":"string","hr":"string","rpe":"string","tip":"string (1 phrase)","before":"string","during":"string","after":"string","gear":"string","why":"string (2-3 phrases)","confidence":75,"nextDay":"Lundi","week":[{"day":"Lun","session":"string","color":"#hex","done":false},{"day":"Mar","session":"string","color":"#hex","done":false},{"day":"Mer","session":"string","color":"#hex","done":false},{"day":"Jeu","session":"string","color":"#hex","done":false},{"day":"Ven","session":"string","color":"#hex","done":false},{"day":"Sam","session":"string","color":"#hex","done":false},{"day":"Dim","session":"string","color":"#hex","done":false}]}`;

    const weekRules = ` RÈGLES week[] : contient TOUJOURS EXACTEMENT 7 entrées, dans l'ordre Lun, Mar, Mer, Jeu, Ven, Sam, Dim (semaine en cours, du lundi ${mondayStr} au dimanche). Chaque entrée a "day", "session", "color", "done". Jours sans course : "session":"Repos" (ou le cross-training prévu), "color":"#374151", "done":false. "done":true UNIQUEMENT pour les séances déjà réalisées cette semaine. Couleurs des séances course : Footing/EF/Récup "#60a5fa" · Tempo/Seuil/Allure spé "#fbbf24" · Fractionné/VMA "#f87171" · Sortie longue "#a78bfa".`;

    const systemPrompt = isBilan
      ? `Tu es un coach marathon expert. Réponds UNIQUEMENT en JSON valide, sans texte avant ou après, sans backticks. Athlète : Yann · 73kg · Nice · objectif ${goalLabel} (allure cible ${paceLabel}) · Marathon de Nice 14 sept 2026 · ${daysLeft} jours restants.${commentPrompt} Sois honnête et précis, ne surestime pas le niveau. Schéma JSON : ${schema} — "confidence" est un entier 0-100 représentant ta confiance dans l'objectif ${goalLabel}. "verdict" est exactement l'une des trois valeurs : "continuer", "ameliorer" ou "downgrade". "acquis", "atravailler" et "priorites" sont des tableaux de 3 strings courtes.`
      : `Tu es un coach marathon expert. Réponds UNIQUEMENT en JSON valide, sans texte avant ou après, sans backticks. Athlète : Yann · 73kg · Nice · objectif ${goalLabel} (allure cible ${paceLabel}) · Marathon de Nice 14 sept 2026 · ${daysLeft} jours restants.${prefsPrompt || ""}${runsWeekPrompt}${commentPrompt} Schéma JSON : ${schema} — Le champ "confidence" est un entier entre 0 et 100 représentant ta confiance dans l'atteinte de l'objectif ${goalLabel} compte tenu de la progression actuelle. Le champ "nextDay" est le jour de la semaine en français (ex: "Lundi", "Mardi"...) où doit avoir lieu la prochaine séance.${weekRules}`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `Activités Strava récentes :\n${activitySummary}\n\n${modePrompts[mode] || modePrompts.session}`,
          },
          // Prefill : force le modèle à démarrer directement sur le JSON
          { role: "assistant", content: "{" },
        ],
      }),
    });

    if (!claudeRes.ok) {
      const errTxt = await claudeRes.text().catch(() => "");
      return res.status(502).json({ error: `Erreur API Claude (${claudeRes.status})`, detail: errTxt.slice(0, 300) });
    }

    const claudeData = await claudeRes.json();
    const raw = "{" + (claudeData.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) return res.status(500).json({ error: "JSON introuvable dans la réponse", raw });

    let result;
    try {
      result = JSON.parse(raw.slice(start, end + 1));
    } catch (e) {
      return res.status(500).json({ error: "Parse error (JSON invalide)", raw });
    }

    result._mode = mode; // permet au front de distinguer bilan vs séance

    res.json({
      result,
      weekDoneKm,
      volume,
      goal: goalMin,
      activities: activities.slice(0, 5).map((a) => ({
        date: new Date(a.start_date).toLocaleDateString("fr-FR", { day: "numeric", month: "short" }),
        iso: localDay(a),
        run: isRun(a),
        type: a.type,
        km: (a.distance / 1000).toFixed(1),
        elevation: Math.round(a.total_elevation_gain),
        effort: a.suffer_score,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: "Erreur serveur : " + (e && e.message ? e.message : String(e)) });
  }
}
