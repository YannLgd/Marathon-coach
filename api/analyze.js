export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { access_token, mode, extra, prefsPrompt, comment, objective } = req.body;

  if (!access_token) return res.status(400).json({ error: "No access_token" });

  // Mode spécial : récupérer l'historique volume sur 12 semaines
  if (mode === "volume_history") {
    const since = new Date();
    since.setDate(since.getDate() - 84);
    const epoch = Math.floor(since.getTime() / 1000);
    const stravaRes = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?per_page=100&after=${epoch}`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    if (!stravaRes.ok) return res.status(401).json({ error: "Strava auth failed" });
    const activities = await stravaRes.json();
    const runs = activities.filter(a =>
      a.type === "Run" || a.type === "TrailRun" ||
      a.sport_type === "Run" || a.sport_type === "TrailRun"
    );
    const weekMap = {};
    runs.forEach(a => {
      const d = new Date(a.start_date);
      const day = d.getDay();
      const diff = (day === 0 ? -6 : 1 - day);
      const monday = new Date(d);
      monday.setDate(d.getDate() + diff);
      monday.setHours(0, 0, 0, 0);
      const key = monday.toISOString().slice(0, 10);
      weekMap[key] = (weekMap[key] || 0) + a.distance / 1000;
    });
    return res.json({ weekMap });
  }

  const stravaRes = await fetch(
    "https://www.strava.com/api/v3/athlete/activities?per_page=10",
    { headers: { Authorization: `Bearer ${access_token}` } }
  );
  if (!stravaRes.ok) return res.status(401).json({ error: "Strava auth failed" });
  const activities = await stravaRes.json();

  const RACE_DATE = new Date("2026-09-14T08:00:00");
  const daysLeft = Math.ceil((RACE_DATE - new Date()) / 86400000);

  const obj = objective || { distance: "42,2 km", time: "4h00", pace: "5'41\"/km" };
  const objectiveStr = `objectif ${obj.time} · allure ${obj.pace} · ${obj.distance}`;

  // Runs déjà effectués cette semaine
  const now = new Date();
  const dayOfWeek = now.getDay();
  const diffToMonday = (dayOfWeek === 0 ? -6 : 1 - dayOfWeek);
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);

  const runsThisWeek = activities.filter(a => {
    const actDate = new Date(a.start_date);
    return actDate >= monday && (a.type === "Run" || a.type === "TrailRun" || a.sport_type === "Run" || a.sport_type === "TrailRun");
  });
  const runsThisWeekCount = runsThisWeek.length;

  const activitySummary = activities.slice(0, 8).map(a => {
    const date = new Date(a.start_date).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
    const km = (a.distance / 1000).toFixed(1);
    const pace = a.average_speed > 0
      ? `${Math.floor(1000 / a.average_speed / 60)}'${String(Math.round(1000 / a.average_speed % 60)).padStart(2, "0")}"/km`
      : "";
    const dp = a.total_elevation_gain ? `D+${Math.round(a.total_elevation_gain)}m` : "";
    const hr = a.average_heartrate ? `FC moy ${Math.round(a.average_heartrate)}bpm` : "";
    const effort = a.suffer_score ? `Effort ${a.suffer_score}` : "";
    return `- ${date} · ${a.type} · ${km}km ${dp} ${pace} ${hr} ${effort}`.trim();
  }).join("\n");

  const modePrompts = {
    session: "Génère la prochaine séance marathon optimale.",
    week: "Génère le programme complet de la semaine prochaine (7 jours).",
    fatigue: "Yann se sent fatigué. Propose une séance allégée ou repos actif.",
    cross: `Yann vient de faire : ${extra || "un autre sport"}. Adapte la prochaine séance marathon.`,
    bilan: "Fais un bilan honnête et précis de la situation actuelle de l'athlète.",
  };

  const runsWeekPrompt = runsThisWeekCount > 0
    ? `\nATTENTION : Yann a déjà effectué ${runsThisWeekCount} séance(s) de course cette semaine (depuis lundi). RÈGLES OBLIGATOIRES pour week[] : (1) Toujours exactement 7 entrées, de Lun à Dim. (2) Le nombre TOTAL de séances de course dans week[] = nombre de séances dans les préférences (EXACTEMENT). (3) Les ${runsThisWeekCount} run(s) déjà faits cette semaine doivent figurer dans week[] avec "done":true sur le bon jour. (4) Les séances de course restantes à planifier = préférences - ${runsThisWeekCount}. Les autres jours = Repos ou cross-training.`
    : `\nRÈGLE OBLIGATOIRE : week[] doit TOUJOURS contenir exactement 7 entrées, une par jour de Lun à Dim. Les jours sans course = Repos.`;

  const commentPrompt = comment && comment.trim()
    ? `\nCOMMENTAIRE DE L'ATHLÈTE (à prendre en compte dans l'analyse) : "${comment.trim()}"`
    : "";

  const isBilan = mode === "bilan";

  const schema = isBilan
    ? `{"niveau":"string","tendance":"string","acquis":["string","string","string"],"atravailler":["string","string","string"],"priorites":["string","string","string"],"verdict":"continuer"|"ameliorer"|"downgrade","verdictDetail":"string (2-3 phrases)","confidence":75}`
    : `{"headline":"string (3 mots max)","type":"string","distance":"string","pace":"string","hr":"string","rpe":"string","tip":"string (1 phrase)","before":"string","during":"string","after":"string","gear":"string","why":"string (2-3 phrases)","confidence":75,"nextDay":"Lundi","week":[{"day":"Lun","session":"string","color":"#hex","done":false},{"day":"Mar","session":"string","color":"#hex","done":false},{"day":"Mer","session":"string","color":"#hex","done":false},{"day":"Jeu","session":"string","color":"#hex","done":false},{"day":"Ven","session":"string","color":"#hex","done":false},{"day":"Sam","session":"string","color":"#hex","done":false},{"day":"Dim","session":"string","color":"#hex","done":false}]}`;

  const systemPrompt = isBilan
    ? `Tu es un coach marathon expert. Réponds UNIQUEMENT en JSON valide, sans texte avant ou après, sans backticks. Athlète : Yann · 73kg · Nice · ${objectiveStr} · Marathon de Nice 14 sept 2026 · ${daysLeft} jours restants.${commentPrompt} Sois honnête et précis. Schéma JSON : ${schema} — "confidence" est un entier 0-100. "verdict" est exactement l'une des trois valeurs : "continuer", "ameliorer" ou "downgrade". "acquis", "atravailler" et "priorites" sont des tableaux de 3 strings courtes.`
    : `Tu es un coach marathon expert. Réponds UNIQUEMENT en JSON valide, sans texte avant ou après, sans backticks. Athlète : Yann · 73kg · Nice · ${objectiveStr} · Marathon de Nice 14 sept 2026 · ${daysLeft} jours restants.${prefsPrompt || ""}${runsWeekPrompt}${commentPrompt} Schéma JSON : ${schema} — "confidence" est un entier 0-100. "nextDay" est le jour en français. "week" contient TOUJOURS exactement 7 objets (Lun→Dim). "done":true uniquement sur les runs déjà effectués cette semaine.`;

  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{
        role: "user",
        content: `Activités Strava récentes :\n${activitySummary}\n\n${modePrompts[mode] || modePrompts.session}`,
      }],
    }),
  });

  const claudeData = await claudeRes.json();
  const raw = (claudeData.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return res.status(500).json({ error: "JSON introuvable", raw });

  try {
    const result = JSON.parse(raw.slice(start, end + 1));
    result._mode = mode;
    const weekDoneKm = Math.round(runsThisWeek.reduce((s, a) => s + a.distance / 1000, 0) * 10) / 10;
    res.json({ result, weekDoneKm, activities: activities.slice(0, 5).map(a => ({
      date: new Date(a.start_date).toLocaleDateString("fr-FR", { day: "numeric", month: "short" }),
      type: a.type,
      km: (a.distance / 1000).toFixed(1),
      elevation: Math.round(a.total_elevation_gain),
      effort: a.suffer_score,
    }))});
  } catch (e) {
    res.status(500).json({ error: "Parse error", raw });
  }
}
