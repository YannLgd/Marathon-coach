// api/_lib/runner.js
// FICHE COUREUR : le seul fichier à modifier après un nouveau test.
// Le dossier _lib n'est pas exposé comme une route : il est seulement importé par le serveur.

/* ============================================================
   PROFIL COUREUR : LA SEULE PARTIE À METTRE À JOUR À LA MAIN
   (après un nouveau test VMA, une course de référence, etc.)
   ============================================================ */
export const RUNNER = {
  updated: "09/11/2026",
  identity: "Yann · 73 kg · Nice · courses visées sur route",
  vma: "15,5 km/h",
  vmaPace: `3'52"/km`,
  hrMax: "177 observée (réelle estimée 177-182)",
  // Zones de FC personnelles (borne haute en bpm, -1 = pas de borne)
  hrZones: [
    { name: "EF", max: 140 },
    { name: "SV1", max: 150 },
    { name: "Entre SV1 et SV2", max: 158 },
    { name: "Seuil", max: 163 },
    { name: "VO2max", max: -1 },
  ],
  footingHrAlert: 145, // au-dessus en footing = sortie de l'endurance
  tests: [
    `Demi-Cooper (04/11, pluie, vent de face) : ~1560 m en 6 min, soit VMA 15,5 km/h (3'52"/km). Probablement un peu sous-estimée (15,7-15,9 possible). Valeur de travail : 15,5.`,
    `5 km (21/10) : 23'15" couru en progressive (4'52" puis 4'31"), FC max 167, pas un vrai max. Potentiel 5 km estimé ~22'15" (4'27"/km).`,
    `30/30 (23/10, 2x8) : 142-147 m par répétition (17-17,6 km/h), légère dégradation en série 2.`,
    `FC max observée 177 (09/11), FC max réelle estimée 177-182.`,
  ],
  paces: [
    `Endurance fondamentale (EF) : 6'00"-6'45"/km, FC < 140`,
    `SV1 : 5'30"-6'00"/km, FC 140-150`,
    `Allure marathon : 5'15"-5'30"/km`,
    `Allure semi : 4'55"-5'10"/km`,
    `Seuil (SV2) : 4'40"-4'50"/km, FC 158-162 au seuil réel`,
    `Allure 10 km : 4'35"-4'40"/km (objectif ~46')`,
    `Allure 5 km : 4'25"-4'30"/km`,
    `VMA / VO2max : 3'52"-4'05"/km (1000 m en 3'55"-4'05", 400 m en 1'33"-1'38")`,
    `30/30 : 3'27"-3'40"/km (16,3-17,4 km/h)`,
  ],
  profile: [
    `Profil plutôt vitesse : bonne VMA et bon 30/30, mais endurance à haute intensité plus faible (écart VMA / 5 km important).`,
    `Points faibles prioritaires : tenir une allure soutenue avec la fatigue, et le volume en vraie endurance fondamentale.`,
    `Allures très régulières quand les zones sont respectées.`,
    `Tendance : ses footings glissent souvent vers une intensité de tempo, et presque toutes ses sorties récentes contiennent de l'intensité.`,
  ],
};
