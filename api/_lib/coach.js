// api/_lib/coach.js
// Cœur du coach : lecture Strava, analyse des flux, prompt, appel Claude.
// Utilisé par api/analyze.js (bouton dans l'app) et, à l'étape 2, par le webhook Strava.
// v8 : extrait de api/analyze.js, la fiche coureur vit dans api/_lib/runner.js

import { RUNNER } from "./runner.js";

const STRAVA_API = "https://www.strava.com/api/v3";
const WEEKDAYS_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const DEEP_WINDOW_DAYS = 14; // fenêtre d'analyse détaillée des courses
const MAX_DEEP_RUNS = 6; // plafond d'appels Strava (2 par course) pour rester sous les limites d'API
const PROFILE_CACHE = new Map(); // cache best effort (instance serveur chaude uniquement)

const zoneRanges = RUNNER.hrZones.map((z, i) => {
  const lo = i === 0 ? null : RUNNER.hrZones[i - 1].max;
  if (lo == null) return { name: z.name, range: `< ${z.max}` };
  if (z.max === -1) return { name: z.name, range: `> ${lo}` };
  return { name: z.name, range: `${lo}-${z.max}` };
});
const zonesTxt = zoneRanges.map((z) => `${z.name} ${z.range}`).join(" · ");

// Fiche coureur renvoyée au front (affichage en lecture seule)
const RUNNER_CARD = {
  updated: RUNNER.updated,
  vma: RUNNER.vma,
  vmaPace: RUNNER.vmaPace,
  hrMax: RUNNER.hrMax,
  zones: zoneRanges,
  paces: RUNNER.paces,
  tests: RUNNER.tests,
  profile: RUNNER.profile,
};

const RUNNER_PROMPT = `\nPROFIL COUREUR (mis à jour le ${RUNNER.updated}, PRIORITAIRE sur toute autre estimation d'allure ou de zone) :
TESTS ET RÉFÉRENCES :
${RUNNER.tests.map((t) => "- " + t).join("\n")}
ALLURES DE RÉFÉRENCE :
${RUNNER.paces.map((t) => "- " + t).join("\n")}
ZONES DE FC : ${zonesTxt}.
PROFIL :
${RUNNER.profile.map((t) => "- " + t).join("\n")}`;

const ANALYSIS_RULES = `\nRÈGLES D'ANALYSE :
- Deux ancrages distincts : endurance et seuils calés sur ce que Yann tient en continu ; fractionné calé sur la VMA et le 30/30. N'applique jamais un % de VMA unique à toutes les zones.
- Au seuil, la FC doit se stabiliser après 3-4 min de bloc. Une FC qui monte en continu signale une séance trop intense ou de la fatigue. Les répétitions longues sont fournies avec la FC à 3-4 min et en fin de bloc pour le vérifier.
- Compare la FC à allure égale d'une séance à l'autre pour détecter la fatigue, en gardant en tête qu'humidité et chaleur la font monter.
- En footing, une FC au-dessus de ${RUNNER.footingHrAlert} = sortie de l'endurance : signale-le dans "why" quand c'est arrivé récemment.
- Répétitions courtes : se fier à la durée ou distance de chaque répétition, pas à l'allure GPS affichée.
- Tiens compte de la charge des 2-3 jours précédents (trail, vélo compris) avant de proposer une séance de qualité.`;

const PROGRAM_RULES = `\nRÈGLES DE PROGRAMMATION :
- Les allures et FC prescrites viennent EXCLUSIVEMENT du profil coureur. Footing, EF et sortie longue de base : 6'00"-6'45"/km, FC < 140, jamais plus vite que 6'00"/km. Récupération : bas de la fourchette EF.
- Récupérations sur blocs au seuil (ex. 3x10') : 2'30"-3' de trot, jamais 5' de marche.
- Structure de semaine : alternance dur / facile, jamais 2 séances de qualité deux jours de suite. 2 séances de qualité par semaine quand la charge le permet (une au seuil ou à allure spécifique, une VMA), une seule en cas de fatigue ou de charge élevée.
- Vu le profil (vitesse supérieure à l'endurance à haute intensité), le travail prioritaire est le seuil, l'allure spécifique et les blocs longs ; la VMA est en entretien.
- Pas de footing "vide" : chaque sortie facile a un rôle explicite (récupération, EF + 6 à 8 lignes droites, EF longue). La sortie longue peut contenir un bloc final à allure marathon quand la fraîcheur le permet.`;

const WRITING_RULES = `\nRÈGLES DE RÉDACTION :
- Vocabulaire unique, celui du profil : EF, SV1, seuil, allure marathon, allure semi, allure 10 km, VMA, sortie longue, récupération, lignes droites. N'utilise jamais "tempo" seul.
- Allures et FC toujours en fourchettes tirées du profil.
- "type" : la zone de la séance (ex. "Seuil", "EF", "VMA", "Allure marathon", "Sortie longue", "Récupération", "Repos").
- "zone" : repère court, ex. "SV2 · FC 158-162" ou "EF · FC < 140".
- "goal" : 1 phrase, ce que la séance travaille et pourquoi maintenant, en s'appuyant sur une séance récente précise (date, donnée mesurée).
- "success" : 1 critère mesurable sur la montre (ex. "FC stable entre 158 et 162 sur les 3 blocs, récup trottinée").
- "structure" : déroulé ordonné. Séance de qualité : au moins 3 blocs (Échauffement, Corps de séance, Retour au calme) ; le corps de séance précise le nombre de répétitions, la durée ou distance de chacune, l'allure, la FC, la nature et la durée des récupérations. Sortie facile : 1 ou 2 blocs (ex. EF puis lignes droites). Repos : tableau vide.
- "why" : 2-3 phrases reliées aux données réelles des séances récentes (ce qui s'est passé, ce que ça implique).
- "weekLogic" : 1 phrase qui donne le fil conducteur de la semaine (ex. "Semaine seuil : on consolide la tenue sous fatigue, VMA en entretien").
- Concis, pas de répétition d'un champ à l'autre.`;

/* ============================================================
   Helpers génériques
   ============================================================ */
async function stravaGet(path, token, timeoutMs) {
  try {
    const r = await fetch(STRAVA_API + path, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs || 7000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

const mmss = (sec) => {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}'${String(s % 60).padStart(2, "0")}`;
};
const paceOf = (mps) => (mps > 0 ? `${mmss(1000 / mps)}"/km` : "?");
const dur = (sec) => {
  const s = Math.round(sec);
  if (s < 120) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m}min${String(r).padStart(2, "0")}` : `${m}min`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h${String(m).padStart(2, "0")}`;
};

/* ============================================================
   Analyse des flux Strava (vitesse, FC, altitude, pente)
   ============================================================ */

// Coût énergétique de la course selon la pente (Minetti), pour ramener l'allure "à plat"
function minetti(g) {
  const x = Math.max(-0.3, Math.min(0.3, g));
  return 155.4 * x ** 5 - 30.4 * x ** 4 - 43.3 * x ** 3 + 46.3 * x ** 2 + 19.5 * x + 3.6;
}

// Rééchantillonne les flux sur une grille de 1 seconde (les pauses restent à null)
function resample1s(streams) {
  const t = streams && streams.time && streams.time.data;
  if (!Array.isArray(t) || t.length < 120) return null;
  const n = Math.min(t[t.length - 1] + 1, 6 * 3600);
  const pick = (key) => {
    const d = streams[key] && streams[key].data;
    if (!Array.isArray(d) || d.length !== t.length) return null;
    const out = new Array(n);
    let j = 0;
    for (let s = 0; s < n; s++) {
      while (j + 1 < t.length && t[j + 1] <= s) j++;
      out[s] = s - t[j] > 10 ? null : d[j];
    }
    return out;
  };
  return {
    n,
    vel: pick("velocity_smooth"),
    hr: pick("heartrate"),
    alt: pick("altitude"),
    grade: pick("grade_smooth"),
  };
}

// Moyenne glissante qui ignore les null
function smooth(arr, w) {
  const n = arr.length;
  const half = Math.floor(w / 2);
  const ps = new Array(n + 1).fill(0);
  const pc = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i++) {
    const v = arr[i];
    ps[i + 1] = ps[i] + (v == null ? 0 : v);
    pc[i + 1] = pc[i] + (v == null ? 0 : 1);
  }
  const out = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (arr[i] == null) continue;
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    const c = pc[b] - pc[a];
    out[i] = c ? (ps[b] - ps[a]) / c : null;
  }
  return out;
}

// Deux groupes d'allures (lent / rapide) sur des valeurs triées
function twoClusters(sorted) {
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  let lo = pct(0.15);
  let hi = pct(0.85);
  for (let it = 0; it < 12; it++) {
    const mid = (lo + hi) / 2;
    let sl = 0, cl = 0, sh = 0, ch = 0;
    for (const v of sorted) {
      if (v < mid) { sl += v; cl++; } else { sh += v; ch++; }
    }
    if (!cl || !ch) break;
    lo = sl / cl;
    hi = sh / ch;
  }
  return { lo, hi };
}

// Découpe la séance en phases rapides (F) et lentes (S) avec hystérésis
function segmentByIntensity(sv, lo, hi) {
  const mid = (lo + hi) / 2;
  const band = 0.1 * (hi - lo);
  const segs = [];
  let cur = null;
  for (let i = 0; i < sv.length; i++) {
    const v = sv[i];
    if (v == null) continue;
    if (!cur) { cur = { type: v >= mid ? "F" : "S", s: i, e: i }; continue; }
    let type = cur.type;
    if (type === "S" && v > mid + band) type = "F";
    else if (type === "F" && v < mid - band) type = "S";
    if (type !== cur.type) { segs.push(cur); cur = { type, s: i, e: i }; }
    else cur.e = i;
  }
  if (cur) segs.push(cur);
  return segs;
}

// Absorbe les phases trop courtes et fusionne les phases adjacentes de même type
function mergeShort(segs, minLen) {
  const out = [];
  for (const sg of segs) {
    const len = sg.e - sg.s + 1;
    const last = out[out.length - 1];
    if (last && (last.type === sg.type || len < minLen)) last.e = sg.e;
    else out.push({ ...sg });
  }
  return out;
}

function segStats(sg, vel, hr, sv, grade) {
  let n = 0, sumV = 0, sumH = 0, nH = 0, maxH = 0, sumG = 0, nG = 0;
  for (let i = sg.s; i <= sg.e; i++) {
    if (sv[i] == null) continue;
    n++;
    sumV += vel[i];
    if (grade && grade[i] != null) { sumG += grade[i]; nG++; }
    const h = hr ? hr[i] : null;
    if (h != null && h > 0) { sumH += h; nH++; if (h > maxH) maxH = h; }
  }

  // FC à 3-4 min puis sur la dernière minute (blocs de 6 min et plus) : stabilisation ou dérive
  let hrEarly = null, hrLate = null;
  const len = sg.e - sg.s + 1;
  if (hr && len >= 360) {
    let eH = 0, eN = 0, lH = 0, lN = 0;
    for (let i = sg.s + 180; i < sg.s + 240 && i <= sg.e; i++) {
      const h = hr[i];
      if (h != null && h > 0) { eH += h; eN++; }
    }
    for (let i = Math.max(sg.s, sg.e - 59); i <= sg.e; i++) {
      const h = hr[i];
      if (h != null && h > 0) { lH += h; lN++; }
    }
    if (eN >= 20 && lN >= 20) { hrEarly = eH / eN; hrLate = lH / lN; }
  }

  return {
    type: sg.type, s: sg.s, e: sg.e, n,
    v: n ? sumV / n : 0,
    hr: nH ? sumH / nH : null,
    hrMax: nH ? maxH : null,
    hrEarly,
    hrLate,
    grade: nG ? sumG / nG : null,
  };
}

// Agrège une liste de phases (vitesse et FC pondérées par la durée)
function agg(list) {
  const n = list.reduce((s, x) => s + x.n, 0);
  if (!n) return null;
  const v = list.reduce((s, x) => s + x.v * x.n, 0) / n;
  const withHr = list.filter((x) => x.hr != null);
  const hw = withHr.reduce((s, x) => s + x.n, 0);
  const hr = hw ? withHr.reduce((s, x) => s + x.hr * x.n, 0) / hw : null;
  return { n, v, hr };
}

// Montées marquées (zigzag sur l'altitude lissée)
function climbStats(alt, thr) {
  const pts = alt.filter((v) => v != null);
  if (pts.length < 60) return { count: 0, gain: 0 };
  let ext = pts[0], startLow = pts[0], dir = 0, count = 0, gain = 0;
  for (const v of pts) {
    if (dir >= 0) {
      if (v > ext) ext = v;
      else if (ext - v >= thr) {
        if (ext - startLow >= thr) { count++; gain += ext - startLow; }
        dir = -1;
        ext = v;
      }
    } else if (v < ext) ext = v;
    else if (v - ext >= thr) { startLow = ext; dir = 1; ext = v; }
  }
  if (dir >= 0 && ext - startLow >= thr) { count++; gain += ext - startLow; }
  return { count, gain };
}

function zoneIndex(hr, zs) {
  for (let i = 0; i < zs.length; i++) {
    if (zs[i].max === -1 || zs[i].max == null || hr < zs[i].max) return i;
  }
  return zs.length - 1;
}

function analyzeStreams(streams, hrZones, elevPerKm) {
  const base = resample1s(streams);
  if (!base || !base.vel) return null;
  const { n, vel, hr, alt, grade } = base;

  // Allure ramenée à plat (GAP) pour ne pas confondre relief et changement de rythme
  const flat = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const v = vel[i];
    if (v == null || v < 0.7) continue;
    const g = grade && grade[i] != null ? grade[i] / 100 : 0;
    flat[i] = v * (minetti(g) / 3.6);
  }
  const sv = smooth(flat, 9);
  const idx = [];
  for (let i = 0; i < n; i++) if (sv[i] != null) idx.push(i);
  if (idx.length < 300) return null;

  const sorted = idx.map((i) => sv[i]).sort((a, b) => a - b);
  const { lo, hi } = twoClusters(sorted);
  const ratio = lo > 0 ? hi / lo : 1;
  const separated = ratio >= 1.2; // écart net entre phases rapides et lentes

  const segs = mergeShort(segmentByIntensity(sv, lo, hi), 12).map((sg) => segStats(sg, vel, hr, sv, grade));
  const fastIdx = [];
  segs.forEach((s, i) => { if (s.type === "F" && s.n >= 20) fastIdx.push(i); });
  const reps = fastIdx.map((i) => segs[i]);
  const fastTotal = reps.reduce((s, r) => s + r.n, 0);
  const first = fastIdx.length ? fastIdx[0] : -1;
  const last = fastIdx.length ? fastIdx[fastIdx.length - 1] : -1;

  const hrTxt = (x) => (x ? ` FC ${Math.round(x)}` : "");
  const driftTxt = (r) => (r.hrEarly && r.hrLate ? ` (FC à 3-4 min ${Math.round(r.hrEarly)}, en fin de bloc ${Math.round(r.hrLate)})` : "");
  const fmtRep = (r, i) => `${i + 1}) ${dur(r.n)} à ${paceOf(r.v)}${hrTxt(r.hr)}${driftTxt(r)}`;
  const lines = [];
  let kind = "regulier";

  const warmCool = () => {
    const warm = first > 0 ? agg(segs.slice(0, first)) : null;
    const cool = last >= 0 && last < segs.length - 1 ? agg(segs.slice(last + 1)) : null;
    if (warm && warm.n >= 180) lines.push(`Avant les phases rapides : ${dur(warm.n)} à ${paceOf(warm.v)}${warm.hr ? ", FC moy " + Math.round(warm.hr) : ""} (échauffement)`);
    if (cool && cool.n >= 180) lines.push(`Après les phases rapides : ${dur(cool.n)} à ${paceOf(cool.v)}${cool.hr ? ", FC moy " + Math.round(cool.hr) : ""} (retour au calme)`);
  };

  if (separated && reps.length >= 3 && fastTotal >= 180) {
    const uphillReps = reps.filter((r) => r.grade != null && r.grade >= 4).length;
    const hillRepeats = uphillReps / reps.length >= 0.7;
    kind = hillRepeats ? "cotes" : "fractionne";
    const durs = reps.map((r) => r.n).sort((a, b) => a - b);
    const med = durs[Math.floor(durs.length / 2)];
    const mean = fastTotal / reps.length;
    const sd = Math.sqrt(reps.reduce((s, r) => s + (r.n - mean) ** 2, 0) / reps.length);
    const cv = Math.round((sd / mean) * 100);
    const a = agg(reps);
    const peak = Math.max(...reps.map((r) => r.hrMax || 0));
    lines.push(`STRUCTURE : ${hillRepeats ? "RÉPÉTITIONS DE CÔTES détectées (efforts rapides en montée, récupération en descente ou à plat)" : "FRACTIONNÉ détecté (alternance nette rapide/lent)"} : ${reps.length} répétitions rapides d'environ ${dur(med)} (de ${dur(durs[0])} à ${dur(durs[durs.length - 1])}, régularité des durées ±${cv}%), allure moyenne des répétitions ${paceOf(a.v)}${a.hr ? ", FC moy " + Math.round(a.hr) : ""}${peak ? ", FC max " + Math.round(peak) : ""}`);
    lines.push(`Répétitions : ${reps.slice(0, 14).map(fmtRep).join(" ; ")}${reps.length > 14 ? " ; ..." : ""}`);
    const recov = segs.filter((s, i) => s.type === "S" && i > first && i < last);
    const rc = agg(recov);
    if (rc) {
      const contrast = a.hr && rc.hr ? `, écart de FC rapide/récup ${Math.round(a.hr - rc.hr)} bpm` : "";
      lines.push(`Récupérations entre répétitions : ${recov.length}, environ ${dur(rc.n / recov.length)} chacune à ${paceOf(rc.v)}${rc.hr ? ", FC moy " + Math.round(rc.hr) : ""}${contrast}`);
    }
    warmCool();
  } else if (separated && reps.length >= 1 && reps.length <= 2 && fastTotal >= 360) {
    kind = "bloc_soutenu";
    lines.push(`STRUCTURE : ${reps.length} bloc(s) rapide(s) continu(s) au milieu de phases plus lentes : ${reps.map(fmtRep).join(" ; ")}`);
    warmCool();
  } else if (separated && reps.length >= 1) {
    kind = "accelerations";
    lines.push(`STRUCTURE : accélérations courtes (${reps.length}, ${dur(fastTotal)} cumulées) dans une séance autrement plus lente : ${reps.slice(0, 10).map(fmtRep).join(" ; ")}`);
  } else {
    const third = Math.max(1, Math.floor(idx.length / 3));
    const avgRaw = (arr) => arr.reduce((s, i) => s + vel[i], 0) / arr.length;
    const vAll = avgRaw(idx);
    const v1 = avgRaw(idx.slice(0, third));
    const v3 = avgRaw(idx.slice(idx.length - third));
    const p10 = sorted[Math.floor(sorted.length * 0.1)];
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    let shape = "allure homogène";
    if (v3 / v1 >= 1.06) shape = `allure progressive (1er tiers ${paceOf(v1)}, dernier tiers ${paceOf(v3)})`;
    else if (v3 / v1 <= 0.94) shape = `fin de séance plus lente (1er tiers ${paceOf(v1)}, dernier tiers ${paceOf(v3)})`;
    lines.push(`STRUCTURE : sans alternance rapide/lent détectée, ${shape}, allure moyenne en mouvement ${paceOf(vAll)}, 80% du temps entre ${paceOf(p90)} et ${paceOf(p10)} (allure équivalente à plat)`);

    // Dérive de FC à allure équivalente (utile en continu uniquement)
    if (hr && idx.length > 1200) {
      const half = Math.floor(idx.length / 2);
      const calc = (arr) => {
        let h = 0, hn = 0, g = 0;
        for (const i of arr) {
          g += sv[i];
          if (hr[i] != null && hr[i] > 0) { h += hr[i]; hn++; }
        }
        return hn > arr.length * 0.5 ? { h: h / hn, g: g / arr.length } : null;
      };
      const a1 = calc(idx.slice(0, half));
      const a2 = calc(idx.slice(half));
      if (a1 && a2) {
        const d = ((a2.h / a2.g) / (a1.h / a1.g) - 1) * 100;
        lines.push(`Dérive FC/allure (2e moitié vs 1re, à allure équivalente) : ${d >= 0 ? "+" : ""}${d.toFixed(1)}%`);
      }
    }

    // Sortie continue : part du temps au-dessus du seuil d'alerte footing
    if (hr) {
      let above = 0, tot = 0;
      for (const i of idx) {
        if (hr[i] != null && hr[i] > 0) { tot++; if (hr[i] > RUNNER.footingHrAlert) above++; }
      }
      if (tot > 300) {
        const p = Math.round((above / tot) * 100);
        if (p >= 10) lines.push(`Temps au-dessus de ${RUNNER.footingHrAlert} bpm : ${p}% (si la sortie se voulait facile, elle est sortie de l'endurance)`);
      }
    }
  }

  // Temps passé dans chaque zone de FC personnelle
  if (hr && Array.isArray(hrZones) && hrZones.length) {
    const cnt = new Array(hrZones.length).fill(0);
    let tot = 0;
    for (let i = 0; i < n; i++) {
      if (sv[i] != null && hr[i] != null && hr[i] > 0) { cnt[zoneIndex(hr[i], hrZones)]++; tot++; }
    }
    if (tot > 120) {
      const parts = cnt
        .map((c, i) => ({ z: hrZones[i].name, p: Math.round((c / tot) * 100) }))
        .filter((x) => x.p >= 1)
        .map((x) => `${x.z} ${x.p}%`);
      lines.push(`Temps en zones de FC personnelles : ${parts.join(" · ")}`);
    }
  }

  // Relief
  if (alt) {
    const c = climbStats(smooth(alt, 9), 15);
    if (c.count >= 1) lines.push(`Relief : ${c.count} montée(s) marquée(s) (15 m ou plus), ${Math.round(c.gain)} m de D+ cumulé sur ces montées`);
  }
  if (kind === "fractionne" && elevPerKm > 30) {
    lines.push(`ATTENTION : terrain très vallonné (${Math.round(elevPerKm)} m de D+ par km). Les alternances peuvent venir du relief (montées marchées) plutôt que d'un vrai fractionné : juge avec la FC et la régularité des répétitions.`);
  }

  return { kind, lines };
}

// Tours définis sur la montre (ignorés si ce sont de simples auto-laps réguliers)
function lapsSummary(laps) {
  if (!Array.isArray(laps) || laps.length < 3 || laps.length > 40) return null;
  const d = laps.map((l) => l.distance || 0);
  const mean = d.reduce((s, x) => s + x, 0) / d.length;
  if (!mean) return null;
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / d.length);
  if (sd / mean < 0.08) return null;
  const items = laps.slice(0, 20).map((l, i) => {
    const dist = l.distance >= 1000 ? `${(l.distance / 1000).toFixed(2)}km` : `${Math.round(l.distance)}m`;
    return `${i + 1}) ${dist} en ${dur(l.moving_time)} à ${paceOf(l.average_speed)}${l.average_heartrate ? " FC" + Math.round(l.average_heartrate) : ""}`;
  });
  return `Tours (laps) définis sur la montre : ${items.join(" ; ")}`;
}

// Allures kilomètre par kilomètre
function splitsSummary(splits) {
  if (!Array.isArray(splits)) return null;
  const sp = splits.filter((s) => s.distance >= 900 && s.average_speed > 0);
  if (sp.length < 3 || sp.length > 30) return null;
  return "Allures au km (FC entre parenthèses) : " + sp
    .map((s) => mmss(1000 / s.average_speed) + (s.average_heartrate ? `(${Math.round(s.average_heartrate)})` : ""))
    .join(" ");
}

function buildRunProfile(a, detail, analysis) {
  const iso = (a.start_date_local || a.start_date || "").slice(0, 10);
  const day = iso ? new Date(iso + "T00:00:00Z") : null;
  const label = day
    ? `${WEEKDAYS_FR[day.getUTCDay()]} ${day.toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" })}`
    : "";
  const head = [
    label,
    `${(a.distance / 1000).toFixed(1)} km en ${dur(a.moving_time)}`,
    a.total_elevation_gain ? `D+${Math.round(a.total_elevation_gain)}m` : "",
    a.average_heartrate ? `FC moy ${Math.round(a.average_heartrate)}` : "",
    a.max_heartrate ? `FC max ${Math.round(a.max_heartrate)}` : "",
    a.suffer_score ? `Effort ${a.suffer_score}` : "",
    detail && typeof detail.perceived_exertion === "number" ? `RPE saisi ${detail.perceived_exertion}/10` : "",
    detail && detail.workout_type === 1 ? "tag Strava : compétition" : "",
  ].filter(Boolean).join(" · ");

  const body = [];
  if (analysis) body.push(...analysis.lines);
  else body.push("Flux détaillés indisponibles pour cette séance : prudence sur l'estimation de l'intensité.");
  const laps = detail ? lapsSummary(detail.laps) : null;
  if (laps) body.push(laps);
  const spl = detail ? splitsSummary(detail.splits_metric) : null;
  if (spl) body.push(spl);

  return {
    iso,
    kind: analysis ? analysis.kind : null,
    text: `- ${head}\n` + body.map((l) => `    ${l}`).join("\n"),
  };
}

// Récupère détail + flux de chaque course récente (en parallèle) et construit son profil
async function deepAnalyzeRuns(runs, token) {
  return Promise.all(runs.map(async (a) => {
    const key = `${a.id}:${a.distance}:${a.moving_time}`;
    if (PROFILE_CACHE.has(key)) return PROFILE_CACHE.get(key);

    const [detail, streams] = await Promise.all([
      stravaGet(`/activities/${a.id}?include_all_efforts=false`, token, 7000),
      stravaGet(`/activities/${a.id}/streams?keys=time,velocity_smooth,heartrate,altitude,grade_smooth&key_by_type=true`, token, 9000),
    ]);
    const elevPerKm = a.distance > 0 ? (a.total_elevation_gain || 0) / (a.distance / 1000) : 0;

    let analysis = null;
    try { analysis = streams ? analyzeStreams(streams, RUNNER.hrZones, elevPerKm) : null; } catch (e) { analysis = null; }

    const profile = buildRunProfile(a, detail, analysis);
    if (detail || analysis) {
      PROFILE_CACHE.set(key, profile);
      if (PROFILE_CACHE.size > 200) PROFILE_CACHE.delete(PROFILE_CACHE.keys().next().value);
    }
    return profile;
  }));
}

/* ============================================================
   Analyse complète (appelable depuis n'importe quelle route)
   ============================================================ */
const reply = (status, body) => ({ status, body });

// params : { access_token, mode, extra, prefsPrompt, comment, objective, maxSessions }
// Retourne { status, body } : le body est exactement ce que l'app reçoit.
export async function runAnalysis(params) {
  try {
    const { access_token, mode, extra, prefsPrompt, comment, objective, maxSessions } = params || {};
    if (!access_token) return reply(400, { error: "No access_token" });

    // ---------- Dates en Europe/Paris (Vercel tourne en UTC) ----------
    const parisNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Paris" }));
    const pad = (n) => String(n).padStart(2, "0");
    const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const todayMidnight = new Date(parisNow.getFullYear(), parisNow.getMonth(), parisNow.getDate());

    // Lundi de la semaine en cours (heure de Nice)
    const dow = parisNow.getDay(); // 0=dim, 1=lun, ...
    const monday = new Date(parisNow);
    monday.setDate(parisNow.getDate() + (dow === 0 ? -6 : 1 - dow));
    const mondayStr = dateStr(monday);

    // Date du jour : la semaine en cours est partielle, le modèle ne doit pas la juger comme une semaine complète
    const todayFr = parisNow.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const daysElapsed = dow === 0 ? 7 : dow;
    const todayPrompt = `\nAUJOURD'HUI : ${todayFr}. La semaine en cours (depuis le lundi ${mondayStr}) est PARTIELLE : ${daysElapsed} jour(s) écoulé(s) sur 7, aujourd'hui inclus. Ne juge JAMAIS son volume, sa charge ou son nombre de séances comme faibles ou insuffisants : évalue volume, régularité et tendance uniquement sur les semaines complètes de l'historique.`;

    // ---------- Objectif générique (éditable, date optionnelle) ----------
    const obj = objective || {};
    const objType = ["trail", "route", "autre"].includes(obj.type) ? obj.type : "route";
    const typeLabelMap = { trail: "trail", route: "course sur route", autre: "objectif" };
    const objTypeLabel = typeLabelMap[objType];
    const distanceKm = Number(obj.distanceKm) > 0 ? Number(obj.distanceKm) : null;
    const objDplus = Number(obj.dplus) > 0 ? Number(obj.dplus) : null;
    const targetMin = Number(obj.targetTime) > 0 ? Number(obj.targetTime) : null;
    const objName = (obj.name || "").trim();
    const timeLbl = targetMin ? `${Math.floor(targetMin / 60)}h${pad(targetMin % 60)}` : null;

    let daysLeft = null, raceFr = null;
    if (obj.date) {
      const race = new Date(obj.date + "T08:00:00");
      if (!isNaN(race.getTime())) {
        const raceMid = new Date(race.getFullYear(), race.getMonth(), race.getDate());
        daysLeft = Math.max(0, Math.round((raceMid - todayMidnight) / 86400000));
        raceFr = race.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
      }
    }

    // Description de l'objectif pour les prompts
    const hasObjective = !!(objName || obj.date || distanceKm || objDplus || targetMin);
    let objDesc;
    if (!hasObjective) {
      objDesc = `OBJECTIF ACTUEL : aucun (entraînement libre, progression continue sur les points faibles du profil)`;
    } else {
      objDesc = `OBJECTIF ACTUEL : ${objTypeLabel}`;
      if (objName) objDesc += ` « ${objName} »`;
      const bits = [];
      if (distanceKm) bits.push(`${distanceKm} km`);
      if (objDplus) bits.push(`D+ ${objDplus} m`);
      if (timeLbl) bits.push(`temps visé ${timeLbl} (indicatif, non contraignant)`);
      if (bits.length) objDesc += ` · ${bits.join(" · ")}`;
      if (daysLeft !== null) objDesc += ` · course le ${raceFr} · ${daysLeft} jours restants`;
      else objDesc += ` · pas de date fixée`;
    }

    // Guidance coaching selon le type
    const trailGuidance = objType === "trail" || objDplus
      ? ` COACHING TRAIL : en trail l'allure en min/km n'est PAS un objectif pertinent (le terrain et le D+ la font varier), raisonne en durée, dénivelé (D+), fréquence cardiaque et RPE. Priorise le travail spécifique de dénivelé, le temps passé debout, la descente et le renforcement. Le vélo et la rando comptent pleinement dans la charge et la base aérobie.`
      : ` Compte le vélo, la rando et la natation dans la charge d'entraînement et la base aérobie.`;

    // Guidance sans date fixée
    const repriseGuidance = daysLeft === null
      ? ` SANS DATE FIXÉE : progression continue, priorité à la régularité, à la vraie endurance fondamentale et aux points faibles du profil.`
      : "";

    // ---------- Strava : 12 semaines d'historique ----------
    const after = Math.floor(Date.now() / 1000) - 84 * 86400;
    const stravaRes = await fetch(
      `${STRAVA_API}/athlete/activities?after=${after}&per_page=100`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    if (!stravaRes.ok) return reply(401, { error: "Strava auth failed" });
    const activitiesRaw = await stravaRes.json();
    if (!Array.isArray(activitiesRaw)) return reply(502, { error: "Réponse Strava invalide" });
    const activities = activitiesRaw.slice().sort((a, b) => new Date(b.start_date) - new Date(a.start_date));

    const isRun = (a) => ["Run", "TrailRun", "VirtualRun"].some((t) => a.type === t || a.sport_type === t);
    const localDay = (a) => (a.start_date_local || a.start_date || "").slice(0, 10);
    const elevOf = (a) => a.total_elevation_gain || 0;
    const effortOf = (a) => a.suffer_score || 0;

    // ---------- Analyse approfondie des courses récentes (laps, splits, flux) ----------
    const cutoffMs = Date.now() - DEEP_WINDOW_DAYS * 86400000;
    const deepRuns = activities
      .filter((a) => isRun(a) && a.moving_time >= 300 && new Date(a.start_date).getTime() >= cutoffMs)
      .slice(0, MAX_DEEP_RUNS);
    const profiles = deepRuns.length ? await deepAnalyzeRuns(deepRuns, access_token) : [];
    const analysedCount = profiles.filter((p) => p.kind).length;

    const runMins = activities.filter(isRun).map((a) => a.moving_time / 60).sort((x, y) => x - y);
    const medianRunMin = runMins.length ? Math.round(runMins[Math.floor(runMins.length / 2)]) : null;

    // Runs déjà effectués cette semaine (lundi = début de semaine, dates locales)
    const runsThisWeek = activities.filter((a) => isRun(a) && localDay(a) >= mondayStr);
    const runsThisWeekCount = runsThisWeek.length;
    const weekDoneKm = Math.round(runsThisWeek.reduce((s, a) => s + a.distance, 0) / 100) / 10;

    // Charge de la semaine en cours (toutes activités)
    const actsThisWeek = activities.filter((a) => localDay(a) >= mondayStr);
    const weekDoneDplus = Math.round(actsThisWeek.reduce((s, a) => s + elevOf(a), 0));
    const weekCharge = Math.round(actsThisWeek.reduce((s, a) => s + effortOf(a), 0));

    // Historique hebdo sur 12 semaines
    const volume = [];
    for (let i = 11; i >= 0; i--) {
      const wStart = new Date(monday);
      wStart.setDate(monday.getDate() - i * 7);
      const wEnd = new Date(wStart);
      wEnd.setDate(wStart.getDate() + 7);
      const s = dateStr(wStart);
      const e = dateStr(wEnd);
      const inWeek = activities.filter((a) => localDay(a) >= s && localDay(a) < e);
      const km = inWeek.filter(isRun).reduce((sum, a) => sum + a.distance, 0);
      const dplus = inWeek.reduce((sum, a) => sum + elevOf(a), 0);
      const charge = inWeek.reduce((sum, a) => sum + effortOf(a), 0);
      volume.push({ start: s, km: Math.round(km / 100) / 10, dplus: Math.round(dplus), charge: Math.round(charge) });
    }

    // ---------- Repères de progressivité (informatifs, SANS plafond ni plancher) ----------
    const lastRun = activities.find(isRun);
    const daysSinceLastRun = lastRun
      ? Math.floor((todayMidnight - new Date(localDay(lastRun) + "T00:00:00")) / 86400000)
      : null;

    const completedWeeks = volume.slice(Math.max(0, volume.length - 5), volume.length - 1);
    const recentAvgKm = completedWeeks.length
      ? Math.round((completedWeeks.reduce((s, w) => s + w.km, 0) / completedWeeks.length) * 10) / 10
      : 0;

    const last28 = Math.floor(Date.now() / 1000) - 28 * 86400;
    const recentLongestRunKm = activities
      .filter((a) => isRun(a) && new Date(a.start_date).getTime() / 1000 >= last28)
      .reduce((max, a) => Math.max(max, a.distance / 1000), 0);
    const recentLongestRunKmRounded = Math.round(recentLongestRunKm * 10) / 10;

    const progressionPrompt = `\nPROGRESSIVITÉ : le programme doit rester progressif et cohérent avec la base actuelle de Yann (moyenne récente ${recentAvgKm} km/semaine sur les 4 dernières semaines complètes, plus longue sortie des 28 derniers jours ${recentLongestRunKmRounded} km, ${daysSinceLastRun === null ? "aucune course récente" : daysSinceLastRun + " jour(s) depuis la dernière course"}). Ce sont des repères, pas des limites : n'applique aucun plafond chiffré ni pourcentage d'augmentation imposé. Ne parle JAMAIS de limites, de plafonds, de règle des +10 % ou de seuils de progressivité dans ta réponse, sauf si Yann le demande ou en cas de signe clair de fatigue ou de blessure dans son commentaire.`;

    const historyPrompt = `\nHISTORIQUE 12 SEMAINES (lundi de la semaine · km course · D+ toutes activités · charge) :\n` +
      volume.map((w, i) => `- ${w.start} · ${w.km} km · D+ ${w.dplus} m · charge ${w.charge}${i === volume.length - 1 ? " (semaine en cours, PARTIELLE)" : ""}`).join("\n");

    const deepPrompt = analysedCount > 0
      ? `\nANALYSE DES SÉANCES : les courses des ${DEEP_WINDOW_DAYS} derniers jours sont fournies avec leur structure RÉELLE mesurée dans les flux Strava (alternance rapide/lent, répétitions, récupérations, FC par phase et dans les blocs, temps en zones personnelles, dérive, relief). Appuie-toi dessus, jamais sur la seule allure moyenne ni sur la distance : en fractionné l'allure moyenne est basse à cause des récupérations alors que la séance est intense. Les titres des activités ne sont pas fournis et ne comptent pas : déduis le type de chaque séance uniquement de ces données. Une séance de qualité pèse lourd dans la charge et appelle de la récupération avant la prochaine séance intense, même si son allure moyenne et sa distance sont modestes. Si une détection semble douteuse (terrain vallonné, répétitions irrégulières, FC sans contraste), dis-le avec prudence au lieu d'affirmer.${medianRunMin ? ` Durée médiane des sorties de Yann sur 12 semaines : ${medianRunMin} min (repère pour reconnaître une sortie longue).` : ""}`
      : `\nANALYSE DES SÉANCES : le détail seconde par seconde n'est pas disponible pour les courses récentes. Ne déduis jamais l'intensité d'une allure moyenne seule : appuie-toi sur la FC moyenne et l'effort relatif, et reste prudent.`;

    const deepBlock = profiles.length
      ? `\n\nANALYSE DÉTAILLÉE DES COURSES RÉCENTES (${DEEP_WINDOW_DAYS} derniers jours) :\n${profiles.map((p) => p.text).join("\n")}`
      : "";

    // ---------- Résumé des activités pour le prompt (toutes disciplines) ----------
    const activitySummary = activities.slice(0, 12).map((a) => {
      const iso = localDay(a);
      const weekday = iso ? WEEKDAYS_FR[new Date(iso + "T00:00:00Z").getUTCDay()] : "";
      const date = new Date(a.start_date).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
      const km = (a.distance / 1000).toFixed(1);
      const pace = isRun(a) && a.average_speed > 0
        ? `allure moy ${Math.floor(1000 / a.average_speed / 60)}'${String(Math.round((1000 / a.average_speed) % 60)).padStart(2, "0")}"/km`
        : "";
      const dp = a.total_elevation_gain ? `D+${Math.round(a.total_elevation_gain)}m` : "";
      const hr = a.average_heartrate ? `FC moy ${Math.round(a.average_heartrate)}bpm` : "";
      const effort = a.suffer_score ? `Effort ${a.suffer_score}` : "";
      return `- ${weekday} ${date} · ${a.type} · ${km}km ${dp} ${pace} ${hr} ${effort}`.trim();
    }).join("\n");

    const modePrompts = {
      session: "Génère la prochaine séance de course optimale.",
      week: "Génère le programme complet de la semaine (7 jours, Lun à Dim).",
      fatigue: "Yann se sent fatigué. Propose une séance allégée ou un repos actif.",
      cross: `Yann vient de faire : ${extra || "un autre sport"}. Adapte sa prochaine séance de course.`,
      bilan: "Fais un bilan honnête et précis de sa situation actuelle.",
    };

    // Runs déjà faits cette semaine : le nombre de séances choisi par Yann est un MAXIMUM
    const maxS = Number(maxSessions) > 0 ? Math.round(Number(maxSessions)) : null;
    const remainingMax = maxS !== null ? Math.max(0, maxS - runsThisWeekCount) : null;
    // Le dimanche, ou quand plus aucune séance n'est à placer cette semaine,
    // le programme bascule sur la semaine SUIVANTE (sinon elle n'est jamais visible).
    const planNext = dow === 0 || remainingMax === 0;
    const nextMonday = new Date(monday);
    nextMonday.setDate(monday.getDate() + 7);
    const nextMondayStr = dateStr(nextMonday);
    const planWeekStart = planNext ? nextMondayStr : mondayStr;

    let runsWeekPrompt = "";
    if (planNext) {
      runsWeekPrompt = `\nSEMAINE À PLANIFIER : la semaine SUIVANTE (du lundi ${nextMondayStr} au dimanche), car ${dow === 0 ? "aujourd'hui est dimanche" : "toutes les séances disponibles de la semaine en cours sont faites"}. week[] décrit cette semaine suivante, entièrement à venir ("done":false partout), avec AU MAXIMUM ${maxS !== null ? maxS : "le nombre des PRÉFÉRENCES"} séance(s) de course, sans séance de remplissage. La semaine en cours (${runsThisWeekCount} séance(s), ${weekDoneKm} km) compte comme charge récente.${dow === 0 && remainingMax !== 0 ? " La séance recommandée (headline, type, nextDay...) peut être aujourd'hui (\"nextDay\":\"Dimanche\") si c'est pertinent, sinon c'est la première séance de la semaine suivante." : " La séance recommandée (headline, type, nextDay...) est la première séance de la semaine suivante."}`;
    } else if (runsThisWeekCount > 0) {
      runsWeekPrompt = `\nSEMAINE EN COURS (depuis lundi ${mondayStr}) : Yann a DÉJÀ effectué ${runsThisWeekCount} séance(s) de course cette semaine, pour ${weekDoneKm} km au total. Dans week[], marque ces jours déjà courus avec "done":true et une "session" décrivant la séance réalisée avec son VRAI type d'après l'analyse détaillée (ex. "Seuil 9km").`;
      if (remainingMax !== null) {
        runsWeekPrompt += ` Il reste AU MAXIMUM ${remainingMax} séance(s) de course à planifier (maximum hebdomadaire ${maxS} moins ${runsThisWeekCount} déjà faite(s)) : planifie le nombre optimal entre 0 et ${remainingMax}, jamais plus, sans séance de remplissage.`;
      } else {
        runsWeekPrompt += ` Sur les jours restants, ne dépasse jamais le maximum hebdomadaire des PRÉFÉRENCES (séances déjà faites comprises) et ne planifie que les séances utiles.`;
      }
    }

    const chargePrompt = `\nCHARGE CETTE SEMAINE (toutes activités confondues) : effort relatif cumulé ${weekCharge}, D+ cumulé ${weekDoneDplus} m. Le vélo, la rando et la natation comptent dans cette charge et dans la base aérobie.`;

    const commentPrompt = comment && comment.trim()
      ? `\nCOMMENTAIRE DE L'ATHLÈTE (à prendre en compte dans l'analyse) : "${comment.trim()}"`
      : "";

    const isBilan = mode === "bilan";

    const confidenceRule = daysLeft !== null
      ? `INDICE DE CONFIANCE ("confidence", entier 0-100) : probabilité que Yann atteigne l'objectif LE JOUR J (${raceFr}, dans ${daysLeft} jours), et non sa capacité à le réaliser aujourd'hui. Projette la progression réaliste d'ici cette date : compare la base actuelle (volume, sortie longue, D+ si objectif trail, niveau mesuré dans le profil coureur, régularité sur 12 semaines) à ce que demande l'objectif, au regard du temps restant. Ne pénalise pas un écart actuel s'il est comblable d'ici la date ; pénalise seulement un écart que ce temps ne permettrait pas de combler à un rythme raisonnable, ou une irrégularité marquée. Applique exactement ce même raisonnement quel que soit le mode demandé : l'indice ne doit varier qu'avec les données Strava, la date ou l'objectif, pas avec le type d'analyse ni avec une fatigue ponctuelle.`
      : `INDICE DE CONFIANCE ("confidence", entier 0-100) : confiance dans la trajectoire de progression, évaluée sur la tendance des 12 dernières semaines. Applique exactement ce même raisonnement quel que soit le mode demandé.`;

    const schema = isBilan
      ? `{"niveau":"string (ex: Intermédiaire, Bon, En reprise)","tendance":"string (ex: En progression, Stable, En baisse)","acquis":["string","string","string"],"atravailler":["string","string","string"],"priorites":["string","string","string"],"verdict":"continuer"|"ameliorer"|"downgrade","verdictDetail":"string (2-3 phrases honnêtes sur l'objectif)","confidence":75}`
      : `{"headline":"string (3 mots max)","type":"string (zone de la séance)","zone":"string (ex: SV2 · FC 158-162)","goal":"string (1 phrase)","success":"string (1 critère mesurable)","structure":[{"phase":"Échauffement","detail":"string","pace":"string","hr":"string"},{"phase":"Corps de séance","detail":"string","pace":"string","hr":"string"},{"phase":"Retour au calme","detail":"string","pace":"string","hr":"string"}],"distance":"string (ex: 12 km)","dplus":"string (ex: 400 m, ou '' si plat)","duration":"string (ex: 1h10)","pace":"string (fourchette du corps de séance)","hr":"string","rpe":"string","tip":"string (1 phrase)","before":"string","during":"string","after":"string","gear":"string","why":"string (2-3 phrases)","weekLogic":"string (1 phrase)","confidence":75,"nextDay":"Lundi","week":[{"day":"Lun","session":"string","detail":"string","color":"#hex","done":false},{"day":"Mar","session":"string","detail":"string","color":"#hex","done":false},{"day":"Mer","session":"string","detail":"string","color":"#hex","done":false},{"day":"Jeu","session":"string","detail":"string","color":"#hex","done":false},{"day":"Ven","session":"string","detail":"string","color":"#hex","done":false},{"day":"Sam","session":"string","detail":"string","color":"#hex","done":false},{"day":"Dim","session":"string","detail":"string","color":"#hex","done":false}]}`;

    const weekRules = ` RÈGLES week[] : contient TOUJOURS EXACTEMENT 7 entrées, dans l'ordre Lun, Mar, Mer, Jeu, Ven, Sam, Dim (semaine ${planNext ? "SUIVANTE" : "en cours"}, du lundi ${planWeekStart} au dimanche). Chaque entrée a "day", "session", "detail", "color", "done". "detail" : UNE ligne qui dit concrètement ce que sera la séance, avec allures et FC du profil (ex. "20' EF, 3x10' seuil 4'40\"-4'50\" FC 158-162, récup 2'30\" trot, 10' retour au calme" ou "10 km EF 6'00\"-6'45\" FC < 140 + 6 lignes droites") ; pour une séance déjà faite, ce qui a été réalisé d'après l'analyse ; "" pour Repos. Format de "session" pour une course : la zone puis la distance, court, ex. "Seuil 10km", "VMA 9km", "EF 10km", "EF + LD 10km", "Récup 6km", "Allure marathon 12km", "SL 18km", "SL 18km dont AM", "Côtes 8km". Jours sans course : "session":"Repos" (ou le cross-training prévu), "color":"#374151", "done":false. "done":true UNIQUEMENT pour les séances déjà réalisées cette semaine. Couleurs : EF/Récup "#60a5fa" · Seuil/Allure spécifique "#fbbf24" · VMA/Fractionné "#f87171" · Côtes "#34d399" · Sortie longue "#a78bfa".`;

    const baseIdentity = `Tu es un coach de course à pied expert (route et trail). Réponds UNIQUEMENT en JSON valide, sans texte avant ou après, sans backticks. Athlète : ${RUNNER.identity} · cycle centré sur la course à pied, avec du vélo, de la natation et de la musculation en complément occasionnel.`;

    const systemPrompt = isBilan
      ? `${baseIdentity}${RUNNER_PROMPT}\n${objDesc}.${todayPrompt}${trailGuidance}${repriseGuidance}${chargePrompt}${historyPrompt}${progressionPrompt}${deepPrompt}${ANALYSIS_RULES}${commentPrompt}\nSois honnête et précis, ne surestime pas le niveau actuel (cela ne change pas la règle de l'indice de confiance ci-dessous). ${confidenceRule} Schéma JSON : ${schema}. "verdict" est exactement l'une des trois valeurs : "continuer", "ameliorer" ou "downgrade". "acquis", "atravailler" et "priorites" sont des tableaux de 3 strings courtes.`
      : `${baseIdentity}${RUNNER_PROMPT}\n${objDesc}.${todayPrompt}${trailGuidance}${repriseGuidance}${chargePrompt}${historyPrompt}${progressionPrompt}${deepPrompt}${ANALYSIS_RULES}${PROGRAM_RULES}${WRITING_RULES}${prefsPrompt || ""}${runsWeekPrompt}${commentPrompt}\n${confidenceRule} Schéma JSON : ${schema} Le champ "nextDay" est le jour de la semaine en français (ex: "Lundi", "Mardi"...) où doit avoir lieu la prochaine séance.${weekRules}`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 3000, // séances détaillées (structure, objectif, critère) : plus de texte qu'avant
        temperature: 0,
        system: systemPrompt,
        // NOTE : pas de prefill assistant. Sonnet 4.6 renvoie une 400 si le
        // dernier message est un message assistant.
        messages: [
          {
            role: "user",
            content: `Activités Strava récentes (toutes disciplines) :\n${activitySummary}${deepBlock}\n\n${modePrompts[mode] || modePrompts.session}`,
          },
        ],
      }),
    });

    if (!claudeRes.ok) {
      const errTxt = await claudeRes.text().catch(() => "");
      return reply(502, { error: `Erreur API Claude (${claudeRes.status})`, detail: errTxt.slice(0, 300) });
    }

    const claudeData = await claudeRes.json();
    const raw = (claudeData.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) return reply(500, { error: "JSON introuvable dans la réponse", raw });

    let result;
    try {
      result = JSON.parse(raw.slice(start, end + 1));
    } catch (e) {
      return reply(500, { error: "Parse error (JSON invalide)", raw });
    }

    result._mode = mode; // permet au front de distinguer bilan vs séance

    return reply(200, {
      savedAt: Date.now(),
      result,
      weekStart: planWeekStart,
      planNext,
      weekDoneKm: planNext ? null : weekDoneKm,
      weekDoneDplus,
      weekCharge,
      volume,
      progression: { daysSinceLastRun, recentAvgKm, recentLongestRunKm: recentLongestRunKmRounded },
      objective: { type: objType, daysLeft },
      runner: RUNNER_CARD, // fiche coureur (lecture seule côté app)
      deep: profiles.map((p) => ({ iso: p.iso, kind: p.kind })), // types détectés (diagnostic)
      activities: activities.slice(0, 5).map((a) => ({
        date: new Date(a.start_date).toLocaleDateString("fr-FR", { day: "numeric", month: "short" }),
        iso: localDay(a),
        run: isRun(a),
        type: a.type,
        km: (a.distance / 1000).toFixed(1),
        elevation: Math.round(a.total_elevation_gain),
        effort: a.suffer_score,
      })),
    });
  } catch (e) {
    return reply(500, { error: "Erreur serveur : " + (e && e.message ? e.message : String(e)) });
  }
}

/* ============================================================
   Analyse détaillée d'UNE séance (dernière course ou activité donnée)
   v9 : écran « Dernière séance » (prévu vs réalisé)
   ============================================================ */
const isRunAct = (a) => ["Run", "TrailRun", "VirtualRun"].some((t) => a && (a.type === t || a.sport_type === t));

async function callClaudeJSON(system, user, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: maxTokens || 2000,
      temperature: 0,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    return { error: `Erreur API Claude (${r.status})`, detail: t.slice(0, 300) };
  }
  const data = await r.json();
  const raw = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  if (s === -1 || e === -1) return { error: "JSON introuvable dans la réponse" };
  try { return { json: JSON.parse(raw.slice(s, e + 1)) }; } catch (err) { return { error: "Parse error (JSON invalide)" }; }
}

// params : { access_token, activityId (optionnel : sinon dernière course), planned (texte de la séance prévue, optionnel) }
export async function runLastSessionAnalysis(params) {
  try {
    const { access_token, activityId, planned } = params || {};
    if (!access_token) return reply(400, { error: "No access_token" });

    const after = Math.floor(Date.now() / 1000) - 21 * 86400;
    const list = await stravaGet(`/athlete/activities?after=${after}&per_page=40`, access_token, 8000);
    if (!Array.isArray(list)) return reply(401, { error: "Strava auth failed" });
    const acts = list.slice().sort((a, b) => new Date(b.start_date) - new Date(a.start_date));

    let target = activityId ? acts.find((a) => String(a.id) === String(activityId)) : acts.find(isRunAct);
    if (!target && activityId) target = await stravaGet(`/activities/${activityId}`, access_token, 8000);
    if (!target) return reply(404, { error: "Aucune course trouvée sur les 21 derniers jours." });
    if (!isRunAct(target)) return reply(422, { error: "La dernière activité n'est pas une course." });

    // Séance analysée + jusqu'à 5 courses précédentes pour comparer la FC à allure égale
    const others = acts.filter((a) => isRunAct(a) && a.id !== target.id && a.moving_time >= 300).slice(0, 5);
    const profiles = await deepAnalyzeRuns([target, ...others], access_token);
    const targetProfile = profiles[0];
    const otherProfiles = profiles.slice(1);

    const system = `Tu es un coach de course à pied expert. Réponds UNIQUEMENT en JSON valide, sans texte avant ou après, sans backticks. Athlète : ${RUNNER.identity}.${RUNNER_PROMPT}${ANALYSIS_RULES}
TÂCHE : analyse détaillée de la séance indiquée, à partir de sa structure RÉELLE mesurée dans les flux Strava (ne te fie ni au titre ni à l'allure moyenne seule).
- Si une séance était prévue, compare précisément prévu et réalisé (allures, FC, durées, récupérations) et donne un verdict honnête : "reussie", "partielle" ou "ratee". Si rien n'était prévu : "libre", et juge la séance pour ce qu'elle est.
- Vérifie la stabilisation de la FC dans les blocs longs, la dérive, le temps hors zone ; en footing, signale toute FC au-dessus de ${RUNNER.footingHrAlert}.
- Compare la FC à allure égale avec les séances récentes fournies pour détecter fatigue ou progrès, en restant prudent (météo inconnue).
- Vocabulaire du profil (EF, SV1, seuil, allure marathon, allure semi, allure 10 km, VMA, sortie longue, récupération). Jamais "tempo" seul. Concis, pas de répétition entre les champs.
Schéma JSON : {"title":"string (type réel de la séance, ex: Seuil 3x10')","verdict":"reussie"|"partielle"|"ratee"|"libre","verdictLabel":"string court (ex: Séance réussie)","summary":"string (2 phrases)","planned":"string (ce qui était prévu, '' si rien)","done":"string (1 ligne, ce qui a été réellement couru)","keyNumbers":[{"label":"string","value":"string"}],"blocks":[{"label":"string (ex: Rép 1, Échauffement)","detail":"string"}],"hr":"string (2 phrases sur la FC)","fatigue":"string (1-2 phrases)","positives":["string"],"improve":["string"],"impact":"string (1-2 phrases : conséquence pour les prochaines séances)"}. "keyNumbers" : 4 à 6 chiffres clés. "blocks" : le déroulé réel, un élément par phase ou répétition (14 maximum, regroupe si plus). "positives" et "improve" : 1 à 3 éléments chacun.`;

    const user = `SÉANCE À ANALYSER :\n${targetProfile.text}\n\nSÉANCE PRÉVUE : ${planned && String(planned).trim() ? planned : "aucune séance prévue connue"}\n\n${otherProfiles.length ? "COURSES RÉCENTES POUR COMPARAISON :\n" + otherProfiles.map((p) => p.text).join("\n") : "Pas d'autre course récente."}`;

    const out = await callClaudeJSON(system, user, 2000);
    if (out.error) return reply(502, { error: out.error, detail: out.detail });

    return reply(200, {
      savedAt: Date.now(),
      activityId: target.id,
      date: (target.start_date_local || target.start_date || "").slice(0, 10),
      distanceKm: Math.round(target.distance / 100) / 10,
      analysis: out.json,
    });
  } catch (e) {
    return reply(500, { error: "Erreur serveur : " + (e && e.message ? e.message : String(e)) });
  }
}

// Utilisé par le pipeline automatique
export async function getActivity(id, token) {
  return stravaGet(`/activities/${id}`, token, 8000);
}
export async function getLatestActivities(token, perPage) {
  const r = await stravaGet(`/athlete/activities?per_page=${perPage || 5}`, token, 8000);
  return Array.isArray(r) ? r : null;
}
export { isRunAct };
