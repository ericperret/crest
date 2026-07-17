/*
  Fichier  : dsm-ombre.js
  Date     : 2026-06-12
  Version  : 3.12 — Zoom/pan ombre : ombreOsc (OffscreenCanvas) + ombreRedessiner()
             + hook render() ; ombrePasse3Src capturée pleine résolution (srcPPx=1,
             srcX=srcY=0) pour rester valide après tout zoom/pan ultérieur.
  Rôle     : Masque d'ombre terrain (passes 1/2/3), lever/coucher 365j et
             simulation eau (mode Robinet) — extraits de dsm_original.html v3.7.
  Workers  : HORIZON_WORKER_SRC (passe 1, workers PERSISTANTS : grille envoyée
             1 fois, file d'azimuts), SHADOW_WORKER_SRC (passe 2),
             INSOL_WORKER_SRC (lever/coucher 365j).
  Astro    : AUCUNE duplication — orbital/vraimoy/moyvrai/sunRiseSet/sunPos
             viennent de dsm-astro.js. INSOL_WORKER_SRC reçoit l'astronomie via
             ASTRO_INJECT : new Blob([ASTRO_INJECT, INSOL_WORKER_SRC]).
  Vidéo    : lancerPasse2Seule(soloLever) — soloLever=true : 1 seul pas (lever),
             gain ×40, utilisé par videoLoopJour (dsm.html).
  Source   : spec-masque-ombre-terrain.md v1.0 ; La2004/IMCCE ; insolsub_f.f (BDL).
  Dépend   : dsm-astro.js (orbital, sunRiseSet, sunPos, ASTRO_INJECT) ;
             globales dsm.html (GEO, elevGrid, imgW/imgH, srcX/srcY/srcPPx, ctx,
             canvas, render, currentOSC, oscHypso, oscWater, ctrl*, modeGlacier,
             videoRunning/videoFrameReady) — résolues à l'exécution, SAUF la
             const `canvas` utilisée au chargement par les listeners eau.
  Ordre    : charger APRÈS le glue inline de dsm.html, dsm-astro.js et
             dsm-worker-tiff.js ; AVANT dsm-insol.js.
  Notes 3.10: redécoupage VERBATIM depuis dsm_original.html v3.7 (workers
             passe 1 persistants, declencherPasse2 debounce, soloLever).
             Conservés du découpage 3.7→3.9 :
             1) suppression des duplications astro (corrige le TODO
                ombreOrbital hardcodé — le curseur ANNÉE agit sur e/eps/pibar) ;
             2) activation de #btn-insol quand ombreHorizonCopy est prêt ;
             3) simulation eau GELÉE — déplacée à l'identique, zéro modif.
*/
"use strict";

// ════════════════════════════════════════════════════════════════
// PANNEAU LEVER / COUCHER — navigation molette
// ════════════════════════════════════════════════════════════════
let insolRise = null, insolSet = null;    // Float32Array[365] une fois calculés
let insolDay  = 172;                      // jour courant affiché (0-based, 172=~solstice été)
let insolHour = -1;                       // heure UTC courante (-1 = non initialisée)
let ombreHorizonPret = false;             // true quand passe 1 terminée
let ombreSrcImg      = null;              // ImageData source capturée au départ passe 1
let ombreInstantRAF  = 0;                 // RAF en attente pour ombreInstant
let insolWorker = null;

const MOIS = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];
const MOIS_DEBUT = [0,31,59,90,120,151,181,212,243,273,304,334]; // j=0-based

function jourVersDate(j) {  // j 0-based
  var m = 11;
  for (var i = 0; i < 12; i++) if (j < MOIS_DEBUT[i+1 < 12 ? i+1 : 12]) { m=i; break; }
  var d = j - MOIS_DEBUT[m] + 1;
  return MOIS[m] + ' ' + d;
}

function hDecToHHMM(h) {
  if (h < 0) return 'nuit';
  var hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  if (mm === 60) { hh++; mm = 0; }
  return String(hh).padStart(2,'0') + 'h' + String(mm).padStart(2,'0');
}

// ════════════════════════════════════════════════════════════════
// INSOL_WORKER — Phase 0 : lever/coucher soleil 365j
// L'astronomie (table La2004, orbital, sunRiseSet…) n'est PLUS dupliquée ici :
// elle est injectée en préambule au moment du new Blob (cf. lancerInsolation,
// new Blob([ASTRO_INJECT, INSOL_WORKER_SRC])). Source unique : dsm-astro.js.
// Entrée   : { type:'sunpath', lat_rad, lon_deg, t_ka }
// Sortie   : { type:'done', rise[365], set[365] } heures UTC décimales, -1=nuit polaire
// ════════════════════════════════════════════════════════════════
const INSOL_WORKER_SRC = `
// ── Point d'entrée worker ─────────────────────────────────────────────────
self.onmessage = function(e) {
  if (e.data.type !== 'sunpath') return;
  var lat   = e.data.lat_rad;
  var lon   = e.data.lon_deg;
  var t_ka  = e.data.t_ka !== undefined ? e.data.t_ka : 0;
  var orb   = orbital(t_ka);
  var pibar = orb.pib + Math.PI;   // convention insolsub_f.f : pibar = pibarh + pi
  var rise  = new Float32Array(365);
  var set   = new Float32Array(365);
  for (var j = 1; j <= 365; j++) {
    var rs   = sunRiseSet(j, orb.e, orb.eps, pibar, lat, lon);
    rise[j-1] = rs.rise;
    set[j-1]  = rs.set;
  }
  self.postMessage({ type:'done', rise:rise, set:set }, [rise.buffer, set.buffer]);
};
`;
// ════════════════════════════════════════════════════════════════
// lancerInsolation — appelée au clic Glacier ou changement d'année
// Utilise ctrlTka() pour l'époque et met à jour les sliders au retour
// ════════════════════════════════════════════════════════════════
function lancerInsolation() {
  var latCentre = (GEO.latMax + GEO.latMin) / 2.0;
  var lonCentre = (GEO.lonMax + GEO.lonMin) / 2.0;

  document.getElementById('vstatus').textContent =
    '☀️ Calcul lever/coucher ' + latCentre.toFixed(3) + '° lat (an ' + ctrlAnnee + ')…';

  if (insolWorker) { insolWorker.terminate(); }
  var blob = new Blob([ASTRO_INJECT, INSOL_WORKER_SRC], {type:'application/javascript'});
  var url  = URL.createObjectURL(blob);
  insolWorker = new Worker(url);
  URL.revokeObjectURL(url);

  insolWorker.onmessage = function(e) {
    if (e.data.type !== 'done') return;
    insolRise = e.data.rise;
    insolSet  = e.data.set;
    insolWorker.terminate(); insolWorker = null;
    // Synchroniser le jour courant depuis le slider
    insolDay = ctrlJour;
    // Initialiser ou clamper l'heure dans la plage lever/coucher du jour
    var r = insolRise[ctrlJour], s = insolSet[ctrlJour];
    if (r >= 0 && s >= 0) {
      if (ctrlHeure <= 0) ctrlHeure = (r + s) / 2;
      ctrlHeure = Math.max(r + 0.001, Math.min(s - 0.001, ctrlHeure));
    }
    insolHour = ctrlHeure;
    ctrlRendrePanneau();
    document.getElementById('vstatus').textContent =
      '☀️ Lever/coucher prêt — ↑↓ slider actif  ←→ valeur';
  };

  insolWorker.onerror = function(err) {
    document.getElementById('vstatus').textContent = 'Erreur worker insol : ' + err.message;
  };

  insolWorker.postMessage({
    type    : 'sunpath',
    lat_rad : latCentre * Math.PI / 180.0,
    lon_deg : lonCentre,
    t_ka    : ctrlTka()
  });
}
// ════════════════════════════════════════════════════════════════════════════
// PHASE 1 — MASQUE D'OMBRE TERRAIN
// Spec    : spec-masque-ombre-terrain.md v1.0 (2026-06-09)
// Algo    : Variante B — balayage transformé O(N) par azimut
// Source  : La2004+IMCCE (worker existant) + insolsub_f.f (BDL/IMCCE)
// Arbitrages retenus : B-variante, N=64 azimuts, B2 bord, R=apparent,
//                      M=par ligne, S=bilinéaire
// ════════════════════════════════════════════════════════════════════════════

// ── Constantes ───────────────────────────────────────────────────────────────
const OMBRE_N_AZ  = 64;          // azimuts discrétisés 0..360° (spec §3.3)
const OMBRE_R     = 6371000;     // rayon terrestre moyen (m)
const OMBRE_DIM   = 1024;        // taille grille
const OMBRE_SHADE = 0.35;        // facteur ombre (spec §5)

// ── État global Phase 1 ───────────────────────────────────────────────────────
let ombreHorizon   = null;  // Int16Array[N*N_AZ] — H[pixel][azimut] en centi-degrés
let ombreHmin      = null;  // Int16Array[N]       — H_min par pixel
let ombreHmax      = null;  // Int16Array[N]       — H_max par pixel
let ombreHbord     = null;  // Uint8Array[N*N_AZ]  — 1 si crête = bord tuile (B2)
// Copies permanentes de l'horizon — survivent au transfert zero-copy vers le worker passe 2
let ombreHorizonCopy = null;
let ombreHminCopy    = null;
let ombreHmaxCopy    = null;
let ombreHbordCopy   = null;
let ombreMask      = null;  // Uint8Array[nSteps*N]— shadowMask[t*N+idx]
let ombreSunAz     = null;  // Float32Array[nSteps]— azimut soleil chaque pas
let ombreSunEl     = null;  // Float32Array[nSteps]— élévation soleil chaque pas
let ombreNSteps    = 0;
let ombreHeureStart = 0;
let ombreRafId     = 0;
let ombreStep      = 0;
let ombreRunning   = false;
let ombreSliderDirty = false;  // true = un slider a changé → passe 3 doit rendre 1 frame

// ── HORIZON_WORKER_SRC — Passe 1, variante B ────────────────────────────────
// Reçoit  : { type:'horizon', elev(Float32Array), W, H, resX_row(Float32Array),
//             resY, azIdx, nAz, R }
// Envoie  : { type:'done', azIdx,
//             horizLine(Int16Array[W*H]), bordLine(Uint8Array[W*H]) }
const HORIZON_WORKER_SRC = `
"use strict";
// ── Passe 1 Variante B : balayage transformé le long de lignes d'azimut ──────
// Source physique : spec §3.1 — transformée z'(s) = z(s) - s²/(2R)
// La pente vraie P→Q = [z'(Q)-z'(P)]/(d) + s_P/R  (démontrée dans spec §3.1)
// L'argmax sur Q est inchangé dans l'espace transformé.
// Algorithme horizon O(N) amorti : pile de crêtes dominantes (convex hull)

self.onmessage = function(ev) {
  var d = ev.data;
  // 'init' : recevoir et garder la grille une seule fois (worker persistant)
  if (d.type === 'init') { self.C = d; return; }
  if (d.type !== 'horizon') return;
  var C = self.C;

  var elev    = C.elev;        // Float32Array[W*H] — cache persistant
  var W       = C.W;
  var H       = C.H;
  var resX_row= C.resX_row;    // Float32Array[H] — resX par ligne (m/pixel)
  var resY    = C.resY;        // m/pixel vertical
  var nAz     = C.nAz;         // 64
  var R       = C.R;           // 6 371 000
  var azIdx   = d.azIdx;       // index azimut 0..nAz-1 — seul paramètre par appel

  // Azimut en radians (géographique : 0=nord sens horaire)
  var azDeg = azIdx * 360.0 / nAz;
  var azRad = azDeg * Math.PI / 180.0;

  // Direction de balayage dans la grille (col, row) normalisée
  // Convention image : axe row vers le bas = sud
  // azimut 0°=nord → dRow=-1, dCol=0
  // azimut 90°=est  → dRow=0,  dCol=+1
  var sinAz = Math.sin(azRad);   // composante est
  var cosAz = Math.cos(azRad);   // composante nord
  var dCol  =  sinAz;            // direction col (est = col croissant)
  var dRow  = -cosAz;            // direction row (nord = row décroissant)

  // Résultat
  var horizLine = new Int16Array(W * H);    // H[pixel][azIdx] en centi-degrés
  var bordLine  = new Uint8Array(W * H);    // 1 si crête est sur bord tuile

  // ── Génération des lignes de balayage parallèles à azRad ────────────────
  // On balaie toutes les origines sur les deux bords perpendiculaires
  // (bord gauche+bas pour azimut entre 0° et 180°, etc.)
  // Plus simple : on énumère tous les pixels de départ sur les 4 bords
  // en ne gardant que ceux dont la direction "entre" dans la grille.

  // Stocker les lignes déjà traitées (un pixel ne doit être visité qu'une fois)
  var visited = new Uint8Array(W * H);

  // Origine : parcourir les 4 bords et collecter les points d'entrée
  var starts = [];

  // Bord haut (row=0) : valide si dRow > 0 (on va vers le bas = sud)
  // Bord bas  (row=H-1) : valide si dRow < 0 (on va vers le haut = nord)
  // Bord gauche (col=0) : valide si dCol > 0
  // Bord droit  (col=W-1) : valide si dCol < 0
  if (dRow > 1e-9)  for (var c=0;c<W;c++) starts.push([c, 0]);
  if (dRow < -1e-9) for (var c=0;c<W;c++) starts.push([c, H-1]);
  if (dCol > 1e-9)  for (var r=0;r<H;r++) starts.push([0, r]);
  if (dCol < -1e-9) for (var r=0;r<H;r++) starts.push([W-1, r]);

  // Dédoublonner (coins comptés deux fois)
  // Simple : visited protège déjà contre le double traitement

  for (var si = 0; si < starts.length; si++) {
    var c0 = starts[si][0], r0 = starts[si][1];

    // Construire la ligne de balayage depuis (c0,r0) dans la direction (dCol,dRow)
    // au pas d'un pixel — échantillonnage bilinéaire
    var lineC = [], lineR = [], lineZ = [], lineD = [];
    var fc = c0, fr = r0, s = 0;

    while (fc >= 0 && fc <= W-1 && fr >= 0 && fr <= H-1) {
      var ic = Math.floor(fc), ir = Math.floor(fr);
	if (ic >= W - 1) ic = W - 2;
        if (ir >= H - 1) ir = H - 2;

      var tx = fc - ic, ty = fr - ir;
      // Bilinéaire sur elevGrid
      var z = elev[ir*W+ic]     * (1-tx)*(1-ty)
            + elev[ir*W+ic+1]   * tx    *(1-ty)
            + elev[(ir+1)*W+ic] * (1-tx)*ty
            + elev[(ir+1)*W+ic+1]* tx   *ty;
      lineC.push(fc); lineR.push(fr); lineZ.push(z); lineD.push(s);

      // Incrément de distance physique en mètres
      var rowI = Math.round(fr);
      if (rowI < 0) rowI = 0; if (rowI >= H) rowI = H-1;
      var rx = resX_row[rowI];
      var ds = Math.sqrt(dCol*dCol*rx*rx + dRow*dRow*resY*resY);
      s += ds;
      fc += dCol; fr += dRow;
    }
    var n = lineC.length;
    if (n < 2) continue;

    // ── Transformée z'(s) = z(s) - s²/(2R) ─────────────────────────────
    var zp = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      zp[i] = lineZ[i] - lineD[i]*lineD[i] / (2*R);
    }

    // ── Algorithme horizon O(N) — pile enveloppe convexe supérieure ─────
    // Parcours arrière→avant. Pour P[i], horizon = max pente vers Q[j] j>i.
    // Pile contient les candidats j potentiellement dominants.
    // Nettoyage : retirer j1=stack[top-1] si la pente i→j2 > pente i→j1
    // (j2 plus loin ET plus haut en pente → j2 domine j1 pour tout i'<=i)
    // Source : algorithme standard horizon scanning (Franklin & Ray 1994)
    var hMax   = new Float64Array(n);
    var isBord = new Uint8Array(n);
    var stack  = new Int32Array(n);
    var top    = 0;

    // Initialiser avec le dernier point
    stack[top++] = n - 1;

    for (var i = n - 2; i >= 0; i--) {
      var sP = lineD[i], zP = zp[i];

      // Nettoyer pile : retirer stack[top-1] si dominé par stack[top-2]
      // Dominé = pente(i→j2) > pente(i→j1) pour j2=stack[top-2], j1=stack[top-1]
      while (top >= 2) {
        var j1 = stack[top-1], j2 = stack[top-2];
        var d1 = lineD[j1] - sP, d2 = lineD[j2] - sP;
        if (d1 <= 0 || d2 <= 0) break;
        var p1 = (zp[j1] - zP) / d1;
        var p2 = (zp[j2] - zP) / d2;
        if (p2 <= p1) break;  // j1 dominant ou égal → garder
        top--;                 // j2 domine j1 → dépiler j1
      }

      // Horizon = pente vers le sommet de pile (le plus dominant)
      var jH = stack[top - 1];
      var dH = lineD[jH] - sP;
      var penteT = dH > 0 ? (zp[jH] - zP) / dH : -Infinity;
      hMax[i]   = Math.atan(penteT + sP / R);  // correction courbure spec §3.1
      isBord[i] = (jH === n - 1) ? 1 : 0;

      stack[top++] = i;
    }
    hMax[n-1]   = -Math.PI / 2;  // dernier point : rien devant → -90°
    isBord[n-1] = 0;

    // ── Affecter les résultats aux pixels ────────────────────────────────
    for (var i = 0; i < n; i++) {
      var col = Math.round(lineC[i]);
      var row = Math.round(lineR[i]);
      if (col < 0||col>=W||row<0||row>=H) continue;
      var idx = row*W + col;
      if (visited[idx]) continue;
      visited[idx] = 1;
      // Convertir en centi-degrés Int16 (spec §3.3)
      var hCd = Math.round(hMax[i] * (180/Math.PI) * 100);
      if (hCd < -9000) hCd = -9000;
      if (hCd >  9000) hCd =  9000;
      horizLine[idx] = hCd;
      bordLine[idx]  = isBord[i];
    }
  }

  // Pixels non visités (ne se trouvaient sur aucune ligne d'entrée)
  // → horizon = -90° (toujours visible) en dernier recours
  for (var idx=0; idx<W*H; idx++) {
    if (!visited[idx]) horizLine[idx] = -9000;
  }

  self.postMessage(
    { type:'done', azIdx:azIdx, horizLine:horizLine, bordLine:bordLine },
    [horizLine.buffer, bordLine.buffer]
  );
};
`;

// ── SHADOW_WORKER_SRC — Passe 2, grille complète ────────────────────────────
// Reçoit  : { type:'shadow', W, H, nAz, nSteps,
//             horizon(Int16Array W*H*nAz), hmin/hmax(Int16Array W*H),
//             bord(Uint8Array W*H*nAz), sunAz/sunEl(Float32Array nSteps),
//             eMin, eMax }
// Envoie  : { type:'progress', pct } toutes les ~5%
//           { type:'done', mask, horizon, hmin, hmax, bord } — restitution buffers
const SHADOW_WORKER_SRC = `
"use strict";
self.onmessage = function(ev) {
  var d = ev.data;
  if (d.type !== 'shadow') return;

  var W       = d.W, H = d.H;
  var nAz     = d.nAz, nSteps = d.nSteps;
  var horizon = d.horizon;   // Int16Array[W*H*nAz]
  var hmin    = d.hmin;      // Int16Array[W*H]
  var hmax    = d.hmax;      // Int16Array[W*H]
  var bord    = d.bord;      // Uint8Array[W*H*nAz]
  var sunAz   = d.sunAz;     // Float32Array[nSteps] degrés
  var sunEl   = d.sunEl;     // Float32Array[nSteps] degrés
  var eMin    = d.eMin;      // degrés élévation min
  var eMax    = d.eMax;      // degrés élévation max

  var N       = W * H;
  var azStep  = 360.0 / nAz;
  var mask    = new Uint8Array(nSteps * N);
  var lastPct = 0;

  for (var t = 0; t < nSteps; t++) {
    var azSun  = sunAz[t];
    var elSun  = sunEl[t];
    var azNorm = ((azSun % 360) + 360) % 360;
    var azFrac = azNorm / azStep;
    var az0    = Math.floor(azFrac) % nAz;
    var az1    = (az0 + 1) % nAz;
    var frac   = azFrac - Math.floor(azFrac);
    var tOff   = t * N;

    for (var idx = 0; idx < N; idx++) {
      var hmaxP = hmax[idx] / 100.0;
      var hminP = hmin[idx] / 100.0;
      var m;
      if (hminP > eMax) {
        m = 1;  // fond de vallée — toujours ombre
      } else if (hmaxP < eMin) {
        m = 0;  // crête dégagée — jamais ombre
      } else {
        var h0 = horizon[idx * nAz + az0] / 100.0;
        var h1 = horizon[idx * nAz + az1] / 100.0;
        var hI = h0 + frac * (h1 - h0);
        m = (elSun < hI) ? 1 : 0;
        // B2 : incertitude bord
        if (bord[idx * nAz + az0] || bord[idx * nAz + az1]) m |= 0x02;
      }
      mask[tOff + idx] = m;
    }

    // Progress toutes les 5%
    var pct = Math.round((t + 1) / nSteps * 100);
    if (pct >= lastPct + 5) {
      lastPct = pct;
      self.postMessage({ type:'progress', pct:pct });
    }
  }

  // Restituer les buffers + le masque
  self.postMessage(
    { type:'done', mask:mask,
      horizon:horizon, hmin:hmin, hmax:hmax, bord:bord },
    [mask.buffer, horizon.buffer, hmin.buffer, hmax.buffer, bord.buffer]
  );
};
`;

// ── ÉTAT PASSE 1 — pool parallèle ────────────────────────────────────────────
let ombreAzCourant   = -1;   // prochain azimut à lancer
let ombreAzDone      = 0;    // nombre d'azimuts intégrés
let ombreElev1024    = null; // grille rééchantillonnée 1024×1024 (réutilisée)
let ombreResX        = null; // Float32Array[1024] resX par ligne
let ombreResY        = 0;    // m/pixel vertical
let ombreWorkerActif = null; // worker passe 2 (1 seul)
let ombrePool        = [];   // workers passe 1 actifs

function lancerOmbre() {
  if (!elevGrid || !GEO) {
    document.getElementById('vstatus').textContent = 'Charger un DSM d\'abord';
    return;
  }
  if (ombreRafId) { cancelAnimationFrame(ombreRafId); ombreRafId = 0; }
  // Tuer les workers passe 1 et passe 2 éventuellement actifs
  ombrePool.forEach(function(w){ w.terminate(); });
  ombrePool = [];
  if (ombreWorkerActif) { ombreWorkerActif.terminate(); ombreWorkerActif = null; }
  ombreRunning   = true;
  ombreAzCourant = 0;
  ombreAzDone    = 0;
  ombreHorizonPret = false;

  var W = OMBRE_DIM, H = OMBRE_DIM, N = W * H, nAz = OMBRE_N_AZ;
  var lat0 = GEO.latMin, lat1 = GEO.latMax;

  // Capturer source hypso (grille complète)
  var tmpCv  = new OffscreenCanvas(W, H);
  var tmpCtx = tmpCv.getContext('2d');
  tmpCtx.drawImage(oscHypso, 0, 0, imgW, imgH, 0, 0, W, H);
  ombreSrcImg = tmpCtx.getImageData(0, 0, W, H);

  // Métriques
  ombreResY = 111320 * (lat1 - lat0) / H;
  ombreResX = new Float32Array(H);
  for (var r = 0; r < H; r++) {
    var lat = lat1 - (r + 0.5) / H * (lat1 - lat0);
    ombreResX[r] = 111320 * Math.cos(lat * Math.PI / 180) *
                   (GEO.lonMax - GEO.lonMin) / W;
  }

  // Rééchantillonnage elevGrid → 1024×1024
  ombreElev1024 = new Float32Array(N);
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

  // Allouer la map horizon complète
  ombreHorizon = new Int16Array(N * nAz);
  ombreHmin    = new Int16Array(N);
  ombreHmax    = new Int16Array(N);
  ombreHbord   = new Uint8Array(N * nAz);
  ombreHmin.fill(9000);
  ombreHmax.fill(-9000);

  // Pool persistant : NW workers, grille envoyée 1 fois chacun, azimuts en file
  var NW = Math.min(OMBRE_N_AZ, navigator.hardwareConcurrency || 4);
  var blob = new Blob([HORIZON_WORKER_SRC], {type:'application/javascript'});
  var url  = URL.createObjectURL(blob);

  for (var k = 0; k < NW; k++) {
    var w = new Worker(url);
    ombrePool.push(w);
    var elevCopy = new Float32Array(ombreElev1024);
    var resXCopy = new Float32Array(ombreResX);
    w.postMessage({
      type: 'init', elev: elevCopy,
      W: W, H: H, resX_row: resXCopy, resY: ombreResY,
      nAz: nAz, R: OMBRE_R
    }, [elevCopy.buffer, resXCopy.buffer]);

    w.onmessage = ombreAzCallback;
    w.onerror   = function(err) {
      document.getElementById('vstatus').textContent = 'Erreur horizon: ' + err.message;
    };
    // Premier azimut de ce worker
    w.postMessage({ type: 'horizon', azIdx: ombreAzCourant++ });
  }
  URL.revokeObjectURL(url);
}

// ── ombreAzCallback — intègre un azimut, redonne du travail au worker ────────
function ombreAzCallback(ev) {
  var res = ev.data;
  if (res.type !== 'done') return;
  var w   = ev.target;
  var nAz = OMBRE_N_AZ, N = OMBRE_DIM * OMBRE_DIM;

  var az = res.azIdx;
  var hl = res.horizLine, bl = res.bordLine;
  for (var i = 0; i < N; i++) {
    ombreHorizon[i * nAz + az] = hl[i];
    ombreHbord  [i * nAz + az] = bl[i];
    if (hl[i] < ombreHmin[i]) ombreHmin[i] = hl[i];
    if (hl[i] > ombreHmax[i]) ombreHmax[i] = hl[i];
  }
  ombreAzDone++;
  document.getElementById('vstatus').textContent =
    '🏔️ Horizons ' + ombreAzDone + '/' + nAz + '…';
  document.getElementById('btn-ombre').textContent = '⏳ ' + ombreAzDone + '/' + nAz + '…';

  if (ombreAzCourant < nAz) {
    // Redonner du travail au même worker — pas de recréation
    w.postMessage({ type: 'horizon', azIdx: ombreAzCourant++ });
  } else {
    // Plus d'azimut à distribuer : ce worker a fini
    w.terminate();
    var idx = ombrePool.indexOf(w);
    if (idx >= 0) ombrePool.splice(idx, 1);
  }

  if (ombreAzDone === nAz) {
    ombreHorizonPret = true;
    document.getElementById('btn-ombre').textContent = '⏳ Passe 2…';
    lancerPasse2();
  }
}


// ── Passe 2 : position solaire + remplissage masque ──────────────────────────
function lancerPasse2() {
  document.getElementById('vstatus').textContent =
    '🏔️ Passe 2 : position solaire…';

  var W = OMBRE_DIM, H = OMBRE_DIM;
  var lat = (GEO.latMax + GEO.latMin) / 2;
  var lon = (GEO.lonMax + GEO.lonMin) / 2;

  var orb   = orbital(ctrlTka());
  var e     = orb.e, eps = orb.eps, pib = orb.pib;
  var pibar = pib + Math.PI;
  var latR  = lat * Math.PI / 180;

  var riseH = sunRiseSet(ctrlJour, e, eps, pibar, latR, lon);
  if (riseH.rise < 0) {
    document.getElementById('vstatus').textContent = 'Nuit polaire — pas d\'ombre';
    document.getElementById('btn-ombre').textContent = '🌑 Ombre';
    return;
  }

  var tStart = riseH.rise + 0.25;
	ombreHeureStart = tStart;
  var tEnd   = riseH.set  - 0.25;
  var nSteps = Math.max(1, Math.ceil((tEnd - tStart) / 0.25));
  ombreNSteps = nSteps;

  ombreSunAz = new Float32Array(nSteps);
  ombreSunEl = new Float32Array(nSteps);
  var eMin = Infinity, eMax = -Infinity;

  for (var t = 0; t < nSteps; t++) {
    var hUTC = tStart + t * 0.25;
    var pos  = sunPos(ctrlJour, hUTC, e, eps, pibar, latR, lon);
    ombreSunAz[t] = pos.az;
    ombreSunEl[t] = pos.el;
    if (pos.el < eMin) eMin = pos.el;
    if (pos.el > eMax) eMax = pos.el;
  }

  document.getElementById('vstatus').textContent =
    '🏔️ Passe 2 : masque ombre ' + nSteps + ' pas…';

  // Un seul worker passe 2 — reçoit tout par transfert zero-copy
  // Le worker retourne le masque complet + restitue les tableaux horizon
  var blob = new Blob([SHADOW_WORKER_SRC], {type:'application/javascript'});
  var url  = URL.createObjectURL(blob);
  var w    = new Worker(url);
  URL.revokeObjectURL(url);
  ombreWorkerActif = w;

  w.onmessage = function(ev) {
    var res = ev.data;
    if (res.type === 'progress') {
      document.getElementById('vstatus').textContent =
        '🏔️ Passe 2 : ' + res.pct + '% …';
      return;
    }
    if (res.type !== 'done') return;
    w.terminate();
    ombreMask    = res.mask;
    ombreHorizon = res.horizon;
    ombreHmin    = res.hmin;
    ombreHmax    = res.hmax;
    ombreHbord   = res.bord;
    // Copies permanentes pour lancerPasse2Seule (survivent aux transferts suivants)
    ombreHorizonCopy = new Int16Array(ombreHorizon);
    ombreHminCopy    = new Int16Array(ombreHmin);
    ombreHmaxCopy    = new Int16Array(ombreHmax);
    ombreHbordCopy   = new Uint8Array(ombreHbord);
    // 3.8+ : l'horizon est disponible → module insolation utilisable
    var biInsol = document.getElementById('btn-insol');
    if (biInsol) biInsol.disabled = false;
    ombreHorizonPret = true;
    lancerPasse3();
  };

  w.onerror = function(err) {
    document.getElementById('vstatus').textContent = 'Erreur passe 2: ' + err.message;
  };

  // Sauvegarder sunAz/El AVANT transfert (le worker les possède après)
  var sunAzSave = new Float32Array(ombreSunAz);
  var sunElSave = new Float32Array(ombreSunEl);

  // Transfert zero-copy — le worker possède les buffers pendant le calcul
  w.postMessage({
    type: 'shadow',
    W: W, H: H, nAz: OMBRE_N_AZ, nSteps: nSteps,
    horizon: ombreHorizon, hmin: ombreHmin,
    hmax: ombreHmax, bord: ombreHbord,
    sunAz: ombreSunAz, sunEl: ombreSunEl,
    eMin: eMin, eMax: eMax
  }, [ombreHorizon.buffer, ombreHmin.buffer,
      ombreHmax.buffer, ombreHbord.buffer,
      ombreSunAz.buffer, ombreSunEl.buffer]);

  // Restaurer les copies pour passe3 et ombreInstant
  ombreSunAz = sunAzSave;
  ombreSunEl = sunElSave;
  ombreHorizon = ombreHmin = ombreHmax = ombreHbord = null;
}

// ── Passe 3 — rendu à la demande (1 frame par changement de slider) ──────────
// ombreSliderDirty = true → afficher le pas courant → s'arrêter
// Pas de boucle RAF permanente : appelé uniquement quand un slider change
function lancerPasse3() {
  document.getElementById('vstatus').textContent =
    '🏔️ Masque prêt — ' + ombreNSteps + ' pas de 15 min — naviguez via les sliders';
  document.getElementById('btn-ombre').textContent = '⏹ Stop ombre';
  document.getElementById('btn-rec').disabled   = false;
  document.getElementById('btn-video').disabled = false;
  ombreStep    = 0;
  ombreRunning = true;
  document.getElementById('btn-ombre').classList.add('active');

  // Capturer la source hypso pleine résolution (srcX=0, srcY=0, srcPPx=1)
  // pour que ombreRedessiner() reste valide après tout zoom/pan ultérieur.
  var W = OMBRE_DIM, H = OMBRE_DIM;
  var osc = (typeof currentOSC === 'function') ? currentOSC() : oscHypso;
  if (!osc) { ombreRunning = false; return; }
  var tmpCv  = new OffscreenCanvas(W, H);
  var tmpCtx = tmpCv.getContext('2d');
  tmpCtx.drawImage(osc, 0, 0, imgW, imgH, 0, 0, W, H);
  ombrePasse3Src = tmpCtx.getImageData(0, 0, W, H);

  // Rendre la frame initiale (pas 0)
  ombreSliderDirty = true;
  ombreRendreFrame();
}

// Source image capturée pour passe 3 (réutilisée à chaque frame)
let ombrePasse3Src = null;
// OffscreenCanvas persistant — source du zoom/pan (comme insolOsc)
let ombreOsc = null;

// ── ombreRedessiner — repeint le canvas principal depuis ombreOsc (zoom/pan) ──
function ombreRedessiner() {
  if (!ombreOsc) return;
  var sw = DISP * srcPPx, sh = DISP * srcPPx;
  srcX = Math.max(0, Math.min(imgW - sw, srcX));
  srcY = Math.max(0, Math.min(imgH - sh, srcY));
  var sx = OMBRE_DIM / imgW, sy = OMBRE_DIM / imgH;
  ctx.clearRect(0, 0, DISP, DISP);
  ctx.drawImage(ombreOsc, srcX * sx, srcY * sy, sw * sx, sh * sy, 0, 0, DISP, DISP);
  document.getElementById('vinfo').textContent = 'zoom \u00d7' + (1 / srcPPx).toFixed(2);
}

// ── ombreRendreFrame — rend exactement 1 frame au pas ombreStep courant ──────
// Appelé par : lancerPasse3 (init) + ctrlChangerPas (slider heure)
function ombreRendreFrame() {
  if (!ombreRunning || !ombreMask || !ombrePasse3Src) return;
  if (!ombreSliderDirty) return;
  ombreSliderDirty = false;

  if (ombreRafId) { cancelAnimationFrame(ombreRafId); ombreRafId = 0; }
  ombreRafId = requestAnimationFrame(function() {
    ombreRafId = 0;
    if (!ombreRunning || !ombreMask || !ombrePasse3Src) return;

    var W   = OMBRE_DIM, H = OMBRE_DIM;
    var t   = Math.max(0, Math.min(ombreNSteps - 1, ombreStep));
    var off = t * W * H;

    var imgData = ctx.createImageData(W, H);
    var src = ombrePasse3Src.data, dst = imgData.data;

    for (var i = 0; i < W * H; i++) {
      var m = ombreMask[off + i];
      var p = i * 4;
      var f = (m & 0x01) ? ((m & 0x02) ? 0.50 : OMBRE_SHADE) : 1.0;
      dst[p]   = src[p]   * f;
      dst[p+1] = src[p+1] * f;
      dst[p+2] = src[p+2] * f;
      dst[p+3] = src[p+3];
    }
    // Stocker dans ombreOsc puis déléguer à ombreRedessiner (zoom/pan)
    if (!ombreOsc) ombreOsc = new OffscreenCanvas(W, H);
    ombreOsc.getContext('2d').putImageData(imgData, 0, 0);
    ombreRedessiner();

    var elStr = ombreSunEl ? ombreSunEl[t].toFixed(1) + '° él.' : '';
    var azStr = ombreSunAz ? '  az.' + ombreSunAz[t].toFixed(1) + '°' : '';
    document.getElementById('vstatus').textContent =
      '🏔️ Pas ' + (t + 1) + '/' + ombreNSteps + ' — Soleil: ' + elStr + azStr;
  });
}
// ── lancerPasse2Seule — recalcul passe 2 uniquement (horizon passe 1 conservé)
// Utilise les copies globales ombreHorizonCopy/* qui survivent aux transferts.
// soloLever=true (mode vidéo) : calcule UNIQUEMENT le pas du lever — gain ×40
function lancerPasse2Seule(soloLever) {
  if (!ombreHorizonCopy || !ombreElev1024) return;
  if (ombreWorkerActif) { ombreWorkerActif.terminate(); ombreWorkerActif = null; }

  var W = OMBRE_DIM, H = OMBRE_DIM;
  var lat = (GEO.latMax + GEO.latMin) / 2;
  var lon = (GEO.lonMax + GEO.lonMin) / 2;

  var orb   = orbital(ctrlTka());
  var e     = orb.e, eps = orb.eps, pib = orb.pib;
  var pibar = pib + Math.PI;
  var latR  = lat * Math.PI / 180;

  var riseH = sunRiseSet(ctrlJour, e, eps, pibar, latR, lon);
  if (riseH.rise < 0) {
    document.getElementById('vstatus').textContent = 'Nuit polaire — pas d\'ombre';
    if (videoRunning && videoFrameReady) videoFrameReady();   // ne pas bloquer la vidéo
    return;
  }

  var tStart = riseH.rise + 0.25;
  ombreHeureStart = tStart;
  var tEnd   = riseH.set - 0.25;
  var nSteps = soloLever ? 1 : Math.max(1, Math.ceil((tEnd - tStart) / 0.25));
  ombreNSteps = nSteps;

  ombreSunAz = new Float32Array(nSteps);
  ombreSunEl = new Float32Array(nSteps);
  var eMin = Infinity, eMax = -Infinity;
  for (var t = 0; t < nSteps; t++) {
    var hUTC = tStart + t * 0.25;
    var pos  = sunPos(ctrlJour, hUTC, e, eps, pibar, latR, lon);
    ombreSunAz[t] = pos.az;
    ombreSunEl[t] = pos.el;
    if (pos.el < eMin) eMin = pos.el;
    if (pos.el > eMax) eMax = pos.el;
  }

  document.getElementById('vstatus').textContent =
    '🏔️ Recalcul j' + (ctrlJour+1) + ' (' + jourVersDate(ctrlJour) + ') — ' + nSteps + ' pas…';

  var blob = new Blob([SHADOW_WORKER_SRC], {type:'application/javascript'});
  var url  = URL.createObjectURL(blob);
  var w    = new Worker(url);
  URL.revokeObjectURL(url);
  ombreWorkerActif = w;

  // Copies fraîches depuis les copies globales — transfert zero-copy vers le worker
  var horizXfr = new Int16Array(ombreHorizonCopy);
  var hminXfr  = new Int16Array(ombreHminCopy);
  var hmaxXfr  = new Int16Array(ombreHmaxCopy);
  var hbordXfr = new Uint8Array(ombreHbordCopy);
  var sunAzXfr = new Float32Array(ombreSunAz);
  var sunElXfr = new Float32Array(ombreSunEl);

  w.onmessage = function(ev) {
    var res = ev.data;
    if (res.type === 'progress') {
      document.getElementById('vstatus').textContent =
        '🏔️ Recalcul j' + (ctrlJour+1) + ' : ' + res.pct + '%…';
      return;
    }
    if (res.type !== 'done') return;
    w.terminate();
    ombreWorkerActif = null;
    ombreMask = res.mask;
    // Les buffers transférés sont consommés — on conserve les copies globales intactes

    // Mode vidéo : chemin court — pas de recapture ni de rendu panneau
    // (le RAF d'ombreRendreFrame écraserait l'overlay avant la capture JPEG)
    if (videoRunning && videoFrameReady) { videoFrameReady(); return; }

    // Recapturer la source hypso pour passe 3
    var osc2 = currentOSC();
    if (osc2) {
      var tmpCv2  = new OffscreenCanvas(W, H);
      var tmpCtx2 = tmpCv2.getContext('2d');
      tmpCtx2.drawImage(osc2, srcX, srcY, W * srcPPx, H * srcPPx, 0, 0, W, H);
      ombrePasse3Src = tmpCtx2.getImageData(0, 0, W, H);
    }

    // Positionner le slider heure au lever si hors plage
    var r2 = insolRise ? insolRise[ctrlJour] : -1;
    var s2 = insolSet  ? insolSet[ctrlJour]  : -1;
    if (r2 >= 0 && s2 >= 0) {
      if (ctrlHeure < r2 || ctrlHeure > s2) ctrlHeure = r2 + 0.001;
      insolHour = ctrlHeure;
    }
    ctrlRendrePanneau();   // → ctrlMajPas → ombreRendreFrame via dirty flag

    document.getElementById('vstatus').textContent =
      '🏔️ j' + (ctrlJour+1) + ' (' + jourVersDate(ctrlJour) + ') — ' + nSteps + ' pas prêts';
  };

  w.onerror = function(err) {
    document.getElementById('vstatus').textContent = 'Erreur recalcul: ' + err.message;
    ombreWorkerActif = null;
    if (videoRunning && videoFrameReady) videoFrameReady();
  };

  w.postMessage({
    type: 'shadow',
    W: W, H: H, nAz: OMBRE_N_AZ, nSteps: nSteps,
    horizon: horizXfr, hmin: hminXfr,
    hmax: hmaxXfr,     bord: hbordXfr,
    sunAz: sunAzXfr,   sunEl: sunElXfr,
    eMin: eMin, eMax: eMax
  }, [horizXfr.buffer, hminXfr.buffer,
      hmaxXfr.buffer,  hbordXfr.buffer,
      sunAzXfr.buffer, sunElXfr.buffer]);
}

// ── Bouton stop ombre ─────────────────────────────────────────────────────────
function stopOmbre() {
  ombreRunning = false;
  ombreOsc     = null;   // invalider le cache — render() reviendra à l'hypso
  if (ombreRafId) { cancelAnimationFrame(ombreRafId); ombreRafId = 0; }
  ombrePool.forEach(function(w){ w.terminate(); });
  ombrePool = [];
  if (ombreWorkerActif) { ombreWorkerActif.terminate(); ombreWorkerActif = null; }
  document.getElementById('btn-ombre').textContent = '🌑 Ombre';
  document.getElementById('btn-ombre').classList.remove('active');
  render();
}

// ── Hook render() — déléguer à ombreRedessiner quand ombre est active ─────────
// Monkey-patch identique au pattern insol/temp : on remplace render() par une
// version qui vérifie ombreRunning en premier, puis appelle l'original.
(function() {
  var _renderOrig = render;
  render = function() {
    if (ombreRunning && ombreOsc) { ombreRedessiner(); return; }
    _renderOrig();
  };
})();


// Simulation eau
let wet=null, border=null, simRunning=false;
let faucetIdx=-1, faucetElev=0, waterRise=0, waterLevel=0, touchesMer=false;
// ════════════════════════════════════════════════════════════════
// SIMULATION EAU — Set border-front, montée si bloqué
// ════════════════════════════════════════════════════════════════
function effectiveRise(){ return waterRise<=10 ? waterRise : 10+(waterRise-10)*2; }

function reachable(idx){
  const bElev=elevGrid[idx], eff=effectiveRise();
  const row=Math.floor(idx/imgW), col=idx%imgW;
  for(let dr=-1;dr<=1;dr++) for(let dc=-1;dc<=1;dc++){
    if(!dr&&!dc) continue;
    const nr=row+dr, nc=col+dc;
    if(nr<0||nr>=imgH||nc<0||nc>=imgW) continue;
    const nIdx=nr*imgW+nc;
    if(wet.has(nIdx)&&bElev<=elevGrid[nIdx]+eff) return true;
  }
  return false;
}

function addToWet(idx,c){
  wet.add(idx); border.delete(idx);
  const row=Math.floor(idx/imgW), col=idx%imgW;
  c.fillRect(col,row,1,1);
  for(let dr=-1;dr<=1;dr++) for(let dc=-1;dc<=1;dc++){
    if(!dr&&!dc) continue;
    const nr=row+dr, nc=col+dc;
    if(nr<0||nr>=imgH||nc<0||nc>=imgW) continue;
    const nIdx=nr*imgW+nc;
    if(wet.has(nIdx)) continue;
    const nv=elevGrid[nIdx];
    if(nv<=0.5){touchesMer=true; continue;}
    border.add(nIdx);
  }
}

function drawFaucetMarker(c,col,row){
  c.fillStyle='rgb(220,40,40)'; c.fillRect(col-2,row-2,5,5);
}

function simTick(){
  if(touchesMer){
    simRunning=false;
    document.getElementById('vstatus').textContent=
      `Mer atteinte — surf. ${waterLevel.toFixed(0)} m — ${wet.size.toLocaleString()} px`;
    render(); return;
  }
  if(border.size===0){
    simRunning=false;
    document.getElementById('vstatus').textContent='Simulation terminée';
    render(); return;
  }
  const c=oscWater.getContext('2d');
  c.fillStyle='rgba(0,20,80,.88)';
  let minE=Infinity;
  for(const idx of border){
    const bElev=elevGrid[idx];
    if(bElev<minE&&reachable(idx)) minE=bElev;
  }
  if(minE===Infinity){
    waterRise++;
    waterLevel=faucetElev+effectiveRise();
    document.getElementById('vstatus').textContent=
      `Montée +${waterRise} (pénétration ${effectiveRise().toFixed(0)} m) — surf. ${waterLevel.toFixed(0)} m — ${wet.size.toLocaleString()} px`;
    render(); return;
  }
  const toAdd=[];
  for(const idx of border)
    if(elevGrid[idx]<=minE+0.5&&reachable(idx)) toAdd.push(idx);
  for(const idx of toAdd) addToWet(idx,c);
  waterLevel=faucetElev+effectiveRise();
  if(faucetIdx>=0) drawFaucetMarker(c,faucetIdx%imgW,Math.floor(faucetIdx/imgW));
  document.getElementById('vstatus').textContent=
    `Surf. ${waterLevel.toFixed(0)} m (+${waterRise} m) — ${wet.size.toLocaleString()} px — front ${border.size.toLocaleString()}`;
  render();
}

function resetSim(){
  simRunning=false;
  wet=null; border=null; faucetIdx=-1;
  faucetElev=0; waterRise=0; waterLevel=0; touchesMer=false;
  if(oscWater) oscWater.getContext('2d').clearRect(0,0,oscWater.width,oscWater.height);
  render();
  document.getElementById('vstatus').textContent=
    'Clic droit = poser le robinet  |  Espace = reset';
}

function placeFaucet(col,row){
  if(!elevGrid||col<0||col>=imgW||row<0||row>=imgH) return;
  const v=elevGrid[row*imgW+col]; if(v<=0.5) return;
  resetSim();
  faucetIdx=row*imgW+col; faucetElev=v;
  waterRise=0; waterLevel=v; touchesMer=false;
  wet=new Set(); border=new Set();
  const c=oscWater.getContext('2d');
  c.fillStyle='rgba(0,20,80,.88)';
  addToWet(faucetIdx,c); drawFaucetMarker(c,col,row);
  render();
  simRunning=true; requestAnimationFrame(simLoop);
  document.getElementById('vstatus').textContent=`Robinet — sol ${v.toFixed(0)} m`;
}

function simLoop(){ if(!simRunning) return; simTick(); if(simRunning) requestAnimationFrame(simLoop); }

canvas.addEventListener('contextmenu',e=>{
  e.preventDefault(); if(!elevGrid) return;
  const r=canvas.getBoundingClientRect();
  const cx=(e.clientX-r.left)/r.width, cy=(e.clientY-r.top)/r.height;
  placeFaucet(Math.round(srcX+cx*DISP*srcPPx), Math.round(srcY+cy*DISP*srcPPx));
});
window.addEventListener('keydown',e=>{ if(e.code==='Space'){e.preventDefault(); resetSim();} });
