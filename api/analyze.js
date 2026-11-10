// api/analyze.js
// v8 : route appelée par l'app. Le cœur du coach est dans api/_lib/coach.js,
// la fiche coureur dans api/_lib/runner.js.
// Avec la clé de l'app (en-tête x-app-key), le serveur utilise sa propre connexion
// Strava, mémorise objectif/préférences et sauvegarde le résultat.

import { runAnalysis } from "./_lib/coach.js";
import { KEYS, checkAppKey, getStravaToken, getJSON, setJSON } from "./_lib/store.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const body = req.body || {};

  let owner = false;
  try { owner = await checkAppKey(req); } catch (e) { owner = false; }

  let token = body.access_token || null;
  if (owner) {
    const serverToken = await getStravaToken().catch(() => null);
    if (serverToken) token = serverToken;
    else if (!token) return res.status(401).json({ error: "Connexion Strava expirée côté serveur : déconnecte puis reconnecte Strava." });

    // Objectif et préférences mémorisés pour les analyses automatiques (étape 2)
    try {
      const prev = (await getJSON(KEYS.settings)) || {};
      await setJSON(KEYS.settings, {
        ...prev,
        objective: body.objective || null,
        prefsPrompt: body.prefsPrompt || prev.prefsPrompt || "",
        maxSessions: body.maxSessions || prev.maxSessions || null,
        updatedAt: Date.now(),
      });
    } catch (e) { /* le stockage ne doit jamais bloquer l'analyse */ }
  }

  const out = await runAnalysis({ ...body, access_token: token });

  if (owner && out.status === 200 && out.body && out.body.result) {
    try {
      const key = out.body.result._mode === "bilan" ? KEYS.bilan : KEYS.result;
      await setJSON(key, { body: out.body, savedAt: out.body.savedAt || Date.now() });
    } catch (e) { /* idem */ }
  }

  res.status(out.status).json(out.body);
}
