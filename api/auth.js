// api/auth.js
// v8 : en plus de renvoyer les jetons à l'app, garde la connexion Strava côté serveur
// (propriétaire unique : le premier athlète connecté) et transmet la clé de l'app.

import { KEYS, storeEnabled, getJSON, setJSON, getOrCreateAppKey } from "./_lib/store.js";

export default async function handler(req, res) {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: "No code" });

  const response = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
    }),
  });

  const data = await response.json();
  if (!response.ok) return res.status(400).json({ error: data });

  const { access_token, refresh_token, expires_at, athlete } = data;
  const params = new URLSearchParams({
    access_token,
    refresh_token,
    expires_at,
    athlete_id: athlete.id,
    athlete_name: athlete.firstname,
  });

  // Stockage serveur : seul le propriétaire (premier athlète connecté) est enregistré
  if (storeEnabled()) {
    try {
      const current = await getJSON(KEYS.strava);
      if (!current || String(current.athlete_id) === String(athlete.id)) {
        await setJSON(KEYS.strava, {
          athlete_id: athlete.id,
          athlete_name: athlete.firstname,
          access_token,
          refresh_token,
          expires_at,
          linkedAt: Date.now(),
        });
        params.set("app_key", await getOrCreateAppKey());
      }
    } catch (e) {
      // En cas de souci de stockage, l'app fonctionne comme avant (sans serveur)
    }
  }

  res.redirect(`/?${params.toString()}`);
}
