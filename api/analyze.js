export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const { access_token, mode, extra, prefsPrompt, comment, objective } = req.body || {};
    if (!access_token) return res.status(400).json({ error: "No access_token" });

    // ---------- Dates en Europe/Paris (Vercel tourne en UTC) ----------
    const parisNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Paris" }));
    const pad = (n) => String(n).padStart(2, "0");
    const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const todayMidnight = new Date(parisNow.getFullYear(), parisNow.getMonth(), parisNow.getDate());

    // Lundi de la semaine en cours (heure de Nice)
    const dow = parisNow.getDay(); // 0=dim, 1=lun, ...
    const monday = new Date(parisNow);
    monday.setDate(parisNow.getDate() + (dow === 0 ? -6 : 1 - dow));
    const mondayStr = dateStr(monday);

    // ---------- Objectif générique (éditable, date optionnelle = mode reprise) ----------
    const obj = objective || {};
    const objType = ["trail", "route", "autre"].includes(obj.type) ? obj.type : "trail";
    const typeLabelMap = { trail: "trail", route: "course sur route", autre: "objectif" };
    const objTypeLabel = typeLabelMap[objType];
    const distanceKm = Number(obj.distanceKm) > 0 ? Number(obj.distanceKm) : null;
    const objDplus = Number(obj.dplus) > 0 ? Number(obj.dplus) : null;
    const targetMin = Number(obj.targetTime) > 0 ? Number(obj.targetTime) : null;
    const objName = (obj.name || "").trim();
    const timeLbl = targetMin ? `${Math.floor(targetMin / 60)}h${pad(targetMin % 60)}` : null;

    let daysLeft = null, raceFr = null;
    if (obj.date) {
      const race = new Date(obj.date + "T08:00:00");
      if (!isNaN(race.getTime())) {
        const raceMid = new Date(race.getFullYear(), race.getMonth(), race.getDate());
        daysLeft = Math.max(0, Math.round((raceMid - todayMidnight) / 86400000));
        raceFr = race.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
      }
    }

    // Description de l'objectif pour les prompts
    let objDesc = `OBJECTIF ACTUEL — ${objTypeLabel}`;
    if (objName) objDesc += ` « ${objName} »`;
    const bits = [];
    if (distanceKm) bits.push(`${distanceKm} km`);
    if (objDplus) bits.push(`D+ ${objDplus} m`);
    if (timeLbl) bits.push(`temps visé ${timeLbl} (indicatif, non contraignant)`);
    if (bits.length) objDesc += ` · ${bits.join(" · ")}`;
    if (daysLeft !== null) objDesc += ` · course le ${raceFr} · ${daysLeft} jours restants`;
    else objDesc += ` · pas de date fixée`;
    if (!distanceKm && !objDplus) objDesc += `. Détails de la course encore indéfinis (Yann prépare un « gros » trail type 30-40 km / 1000-2000 D+, distance et date à confirmer).`;

    // Guidance coaching selon le type
    const trailGuidance = objType === "trail"
      ? ` COACHING TRAIL : en trail l'allure en min/km n'est PAS un objectif pertinent (le terrain et le D+ la font varier) — raisonne en durée, dénivelé (D+), fréquence cardiaque et RPE. Le champ "pace" reste "" (ou une allure indicative sur plat seulement). Priorise le travail spécifique de dénivelé (séances de côtes, D+ progressif), le temps passé debout (sorties longues en nature), la descente technique et le renforcement. Le vélo et la rando comptent pleinement dans la charge et la base aérobie, surtout pour préparer le D+.`
      : ` Compte le vélo, la rando et la natation dans la charge d'entraînement et la base aérobie.`;

    // Guidance reprise (pas de date fixée)
    const repriseGuidance = daysLeft === null
      ? ` PHASE DE REPRISE : Yann reprend la course après une coupure (bloc vélo / marche / nage lié à la chaleur). Volumes modérés, intensité progressive, aucune séance traumatisante d'emblée ; priorité au ré-ancrage de l'habitude et à la base aérobie avant de spécifier vers le trail.`
      : "";

    // ---------- Strava : 12 semaines d'historique ----------
    const after = Math.floor(Date.now() / 1000) - 84 * 86400;
    const stravaRes = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=100`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    if (!stravaRes.ok) return res.status(401).json({ error: "Strava auth failed" });
    const activitiesRaw = await stravaRes.json();
    if (!Array.isArray(activitiesRaw)) return res.status(502).json({ error: "Réponse Strava invalide" });
    const activities = activitiesRaw.slice().sort((a, b) => new Date(b.start_date) - new Date(a.start_date));

    const isRun = (a) => a.type === "Run" || a.type === "TrailRun" || a.sport_type === "Run" || a.sport_type === "TrailRun";
    const localDay = (a) => (a.start_date_local || a.start_date || "").slice(0, 10);
    const elevOf = (a) => a.total_elevation_gain || 0;
    const effortOf = (a) => a.suffer_score || 0;

    // Runs déjà effectués cette semaine (lundi = début de semaine, dates locales)
    const runsThisWeek = activities.filter((a) => isRun(a) && localDay(a) >= mondayStr);
    const runsThisWeekCount = runsThisWeek.length;
    const weekDoneKm = Math.round(runsThisWeek.reduce((s, a) => s + a.distance, 0) / 100) / 10;

    // Charge de la semaine en cours (toutes activités : course + vélo + rando + nage)
    const actsThisWeek = activities.filter((a) => localDay(a) >= mondayStr);
    const weekDoneDplus = Math.round(actsThisWeek.reduce((s, a) => s + elevOf(a), 0));
    const weekCharge = Math.round(actsThisWeek.reduce((s, a) => s + effortOf(a), 0));

    // Historique hebdo sur 12 semaines : km course + D+ (toutes activités) + charge (effort, toutes activités)
    const volume = [];
    for (let i = 11; i >= 0; i--) {
      const wStart = new Date(monday);
      wStart.setDate(monday.getDate() - i * 7);
      const wEnd = new Date(wStart);
      wEnd.setDate(wStart.getDate() + 7);
      const s = dateStr(wStart);
      const e = dateStr(wEnd);
      const inWeek = activities.filter((a) => localDay(a) >= s && localDay(a) < e);
      const km = inWeek.filter(isRun).reduce((sum, a) => sum + a.distance, 0);
      const dplus = inWeek.reduce((sum, a) => sum + elevOf(a), 0);
      const charge = inWeek.reduce((sum, a) => sum + effortOf(a), 0);
      volume.push({ start: s, km: Math.round(km / 100) / 10, dplus: Math.round(dplus), charge: Math.round(charge) });
    }

    // ---------- Couche de progressivité (prévention blessures) ----------
    // Jours écoulés depuis la dernière course (basé sur les activités déjà triées par date desc)
    const lastRun = activities.find(isRun);
    const daysSinceLastRun = lastRun
      ? Math.floor((todayMidnight - new Date(localDay(lastRun) + "T00:00:00")) / 86400000)
      : null;

    // Moyenne des 4 dernières semaines COMPLÈTES (exclut la semaine en cours, encore partielle)
    const completedWeeks = volume.slice(Math.max(0, volume.length - 5), volume.length - 1); // 4 semaines avant la semaine en cours
    const recentAvgKm = completedWeeks.length
      ? Math.round((completedWeeks.reduce((s, w) => s + w.km, 0) / completedWeeks.length) * 10) / 10
      : 0;

    // Plus longue sortie course des 28 derniers jours (référence pour plafonner la SL)
    const last28 = Math.floor(Date.now() / 1000) - 28 * 86400;
    const recentLongestRunKm = activities
      .filter((a) => isRun(a) && new Date(a.start_date).getTime() / 1000 >= last28)
      .reduce((max, a) => Math.max(max, a.distance / 1000), 0);
    const recentLongestRunKmRounded = Math.round(recentLongestRunKm * 10) / 10;

    // Détermine le régime de progressivité et les plafonds correspondants
    let regimeLabel, weeklyCapKm, slCapKm;
    if (daysSinceLastRun === null) {
      // Aucun historique de course exploitable sur 12 semaines
      regimeLabel = "Reprise complète — aucune donnée de course récente";
      weeklyCapKm = 15;
      slCapKm = 5;
    } else if (daysSinceLastRun >= 21) {
      regimeLabel = `Reprise après coupure longue (${daysSinceLastRun} jours sans course)`;
      weeklyCapKm = Math.max(10, Math.round(recentAvgKm * 0.4));
      slCapKm = Math.max(5, Math.round(weeklyCapKm * 0.3));
    } else if (daysSinceLastRun >= 14) {
      regimeLabel = `Reprise après coupure (${daysSinceLastRun} jours sans course)`;
      weeklyCapKm = Math.max(12, Math.round(recentAvgKm * 0.6));
      slCapKm = Math.max(6, Math.round(weeklyCapKm * 0.3));
    } else if (daysSinceLastRun >= 7) {
      regimeLabel = `Reprise légère (${daysSinceLastRun} jours sans course)`;
      weeklyCapKm = Math.max(10, Math.round(recentAvgKm * 0.85));
      slCapKm = Math.max(5, Math.round(Math.min(weeklyCapKm * 0.32, (recentLongestRunKmRounded || weeklyCapKm * 0.32) * 1.15)));
    } else {
      regimeLabel = "Entraînement continu";
      // Règle classique des +10% de volume hebdo, SL plafonnée à ~35% du volume ou +20% de la plus longue sortie récente
      weeklyCapKm = recentAvgKm > 0 ? Math.round(recentAvgKm * 1.10) : 30;
      const slFromVolume = weeklyCapKm * 0.35;
      const slFromHistory = recentLongestRunKmRounded > 0 ? recentLongestRunKmRounded * 1.20 : slFromVolume;
      slCapKm = Math.round(Math.min(slFromVolume, slFromHistory));
    }

    const progressionPrompt = `\nCONTRAINTES DE PROGRESSIVITÉ (impératif, priment sur toute autre logique de planification — objectif de course de blessure non négociable) : ${regimeLabel}. Volume TOTAL de course cette semaine ≤ ${weeklyCapKm} km (somme de toutes les séances de course planifiées, y compris celles déjà faites). Sortie longue individuelle ≤ ${slCapKm} km. Repère : moyenne des 4 dernières semaines complètes = ${recentAvgKm} km/semaine ; plus longue sortie course des 28 derniers jours = ${recentLongestRunKmRounded} km. Ne JAMAIS générer une semaine ou une sortie longue dépassant ces plafonds, même si le calendrier de l'objectif semble le permettre ou l'exiger — dans ce cas, explique le compromis dans "why" plutôt que de dépasser les plafonds. Répartis le volume progressivement sur les séances disponibles plutôt que de le concentrer sur une seule sortie.`;

    // ---------- Résumé des activités pour le prompt (toutes disciplines) ----------
    const WEEKDAYS_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
    const activitySummary = activities.slice(0, 12).map((a) => {
      const iso = localDay(a);
      const weekday = iso ? WEEKDAYS_FR[new Date(iso + "T00:00:00Z").getUTCDay()] : "";
      const date = new Date(a.start_date).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
      const km = (a.distance / 1000).toFixed(1);
      const pace = isRun(a) && a.average_speed > 0
        ? `${Math.floor(1000 / a.average_speed / 60)}'${String(Math.round((1000 / a.average_speed) % 60)).padStart(2, "0")}"/km`
        : "";
      const dp = a.total_elevation_gain ? `D+${Math.round(a.total_elevation_gain)}m` : "";
      const hr = a.average_heartrate ? `FC moy ${Math.round(a.average_heartrate)}bpm` : "";
      const effort = a.suffer_score ? `Effort ${a.suffer_score}` : "";
      return `- ${weekday} ${date} · ${a.type} · ${km}km ${dp} ${pace} ${hr} ${effort}`.trim();
    }).join("\n");

    const modePrompts = {
      session: "Génère la prochaine séance de course optimale pour cet objectif.",
      week: "Génère le programme complet de la semaine (7 jours, Lun à Dim).",
      fatigue: "Yann se sent fatigué. Propose une séance allégée ou un repos actif.",
      cross: `Yann vient de faire : ${extra || "un autre sport"}. Adapte sa prochaine séance de course.`,
      bilan: "Fais un bilan honnête et précis de sa situation actuelle vis-à-vis de l'objectif.",
    };

    // Runs déjà faits cette semaine → instructions explicites et non contradictoires
    const runsWeekPrompt = runsThisWeekCount > 0
      ? `\nSEMAINE EN COURS (depuis lundi ${mondayStr}) : Yann a DÉJÀ effectué ${runsThisWeekCount} séance(s) de course cette semaine, pour ${weekDoneKm} km au total. Dans week[], marque ces jours déjà courus avec "done":true et une "session" décrivant la séance réalisée. Sur les jours restants, planifie uniquement le nombre de séances de course manquantes pour atteindre le total hebdomadaire demandé (total hebdo moins ${runsThisWeekCount} déjà faites).`
      : "";

    // Charge multi-sports de la semaine
    const chargePrompt = `\nCHARGE CETTE SEMAINE (toutes activités confondues) : effort relatif cumulé ${weekCharge}, D+ cumulé ${weekDoneDplus} m. Le vélo, la rando et la natation comptent dans cette charge et dans la base aérobie.`;

    // Commentaire utilisateur
    const commentPrompt = comment && comment.trim()
      ? `\nCOMMENTAIRE DE L'ATHLÈTE (à prendre en compte dans l'analyse) : "${comment.trim()}"`
      : "";

    const isBilan = mode === "bilan";

    const confidenceDef = daysLeft !== null
      ? `ta confiance dans l'atteinte de l'objectif compte tenu de la progression actuelle`
      : `ta confiance dans le bon déroulé de la reprise et la trajectoire vers un « gros » trail`;

    const schema = isBilan
      ? `{"niveau":"string (ex: Intermédiaire, Bon, En reprise)","tendance":"string (ex: En progression, Stable, En baisse)","acquis":["string","string","string"],"atravailler":["string","string","string"],"priorites":["string","string","string"],"verdict":"continuer"|"ameliorer"|"downgrade","verdictDetail":"string (2-3 phrases honnêtes sur l'objectif ${objTypeLabel})","confidence":75}`
      : `{"headline":"string (3 mots max)","type":"string","distance":"string (ex: 12 km)","dplus":"string (ex: 400 m, ou '' si plat/non pertinent)","duration":"string (ex: 1h10)","pace":"string (allure indicative sur plat, ou '' en trail)","hr":"string","rpe":"string","tip":"string (1 phrase)","before":"string","during":"string","after":"string","gear":"string","why":"string (2-3 phrases)","confidence":75,"nextDay":"Lundi","week":[{"day":"Lun","session":"string","color":"#hex","done":false},{"day":"Mar","session":"string","color":"#hex","done":false},{"day":"Mer","session":"string","color":"#hex","done":false},{"day":"Jeu","session":"string","color":"#hex","done":false},{"day":"Ven","session":"string","color":"#hex","done":false},{"day":"Sam","session":"string","color":"#hex","done":false},{"day":"Dim","session":"string","color":"#hex","done":false}]}`;

    const weekRules = ` RÈGLES week[] : contient TOUJOURS EXACTEMENT 7 entrées, dans l'ordre Lun, Mar, Mer, Jeu, Ven, Sam, Dim (semaine en cours, du lundi ${mondayStr} au dimanche). Chaque entrée a "day", "session", "color", "done". Jours sans course : "session":"Repos" (ou le cross-training prévu : vélo, rando…), "color":"#374151", "done":false. "done":true UNIQUEMENT pour les séances déjà réalisées cette semaine. Couleurs des séances : Footing/EF/Récup "#60a5fa" · Tempo/Seuil "#fbbf24" · Fractionné/VMA "#f87171" · Séance de côtes/dénivelé "#34d399" · Sortie longue/rando-course "#a78bfa".`;

    const baseIdentity = `Tu es un coach de course à pied et de trail expert. Réponds UNIQUEMENT en JSON valide, sans texte avant ou après, sans backticks. Athlète : Yann · 73 kg · Nice · reprend la course après une coupure (bloc vélo/marche/nage), semi récent en 1h48.`;

    const systemPrompt = isBilan
      ? `${baseIdentity} ${objDesc}.${trailGuidance}${repriseGuidance}${chargePrompt}${progressionPrompt}${commentPrompt} Sois honnête et précis, ne surestime pas le niveau. Tiens compte des contraintes de progressivité ci-dessus dans "atravailler" et "priorites" si le rythme actuel les met en risque. Schéma JSON : ${schema} — "confidence" est un entier 0-100 représentant ${confidenceDef}. "verdict" est exactement l'une des trois valeurs : "continuer", "ameliorer" ou "downgrade". "acquis", "atravailler" et "priorites" sont des tableaux de 3 strings courtes.`
      : `${baseIdentity} ${objDesc}.${trailGuidance}${repriseGuidance}${chargePrompt}${progressionPrompt}${prefsPrompt || ""}${runsWeekPrompt}${commentPrompt} Schéma JSON : ${schema} — Le champ "confidence" est un entier entre 0 et 100 représentant ${confidenceDef}. Le champ "nextDay" est le jour de la semaine en français (ex: "Lundi", "Mardi"...) où doit avoir lieu la prochaine séance.${weekRules}`;

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
        temperature: 0,
        system: systemPrompt,
        // NOTE : pas de prefill assistant — Sonnet 4.6 renvoie une 400 si le
        // dernier message est un message assistant (breaking change du modèle).
        messages: [
          {
            role: "user",
            content: `Activités Strava récentes (toutes disciplines) :\n${activitySummary}\n\n${modePrompts[mode] || modePrompts.session}`,
          },
        ],
      }),
    });

    if (!claudeRes.ok) {
      const errTxt = await claudeRes.text().catch(() => "");
      return res.status(502).json({ error: `Erreur API Claude (${claudeRes.status})`, detail: errTxt.slice(0, 300) });
    }

    const claudeData = await claudeRes.json();
    const raw = (claudeData.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
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
      weekStart: mondayStr,
      weekDoneKm,
      weekDoneDplus,
      weekCharge,
      volume,
      progression: { regimeLabel, weeklyCapKm, slCapKm, daysSinceLastRun, recentAvgKm, recentLongestRunKm: recentLongestRunKmRounded },
      objective: { type: objType, daysLeft },
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
