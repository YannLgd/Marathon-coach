// api/_lib/runner.js
// FICHE COUREUR : le seul fichier à modifier après un nouveau test.
// Le dossier _lib n'est pas exposé comme une route : il est seulement importé par le serveur.
// v12 : fiche réorganisée (VMA + FC max, allures seules, zones de FC seules, profil en 3 lignes).
// Les allures s'écrivent 6'00-6'45 (sans guillemet pour les secondes).

/* ============================================================
   PROFIL COUREUR : LA SEULE PARTIE À METTRE À JOUR À LA MAIN
   (après un nouveau test VMA, une course de référence, etc.)
   ============================================================ */
export const RUNNER = {
  updated: "09/11/2026",
  identity: "Yann · 73 kg · Nice · courses visées sur route",

  // 1) VMA et FC max
  vmaKmh: "15,5",            // km/h
  vmaPace: "3'52",           // min/km
  vmaNote: "demi-Cooper du 04/11, probablement un peu sous-estimée (15,7-15,9 possible)",
  hrMax: 177,                // bpm, observée
  hrMaxNote: "réelle estimée 177-182",

  // 2) Allures (min/km), uniquement des allures
  paces: [
    { name: "EF", pace: "6'00-6'45" },
    { name: "SV1", pace: "5'30-6'00" },
    { name: "Marathon", pace: "5'15-5'30" },
    { name: "Semi", pace: "4'55-5'10" },
    { name: "Seuil", pace: "4'40-4'50" },
    { name: "10 km", pace: "4'35-4'40" },
    { name: "5 km", pace: "4'25-4'30" },
    { name: "VMA", pace: "3'52-4'05" },
    { name: "30/30", pace: "3'27-3'40" },
  ],

  // 3) Zones de FC (borne haute EXCLUE en bpm, -1 = pas de borne)
  //    EF < 140 · SV1 140-149 · Entre SV1 et SV2 150-157 · Seuil 158-162 · VO2max 163 et plus
  hrZones: [
    { name: "EF", max: 140 },
    { name: "SV1", max: 150 },
    { name: "Entre SV1 et SV2", max: 158 },
    { name: "Seuil", max: 163 },
    { name: "VO2max", max: -1 },
  ],
  footingHrAlert: 145, // au-dessus en footing = sortie de l'endurance

  // 4) Profil : 3 lignes courtes
  profile: [
    { label: "Force", text: "VMA et 30/30" },
    { label: "À travailler", text: "tenir l'allure sous fatigue, volume en vraie EF" },
    { label: "Attention", text: "footings souvent trop rapides, presque toutes les sorties récentes contiennent de l'intensité" },
  ],

  // Tests et références (détail, affiché derrière un lien)
  tests: [
    "Demi-Cooper (04/11, pluie, vent de face) : ~1560 m en 6 min, soit VMA 15,5 km/h (3'52/km).",
    "5 km (21/10) : 23'15 couru en progressive (4'52 puis 4'31), FC max 167, pas un vrai max. Potentiel 5 km ~22'15 (4'27/km).",
    "30/30 (23/10, 2x8) : 142-147 m par répétition (17-17,6 km/h), légère dégradation en série 2.",
    "FC max observée 177 (09/11), réelle estimée 177-182.",
    "1000 m à VMA : 3'55-4'05 · 400 m : 1'33-1'38. Allure 10 km visée : ~46'.",
  ],
};
