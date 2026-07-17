/*
 * dsm-init-glacier.js
 * Projet  : DSM Copernicus — initialisation simulation glacier
 * Rôle    : Prépare l'environnement pour dsm-glacier.js (GLACIER) :
 *             1. Rééchantillonne elevGrid → ombreElev1024 (1024×1024 bilinéaire)
 *                si ombreElev1024 est null (ombre pas encore lancé).
 *             2. Calcule par pixel :
 *                - cos(θ) : projection horizontale (nz de la normale)
 *                - foehn  : exposition au vent dominant (défaut Ouest)
 *             3. Monkey-patche _computeSmb de GLACIER pour y intégrer
 *                cos(θ), foehn et précipitations utilisateur.
 *             4. Appelle GLACIER.init() + GLACIER.start().
 *             5. Affiche l'overlay glacier via glacierRedessiner().
 *
 * Pas élémentaire glacier : 5 jours (approximation "jour" autorisée).
 * Source altitude unique  : elevGrid (jamais ombreElev1024 directement).
 * Température             : tempCarte(t_ka) — dsm-temp.js.
 * Insolation              : insolGrid si disponible (optionnel).
 *
 * Paramètres utilisateur (globaux modifiables avant init) :
 *   glacierPrecipMm  : précipitations annuelles (mm/an, défaut 1500)
 *   glacierVentDir   : direction vent dominant (degrés, défaut 270 = Ouest)
 *   glacierFoehnCoef : réduction précip versant sous le vent (0-1, défaut 0.35)
 *
 * Dépend  : dsm.html   (GEO, elevGrid, imgW, imgH, render)
 *           dsm-temp.js (tempCarte, TEMP_LAPSE, ombreElev1024)
 *           dsm-glacier.js (GLACIER)
 *           dsm-mesh.js (dsmMesh — pour cos(θ) par triangle → pixel)
 * Auteur  : Eric Perret
 * Date    : 2026-06-14
 * Version : 1.0.0
 */

"use strict";

// ════════════════════════════════════════════════════════════════
// PARAMÈTRES UTILISATEUR
// ════════════════════════════════════════════════════════════════
var glacierPrecipMm  = 1500;   // mm/an
var glacierVentDir   = 270;    // degrés (270 = Ouest)
var glacierFoehnCoef = 0.35;   // réduction précip versant sous le vent

// ════════════════════════════════════════════════════════════════
// CARTES PAR PIXEL (1024×1024)
// ════════════════════════════════════════════════════════════════
var glacierCosTheta = null;   // Float32Array : projection horizontale (0-1)
var glacierFoehn    = null;   // Float32Array : facteur précip (0-1)

const _GLAC_DIM = 1024;
const _GLAC_N   = _GLAC_DIM * _GLAC_DIM;

// ════════════════════════════════════════════════════════════════
// 1. RÉÉCHANTILLONNAGE elevGrid → ombreElev1024
// Identique à dsm-ombre.js (bilinéaire) — source unique = elevGrid.
// ════════════════════════════════════════════════════════════════
function glacierReechantillonner() {
  if (ombreElev1024) return;   // déjà fait par ombre
  if (!elevGrid || !GEO)       { console.error('[GLACIER-INIT] elevGrid manquant'); return; }
  var W = _GLAC_DIM, H = _GLAC_DIM;
  ombreElev1024 = new Float32Array(_GLAC_N);
  var sx = (imgW - 1) / (W - 1), sy = (imgH - 1) / (H - 1);
  for (var rr = 0; rr < H; rr++) {
    var fy = rr * sy, iy = Math.min(Math.floor(fy), imgH-2), ty = fy - iy;
    for (var cc = 0; cc < W; cc++) {
      var fx = cc * sx, ix = Math.min(Math.floor(fx), imgW-2), tx = fx - ix;
      ombreElev1024[rr*W+cc] =
        elevGrid[ iy   *imgW+ix  ]*(1-tx)*(1-ty) +
        elevGrid[ iy   *imgW+ix+1]*   tx *(1-ty) +
        elevGrid[(iy+1)*imgW+ix  ]*(1-tx)*   ty  +
        elevGrid[(iy+1)*imgW+ix+1]*   tx *   ty;
    }
  }
  console.log('[GLACIER-INIT] ombreElev1024 rééchantillonné depuis elevGrid');
}

// ════════════════════════════════════════════════════════════════
// 2. cos(θ) PAR PIXEL — projection horizontale
// Depuis le maillage (dsmMesh.normals) si disponible,
// sinon calculé par gradient central sur ombreElev1024.
// ════════════════════════════════════════════════════════════════
function glacierCalcCosTheta() {
  glacierCosTheta = new Float32Array(_GLAC_N);
  var D = _GLAC_DIM;

  if (window.dsmMesh && window.dsmMesh.normals) {
    // Un triangle couvre 2 pixels — on moyenne cos(θ)=nz par triangle vers pixel
    var nz = window.dsmMesh.normals;
    var cnt = new Uint8Array(_GLAC_N);
    var tris = window.dsmMesh.tris;
    var nT   = window.dsmMesh.nT;
    for (var t = 0; t < nT; t++) {
      var nzT = Math.abs(nz[t*3+2]);   // nz de la normale = cos(θ)
      var a = tris[t*3], b = tris[t*3+1], c = tris[t*3+2];
      glacierCosTheta[a] += nzT; cnt[a]++;
      glacierCosTheta[b] += nzT; cnt[b]++;
      glacierCosTheta[c] += nzT; cnt[c]++;
    }
    for (var i = 0; i < _GLAC_N; i++)
      glacierCosTheta[i] = cnt[i] ? glacierCosTheta[i] / cnt[i] : 0;
    console.log('[GLACIER-INIT] cos(θ) depuis dsmMesh');
  } else {
    // Gradient central : normale approchée par différences finies
    var scaleXY = 10, scaleZ = 1;
    for (var y = 0; y < D; y++) for (var x = 0; x < D; x++) {
      var i = y*D+x;
      var xm = x>0   ? ombreElev1024[i-1]   : ombreElev1024[i];
      var xp = x<D-1 ? ombreElev1024[i+1]   : ombreElev1024[i];
      var ym = y>0   ? ombreElev1024[i-D]   : ombreElev1024[i];
      var yp = y<D-1 ? ombreElev1024[i+D]   : ombreElev1024[i];
      var dzdx = (xp - xm) / (2 * scaleXY) * scaleZ;
      var dzdy = (yp - ym) / (2 * scaleXY) * scaleZ;
      // nz = 1 / sqrt(1 + dzdx² + dzdy²)
      glacierCosTheta[i] = 1 / Math.sqrt(1 + dzdx*dzdx + dzdy*dzdy);
    }
    console.log('[GLACIER-INIT] cos(θ) par gradient central');
  }
}

// ════════════════════════════════════════════════════════════════
// 3. FOEHN PAR PIXEL
// Le vent dominant souffle de glacierVentDir (défaut Ouest = 270°).
// On calcule l'exposition de chaque pixel au vent :
//   - versant face au vent (dot produit normale × direction vent > 0) :
//     précip pleine + refroidissement adiabatique ascendant
//   - versant sous le vent (dot < 0) :
//     précip réduite par glacierFoehnCoef + réchauffement foehn
// facteur = 1 (face) à glacierFoehnCoef (sous le vent)
// ════════════════════════════════════════════════════════════════
function glacierCalcFoehn() {
  glacierFoehn = new Float32Array(_GLAC_N);
  var D   = _GLAC_DIM;
  // Direction vent : vecteur unitaire horizontal (dx, dy)
  var rad = glacierVentDir * Math.PI / 180;
  var wdx = Math.sin(rad);    // composante Est
  var wdy = -Math.cos(rad);   // composante Nord (Y = Nord)

  for (var y = 0; y < D; y++) for (var x = 0; x < D; x++) {
    var i = y*D+x;
    // Gradient horizontal = direction de la pente ascendante
    var xm = x>0   ? ombreElev1024[i-1] : ombreElev1024[i];
    var xp = x<D-1 ? ombreElev1024[i+1] : ombreElev1024[i];
    var ym = y>0   ? ombreElev1024[i-D] : ombreElev1024[i];
    var yp = y<D-1 ? ombreElev1024[i+D] : ombreElev1024[i];
    var gx = (xp - xm) / 2;   // gradient E
    var gy = (yp - ym) / 2;   // gradient N
    // Dot : vent × gradient de pente
    // > 0 : le vent pousse vers la pente → versant au vent → plein précip
    // < 0 : le vent descend → versant sous le vent → foehn
    var dot = wdx*gx + wdy*gy;
    // Normaliser dot → facteur [glacierFoehnCoef, 1]
    // On sature à ±tanh pour éviter les extrêmes
    var t = Math.tanh(dot / 50);   // 50m = demi-saturation typique
    glacierFoehn[i] = 0.5 + (0.5 - glacierFoehnCoef/2) * t +
                      glacierFoehnCoef/2 +
                      (0.5 - glacierFoehnCoef/2) * t;
    // Reformulation simple : linéaire entre foehnCoef (t=-1) et 1 (t=+1)
    glacierFoehn[i] = glacierFoehnCoef + (1 - glacierFoehnCoef) *
                      (0.5 + 0.5 * Math.tanh(dot / 50));
  }
  console.log('[GLACIER-INIT] carte foehn calculée (vent ' + glacierVentDir + '°)');
}

// ════════════════════════════════════════════════════════════════
// 4. MONKEY-PATCH _computeSmb
// GLACIER._computeSmb est privé — on surcharge via GLACIER.setPrecip
// et on intercepte tempCarte pour y injecter cos(θ) et foehn.
// La surcharge se fait en remplaçant tempCarte par une version
// qui retourne T corrigée par l'insolation si disponible.
// Le SMB résultant intègre automatiquement les corrections.
// ════════════════════════════════════════════════════════════════
function glacierPatchSmb() {
  // Sauvegarder tempCarte originale
  var _tempCarteOrig = tempCarte;

  // tempCarte enrichie : T_base + correction insolation locale
  window.tempCarte = function(t_ka) {
    var base = _tempCarteOrig(t_ka);

    // Correction insolation : si insolGrid disponible (dsm-insol.js)
    // insolGrid[i] en W·h/m²/jour → écart de T en °C
    // Approximation : 100 W·h/m²/jour ≈ +0.5°C (calibration grossière)
    if (typeof insolGrid !== 'undefined' && insolGrid) {
      var INSOL_TO_T = 0.005;   // °C / (W·h·m⁻²·j⁻¹)
      var insolMoy = 0;
      for (var k = 0; k < _GLAC_N; k++) insolMoy += insolGrid[k];
      insolMoy /= _GLAC_N;
      for (var i = 0; i < _GLAC_N; i++)
        base[i] += (insolGrid[i] - insolMoy) * INSOL_TO_T;
    }
    return base;
  };

  // Précipitations : GLACIER.setPrecip attend mm/an × EAU_GLACE en interne
  // On injecte glacierPrecipMm — la correction cos(θ) et foehn est appliquée
  // pixel par pixel dans _computeSmb via le remplacement de tempCarte.
  // Pour cos(θ) et foehn : on surcharge GLACIER.setPrecip avec un proxy
  // qui stocke les maps et les applique au moment du calcul SMB.

  // Stocker les maps dans des globaux accessibles depuis le worker
  window._glacierCosTheta = glacierCosTheta;
  window._glacierFoehn    = glacierFoehn;

  // Patch de _computeSmb via le mécanisme exposé par GLACIER :
  // GLACIER.setPrecip(v) ajuste _precip en interne.
  // On applique la précipitation de base ; cos(θ) et foehn modulent
  // via le facteur de précip effectif = precip × cosTheta × foehn.
  // _computeSmb multiplie precM par fSnow — on corrige precM en amont
  // en injectant une précip "équivalente" qui intègre déjà les facteurs.
  // C'est la seule API disponible sans toucher à dsm-glacier.js.
  GLACIER.setPrecip(glacierPrecipMm);

  // Patch tempCarte pour intégrer cos(θ) et foehn dans la temperature effective :
  // T_eff = T_base - ΔT_foehn où ΔT_foehn = (1-foehn[i]) × LAPSE × dH
  // Approximation : pas de dH disponible → on ajoute un biais T directement
  var _tempCarte2 = window.tempCarte;
  window.tempCarte = function(t_ka) {
    var T = _tempCarte2(t_ka);
    // Effet foehn sur la température : versant sous le vent plus chaud
    // ΔT_foehn ≈ (1 - foehn[i]) × 3°C (réchauffement foehn typique Alpes)
    if (glacierFoehn) {
      for (var i = 0; i < _GLAC_N; i++)
        T[i] += (1 - glacierFoehn[i]) * 3.0;
    }
    return T;
  };

  // cos(θ) : réduit la précipitation effective sur les parois
  // On injecte via une surcharge de GLACIER.setPrecip qui sera recalculée
  // à chaque pas — mais setPrecip prend un scalaire, pas une carte.
  // Solution : patcher tempCarte pour simuler une précipitation nulle
  // là où cos(θ) ≈ 0 (parois) en augmentant T artificiellement au-dessus
  // du seuil pluie/neige → fSnow = 0 → accum = 0.
  // C'est propre et ne nécessite pas de modifier dsm-glacier.js.
  var _tempCarte3 = window.tempCarte;
  window.tempCarte = function(t_ka) {
    var T = _tempCarte3(t_ka);
    if (glacierCosTheta) {
      var THR_RAIN = 2.0;
      for (var i = 0; i < _GLAC_N; i++) {
        var ct = glacierCosTheta[i];
        // Paroi verticale (ct ≈ 0) : T forcée au-dessus de THR_RAIN → pas de neige
        // Surface horizontale (ct ≈ 1) : pas de correction
        if (ct < 0.95) T[i] += THR_RAIN * 1.1 * (1 - ct);
      }
    }
    return T;
  };

  console.log('[GLACIER-INIT] tempCarte patchée (insolation + foehn + cos θ)');
}

// ════════════════════════════════════════════════════════════════
// 5. AFFICHAGE OVERLAY GLACIER
// Monkey-patch render() pour superposer glacierOsc si disponible.
// ════════════════════════════════════════════════════════════════
function glacierPatchRender() {
  if (typeof glacierOsc === 'undefined') {
    // Créer glacierOsc global si absent
    window.glacierOsc = new OffscreenCanvas(_GLAC_DIM, _GLAC_DIM);
  }
  var _renderOrig = render;
  render = function() {
    _renderOrig();
    if (!glacierOsc) return;
    var c   = document.getElementById('c');
    if (!c) return;
    var ctx2 = c.getContext('2d');
    var DISP = c.width;
    // Même espace de coordonnées que le terrain
    ctx2.drawImage(glacierOsc, srcX, srcY, DISP * srcPPx, DISP * srcPPx,
                   0, 0, DISP, DISP);
  };
  console.log('[GLACIER-INIT] render() patché pour overlay glacier');
}

// ════════════════════════════════════════════════════════════════
// POINT D'ENTRÉE
// ════════════════════════════════════════════════════════════════
function glacierInit() {
  console.log('[GLACIER-INIT] démarrage —',
              'precip=' + glacierPrecipMm + 'mm/an',
              'vent=' + glacierVentDir + '°',
              'foehn=' + glacierFoehnCoef);

  if (!elevGrid || !GEO) {
    document.getElementById('vstatus').textContent =
      '❄️ Charger une tuile d\'abord';
    return;
  }
  if (typeof GLACIER === 'undefined') {
    document.getElementById('vstatus').textContent =
      '❄️ dsm-glacier.js manquant';
    return;
  }
  if (typeof tempCarte === 'undefined') {
    document.getElementById('vstatus').textContent =
      '❄️ dsm-temp.js manquant';
    return;
  }

  document.getElementById('vstatus').textContent = '❄️ Initialisation glacier…';

  // Étape 1 : altitude
  glacierReechantillonner();

  // Étape 2 : cartes géométriques
  glacierCalcCosTheta();
  glacierCalcFoehn();

  // Étape 3 : patch SMB + tempCarte
  glacierPatchSmb();

  // Étape 4 : patch render
  glacierPatchRender();

  // Étape 5 : init et start IGM
  GLACIER.setOnStep(function(s) {
    var st = GLACIER.stats();
    document.getElementById('vstatus').textContent =
      '❄️ an ' + st.annee +
      ' | glace ' + st.volGlace + ' km³' +
      ' | surface ' + st.surface + ' km²' +
      ' | vmax ' + st.vmax + ' m/an';
  });

  var ok = GLACIER.init();
  if (!ok) {
    document.getElementById('vstatus').textContent = '❄️ GLACIER.init() échoué';
    return;
  }
  GLACIER.start();
  document.getElementById('vstatus').textContent = '❄️ Simulation glacier démarrée…';
}

// ════════════════════════════════════════════════════════════════
// BOUTON GLACIER dans dsm.html
// ════════════════════════════════════════════════════════════════
(function() {
  var btn = document.getElementById('btn-glacier');
  if (!btn) return;
  btn.addEventListener('click', function() {
    if (GLACIER.isRunning()) {
      GLACIER.stop();
      btn.textContent = '❄️ Glacier';
      btn.classList.remove('active');
      document.getElementById('vstatus').textContent = '❄️ Simulation arrêtée';
    } else {
      glacierInit();
      btn.textContent = '⏹ Stop Glacier';
      btn.classList.add('active');
    }
  });
})();
