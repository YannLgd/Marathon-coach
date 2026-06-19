export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { access_token, mode, extra } = req.body;
  if (!access_token) return res.status(400).json({ error: "No access_token" });

  const stravaRes = await fetch(
    "https://www.strava.com/api/v3/athlete/activities?per_page=10",
    { headers: { Authorization: `Bearer ${access_token}` } }
  );
  if (!stravaRes.ok) return res.status(401).json({ error: "Strava auth failed" });
  const activities = await stravaRes.json();

  const RACE_DATE = new Date("2026-09-14T08:00:00");
  const daysLeft = Math.ceil((RACE_DATE - new Date()) / 86400000);

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
  };

  const schema = `{"headline":"string (3 mots max)","type":"string","distance":"string","pace":"string","hr":"string","rpe":"string","tip":"string (1 phrase)","before":"string","during":"string","after":"string","gear":"string","why":"string (2-3 phrases)","week":[{"day":"Lun","session":"string","color":"#hex"},{"day":"Mar","session":"string","color":"#hex"},{"day":"Mer","session":"string","color":"#hex"},{"day":"Jeu","session":"string","color":"#hex"},{"day":"Ven","session":"string","color":"#hex"},{"day":"Sam","session":"string","color":"#hex"},{"day":"Dim","session":"string","color":"#hex"}]}`;

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
      system: `Tu es un coach marathon expert. Réponds UNIQUEMENT en JSON valide, sans texte avant ou après, sans backticks. Athlète : Yann · 73kg · Nice · sub-4h · Marathon de Nice 14 sept 2026 · ${daysLeft} jours restants. Schéma JSON : ${schema}`,
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
    res.json({ result, activities: activities.slice(0, 5).map(a => ({
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
