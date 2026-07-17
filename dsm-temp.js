/*
  Fichier  : dsm-temp.js
  Date     : 2026-07-15
  Version  : 2.4 — AUDIT DES CONSTANTES : TEMP_A_SAISON 15→9,5 °C (amplitude
             annuelle mesurée aux normales 1991-2020, ~45°N) et TEMP_JOUR_ETE
             172→203 (pic thermique réel ~22 juillet, retard d'inertie sur le
             solstice). TEMP_A_DIURNE 12 conservé (Tmax−Tmin plein soleil,
             plage mesurée). Valeurs INTÉRIM documentées : remplacement prévu
             par le modèle de bilan d'énergie saisonnier (EBM) piloté par
             l'insolation dsm-astro/insol. Effet attendu : ELA −800 à −1000 m.
  Version  : 2.3 — tempInstant : terme diurne PROPORTIONNEL à l'ensoleillement
             (estEnSoleil accepte 0..1, pas seulement booléen). Permet au
             glacier de piloter le diurne par la carte d'insolation du jour.
  v2.2     — Convention t_ka NÉGATIF = passé (LGM = -20, présent = 0).
             Tables paléo retournées (t croissant -20→0) ; clamp spline et
             tests internes alignés. anomaliePaleo(-20,·) = creux LGM.
  v2.1     — tempInstant(idx, heure, jour, t_ka, rise, set, estEnSoleil)
             Température instantanée au pas de 15 min. Composante saisonnière
             (±15°C) + composante diurne (12°C si soleil direct, 0 à l'ombre).
             Physique montagne : convection > conduction, neige/glace isolante.
  v2.0     — Modèle paléo planétaire (latitude × époque).
             • Tables corrigées d'après Figure 3 (forages GRIP 70°N /
               Vostok 78°S) : Bølling-Allerød + rechute Younger Dryas
               (la série n'est PLUS monotone).
             • Axe ÉPOQUE : spline cubique MONOTONE (Fritsch-Carlson) au
               lieu de l'interpolation linéaire à segments cassés — courbe
               lisse qui suit les bosses sans dépasser les points.
             • Axe LATITUDE : fondu continu pôle→équateur. L'anomalie est
               PLEINE au site de forage, NULLE à l'équateur, par
               |lat|/|lat_forage| clampé à 1. Hémisphère par signe de lat.
             • Nouvelle RÉFÉRENCE : 0 ka = 0 °C (présent), anomalies
               relatives à AUJOURD'HUI (cohérent avec TEMP_T0_MER = T
               actuelle du site). L'ancien +2 °C anthropique est retiré.
             v1.1 : suppression hooks redondants (dsm.html 3.12 recalcule
                    déjà via ctrlIncrementer & applyPct).
  Rôle     : Carte de température annuelle moyenne par pixel (°C).
             Combine gradient thermique ISA vertical et anomalie
             paléoclimatique interpolée en latitude ET en époque.
  Modèle   : T(z, t_ka) = TEMP_T0_MER + anomaliePaleo(t_ka, lat) − TEMP_LAPSE/1000 · z
  Sources  : gradient ISA 6,5 °C/km (OACI standard) ;
             forages GRIP (Groenland 70°N) & Vostok (Antarctique 78°S),
             Figure 3 — anomalies vs présent, 0–20 ka BP.
  API      : anomaliePaleo(t_ka, latDeg) → Number
             tempPixel(idx, t_ka)        → Number  (moyenne annuelle)
             tempInstant(idx, heure, jour, t_ka, rise, set, estEnSoleil) → Number
             tempCarte(t_ka)             → Float32Array[1024²]
             isothermeZero(t_ka)         → Number (altitude en m)
  Dépend   : dsm.html (GEO, ombreElev1024, OMBRE_DIM, render, coordEl,
                        ctrlAnnee, ctrlTka, INSOL_W_PAR_H)
             dsm-ombre.js (ombreElev1024, OMBRE_DIM exposés)
  Ordre    : charger EN DERNIER (après dsm-insol.js)
  Auteur   : Eric Perret
*/
"use strict";

// ════════════════════════════════════════════════════════════════
// CONSTANTES RÉGLABLES
// ════════════════════════════════════════════════════════════════

// Gradient thermique ISA : 6,5 °C par 1000 m
const TEMP_LAPSE = 6.5;   // °C / 1000 m

// Température de référence au niveau de la mer pour l'époque actuelle (°C).
// Formule par défaut : 27 − 0,4·(|lat|−15) clampée [−5, 35].
// Basée sur une approximation zonale grossière — l'utilisateur ajuste
// TEMP_T0_MER à la valeur mesurée sur son site.
// Exemple : Alpes centrales (lat ≈ 46°) → 27 − 0,4·(46−15) = 14,6 °C ≈ 15 °C.
// La constante est initialisée dans tempInit() dès que GEO est disponible.
var TEMP_T0_MER = 15.0;   // °C — sera recalculé au premier affichage

// ════════════════════════════════════════════════════════════════
// TABLES PALÉOCLIMATIQUES — anomalie au SITE DE FORAGE (°C vs présent)
// Source : Figure 3 — GRIP (Groenland 70°N) & Vostok (Antarctique 78°S).
// t_ka = 0 → présent (anomalie 0) ; t_ka = -20 → dernier maximum glaciaire.
// La série n'est PAS monotone : réchauffement Bølling-Allerød (~13 ka)
// puis rechute Younger Dryas (~12-11 ka) avant l'Holocène.
// Tables triées par t_ka CROISSANT (-20 → 0) pour la spline.
// ════════════════════════════════════════════════════════════════

// Latitudes des forages = points où l'anomalie est PLEINE (fondu = 1).
const TEMP_LAT_NORD =  70.0;   // GRIP Summit (Groenland)
const TEMP_LAT_SUD  =  78.0;   // Vostok (Antarctique) — |lat|

// Hémisphère NORD (GRIP) — anomalie °C au forage
//   0 ka :   0,0   présent (référence)
//   5 ka :  −1,0   Holocène moyen
//  10 ka :  −3,0   fin Younger Dryas
//  11 ka :  −7,4   minimum Younger Dryas (rechute froide)
//  12 ka :  −8,0   Younger Dryas
//  13 ka :  −3,4   Bølling-Allerød (réchauffement transitoire)
//  20 ka : −20,0   dernier maximum glaciaire
const TEMP_PALEO_NORD = [
  { t: -20.0, dT: -20.0 },
  { t: -13.0, dT:  -3.4 },
  { t: -12.0, dT:  -8.0 },
  { t: -11.0, dT:  -7.4 },
  { t: -10.0, dT:  -3.0 },
  { t:  -5.0, dT:  -1.0 },
  { t:   0.0, dT:   0.0 },
];

// Hémisphère SUD (Vostok) — anomalie °C au forage. Amplitude moindre,
// oscillation YD atténuée (signature australe plus douce).
//   0 ka :   0,0
//   5 ka :  −0,5
//  10 ka :  −3,0
//  11 ka :  −4,0
//  12 ka :  −3,8
//  13 ka :  −2,7
//  20 ka :  −9,8
const TEMP_PALEO_SUD = [
  { t: -20.0, dT:  -9.8 },
  { t: -13.0, dT:  -2.7 },
  { t: -12.0, dT:  -3.8 },
  { t: -11.0, dT:  -4.0 },
  { t: -10.0, dT:  -3.0 },
  { t:  -5.0, dT:  -0.5 },
  { t:   0.0, dT:   0.0 },
];

// ════════════════════════════════════════════════════════════════
// SPLINE CUBIQUE MONOTONE (Fritsch-Carlson)
// « Tangentes calligraphiques » : courbe lisse C¹ qui passe par tous les
// points SANS jamais dépasser leur enveloppe (pas de faux pic/creux dans
// les coins, contrairement à une spline naturelle). Tangentes pré-calculées
// une fois par table, puis évaluation Hermite par segment.
// ════════════════════════════════════════════════════════════════
function _splinePentes(table) {
  var n = table.length;
  var d = new Array(n - 1);   // pentes des segments
  var m = new Array(n);       // tangentes aux nœuds
  for (var i = 0; i < n - 1; i++) {
    d[i] = (table[i + 1].dT - table[i].dT) / (table[i + 1].t - table[i].t);
  }
  m[0]     = d[0];
  m[n - 1] = d[n - 2];
  for (var k = 1; k < n - 1; k++) {
    // Extremum local → tangente nulle (garantit la monotonie par morceaux)
    m[k] = (d[k - 1] * d[k] <= 0) ? 0 : (d[k - 1] + d[k]) / 2;
  }
  // Limiteur Fritsch-Carlson : borne les tangentes pour rester monotone
  for (var j = 0; j < n - 1; j++) {
    if (d[j] === 0) { m[j] = 0; m[j + 1] = 0; continue; }
    var a = m[j] / d[j], b = m[j + 1] / d[j];
    var s = a * a + b * b;
    if (s > 9) {
      var tau = 3 / Math.sqrt(s);
      m[j]     = tau * a * d[j];
      m[j + 1] = tau * b * d[j];
    }
  }
  return m;
}

// Tangentes pré-calculées (une seule fois au chargement)
const _PENTES_NORD = _splinePentes(TEMP_PALEO_NORD);
const _PENTES_SUD  = _splinePentes(TEMP_PALEO_SUD);

// Évaluation Hermite d'une table {t, dT} + ses pentes m, à l'abscisse t_ka.
function _splineEval(table, m, t_ka) {
  var n = table.length;
  if (t_ka <= table[0].t)     return table[0].dT;        // clamp présent
  if (t_ka >= table[n - 1].t) return table[n - 1].dT;    // clamp LGM
  // Segment contenant t_ka (tables croissantes en t)
  var i = 0;
  while (i < n - 1 && t_ka > table[i + 1].t) i++;
  var h  = table[i + 1].t - table[i].t;
  var s  = (t_ka - table[i].t) / h;     // s ∈ [0,1]
  var s2 = s * s, s3 = s2 * s;
  // Bases d'Hermite
  var h00 =  2 * s3 - 3 * s2 + 1;
  var h10 =      s3 - 2 * s2 + s;
  var h01 = -2 * s3 + 3 * s2;
  var h11 =      s3 -     s2;
  return h00 * table[i].dT + h10 * h * m[i]
       + h01 * table[i + 1].dT + h11 * h * m[i + 1];
}

// ════════════════════════════════════════════════════════════════
// API CALCUL TEMPÉRATURE
// ════════════════════════════════════════════════════════════════

// Anomalie paléo (°C) à une époque et une latitude quelconques.
// • ÉPOQUE : spline cubique monotone (Fritsch-Carlson) sur chaque table.
// • LATITUDE : trois droites raccordées.
//   Droite 1 (lat ≥ 45°N) : forage GRIP (70°N) → 0 à l'équateur.
//              anomalie = anomNord × lat/70, clampée au forage au-delà.
//   Droite 2 (lat ≤ −45°S) : forage Vostok (−78°S) → 0 à l'équateur.
//              anomalie = anomSud × |lat|/78, clampée au forage au-delà.
//   Droite 3 (−45° < lat < 45°) : interpolation linéaire entre la valeur
//              à 45°N (droite 1) et la valeur à −45°S (droite 2).
//              La droite est inclinée (hémisphère sud se réchauffe plus vite)
//              → l'équateur n'est pas au milieu arithmétique.
// t_ka > 0 (futur) → présent ; t_ka < -20 → LGM (clamps dans _splineEval).
const TEMP_LAT_PIVOT = 45.0;   // latitude de raccord droites 1-2 / droite 3
function anomaliePaleo(t_ka, latDeg) {
  var anomNord = _splineEval(TEMP_PALEO_NORD, _PENTES_NORD, t_ka);
  var anomSud  = _splineEval(TEMP_PALEO_SUD,  _PENTES_SUD,  t_ka);
  // Valeurs aux pivots (raccords)
  var v45N = anomNord * TEMP_LAT_PIVOT / TEMP_LAT_NORD;   // droite 1 à 45°N
  var v45S = anomSud  * TEMP_LAT_PIVOT / TEMP_LAT_SUD;    // droite 2 à 45°S
  if (latDeg >= TEMP_LAT_PIVOT) {
    // Droite 1 : 0 (équateur) → anomNord (forage), clamp au-delà du forage
    return anomNord * Math.min(latDeg, TEMP_LAT_NORD) / TEMP_LAT_NORD;
  }
  if (latDeg <= -TEMP_LAT_PIVOT) {
    // Droite 2 : 0 (équateur) → anomSud (forage), clamp au-delà du forage
    return anomSud * Math.min(-latDeg, TEMP_LAT_SUD) / TEMP_LAT_SUD;
  }
  // Droite 3 : entre (45°N, v45N) et (−45°S, v45S)
  var f = (TEMP_LAT_PIVOT - latDeg) / (2 * TEMP_LAT_PIVOT);   // 0→45N, 1→−45S
  return v45N + f * (v45S - v45N);
}

// Température annuelle moyenne d'un pixel de la grille OMBRE_DIM (°C).
// z lu dans ombreElev1024 ; mer (z ≤ 0,5) → T_mer seule (pas de gradient).
function tempPixel(idx, t_ka) {
  if (!ombreElev1024 || !GEO) return 0;
  var z       = ombreElev1024[idx];
  var latCentre = (GEO.latMax + GEO.latMin) / 2;
  var anom    = anomaliePaleo(t_ka, latCentre);
  var tMer    = TEMP_T0_MER + anom;
  if (z <= 0.5) return tMer;                    // pixel mer
  return tMer - (TEMP_LAPSE / 1000) * z;
}

// Carte complète OMBRE_DIM² (Float32Array, °C) — boucle simple, < 10 ms.
// Pas de cache : la future sim glacier appelle à chaque pas de 100 ans.
function tempCarte(t_ka) {
  var g    = OMBRE_DIM;
  var n    = g * g;
  var out  = new Float32Array(n);
  if (!ombreElev1024 || !GEO) return out;
  var latCentre = (GEO.latMax + GEO.latMin) / 2;
  var anom = anomaliePaleo(t_ka, latCentre);
  var tMer = TEMP_T0_MER + anom;
  var l    = TEMP_LAPSE / 1000;
  for (var i = 0; i < n; i++) {
    var z = ombreElev1024[i];
    out[i] = (z <= 0.5) ? tMer : tMer - l * z;
  }
  return out;
}

// Altitude de l'isotherme 0 °C (m) pour une époque.
// z₀ = (T_mer + anomalie) · 1000 / TEMP_LAPSE
// Utile pour la sim glacier : le glacier ne peut exister en dessous.
function isothermeZero(t_ka) {
  if (!GEO) return 0;
  var latCentre = (GEO.latMax + GEO.latMin) / 2;
  var anom = anomaliePaleo(t_ka, latCentre);
  var tMer = TEMP_T0_MER + anom;
  return (tMer * 1000) / TEMP_LAPSE;
}

// ════════════════════════════════════════════════════════════════
// TEMPÉRATURE INSTANTANÉE — pas de 15 minutes
// ════════════════════════════════════════════════════════════════
// T(pixel, heure, jour, t_ka, estEnSoleil)
//
// T = T_base(z, t_ka)
//   + A_SAISON × cos(2π(jour−172)/365)          pic été, creux hiver
//   + (estEnSoleil ? A_DIURNE × sin(π×(h−rise)/(set−rise)) : 0)
//
// Physique :
//   — Ombre terrain → pas de réchauffement radiatif (convection >> conduction)
//   — Neige/glace : isolant quasi-parfait, fonte uniquement par surface exposée
//   — Amplitude diurne 12°C (montagne : convection forte, refroidissement rapide)
//   — Amplitude annuelle 15°C (pic solstice été j=172, creux j=355)
//
// Paramètres :
//   idx         : indice pixel dans ombreElev1024
//   heure       : heure UTC décimale (ex. 13.5 = 13h30)
//   jour        : jour julien 1-365
//   t_ka        : époque en ka (0=présent, 20=LGM)
//   rise, set   : lever/coucher soleil UTC décimaux pour ce jour
//   estEnSoleil : booléen — masque ombre terrain à cet instant
//
// Retourne : température en °C à cet instant pour ce pixel

const TEMP_A_SAISON = 9.5;    // °C — amplitude annuelle MESURÉE (normales 1991-2020,
                              // stations 45°N : Lyon 9,7 / Chambéry 9,3 / Munich 9,6).
                              // INTÉRIM : sera remplacée par l'EBM saisonnier (TODO 2).
const TEMP_A_DIURNE = 12.0;   // °C — écart Tmax−Tmin plein soleil (la base C joue le rôle
                              // du minimum nocturne). Plage mesurée montagne ciel clair
                              // 10-12 °C : conservé, à valider par tempVerif() (TODO 2).
const TEMP_JOUR_ETE = 203;    // jour julien du pic thermique (~22 juillet) : retard de
                              // ~30 j sur le solstice par inertie thermique (mesuré).
                              // INTÉRIM : le déphasage émergera de l'EBM (TODO 2).

function tempInstant(idx, heure, jour, t_ka, rise, set, estEnSoleil) {
  if (!ombreElev1024 || !GEO) return 0;

  // T de base : gradient ISA + anomalie paléo (température annuelle moyenne)
  var z         = ombreElev1024[idx];
  var latCentre = (GEO.latMax + GEO.latMin) / 2;
  var anom      = anomaliePaleo(t_ka, latCentre);
  var tMer      = TEMP_T0_MER + anom;
  var tBase     = (z <= 0.5) ? tMer : tMer - (TEMP_LAPSE / 1000) * z;

  // Composante saisonnière : cosinus centré sur le solstice d'été
  var tSaison = TEMP_A_SAISON * Math.cos(2 * Math.PI * (jour - TEMP_JOUR_ETE) / 365);

  // Composante diurne : sinus lever→coucher, AMPLITUDE pilotée par l'ensoleillement.
  // estEnSoleil : booléen (true→1, false→0) OU pondération 0..1 (insolation locale
  // du jour, ombre déjà incluse). Un versant ombré → diurne nul ; plein sud → max.
  var wSun = +estEnSoleil;                       // bool→{0,1} ; nombre→0..1
  var tDiurne = 0;
  if (wSun > 0 && set > rise && heure >= rise && heure <= set) {
    var phase = (heure - rise) / (set - rise);   // 0→1 lever→coucher
    tDiurne = TEMP_A_DIURNE * Math.sin(Math.PI * phase) * wSun;
  }

  return tBase + tSaison + tDiurne;
}

// ════════════════════════════════════════════════════════════════
// ÉTAT VUE TEMPÉRATURE
// ════════════════════════════════════════════════════════════════
var tempActive   = false;   // vue temp affichée
var tempImgData  = null;    // ImageData cachée (redessins, resize, render)
var tempOsc      = null;    // OffscreenCanvas colorisé — source du zoom/pan
var tempMap      = null;    // Float32Array courante
var tempMn       = 0;       // min terre (°C)
var tempMx       = 1;       // max terre (°C)
var tempTestsFaits = false; // tests de validation exécutés une fois

// ── LUT froid→chaud centrée sur 0 °C ─────────────────────────────
// bleu (froid) → blanc (0 °C) → rouge (chaud)
// Indice 128 = 0 °C (milieu exact de la barre).
var tempLUT = null;

function _makeTempLUT() {
  // Stops : [position 0-1, R, G, B]
  var stops = [
    [0.00,  20,  60, 180],  // bleu froid
    [0.35,  80, 140, 220],  // bleu clair
    [0.50, 240, 240, 240],  // blanc ≈ 0 °C
    [0.65, 240, 140,  60],  // orange
    [1.00, 180,  20,  20],  // rouge chaud
  ];
  var lut = new Uint8Array(256 * 3);
  for (var i = 0; i < 256; i++) {
    var t = i / 255;
    var s0 = stops[0], s1 = stops[1];
    for (var k = 0; k < stops.length - 1; k++) {
      if (t >= stops[k][0] && t <= stops[k + 1][0]) {
        s0 = stops[k]; s1 = stops[k + 1]; break;
      }
    }
    var f = (s1[0] === s0[0]) ? 0 : (t - s0[0]) / (s1[0] - s0[0]);
    lut[i * 3]     = Math.round(s0[1] + f * (s1[1] - s0[1]));
    lut[i * 3 + 1] = Math.round(s0[2] + f * (s1[2] - s0[2]));
    lut[i * 3 + 2] = Math.round(s0[3] + f * (s1[3] - s0[3]));
  }
  tempLUT = lut;
}

// ════════════════════════════════════════════════════════════════
// ACTIVATION btn-temp — synchronisée avec btn-insol (même condition :
// ombreElev1024 disponible après passe 1 de dsm-ombre.js).
// On observe btn-insol : quand il devient enabled, on active btn-temp.
// ════════════════════════════════════════════════════════════════
(function() {
  var btnTemp  = document.getElementById('btn-temp');
  var btnInsol = document.getElementById('btn-insol');
  if (!btnTemp || !btnInsol) return;
  var obs = new MutationObserver(function() {
    if (!btnInsol.disabled) {
      btnTemp.disabled = false;
    }
  });
  obs.observe(btnInsol, { attributes: true, attributeFilter: ['disabled'] });
})();

// ════════════════════════════════════════════════════════════════
// INITIALISATION — recalcul de TEMP_T0_MER dès que GEO est connu
// ════════════════════════════════════════════════════════════════
function tempInit() {
  if (!GEO) return;
  var latAbs = Math.abs((GEO.latMax + GEO.latMin) / 2);
  // Formule : 27 − 0,4·(|lat|−15), clampée [−5, 35]
  // Exemples : lat 0° → 33 °C (tropique) ; lat 45° → 15 °C (Europe tempérée)
  //            lat 70° → 1 °C (Arctique) — valeur brute, à ajuster.
  TEMP_T0_MER = Math.max(-5, Math.min(35, 27 - 0.4 * (latAbs - 15)));
}

// ════════════════════════════════════════════════════════════════
// TESTS DE VALIDATION — console.log au premier affichage
// ════════════════════════════════════════════════════════════════
function _tempTests() {
  // 1. LGM au site de forage (poids latitudinal = 1 si |lat| ≥ lat_forage)
  var a20N = anomaliePaleo(-20,  70);   // GRIP
  var a20S = anomaliePaleo(-20, -78);   // Vostok
  console.log('[temp test 1] anomaliePaleo(-20, +70) = ' + a20N.toFixed(2) + ' (attendu ≈ −20, forage nord)');
  console.log('[temp test 1] anomaliePaleo(-20, −78) = ' + a20S.toFixed(2) + ' (attendu ≈ −9,8, forage sud)');

  // 2. Présent = 0 partout ; fondu latitudinal (équateur → 0)
  var a0N   = anomaliePaleo(0,  45);
  var a20eq = anomaliePaleo(-20,  0);
  var a20_45 = anomaliePaleo(-20, 45);   // 45/70 ≈ 0,643 × (−20)
  console.log('[temp test 2] anomaliePaleo(0, 45) = ' + a0N.toFixed(2) + ' (attendu 0, présent)');
  console.log('[temp test 2] LGM équateur = ' + a20eq.toFixed(2) + ' (attendu 0, fondu nul)');
  console.log('[temp test 2] LGM 45°N = ' + a20_45.toFixed(2) + ' (attendu ≈ −12,9 = −20×45/70)');

  // 3. Spline monotone : rechute Younger Dryas visible (-12 ka plus froid que -13 ka)
  var a13 = anomaliePaleo(-13,  70);
  var a12 = anomaliePaleo(-12,  70);
  var a11 = anomaliePaleo(-11,  70);
  console.log('[temp test 3] nord -13/-12/-11 ka = ' + a13.toFixed(1) + ' / ' + a12.toFixed(1) + ' / ' + a11.toFixed(1) + ' (rechute YD : -12 et -11 < -13)');

  // 4. Isotherme 0 °C présent vs LGM
  var iz0  = isothermeZero(0);
  var iz20 = isothermeZero(20);
  console.log('[temp test 4] isothermeZero(0)  = ' + iz0.toFixed(0) + ' m  (T0=' + TEMP_T0_MER.toFixed(1) + ' °C)');
  console.log('[temp test 4] isothermeZero(20) = ' + iz20.toFixed(0) + ' m  (écart = ' + (iz0 - iz20).toFixed(0) + ' m — plus bas au LGM)');

  // 5. Cohérence tempPixel
  if (ombreElev1024 && GEO) {
    var idx0 = 512 * OMBRE_DIM + 512;
    var z    = ombreElev1024[idx0];
    var tka  = ctrlTka();
    var tPixel = tempPixel(idx0, tka);
    var latC   = (GEO.latMax + GEO.latMin) / 2;
    var anom   = anomaliePaleo(tka, latC);
    var tManuel = TEMP_T0_MER + anom - (TEMP_LAPSE / 1000) * z;
    var ecart  = Math.abs(tPixel - tManuel);
    console.log('[temp test 5] tempPixel(centre) = ' + tPixel.toFixed(4) + '  formule = ' + tManuel.toFixed(4) + '  écart = ' + ecart.toExponential(2) + ' (< 1e-6, z=' + z.toFixed(0) + 'm)');
  }
}

// ════════════════════════════════════════════════════════════════
// CALCUL + DESSIN DE LA CARTE
// ════════════════════════════════════════════════════════════════
function tempRecalcul() {
  if (!ombreElev1024 || !GEO) return;
  if (!tempLUT) _makeTempLUT();
  tempInit();

  var tka = ctrlTka();
  tempMap = tempCarte(tka);

  // Bornes min/max sur les pixels terre uniquement
  var g    = OMBRE_DIM;
  var mn   =  1e9, mx = -1e9;
  for (var i = 0; i < g * g; i++) {
    var z = ombreElev1024[i];
    if (z <= 0.5 || z >= 9000) continue;
    var v = tempMap[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (mn >= mx) { mn = -20; mx = 30; }
  tempMn = mn; tempMx = mx;

  // Colorisation dans un OffscreenCanvas (même schéma que dsm-insol.js)
  tempOsc = new OffscreenCanvas(g, g);
  var octx = tempOsc.getContext('2d');
  var imgd = octx.createImageData(g, g);
  var d    = imgd.data;
  var span = tempMx - tempMn;

  for (var i = 0; i < g * g; i++) {
    var z2  = ombreElev1024[i];
    var p   = i * 4;
    if (z2 <= 0.5 || z2 >= 9000) {
      // Mer : noir
      d[p] = 0; d[p+1] = 0; d[p+2] = 0; d[p+3] = 255;
      continue;
    }
    var v2  = tempMap[i];
    var t2  = Math.max(0, Math.min(1, (v2 - tempMn) / span));
    var li  = Math.round(t2 * 255);
    d[p]   = tempLUT[li * 3];
    d[p+1] = tempLUT[li * 3 + 1];
    d[p+2] = tempLUT[li * 3 + 2];
    d[p+3] = 255;
  }
  octx.putImageData(imgd, 0, 0);
  tempImgData = imgd;   // garde pour redessins

  // Statut
  var iz = isothermeZero(tka);
  document.getElementById('vstatus').textContent =
    '🌡 an ' + ctrlAnnee + ' — T_mer ' + (TEMP_T0_MER + anomaliePaleo(tka, (GEO.latMax+GEO.latMin)/2)).toFixed(1) +
    ' °C / isotherme 0 °C à ' + iz.toFixed(0) + ' m';

  if (!tempTestsFaits) { _tempTests(); tempTestsFaits = true; }

  render();   // délégation → tempRedessiner()
}

// Redessiner la carte temp sur le canvas principal (zoom/pan).
// La grille temp (OMBRE_DIM²) couvre la même emprise que imgW×imgH →
// facteur d'échelle sx/sy identique à insolRedessiner.
function tempRedessiner() {
  if (!tempOsc) return;
  var sw = DISP * srcPPx, sh = DISP * srcPPx;
  srcX = Math.max(0, Math.min(imgW - sw, srcX));
  srcY = Math.max(0, Math.min(imgH - sh, srcY));
  var sx = OMBRE_DIM / imgW, sy = OMBRE_DIM / imgH;
  ctx.clearRect(0, 0, DISP, DISP);
  ctx.drawImage(tempOsc, srcX * sx, srcY * sy, sw * sx, sh * sy, 0, 0, DISP, DISP);
  document.getElementById('vinfo').textContent = 'zoom \u00d7' + (1 / srcPPx).toFixed(2);
  drawLegend();
}

// ════════════════════════════════════════════════════════════════
// LÉGENDE TEMPÉRATURE
// ════════════════════════════════════════════════════════════════
function drawLegendTemp() {
  var lcv  = document.getElementById('lcv');
  if (!lcv || !tempLUT) return;
  var legT = document.querySelector('#legend-panel .leg-title');
  var legU = document.querySelector('#legend-panel .leg-unit');
  if (legT) legT.textContent = 'TEMPÉRATURE';
  if (legU) legU.textContent = '°C';

  var lh = lcv.height, lw = lcv.width;
  if (lh < 10) return;
  var lctx = lcv.getContext('2d');
  lctx.clearRect(0, 0, lw, lh);
  var barX = 0, barW = 22, textX = barW + 3, barH = lh - 4, barY = 2;

  // Barre couleur
  for (var y = 0; y < barH; y++) {
    var t  = 1 - y / barH;
    var li = Math.round(t * 255);
    lctx.fillStyle = 'rgb(' + tempLUT[li*3] + ',' + tempLUT[li*3+1] + ',' + tempLUT[li*3+2] + ')';
    lctx.fillRect(barX, barY + y, barW, 1);
  }

  // Graduations (5 niveaux)
  lctx.font = '8px monospace';
  var span = tempMx - tempMn;
  for (var ti = 0; ti <= 4; ti++) {
    var frac = ti / 4;
    var elev = tempMn + frac * span;
    var yy   = barY + Math.round((1 - frac) * barH);
    lctx.fillStyle = 'rgba(180,190,210,.6)'; lctx.fillRect(barX + barW, yy, 4, 1);
    lctx.fillStyle = '#a6adc8'; lctx.fillText(elev.toFixed(1), textX + 2, yy + 3);
  }

  // Marqueur 0 °C — LA frontière intéressante pour la sim glacier
  if (tempMn < 0 && tempMx > 0) {
    var t0 = (0 - tempMn) / span;
    var y0 = barY + Math.round((1 - t0) * barH);
    lctx.strokeStyle = 'rgba(240,240,80,.95)'; lctx.lineWidth = 1.5;
    lctx.beginPath(); lctx.moveTo(barX, y0); lctx.lineTo(barX + barW + 10, y0); lctx.stroke();
    lctx.fillStyle = 'rgba(240,240,80,.95)';
    lctx.fillText('0', textX + 2, y0 - 2);
  }
}

// ════════════════════════════════════════════════════════════════
// HOOKS DANS render() et drawLegend() de dsm.html
// Injectés via monkey-patching (même technique que dsm-insol.js
// qui insère ses tests dans ctrlIncrementer/applyPct).
// ════════════════════════════════════════════════════════════════
(function() {
  // -- render() : déléguer à tempRedessiner si vue temp active
  var _renderOrig = render;
  render = function() {
    if (tempActive && tempOsc) { tempRedessiner(); return; }
    _renderOrig();
  };

  // -- drawLegend() : déléguer à drawLegendTemp si vue temp active
  var _drawLegendOrig = drawLegend;
  drawLegend = function() {
    if (tempActive && tempImgData) { drawLegendTemp(); return; }
    _drawLegendOrig();
  };
})();

// ════════════════════════════════════════════════════════════════
// HOOKS SLIDER ANNÉE — AUCUN ICI depuis dsm.html 3.12 :
// ctrlIncrementer (l. ~311) et applyPct (l. ~402) appellent directement
// tempRecalcul() quand tempActive est vrai, à côté des hooks insol.
// (v1.0 dupliquait le recalcul via monkey-patch + MutationObserver →
//  supprimé en v1.1 : un seul recalcul par changement d'année.)
// ════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
// OVERLAY COORDONNÉES — ajout 🌡 X.X °C quand vue temp active
// ════════════════════════════════════════════════════════════════
(function() {
  var canvas2 = document.getElementById('c');
  canvas2.addEventListener('mousemove', function(e) {
    if (!tempActive || !tempMap || !GEO) return;
    var r  = canvas2.getBoundingClientRect();
    var cx = (e.clientX - r.left)  / r.width;
    var cy = (e.clientY - r.top)   / r.height;
    var px = srcX + cx * DISP * srcPPx;
    var py = srcY + cy * DISP * srcPPx;
    var g  = OMBRE_DIM;
    var gc = Math.min(g - 1, Math.max(0, Math.round(px / (imgW - 1) * (g - 1))));
    var gr = Math.min(g - 1, Math.max(0, Math.round(py / (imgH - 1) * (g - 1))));
    var vt = tempMap[gr * g + gc];
    // Récupérer le contenu courant (lat/lon/alt) et y ajouter la temp
    var cur = coordEl.textContent;
    // Supprimer un éventuel suffixe 🌡 déjà présent pour éviter les doublons
    cur = cur.replace(/\s*🌡.*$/, '');
    coordEl.textContent = cur + '  🌡 ' + vt.toFixed(1) + ' °C';
  });
})();

// ════════════════════════════════════════════════════════════════
// BOUTON 🌡 Temp — toggle vue
// ════════════════════════════════════════════════════════════════
document.getElementById('btn-temp').addEventListener('click', function() {
  if (tempActive) {
    // Désactiver
    tempActive  = false;
    tempImgData = null;
    tempOsc     = null;
    var lt = document.querySelector('#legend-panel .leg-title');
    var lu = document.querySelector('#legend-panel .leg-unit');
    if (lt) lt.textContent = 'ALTITUDE';
    if (lu) lu.textContent = 'mètres';
    this.classList.remove('active');
    render();
    document.getElementById('vstatus').textContent = '🌡 Temp désactivée';
    return;
  }
  // Activer — vérifications
  if (!ombreElev1024) {
    document.getElementById('vstatus').textContent =
      '🌡 Lancer 🌑 Ombre d\'abord (la passe 1 calcule ombreElev1024)';
    return;
  }
  // Désactiver vue insol si elle est active (exclusivité)
  if (typeof insolActive !== 'undefined' && insolActive) {
    document.getElementById('btn-insol').click();
  }
  tempActive = true;
  this.classList.add('active');
  tempRecalcul();
});
