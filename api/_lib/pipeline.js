// api/_lib/pipeline.js
// Traitement d'une nouvelle activité (webhook Strava ou bouton « Analyser ma dernière séance ») :
// analyse détaillée de la séance + nouvelle prochaine séance et programme de la semaine.

import { runAnalysis, runLastSessionAnalysis, getActivity, getLatestActivities, isRunAct } from "./coach.js";
import { KEYS, getJSON, setJSON, getStravaToken } from "./store.js";

const ABBR = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const FULL = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];

function mondayOf(iso) {
  const d = new Date(iso + "T12:00:00Z");
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return d.toISOString().slice(0, 10);
}

// Retrouve la séance qui était prévue ce jour-là dans le dernier programme
function plannedFor(iso, prevBody) {
  if (!iso || !prevBody || !prevBody.result) return "";
  const r = prevBody.result;
  const dIdx = (new Date(iso + "T12:00:00Z").getUTCDay() + 6) % 7;
  // 1) la séance recommandée détaillée, si elle tombait ce jour-là
  if (r.nextDay && r.nextDay === FULL[dIdx] && prevBody.weekStart === mondayOf(iso)) {
    const blocks = Array.isArray(r.structure) ? r.structure.map((b) => `${b.phase} : ${b.detail}${b.pace ? " (" + b.pace + ")" : ""}${b.hr ? " FC " + b.hr : ""}`).join(" ; ") : "";
    return `${r.type || ""}${r.zone ? " · " + r.zone : ""}${r.distance ? " · " + r.distance : ""}${blocks ? " · " + blocks : ""}${r.success ? " · Critère : " + r.success : ""}`;
  }
  // 2) sinon la ligne du programme de la semaine
  if (prevBody.weekStart === mondayOf(iso) && Array.isArray(r.week)) {
    const w = r.week.find((x) => x.day === ABBR[dIdx]);
    // Une entrée déjà marquée faite décrit le réalisé, pas le prévu
    if (w && w.session && !w.done && !/^repos/i.test(w.session)) return `${w.session}${w.detail ? " : " + w.detail : ""}`;
  }
  return "";
}

async function setStatus(patch) {
  try {
    const s = (await getJSON(KEYS.status)) || {};
    await setJSON(KEYS.status, { ...s, ...patch });
  } catch (e) { /* jamais bloquant */ }
}

// options : { activityId (optionnel), source : "webhook" | "manuel" }
export async function runPipeline(options) {
  const t0 = Date.now();
  const source = (options && options.source) || "manuel";
  let activityId = options && options.activityId;
  try {
    const token = await getStravaToken();
    if (!token) throw new Error("Connexion Strava serveur indisponible : reconnecte Strava dans l'app");

    let act = null;
    if (activityId) act = await getActivity(activityId, token);
    else {
      const latest = await getLatestActivities(token, 10);
      act = latest ? latest.find(isRunAct) || null : null;
      if (act) activityId = act.id;
    }
    if (!act) throw new Error("Activité introuvable sur Strava");

    const iso = (act.start_date_local || act.start_date || "").slice(0, 10);
    const settings = (await getJSON(KEYS.settings)) || {};
    const prev = await getJSON(KEYS.result);
    // La séance prévue est figée au premier passage : si l'analyse échoue et qu'on
    // la relance, le programme a déjà été régénéré et ne dit plus ce qui était prévu.
    const plannedKey = `mc:planned:${activityId}`;
    let planned = await getJSON(plannedKey).catch(() => null);
    if (planned == null) {
      planned = plannedFor(iso, prev && prev.body);
      await setJSON(plannedKey, planned).catch(() => {});
    }
    const run = isRunAct(act);

    const [lastOut, nextOut] = await Promise.all([
      run ? runLastSessionAnalysis({ access_token: token, activityId, planned }) : Promise.resolve(null),
      runAnalysis({
        access_token: token,
        mode: "session",
        prefsPrompt: settings.prefsPrompt || "",
        maxSessions: settings.maxSessions || null,
        objective: settings.objective || null,
        comment: "",
        extra: "",
      }),
    ]);

    let last = null, result = null;
    const errors = [];
    if (lastOut) {
      if (lastOut.status === 200) {
        last = { ...lastOut.body, planned, source };
        await setJSON(KEYS.last, { body: last, savedAt: last.savedAt });
      } else errors.push("Dernière séance : " + (lastOut.body && lastOut.body.error));
    }
    if (nextOut.status === 200) {
      result = nextOut.body;
      await setJSON(KEYS.result, { body: result, savedAt: result.savedAt });
    } else errors.push("Programme : " + (nextOut.body && nextOut.body.error));

    await setStatus({
      lastPipeline: {
        at: Date.now(), source, activityId, activityType: act.sport_type || act.type, run,
        ok: errors.length === 0, error: errors.join(" · ") || null, durationS: Math.round((Date.now() - t0) / 1000),
      },
    });
    return { ok: errors.length === 0, last, result, error: errors.join(" · ") || null };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    await setStatus({ lastPipeline: { at: Date.now(), source, activityId: activityId || null, ok: false, error: msg, durationS: Math.round((Date.now() - t0) / 1000) } });
    return { ok: false, last: null, result: null, error: msg };
  }
}
