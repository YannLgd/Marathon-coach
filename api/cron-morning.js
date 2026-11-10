// api/cron-morning.js
// Rappel du matin, déclenché chaque jour par Vercel (voir "crons" dans vercel.json).
// Envoie une notification seulement si une course est prévue aujourd'hui et pas encore faite.
// Aucun appel à Claude : on lit le programme déjà calculé.

import { KEYS, getJSON, setOnce } from "./_lib/store.js";
import { sendPush } from "./_lib/notify.js";

const ABBR = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const FULL = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];

export default async function handler(req, res) {
  // Si CRON_SECRET est défini dans Vercel, seul Vercel peut déclencher ce rappel
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end();
  }
  try {
    const paris = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Paris" }));
    const pad = (n) => String(n).padStart(2, "0");
    const today = `${paris.getFullYear()}-${pad(paris.getMonth() + 1)}-${pad(paris.getDate())}`;
    const idx = (paris.getDay() + 6) % 7;
    const monday = new Date(paris);
    monday.setDate(paris.getDate() - idx);
    const mondayStr = `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;

    const saved = await getJSON(KEYS.result);
    const body = saved && saved.body;
    if (!body || !body.result || body.weekStart !== mondayStr) return res.json({ sent: 0, reason: "pas de programme pour cette semaine" });
    const r = body.result;
    const w = Array.isArray(r.week) ? r.week.find((x) => x.day === ABBR[idx]) : null;
    const isRun = w && w.session && !w.done && !/^repos/i.test(w.session) && /\d\s*km/i.test(w.session);
    if (!isRun) return res.json({ sent: 0, reason: "pas de course prévue aujourd'hui" });

    // Une seule fois par jour, même si Vercel rappelle la route
    if (!(await setOnce(`mc:reminded:${today}`, 2 * 86400))) return res.json({ sent: 0, reason: "déjà envoyé" });

    const detailed = r.nextDay === FULL[idx] && r.headline;
    const title = `Aujourd'hui : ${w.session}`;
    const text = detailed && r.goal ? r.goal : (w.detail || "Ouvre l'app pour le détail de ta séance.");
    const sent = await sendPush({ title, body: text.slice(0, 180), url: "/?view=result", tag: `reminder-${today}` });
    return res.json({ sent });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
}
