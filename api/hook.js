// api/hook.js
// Gestion de l'abonnement au webhook Strava depuis l'écran « État du coach ».
// GET    : abonnement actif ?
// POST   : crée l'abonnement (Strava valide aussitôt l'adresse /api/webhook)
// DELETE : supprime l'abonnement
// Protégé par la clé de l'app.

import crypto from "crypto";
import { KEYS, storeEnabled, checkAppKey, setJSON } from "./_lib/store.js";

const SUBS = "https://www.strava.com/api/v3/push_subscriptions";

async function listSubs() {
  const q = new URLSearchParams({ client_id: process.env.STRAVA_CLIENT_ID, client_secret: process.env.STRAVA_CLIENT_SECRET });
  const r = await fetch(`${SUBS}?${q}`);
  const d = await r.json().catch(() => null);
  return Array.isArray(d) ? d : [];
}

export default async function handler(req, res) {
  if (!storeEnabled()) return res.status(503).json({ error: "Stockage serveur non configuré" });
  let ok = false;
  try { ok = await checkAppKey(req); } catch (e) { ok = false; }
  if (!ok) return res.status(401).json({ error: "Clé de l'app invalide : déconnecte puis reconnecte Strava." });

  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const callbackUrl = `https://${host}/api/webhook`;

  try {
    if (req.method === "GET") {
      const subs = await listSubs();
      return res.json({ active: subs.length > 0, callbackUrl: subs[0] ? subs[0].callback_url : null, expectedUrl: callbackUrl });
    }

    if (req.method === "POST") {
      const subs = await listSubs();
      if (subs.length) return res.json({ active: true, callbackUrl: subs[0].callback_url, already: true });
      const verify = crypto.randomBytes(16).toString("hex");
      await setJSON(KEYS.verify, verify);
      const r = await fetch(SUBS, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: process.env.STRAVA_CLIENT_ID,
          client_secret: process.env.STRAVA_CLIENT_SECRET,
          callback_url: callbackUrl,
          verify_token: verify,
        }).toString(),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(400).json({ error: "Strava a refusé l'abonnement", detail: d });
      return res.json({ active: true, callbackUrl, id: d.id });
    }

    if (req.method === "DELETE") {
      const subs = await listSubs();
      for (const s of subs) {
        const q = new URLSearchParams({ client_id: process.env.STRAVA_CLIENT_ID, client_secret: process.env.STRAVA_CLIENT_SECRET });
        await fetch(`${SUBS}/${s.id}?${q}`, { method: "DELETE" });
      }
      return res.json({ active: false });
    }

    return res.status(405).end();
  } catch (e) {
    return res.status(500).json({ error: "Erreur : " + (e && e.message ? e.message : String(e)) });
  }
}
