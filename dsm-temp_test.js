/*
 * dsm-temp_test.js
 * Projet  : DSM — VÉRIFICATION du module température contre la MESURE.
 * Rôle    : charge dsm-temp.js (avec bouchons des globaux navigateur), échantillonne
 *           tempInstant sur 24 h au 15 de chaque mois à l'altitude de stations de
 *           référence, et confronte Tmin/Tmax modélisés aux NORMALES 1991-2020.
 *           Verdict mécanique :
 *             - biais sur le cycle des Tmin  → TEMP_T0_MER / TEMP_A_SAISON
 *             - biais sur (Tmax − Tmin)      → TEMP_A_DIURNE
 *             - biais SAISONNIER d'amplitude → modulation wSun/durée du jour (structurel)
 *           Principe : la station VALIDE, elle ne règle pas. Le modèle est sans
 *           nuages ; la chaîne (DDF compris) est empirique TOUS CIELS → la
 *           référence correcte est l'amplitude moyenne mensuelle des normales,
 *           pas l'amplitude d'un beau jour.
 * Usage   : node dsm-temp_test.js   (dsm-temp.js dans le même dossier)
 * DONNÉES : normales OFFICIELLES Météo-France 1991-2020 (fiches 73329001 et
 * 73054001, éditées 06/06/2025, fournies par Eric le 2026-07-15).
 * Dépend  : dsm-temp.js. JS pur, zéro librairie.
 * Auteur  : Eric Perret / implémentation Claude
 * Date    : 2026-07-15
 * Version : 1.1.0  (normales officielles intégrées — le test fait foi)
 */
"use strict";
const fs = require('fs');
const vm = require('vm');

// ── Stations de référence (sites WMO plats et dégagés → plein soleil géométrique) ──
// normales : 12 mois × [Tmin, Tmax] en °C — REMPLACER par les fiches officielles.
const STATIONS = [
  // Fiches climatologiques Météo-France 1991-2020, éditées 06/06/2025 (fournies par Eric) :
  { nom: 'CHAMBERY-AIX (73329001)', lat: 45.641, alt: 235, aVerifier: false,
    normales: [[-0.7,6.4],[-0.4,8.5],[2.5,13.4],[5.6,17.3],[10.0,21.3],[13.5,25.3],
               [15.0,27.8],[14.6,27.1],[11.3,22.3],[7.7,17.0],[3.1,10.6],[0.0,6.9]] },
  { nom: 'BOURG ST MAURICE (73054001)', lat: 45.6125, alt: 865, aVerifier: false,
    normales: [[-3.2,5.7],[-2.8,7.8],[0.7,12.8],[4.1,16.2],[7.9,20.4],[11.2,24.5],
               [12.9,26.7],[12.6,26.4],[9.3,21.9],[5.7,16.9],[1.1,10.2],[-2.2,5.7]] },
];
const T_KA = 0.06;            // ≈ centre de la période des normales (2005)
const JOURS_MOIS = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349];

// ── Bouchons des globaux navigateur pour charger dsm-temp.js en Node ──
function chargeTemp(latStation, altStation) {
  // Bac à sable NEUF à chaque tentative (les const du module ne se redéclarent
  // pas dans le même contexte) ; chaque global UI manquant devient un bouchon.
  const stubs = {
    console: console, Math: Math,
    GEO: { latMin: latStation - 0.2, latMax: latStation + 0.2, lonMin: 6, lonMax: 7 },
    OMBRE_DIM: 1024,
    ombreElev1024: (() => { const a = new Float32Array(1); a[0] = altStation; return a; })(),
    INSOL_W_PAR_H: null, render: () => {}, coordEl: { textContent: '' },
    ctrlAnnee: { value: 2005 }, ctrlTka: () => T_KA,
    MutationObserver: function(){ this.observe = () => {}; this.disconnect = () => {}; },
    document: { getElementById: () => ({ addEventListener(){}, classList:{add(){},remove(){},toggle(){}},
                textContent:'', value:0, style:{} }), createElement: () => ({ getContext: () => null, style:{} }) },
  };
  stubs.window = stubs;
  const src = fs.readFileSync(__dirname + '/dsm-temp.js', 'utf8');
  for (let essai = 0; essai < 40; essai++) {
    const bac = vm.createContext(Object.assign({}, stubs));
    try { vm.runInContext(src, bac); return bac.tempInstant; }
    catch (e) {
      const m = /^(\w+) is not defined/.exec(e.message);
      if (!m || essai === 39) throw e;
      stubs[m[1]] = function(){};
    }
  }
}

// ── Lever/coucher solaires (formule standard, déclinaison de Cooper) ──
function riseSet(lat, jour) {
  const dec = -23.44 * Math.cos(2 * Math.PI * (jour + 10) / 365) * Math.PI / 180;
  const phi = lat * Math.PI / 180;
  const x = -Math.tan(phi) * Math.tan(dec);
  if (x >= 1)  return [12, 12];        // nuit polaire
  if (x <= -1) return [0, 24];         // jour polaire
  const H0 = Math.acos(x) * 12 / Math.PI;
  return [12 - H0, 12 + H0];
}

// ── Vérification ──
let avert = false;
for (const st of STATIONS) {
  const tempInstant = chargeTemp(st.lat, st.alt);
  if (st.aVerifier) avert = true;
  console.log('\n══ ' + st.nom + ' — ' + st.alt + ' m ══' +
              (st.aVerifier ? '   ⚠ normales À CONTRE-VÉRIFIER (fiche officielle)' : ''));
  console.log('mois | Tmin mes/mod (Δ)     | Tmax mes/mod (Δ)     | ampl mes/mod');
  let bMin = 0, bMax = 0, bAmp = 0, rms = 0, n = 0;
  for (let mo = 0; mo < 12; mo++) {
    const jour = JOURS_MOIS[mo];
    const [rise, set] = riseSet(st.lat, jour);
    let tMin = 1e9, tMax = -1e9;
    for (let h = 0; h < 24; h += 0.25) {
      const T = tempInstant(0, h, jour, T_KA, rise, set, 1);   // plein soleil (site dégagé)
      if (T < tMin) tMin = T;
      if (T > tMax) tMax = T;
    }
    const [mMin, mMax] = st.normales[mo];
    const dMin = tMin - mMin, dMax = tMax - mMax;
    bMin += dMin; bMax += dMax; bAmp += (tMax - tMin) - (mMax - mMin);
    rms += dMin * dMin + dMax * dMax; n += 2;
    console.log('  ' + String(mo + 1).padStart(2) + '  | ' +
      mMin.toFixed(1).padStart(5) + '/' + tMin.toFixed(1).padStart(5) + ' (' + (dMin >= 0 ? '+' : '') + dMin.toFixed(1) + ') | ' +
      mMax.toFixed(1).padStart(5) + '/' + tMax.toFixed(1).padStart(5) + ' (' + (dMax >= 0 ? '+' : '') + dMax.toFixed(1) + ') | ' +
      (mMax - mMin).toFixed(1).padStart(4) + '/' + (tMax - tMin).toFixed(1).padStart(4));
  }
  console.log('  biais moyen Tmin ' + (bMin / 12).toFixed(2) + ' °C | Tmax ' + (bMax / 12).toFixed(2) +
              ' °C | amplitude ' + (bAmp / 12).toFixed(2) + ' °C | RMS ' + Math.sqrt(rms / n).toFixed(2) + ' °C');
}
console.log('\nLECTURE DU VERDICT :');
console.log('  biais amplitude > 0  → TEMP_A_DIURNE trop grand : adopter la valeur mesurée');
console.log('  biais Tmin/Tmax de même signe → TEMP_T0_MER (constante) ou TEMP_A_SAISON (si saisonnier)');
console.log('  biais d\'amplitude variable selon la saison → modulation wSun/durée du jour à examiner');


