// api/push.js
// GET    : clé publique pour s'abonner + nombre d'appareils abonnés
// POST   : { subscription } enregistre l'appareil · { action: "test" } envoie une notification de test
// DELETE : { endpoint } désabonne l'appareil
// Protégé par la clé de l'app.

import { storeEnabled, checkAppKey } from "./_lib/store.js";
import { getVapid, listSubs, addSub, removeSub, sendPush } from "./_lib/notify.js";

export default async function handler(req, res) {
  if (!storeEnabled()) return res.status(503).json({ error: "Stockage serveur non configuré" });
  let ok = false;
  try { ok = await checkAppKey(req); } catch (e) { ok = false; }
  if (!ok) return res.status(401).json({ error: "Clé de l'app invalide : déconnecte puis reconnecte Strava." });

  const host = req.headers["x-forwarded-host"] || req.headers.host;
  try {
    if (req.method === "GET") {
      const v = await getVapid(`https://${host}`);
      const subs = await listSubs();
      return res.json({ publicKey: v.publicKey, devices: subs.length, endpoints: subs.map((s) => s.endpoint) });
    }
    const b = req.body || {};
    if (req.method === "POST" && b.action === "test") {
      const sent = await sendPush({ title: "Coach", body: "Notifications actives ✓ Tu seras prévenu après chaque séance analysée.", url: "/", tag: "test" });
      return res.json({ sent });
    }
    if (req.method === "POST") {
      await getVapid(`https://${host}`);
      const devices = await addSub(b.subscription);
      return res.json({ ok: true, devices });
    }
    if (req.method === "DELETE") {
      await removeSub(b.endpoint);
      return res.json({ ok: true });
    }
    return res.status(405).end();
  } catch (e) {
    return res.status(500).json({ error: "Erreur notifications : " + (e && e.message ? e.message : String(e)) });
  }
}
