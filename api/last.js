// api/last.js
// Bouton « Analyser ma dernière séance » : même traitement que le webhook,
// mais lancé à la main et en attendant le résultat. Protégé par la clé de l'app.

import { storeEnabled, checkAppKey } from "./_lib/store.js";
import { runPipeline } from "./_lib/pipeline.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  if (!storeEnabled()) return res.status(503).json({ error: "Stockage serveur non configuré" });
  let ok = false;
  try { ok = await checkAppKey(req); } catch (e) { ok = false; }
  if (!ok) return res.status(401).json({ error: "Clé de l'app invalide : déconnecte puis reconnecte Strava." });

  const out = await runPipeline({ source: "manuel" });
  if (!out.last && !out.result) return res.status(500).json({ error: out.error || "Analyse impossible" });
  return res.json(out);
}
