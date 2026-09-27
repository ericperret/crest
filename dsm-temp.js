/* ═══════════════════════════════════════════════════════════════════
   FICHIER : dsm-temp.js - v27/09/2026
   OBJET   : climat de surface : anomalie paléo (courbes de forage nord et
             sud, pondération en latitude), gradient altitudinal, cycle
             saisonnier, cycle diurne modulé par la nébulosité ; carte et
             légende de température (bouton Temp).
   AUTEUR  : Eric P.
   RELECTURE : Opus 5.5
   DÉPEND  : dsm.html (render, drawLegend, ctrlTka, ctrlAnnee, srcX,
             srcY, srcPPx, imgW, imgH, DISP, ctx, coordEl, GEO),
             dsm-ombre.js (ombreElev1024, OMBRE_DIM)
   EXPOSE  : TEMP_* (constantes), anomaliePaleo, tempPixel, tempCarte,
             isothermeZero, tempJourEte, tempAmplSaison, tempSaison,
             nebJour, tempInstant, tempInit, tempRecalcul
   CONVENTIONS : t_ka en milliers d'années (0 = 1950) ; températures en °C ;
             altitude ≤ 0,5 m = mer (température du niveau de la mer)
   ⚠ Sources non documentées : table de nébulosité TEMP_NEB (station
     inconnue), T0 = 27 − 0,4·(|lat| − 15), amplitude saisonnière 9,5 °C
     à 45°. Avant −20 ka l'anomalie reste figée à sa valeur LGM alors
     que la simulation glacier démarre à −30 ka.
   ═══════════════════════════════════════════════════════════════════ */
"use strict";

const TEMP_LAPSE = 6.5;

var TEMP_T0_MER = 15.0;

const TEMP_LAT_NORD =  70.0;
const TEMP_LAT_SUD  =  78.0;

const TEMP_PALEO_NORD = [
  { t: -20.0, dT: -20.0 },
  { t: -13.0, dT:  -3.4 },
  { t: -12.0, dT:  -8.0 },
  { t: -11.0, dT:  -7.4 },
  { t: -10.0, dT:  -3.0 },
  { t:  -5.0, dT:  -1.0 },
  { t:   0.0, dT:   0.0 },
];

const TEMP_PALEO_SUD = [
  { t: -20.0, dT:  -9.8 },
  { t: -13.0, dT:  -2.7 },
  { t: -12.0, dT:  -3.8 },
  { t: -11.0, dT:  -4.0 },
  { t: -10.0, dT:  -3.0 },
  { t:  -5.0, dT:  -0.5 },
  { t:   0.0, dT:   0.0 },
];

/* ── _splinePentes ── E : table [{t, dT}] triée → T : pentes des segments ;
   pente aux nœuds = moyenne des voisines, 0 en cas de changement de signe ;
   limitation de Fritsch-Carlson (α² + β² ≤ 9) → S : pentes aux nœuds.
   ALGO : « Pentes d'une interpolation d'Hermite cubique monotone (PCHIP). » */
function _splinePentes(table) {
  var n = table.length;
  var d = new Array(n - 1);
  var m = new Array(n);
  for (var i = 0; i < n - 1; i++) {
    d[i] = (table[i + 1].dT - table[i].dT) / (table[i + 1].t - table[i].t);
  }
  m[0]     = d[0];
  m[n - 1] = d[n - 2];
  for (var k = 1; k < n - 1; k++) {
    m[k] = (d[k - 1] * d[k] <= 0) ? 0 : (d[k - 1] + d[k]) / 2;
  }
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

const _PENTES_NORD = _splinePentes(TEMP_PALEO_NORD);
const _PENTES_SUD  = _splinePentes(TEMP_PALEO_SUD);

/* ── _splineEval ── E : table, pentes m, t_ka → T : segment encadrant, bases
   d'Hermite h00, h10, h01, h11 ; hors table, valeur de l'extrémité → S : dT
   (°C). ALGO : « Évalue la spline d'Hermite monotone, constante au-delà des
   bornes. » */
function _splineEval(table, m, t_ka) {
  var n = table.length;
  if (t_ka <= table[0].t)     return table[0].dT;
  if (t_ka >= table[n - 1].t) return table[n - 1].dT;
  var i = 0;
  while (i < n - 1 && t_ka > table[i + 1].t) i++;
  var h  = table[i + 1].t - table[i].t;
  var s  = (t_ka - table[i].t) / h;
  var s2 = s * s, s3 = s2 * s;
  var h00 =  2 * s3 - 3 * s2 + 1;
  var h10 =      s3 - 2 * s2 + s;
  var h01 = -2 * s3 + 3 * s2;
  var h11 =      s3 -     s2;
  return h00 * table[i].dT + h10 * h * m[i]
       + h01 * table[i + 1].dT + h11 * h * m[i + 1];
}

const TEMP_LAT_PIVOT = 45.0;
const TEMP_REF_RECHAUF = 1.3;

/* Fraction de l'anomalie polaire conservée à l'équateur. L'amplification
   polaire n'est pas totale : au DMG les tropiques se sont refroidis de
   2 à 3 °C quand les hautes latitudes perdaient 20 °C, soit environ
   0,125. L'ancien code interpolait entre les deux valeurs à 45°, ce qui
   transportait ~9 °C de refroidissement jusqu'à l'équateur.            */
const TEMP_LAT_EQ_FRAC = 0.125;
/* ── anomaliePaleo ── E : t_ka, latDeg → T : anomalie brute (latitude) moins
   TEMP_REF_RECHAUF·w, w passant de 1 (t ≤ −0,1 ka, 1850) à 0 (t ≥ 0,055 ka,
   2005) → S : anomalie par rapport au climat actuel (°C). ALGO : « Anomalie
   paléo rapportée au présent : les forages sont préindustriels, on retire
   le réchauffement moderne. » */
function anomaliePaleo(t_ka, latDeg) {
  var brut = _anomaliePaleoBrut(t_ka, latDeg);
  var w = (0.055 - t_ka) / 0.155;
  if (w < 0) w = 0; else if (w > 1) w = 1;
  return brut - TEMP_REF_RECHAUF * w;
}
/* ── _anomaliePaleoBrut ───────────────────────────────────────────────
   ENTRÉE     : t_ka, latDeg
   TRAITEMENT : anomalies de forage nord (70°) et sud (78°) par spline ;
                au-delà de ±45°, proportionnelle à |lat| / latitude du
                forage ; entre 0 et ±45°, droite de la valeur équatoriale
                (TEMP_LAT_EQ_FRAC × anomalie polaire) à la valeur à 45°
   SORTIE     : anomalie préindustrielle (°C)
   ALGO       : « Anomalie paléo à une latitude : amplification polaire
                linéaire, tropiques refroidis au huitième de l'anomalie
                polaire. »
   ─────────────────────────────────────────────────────────────────── */
function _anomaliePaleoBrut(t_ka, latDeg) {
  var anomNord = _splineEval(TEMP_PALEO_NORD, _PENTES_NORD, t_ka);
  var anomSud  = _splineEval(TEMP_PALEO_SUD,  _PENTES_SUD,  t_ka);
  var v45N = anomNord * TEMP_LAT_PIVOT / TEMP_LAT_NORD;
  var v45S = anomSud  * TEMP_LAT_PIVOT / TEMP_LAT_SUD;
  if (latDeg >= TEMP_LAT_PIVOT) {
    return anomNord * Math.min(latDeg, TEMP_LAT_NORD) / TEMP_LAT_NORD;
  }
  if (latDeg <= -TEMP_LAT_PIVOT) {
    return anomSud * Math.min(-latDeg, TEMP_LAT_SUD) / TEMP_LAT_SUD;
  }
  /* Entre ±45° : deux segments linéaires passant par la valeur
     équatoriale, au lieu d'une droite reliant directement v45N à v45S. */
  var vEq = TEMP_LAT_EQ_FRAC * (latDeg >= 0 ? anomNord : anomSud);
  if (latDeg >= 0) {
    var fN = latDeg / TEMP_LAT_PIVOT;
    return vEq + fN * (v45N - vEq);
  }
  var fS = -latDeg / TEMP_LAT_PIVOT;
  return vEq + fS * (v45S - vEq);
}

/* Les fonctions ci-dessous dépendent de globaux posés par dsm-ombre.js
   et dsm-worker-tiff.js. Elles retournaient 0 en silence quand ces
   globaux manquaient — indiscernable d'un vrai 0 °C ou 0 m. Le repli
   reste numérique pour ne pas casser le rendu, mais il s'annonce.     */
var _tempManquePrevenu = {};
/* ── _tempContexte ── E : nom de la fonction appelante → T : vérifie
   ombreElev1024 et GEO, avertit une fois par fonction s'ils manquent →
   S : booléen « contexte prêt ». */
function _tempContexte(fn) {
  if (ombreElev1024 && GEO) return true;
  if (!_tempManquePrevenu[fn]) {
    _tempManquePrevenu[fn] = true;
    console.warn('[temp] ' + fn + ' : repli à 0 — ' +
                 (!ombreElev1024 ? 'ombreElev1024 ' : '') +
                 (!GEO ? 'GEO ' : '') + 'non initialisé.');
  }
  return false;
}

/* ── tempPixel ── E : idx pixel 1024², t_ka → T : T_mer = T0 + anomalie ;
   mer : T_mer, terre : T_mer − 6,5 °C/km × z → S : température moyenne
   annuelle (°C). ALGO : « Température annuelle d'un pixel par gradient
   altitudinal standard. » */
function tempPixel(idx, t_ka) {
  if (!_tempContexte('tempPixel')) return 0;
  var z       = ombreElev1024[idx];
  var latCentre = (GEO.latMax + GEO.latMin) / 2;
  var anom    = anomaliePaleo(t_ka, latCentre);
  var tMer    = TEMP_T0_MER + anom;
  if (z <= 0.5) return tMer;
  return tMer - (TEMP_LAPSE / 1000) * z;
}

/* ── tempCarte ── E : t_ka → T : tempPixel sur toute la grille (anomalie
   calculée une fois) → S : Float32Array 1024² (°C). */
function tempCarte(t_ka) {
  var g    = OMBRE_DIM;
  var n    = g * g;
  var out  = new Float32Array(n);
  if (!_tempContexte('tempCarte')) return out;
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

/* ── isothermeZero ── E : t_ka → T : T_mer / gradient → S : altitude de
   l'isotherme 0 °C annuel (m). */
function isothermeZero(t_ka) {
  if (!_tempContexte('isothermeZero')) return 0;
  var latCentre = (GEO.latMax + GEO.latMin) / 2;
  var anom = anomaliePaleo(t_ka, latCentre);
  var tMer = TEMP_T0_MER + anom;
  return (tMer * 1000) / TEMP_LAPSE;
}

const TEMP_A_SAISON = 9.5;
const TEMP_NEB = [0.744,0.796,0.880,0.826,0.819,0.909,0.990,1.000,0.954,0.803,0.668,0.664];

/* _tempLatCentre — E : aucune → T : latitude du centre de la tuile (45 sans
   tuile) → S : degrés. */
function _tempLatCentre() { return GEO ? (GEO.latMax + GEO.latMin) / 2 : 45; }

/* ── tempJourEte ── E : aucune → T : TEMP_JOUR_ETE (203), + 182 jours dans
   l'hémisphère sud → S : jour du maximum thermique. */
function tempJourEte() {
  return _tempLatCentre() < 0 ? (TEMP_JOUR_ETE + 182) % 365 : TEMP_JOUR_ETE;
}

/* ── tempAmplSaison ── E : aucune → T : 1 + (A45 − 1)·min(1, |lat|/45)^1,5
   → S : demi-amplitude saisonnière (°C). ALGO : « ≈ 1 °C sous l'équateur,
   TEMP_A_SAISON au-delà de 45°. » */
function tempAmplSaison() {
  var r = Math.min(1, Math.abs(_tempLatCentre()) / 45);
  return 1 + (TEMP_A_SAISON - 1) * Math.pow(r, 1.5);
}

/* ── tempSaison ── E : jour (1..365) → T : amplitude·cos(2π(j − jour d'été)/365)
   → S : écart saisonnier (°C). */
function tempSaison(jour) {
  return tempAmplSaison() * Math.cos(2 * Math.PI * (jour - tempJourEte()) / 365);
}

/* ── nebJour ── E : jour → T : interpolation linéaire circulaire entre les
   12 valeurs mensuelles TEMP_NEB (mi-mois), décalée de 6 mois au sud →
   S : facteur d'ensoleillement 0..1 qui module l'amplitude diurne. */
function nebJour(jour) {
  var jc = [15,46,74,105,135,166,196,227,258,288,319,349];
  if (_tempLatCentre() < 0) jour += 182;
  var j = ((jour % 365) + 365) % 365;
  for (var m = 0; m < 12; m++) {
    var a = jc[m], b = jc[(m+1)%12], fb = TEMP_NEB[(m+1)%12], fa = TEMP_NEB[m];
    var db = (b - a + 365) % 365, dj = (j - a + 365) % 365;
    if (dj <= db) return fa + (fb - fa) * dj / db;
  }
  return 1;
}
const TEMP_A_DIURNE = 13.8;
const TEMP_JOUR_ETE = 203;

/* ── tempInstant ──────────────────────────────────────────────────────
   ENTRÉE     : idx pixel, heure solaire, jour, t_ka, rise, set, estEnSoleil
                (0..1 ou booléen)
   TRAITEMENT : T annuelle (tempPixel) + tempSaison(jour) ; si ensoleillé,
                cycle diurne bD = TEMP_A_DIURNE·nebJour·w : demi-sinus entre
                lever et coucher, moins sa moyenne journalière
                2·bD/π·(durée du jour/24), nuit plate
   SORTIE     : température (°C)
   ALGO       : « Température instantanée : annuelle + saisonnière + demi-
                sinus diurne de moyenne nulle, amplitude modulée par la
                nébulosité et l'ensoleillement. »
   ─────────────────────────────────────────────────────────────────── */
function tempInstant(idx, heure, jour, t_ka, rise, set, estEnSoleil) {
  if (!_tempContexte('tempInstant')) return 0;

  var z         = ombreElev1024[idx];
  var latCentre = (GEO.latMax + GEO.latMin) / 2;
  var anom      = anomaliePaleo(t_ka, latCentre);
  var tMer      = TEMP_T0_MER + anom;
  var tBase     = (z <= 0.5) ? tMer : tMer - (TEMP_LAPSE / 1000) * z;

  var tSaison = tempSaison(jour);

  var wSun = +estEnSoleil;
  var tDiurne = 0;
  if (wSun > 0 && set > rise) {
    var bD = TEMP_A_DIURNE * nebJour(jour) * wSun;
    var mD = (2 * bD / Math.PI) * ((set - rise) / 24);
    tDiurne = -mD;
    if (heure >= rise && heure <= set) {
      var phase = (heure - rise) / (set - rise);
      tDiurne += bD * Math.sin(Math.PI * phase);
    }
  }

  return tBase + tSaison + tDiurne;
}

var tempActive   = false;
var tempImgData  = null;
var tempOsc      = null;
var tempMap      = null;
var tempMn       = 0;
var tempMx       = 1;
var tempTestsFaits = false;

var tempLUT = null;

/* ── _makeTempLUT ── E : aucune → T : 5 paliers bleu → blanc → rouge,
   interpolation linéaire sur 256 niveaux → S : tempLUT (RGB). */
function _makeTempLUT() {
  var stops = [
    [0.00,  20,  60, 180],
    [0.35,  80, 140, 220],
    [0.50, 240, 240, 240],
    [0.65, 240, 140,  60],
    [1.00, 180,  20,  20],
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

/* Active le bouton Temp dès que Insol est activable (même prérequis :
   horizons calculés), par observation de l'attribut disabled. */
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

/* ── tempInit ── E : GEO → T : T0 = 27 °C sous 15°, puis 27 − 0,4·(|lat| − 15),
   plancher −5 °C → S : TEMP_T0_MER (température actuelle au niveau de la
   mer). ALGO : « Température moyenne annuelle actuelle au niveau de la
   mer selon la latitude. » */
function tempInit() {
  if (!GEO) return;
  var latAbs = Math.abs((GEO.latMax + GEO.latMin) / 2);
  TEMP_T0_MER = latAbs <= 15 ? 27 : Math.max(-5, 27 - 0.4 * (latAbs - 15));
}

/* ── _tempTests ── E : aucune → T : cinq contrôles console (anomalies LGM
   nord/sud, référence moderne, Dryas récent, isotherme 0, cohérence
   tempPixel/formule) → S : journal console. */
function _tempTests() {
  var a20N = anomaliePaleo(-20,  70);
  var a20S = anomaliePaleo(-20, -78);
  console.log('[temp test 1] anomaliePaleo(-20, +70) = ' + a20N.toFixed(2) +
              ' (attendu ≈ −21,3 = −20 forage − ' + TEMP_REF_RECHAUF.toFixed(1) + ' réchauffement moderne)');
  console.log('[temp test 1] anomaliePaleo(-20, −78) = ' + a20S.toFixed(2) +
              ' (attendu ≈ −11,1 = −9,8 forage − ' + TEMP_REF_RECHAUF.toFixed(1) + ')');

  var a0N   = anomaliePaleo(0,  45);
  var a20eq = anomaliePaleo(-20,  0);
  var a20_45 = anomaliePaleo(-20, 45);
  console.log('[temp test 2] anomaliePaleo(0, 45) = ' + a0N.toFixed(2) +
              ' (attendu ≈ −0,46 : t_ka=0 vaut 1950, réchauffement moderne partiel)');
  console.log('[temp test 2] LGM équateur = ' + a20eq.toFixed(2) +
              ' (attendu ≈ −3,8 = −20×' + TEMP_LAT_EQ_FRAC + ' − ' + TEMP_REF_RECHAUF.toFixed(1) + ', tropiques peu refroidis)');
  console.log('[temp test 2] LGM 45°N = ' + a20_45.toFixed(2) + ' (attendu ≈ −14,2 = −20×45/70 − ' + TEMP_REF_RECHAUF.toFixed(1) + ')');

  var a13 = anomaliePaleo(-13,  70);
  var a12 = anomaliePaleo(-12,  70);
  var a11 = anomaliePaleo(-11,  70);
  console.log('[temp test 3] nord -13/-12/-11 ka = ' + a13.toFixed(1) + ' / ' + a12.toFixed(1) + ' / ' + a11.toFixed(1) + ' (rechute YD : -12 et -11 < -13)');

  var iz0  = isothermeZero(0);
  var iz20 = isothermeZero(-20);
  console.log('[temp test 4] isothermeZero(0)  = ' + iz0.toFixed(0) + ' m  (T0=' + TEMP_T0_MER.toFixed(1) + ' °C)');
  console.log('[temp test 4] isothermeZero(-20) = ' + iz20.toFixed(0) + ' m  (écart = ' + (iz0 - iz20).toFixed(0) + ' m — plus bas au LGM)');

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

/* ── tempRecalcul ── E : ctrlTka() → T : tempInit, tempCarte, étendue
   min/max sur la terre, image colorée par tempLUT (mer en noir), message
   d'état avec l'isotherme 0 °C, tests au premier appel → S : tempOsc,
   tempMap, tempMn/Mx ; render(). */
function tempRecalcul() {
  if (!ombreElev1024 || !GEO) return;
  if (!tempLUT) _makeTempLUT();
  tempInit();

  var tka = ctrlTka();
  tempMap = tempCarte(tka);

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

  tempOsc = new OffscreenCanvas(g, g);
  var octx = tempOsc.getContext('2d');
  var imgd = octx.createImageData(g, g);
  var d    = imgd.data;
  var span = tempMx - tempMn;

  for (var i = 0; i < g * g; i++) {
    var z2  = ombreElev1024[i];
    var p   = i * 4;
    if (z2 <= 0.5 || z2 >= 9000) {
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
  tempImgData = imgd;

  var iz = isothermeZero(tka);
  document.getElementById('vstatus').textContent =
    '🌡 an ' + ctrlAnnee + ' — T_mer ' + (TEMP_T0_MER + anomaliePaleo(tka, (GEO.latMax+GEO.latMin)/2)).toFixed(1) +
    ' °C / isotherme 0 °C à ' + iz.toFixed(0) + ' m';

  if (!tempTestsFaits) { _tempTests(); tempTestsFaits = true; }

  render();
}

/* ── tempRedessiner ── E : tempOsc, vue courante (srcX, srcY, srcPPx) → T :
   recadre la vue et dessine la carte redimensionnée, met à jour zoom et
   légende → S : dessin. */
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

/* ── drawLegendTemp ── E : tempLUT, tempMn/Mx → T : barre de couleur
   verticale, 5 graduations, trait jaune à 0 °C → S : dessin sur #lcv. */
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

  for (var y = 0; y < barH; y++) {
    var t  = 1 - y / barH;
    var li = Math.round(t * 255);
    lctx.fillStyle = 'rgb(' + tempLUT[li*3] + ',' + tempLUT[li*3+1] + ',' + tempLUT[li*3+2] + ')';
    lctx.fillRect(barX, barY + y, barW, 1);
  }

  lctx.font = '8px monospace';
  var span = tempMx - tempMn;
  for (var ti = 0; ti <= 4; ti++) {
    var frac = ti / 4;
    var elev = tempMn + frac * span;
    var yy   = barY + Math.round((1 - frac) * barH);
    lctx.fillStyle = 'rgba(180,190,210,.6)'; lctx.fillRect(barX + barW, yy, 4, 1);
    lctx.fillStyle = '#a6adc8'; lctx.fillText(elev.toFixed(1), textX + 2, yy + 3);
  }

  if (tempMn < 0 && tempMx > 0) {
    var t0 = (0 - tempMn) / span;
    var y0 = barY + Math.round((1 - t0) * barH);
    lctx.strokeStyle = 'rgba(240,240,80,.95)'; lctx.lineWidth = 1.5;
    lctx.beginPath(); lctx.moveTo(barX, y0); lctx.lineTo(barX + barW + 10, y0); lctx.stroke();
    lctx.fillStyle = 'rgba(240,240,80,.95)';
    lctx.fillText('0', textX + 2, y0 - 2);
  }
}

/* Surcharge de render et drawLegend : en mode Temp, carte et légende de
   température remplacent l'affichage normal. */
(function() {
  var _renderOrig = render;
  render = function() {
    if (tempActive && tempOsc) { tempRedessiner(); return; }
    _renderOrig();
  };

  var _drawLegendOrig = drawLegend;
  drawLegend = function() {
    if (tempActive && tempImgData) { drawLegendTemp(); return; }
    _drawLegendOrig();
  };
})();

/* Survol en mode Temp : ajoute la température du pixel au texte des
   coordonnées. */
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
    var cur = coordEl.textContent;
    cur = cur.replace(/\s*🌡.*$/, '');
    coordEl.textContent = cur + '  🌡 ' + vt.toFixed(1) + ' °C';
  });
})();

/* Bouton Temp : bascule la carte de température (désactive Insol). */
document.getElementById('btn-temp').addEventListener('click', function() {
  if (tempActive) {
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
  if (!ombreElev1024) {
    document.getElementById('vstatus').textContent =
      '🌡 Lancer 🌑 Ombre d\'abord (la passe 1 calcule ombreElev1024)';
    return;
  }
  if (typeof insolActive !== 'undefined' && insolActive) {
    document.getElementById('btn-insol').click();
  }
  tempActive = true;
  this.classList.add('active');
  tempRecalcul();
});
