// api/webhook.js
// Webhook Strava : Strava appelle cette adresse à chaque nouvelle activité.
// GET  : validation de l'abonnement (une seule fois, à l'activation).
// POST : événement. On répond tout de suite (Strava exige moins de 2 s),
//        puis l'analyse continue en arrière-plan grâce à waitUntil.

import { waitUntil } from "@vercel/functions";
import { KEYS, getJSON, setJSON, setOnce } from "./_lib/store.js";
import { runPipeline } from "./_lib/pipeline.js";

export default async function handler(req, res) {
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    const expected = await getJSON(KEYS.verify).catch(() => null);
    if (mode === "subscribe" && expected && token === expected) {
      return res.status(200).json({ "hub.challenge": challenge });
    }
    return res.status(403).json({ error: "Vérification refusée" });
  }

  if (req.method !== "POST") return res.status(405).end();

  const ev = req.body || {};
  try {
    const owner = await getJSON(KEYS.strava);
    const isOwner = owner && String(owner.athlete_id) === String(ev.owner_id);

    if (isOwner && ev.object_type === "activity" && ev.aspect_type === "create" && ev.object_id) {
      const status = (await getJSON(KEYS.status)) || {};
      await setJSON(KEYS.status, { ...status, lastEvent: { at: Date.now(), activityId: ev.object_id, aspect: ev.aspect_type } });
      // Anti-doublon : Strava peut renvoyer le même événement
      const first = await setOnce(`mc:seen:${ev.object_id}`, 7 * 86400);
      if (first) waitUntil(runPipeline({ activityId: ev.object_id, source: "webhook" }));
    }

    if (isOwner && ev.object_type === "athlete" && ev.updates && ev.updates.authorized === "false") {
      const status = (await getJSON(KEYS.status)) || {};
      await setJSON(KEYS.status, { ...status, deauthorizedAt: Date.now() });
    }
  } catch (e) {
    // Toujours répondre 200 à Strava, sinon il réessaie
  }
  return res.status(200).json({ ok: true });
}
