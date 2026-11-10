// api/_lib/store.js
// Stockage serveur (Upstash Redis via son API web, aucune bibliothèque à installer)
// + connexion Strava gardée côté serveur + clé d'accès de l'app.

import crypto from "crypto";

const KEYS = {
  strava: "mc:strava",     // jetons Strava du propriétaire de l'app
  appKey: "mc:appkey",     // clé secrète partagée avec l'app (en-tête x-app-key)
  settings: "mc:settings", // objectif + préférences, pour les analyses automatiques
  result: "mc:result",     // dernière analyse séance/semaine { body, savedAt }
  bilan: "mc:bilan",       // dernier bilan { body, savedAt }
  last: "mc:last",         // analyse de la dernière séance { body, savedAt }
  status: "mc:status",     // état du coach automatique (dernier événement, dernier traitement)
  verify: "mc:verify",     // jeton de vérification du webhook Strava
};
export { KEYS };

function conf() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}
export const storeEnabled = () => !!conf();

async function cmd(args) {
  const c = conf();
  if (!c) throw new Error("Stockage serveur non configuré");
  const r = await fetch(c.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error("Upstash : " + (data.error || r.status));
  return data.result;
}

export async function getJSON(key) {
  const v = await cmd(["GET", key]);
  if (v == null) return null;
  try { return JSON.parse(v); } catch { return null; }
}
export async function setJSON(key, value) {
  return cmd(["SET", key, JSON.stringify(value)]);
}
// Pose la clé seulement si elle n'existe pas (anti-doublon). true = première fois.
export async function setOnce(key, ttlSeconds) {
  const r = await cmd(["SET", key, "1", "NX", "EX", String(ttlSeconds || 604800)]);
  return r === "OK";
}

// Vérifie l'en-tête x-app-key (comparaison à temps constant)
export async function checkAppKey(req) {
  if (!storeEnabled()) return false;
  const k = req.headers["x-app-key"];
  if (!k || typeof k !== "string") return false;
  const stored = await getJSON(KEYS.appKey).catch(() => null);
  if (!stored || typeof stored !== "string" || stored.length !== k.length) return false;
  return crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(k));
}

// Clé de l'app : créée une seule fois, réutilisée ensuite (plusieurs appareils possibles)
export async function getOrCreateAppKey() {
  const existing = await getJSON(KEYS.appKey);
  if (existing) return existing;
  const key = crypto.randomBytes(24).toString("hex");
  await setJSON(KEYS.appKey, key);
  return key;
}

// Jeton Strava valide côté serveur (rafraîchi si besoin). null si indisponible.
export async function getStravaToken() {
  const t = await getJSON(KEYS.strava);
  if (!t || !t.refresh_token) return null;
  if (Date.now() / 1000 < (t.expires_at || 0) - 300) return t.access_token;
  const r = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: t.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) return null;
  await setJSON(KEYS.strava, {
    ...t,
    access_token: data.access_token,
    refresh_token: data.refresh_token || t.refresh_token,
    expires_at: data.expires_at,
  });
  return data.access_token;
}
