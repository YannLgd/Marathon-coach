// api/state.js
// GET  : derniers résultats sauvegardés côté serveur (séance/semaine, bilan, dernière séance, état).
// POST : met à jour objectif et préférences sans lancer d'analyse.
// Protégé par la clé de l'app (en-tête x-app-key).

import { KEYS, storeEnabled, checkAppKey, getJSON, setJSON } from "./_lib/store.js";

export default async function handler(req, res) {
  if (!storeEnabled()) return res.status(503).json({ error: "Stockage serveur non configuré" });
  let ok = false;
  try { ok = await checkAppKey(req); } catch (e) { ok = false; }
  if (!ok) return res.status(401).json({ error: "Clé de l'app invalide : déconnecte puis reconnecte Strava." });

  try {
    if (req.method === "GET") {
      const [result, bilan, strava, last, status] = await Promise.all([
        getJSON(KEYS.result), getJSON(KEYS.bilan), getJSON(KEYS.strava), getJSON(KEYS.last), getJSON(KEYS.status),
      ]);
      return res.json({ ok: true, stravaLinked: !!(strava && strava.refresh_token), result, bilan, last, status });
    }
    if (req.method === "POST") {
      const b = req.body || {};
      const prev = (await getJSON(KEYS.settings)) || {};
      const next = { ...prev, updatedAt: Date.now() };
      if ("objective" in b) next.objective = b.objective || null;
      if (typeof b.prefsPrompt === "string") next.prefsPrompt = b.prefsPrompt;
      if (b.maxSessions) next.maxSessions = b.maxSessions;
      await setJSON(KEYS.settings, next);
      return res.json({ ok: true });
    }
    return res.status(405).end();
  } catch (e) {
    return res.status(500).json({ error: "Erreur stockage : " + (e && e.message ? e.message : String(e)) });
  }
}
