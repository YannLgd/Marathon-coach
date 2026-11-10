// api/_lib/notify.js
// Notifications push (Web Push). Les clés VAPID sont créées automatiquement
// au premier besoin et gardées dans Upstash : aucune variable à configurer.

import webpush from "web-push";
import { getJSON, setJSON } from "./store.js";

const VAPID = "mc:vapid";
const SUBS = "mc:push:subs";

// subject : adresse du site, exigée par les services de push (Apple compris)
export async function getVapid(subject) {
  let v = await getJSON(VAPID);
  if (!v || !v.publicKey || !v.privateKey) {
    const k = webpush.generateVAPIDKeys();
    v = { publicKey: k.publicKey, privateKey: k.privateKey, subject: subject || "https://marathon-coach-five.vercel.app" };
    await setJSON(VAPID, v);
  }
  return v;
}

export async function listSubs() {
  const s = await getJSON(SUBS);
  return Array.isArray(s) ? s : [];
}

export async function addSub(sub) {
  if (!sub || !sub.endpoint) throw new Error("Abonnement invalide");
  const subs = (await listSubs()).filter((s) => s.endpoint !== sub.endpoint);
  subs.push({ ...sub, addedAt: Date.now() });
  await setJSON(SUBS, subs.slice(-5)); // 5 appareils maximum
  return subs.length;
}

export async function removeSub(endpoint) {
  const subs = (await listSubs()).filter((s) => s.endpoint !== endpoint);
  await setJSON(SUBS, subs);
}

// payload : { title, body, url, tag }. Retourne le nombre de notifications envoyées.
export async function sendPush(payload) {
  const subs = await listSubs();
  if (!subs.length) return 0;
  const v = await getVapid();
  webpush.setVapidDetails(v.subject, v.publicKey, v.privateKey);
  let sent = 0;
  const keep = [];
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: s.keys },
        JSON.stringify(payload),
        { TTL: 6 * 3600, urgency: "normal" }
      );
      sent++;
      keep.push(s);
    } catch (e) {
      // 404 / 410 : abonnement expiré ou révoqué, on le retire
      if (!(e && (e.statusCode === 404 || e.statusCode === 410))) keep.push(s);
    }
  }
  if (keep.length !== subs.length) await setJSON(SUBS, keep);
  return sent;
}
