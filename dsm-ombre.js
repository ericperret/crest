/* ═══════════════════════════════════════════════════════════════════
   FICHIER : dsm-ombre.js - v27/09/2026
   OBJET   : ombres portées sur la grille 1024² : horizons sur 64
             azimuts (passe 1, pool de Workers), masques d'ombre d'une
             journée (passe 2), rendu ombré et film des heures (passe 3) ;
             lever/coucher sur l'année ; simulation « robinet » de
             remplissage d'eau (clic droit).
   AUTEUR  : Eric P.
   RELECTURE : Opus 5.5
   LICENCE : CC BY-NC 4.0 — source à citer : https://github.com/ericperret/crest/
             usage commercial interdit sauf accord écrit de l'auteur (voir LICENSE)
   DÉPEND  : dsm-astro.js (ASTRO_INJECT, orbital, sunRiseSet, sunPos),
             dsm.html (GEO, imgW, imgH, elevGrid, oscHypso, currentOSC, ctx,
             canvas, render, vue courante, panneau ctrl*)
   EXPOSE  : ombreElev1024, ombreResX, ombreResY, ombreHorizonCopy,
             OMBRE_DIM, OMBRE_N_AZ, lancerOmbre, lancerPasse2,
             lancerPasse2Seule, stopOmbre, resetSim, placeFaucet, eauNiveau,
             eauNb, waterLevel, …
   CONVENTIONS : azimut 0 = nord, sens horaire ; horizons en centi-degrés
             (Int16) ; heures solaires locales
   ═══════════════════════════════════════════════════════════════════ */
"use strict";

let insolRise = null, insolSet = null;
let insolDay  = 172;
let insolHour = -1;
let ombreHorizonPret = false;
let insolWorker = null;

const MOIS = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];
const MOIS_DEBUT = [0,31,59,90,120,151,181,212,243,273,304,334];

/* ── jourVersDate ── E : j (0..364) → T : mois par table des débuts de mois
   (année non bissextile) → S : « Mmm J ». */
function jourVersDate(j) {
  var m = 11;
  for (var i = 0; i < 12; i++) if (j < MOIS_DEBUT[i+1 < 12 ? i+1 : 12]) { m=i; break; }
  var d = j - MOIS_DEBUT[m] + 1;
  return MOIS[m] + ' ' + d;
}

/* ── hDecToHHMM ── E : heure décimale → T : heures et minutes arrondies,
   « nuit » si négative → S : « HHhMM ». */
function hDecToHHMM(h) {
  if (h < 0) return 'nuit';
  var hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  if (mm === 60) { hh++; mm = 0; }
  return String(hh).padStart(2,'0') + 'h' + String(mm).padStart(2,'0');
}

const INSOL_WORKER_SRC = `
// Worker 'sunpath' — E : lat (rad), lon, t_ka → T : orbite, sunRiseSet pour
// j = 1..365 → S : { rise, set } Float32Array[365] (heures solaires locales).
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
/* ── lancerInsolation ── E : GEO, ctrlTka() → T : Worker (ASTRO_INJECT +
   source 'sunpath') qui calcule lever et coucher des 365 jours au centre
   de la tuile ; au retour, cale l'heure du panneau dans le jour → S :
   insolRise, insolSet (Float32Array[365]). */
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
    insolDay = ctrlJour;
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

const OMBRE_N_AZ  = 64;
const OMBRE_R     = 6371000;
const OMBRE_DIM   = 1024;
const OMBRE_SHADE = 0.35;

let ombreHorizon   = null;
let ombreHmin      = null;
let ombreHmax      = null;
let ombreHbord     = null;
let ombreHorizonCopy = null;
let ombreHminCopy    = null;
let ombreHmaxCopy    = null;
let ombreHbordCopy   = null;
let ombreMask      = null;
let ombreSunAz     = null;
let ombreSunEl     = null;
let ombreNSteps    = 0;
let ombreHeureStart = 0;
let ombreRafId     = 0;
let ombreStep      = 0;
let ombreRunning   = false;
let ombreSliderDirty = false;

const HORIZON_WORKER_SRC = `
"use strict";
// ── Passe 1 Variante B : balayage transformé le long de lignes d'azimut ──────
// Source physique : spec §3.1 — transformée z'(s) = z(s) - s²/(2R)
// La pente vraie P→Q = [z'(Q)-z'(P)]/(d) + s_P/R  (démontrée dans spec §3.1)
// L'argmax sur Q est inchangé dans l'espace transformé.
// Algorithme horizon O(N) amorti : pile de crêtes dominantes (convex hull)

// Worker d'horizon — E : 'init' (grille 1024², resX par ligne, resY, nAz,
// R) gardée en mémoire ; 'horizon' (azIdx) → T : lignes parallèles à
// l'azimut couvrant la grille (départ sur les bords amont), échantillonnage
// bilinéaire tous les pixels, altitude corrigée de la courbure z − s²/2R ;
// en remontant chaque ligne, enveloppe convexe supérieure (pile) des
// points vus ; horizon de P = pente vers le sommet de la pile + s_P/R ;
// drapeau « bord » si l'horizon est donné par le dernier point de la ligne
// → S : Int16 centi-degrés par pixel pour cet azimut, drapeaux de bord.
// ALGO : « Horizon exact le long de lignes d'azimut en O(N) par
// enveloppe convexe, courbure terrestre incluse. »
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

const SHADOW_WORKER_SRC = `
"use strict";
// Worker d'ombre — E : horizons (nAz par pixel), hmin/hmax, drapeaux de
// bord, positions du Soleil (nSteps) → T : par pixel, jamais à l'ombre si
// hmax < élévation min du jour, toujours si hmin > élévation max ; sinon,
// par pas, horizon interpolé entre les deux azimuts encadrants comparé à
// l'élévation → S : Uint8 par pas et pixel (bit 0 ombre, bit 1 bord).
// ALGO : « Masque d'ombre par comparaison élévation solaire / horizon
// interpolé en azimut. »
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

let ombreAzCourant   = -1;
let ombreAzDone      = 0;
let ombreElev1024    = null;
let ombreResX        = null;
let ombreResY        = 0;
let ombreWorkerActif = null;
let ombrePool        = [];

/* ── lancerOmbre ─────────────────────────────────────────────────────────
   ENTRÉE     : elevGrid (imgW × imgH), GEO
   TRAITEMENT : rééchantillonne l'altitude en 1024² (bilinéaire, coins
                alignés) ; resX par ligne (m, cos φ) et resY ; lance le calcul
                de lever/coucher ; crée un pool de Workers d'horizon qui
                reçoivent la grille une fois, puis leur distribue les 64
                azimuts (ombreAzCallback)
   SORTIE     : ombreElev1024, ombreResX, ombreResY ; passe 1 en cours
   ALGO       : « Prépare la grille métrique 1024² et lance le calcul des
                horizons en parallèle, un azimut par tâche. »
   ─────────────────────────────────────────────────────────────────── */
function lancerOmbre() {
  if (!elevGrid || !GEO) {
    document.getElementById('vstatus').textContent = 'Charger un DSM d\'abord';
    return;
  }
  if (ombreRafId) { cancelAnimationFrame(ombreRafId); ombreRafId = 0; }
  ombrePool.forEach(function(w){ w.terminate(); });
  ombrePool = [];
  if (ombreWorkerActif) { ombreWorkerActif.terminate(); ombreWorkerActif = null; }
  ombreRunning   = true;
  ombreAzCourant = 0;
  ombreAzDone    = 0;
  ombreHorizonPret = false;

  var W = OMBRE_DIM, H = OMBRE_DIM, N = W * H, nAz = OMBRE_N_AZ;
  var lat0 = GEO.latMin, lat1 = GEO.latMax;

  ombreResY = 111320 * (lat1 - lat0) / H;
  ombreResX = new Float32Array(H);
  for (var r = 0; r < H; r++) {
    var lat = lat1 - (r + 0.5) / H * (lat1 - lat0);
    ombreResX[r] = 111320 * Math.cos(lat * Math.PI / 180) *
                   (GEO.lonMax - GEO.lonMin) / W;
  }

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

  ombreHorizon = new Int16Array(N * nAz);
  ombreHmin    = new Int16Array(N);
  ombreHmax    = new Int16Array(N);
  ombreHbord   = new Uint8Array(N * nAz);
  ombreHmin.fill(9000);
  ombreHmax.fill(-9000);

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
    w.postMessage({ type: 'horizon', azIdx: ombreAzCourant++ });
  }
  URL.revokeObjectURL(url);
}

/* ── ombreAzCallback ── E : réponse d'un Worker d'horizon (azimut, horizon,
   drapeaux de bord) → T : range la tranche dans ombreHorizon, met à jour
   hmin/hmax par pixel, relance le Worker sur l'azimut suivant ; à la fin,
   termine le pool et enchaîne la passe 2 → S : aucune. */
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
    w.postMessage({ type: 'horizon', azIdx: ombreAzCourant++ });
  } else {
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

/* ── lancerPasse2 ────────────────────────────────────────────────────────
   ENTRÉE     : horizons (passe 1), jour et heure du panneau, t_ka
   TRAITEMENT : lever/coucher du jour ; nuit polaire → publie les horizons
                et s'arrête ; sinon position du Soleil tous les 15 min ;
                copies des horizons pour l'insolation ; Worker d'ombre qui
                produit un masque par pas
   SORTIE     : ombreMask (nSteps × 1024²), ombreSunAz/El ; passe 3
   ALGO       : « Masques d'ombre d'une journée à partir des horizons
                précalculés. »
   ─────────────────────────────────────────────────────────────────── */
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

  var riseH = sunRiseSet(ctrlJour + 1, e, eps, pibar, latR, lon);
  if (riseH.rise < 0) {
    /* Horizons valables quand même : on les publie pour insol / glacier */
    ombreHorizonCopy = new Int16Array(ombreHorizon);
    ombreHminCopy    = new Int16Array(ombreHmin);
    ombreHmaxCopy    = new Int16Array(ombreHmax);
    ombreHbordCopy   = new Uint8Array(ombreHbord);
    ombreMask = null; ombreRunning = false;
    var biInsolN = document.getElementById('btn-insol');
    if (biInsolN) biInsolN.disabled = false;
    document.getElementById('vstatus').textContent = 'Nuit polaire — pas d\'ombre (horizons prêts)';
    document.getElementById('btn-ombre').textContent = '🌑 Ombre';
    document.getElementById('btn-ombre').classList.remove('active');
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
    var hLoc = tStart + t * 0.25;
    var pos  = sunPos(ctrlJour + 1, hLoc, e, eps, pibar, latR, lon);
    ombreSunAz[t] = pos.az;
    ombreSunEl[t] = pos.el;
    if (pos.el < eMin) eMin = pos.el;
    if (pos.el > eMax) eMax = pos.el;
  }

  document.getElementById('vstatus').textContent =
    '🏔️ Passe 2 : masque ombre ' + nSteps + ' pas…';

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
    ombreHorizonCopy = new Int16Array(ombreHorizon);
    ombreHminCopy    = new Int16Array(ombreHmin);
    ombreHmaxCopy    = new Int16Array(ombreHmax);
    ombreHbordCopy   = new Uint8Array(ombreHbord);
    var biInsol = document.getElementById('btn-insol');
    if (biInsol) biInsol.disabled = false;
    ombreHorizonPret = true;
    lancerPasse3();
  };

  w.onerror = function(err) {
    document.getElementById('vstatus').textContent = 'Erreur passe 2: ' + err.message;
  };

  var sunAzSave = new Float32Array(ombreSunAz);
  var sunElSave = new Float32Array(ombreSunEl);

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

  ombreSunAz = sunAzSave;
  ombreSunEl = sunElSave;
  ombreHorizon = ombreHmin = ombreHmax = ombreHbord = null;
}

/* ── lancerPasse3 ── E : image de fond courante (hypso ou courbes) → T :
   la ramène en 1024² (ombrePasse3Src), active le rendu ombré au pas de
   l'heure choisie → S : affichage. */
function lancerPasse3() {
  document.getElementById('vstatus').textContent =
    '🏔️ Masque prêt — ' + ombreNSteps + ' pas de 15 min — naviguez via les sliders';
  document.getElementById('btn-ombre').textContent = '⏹ Stop ombre';
  document.getElementById('btn-rec').disabled   = false;
  document.getElementById('btn-video').disabled = false;
  ombreStep    = 0;
  ombreRunning = true;
  document.getElementById('btn-ombre').classList.add('active');

  var W = OMBRE_DIM, H = OMBRE_DIM;
  var osc = (typeof currentOSC === 'function') ? currentOSC() : oscHypso;
  if (!osc) { ombreRunning = false; return; }
  var tmpCv  = new OffscreenCanvas(W, H);
  var tmpCtx = tmpCv.getContext('2d');
  tmpCtx.drawImage(osc, 0, 0, imgW, imgH, 0, 0, W, H);
  ombrePasse3Src = tmpCtx.getImageData(0, 0, W, H);

  ombreSliderDirty = true;
  ombreRendreFrame();
}

let ombrePasse3Src = null;
let ombreOsc = null;

/* ── ombreRedessiner ── E : ombreOsc, vue courante → T : recadre la vue et
   dessine l'image ombrée à l'échelle, sans lissage → S : dessin. */
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

/* ── ombreRendreFrame ── E : pas courant, masque, fond → T : sur l'image
   suivante, assombrit le fond (×0,35 à l'ombre, ×0,5 au bord de tuile) et
   met à jour le message Soleil → S : ombreOsc ; affichage. */
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
    if (!ombreOsc) ombreOsc = new OffscreenCanvas(W, H);
    ombreOsc.getContext('2d').putImageData(imgData, 0, 0);
    ombreRedessiner();

    var elStr = ombreSunEl ? ombreSunEl[t].toFixed(1) + '° él.' : '';
    var azStr = ombreSunAz ? '  az.' + ombreSunAz[t].toFixed(1) + '°' : '';
    document.getElementById('vstatus').textContent =
      '🏔️ Pas ' + (t + 1) + '/' + ombreNSteps + ' — Soleil: ' + elStr + azStr;
  });
}
/* ── lancerPasse2Seule ── E : soloLever (vidéo) ou rien → T : même calcul
   que lancerPasse2 en réutilisant les horizons déjà prêts (changement de
   jour ou d'année) ; en vidéo, un seul pas au lever + 15 min et appel de
   videoFrameReady → S : ombreMask ; affichage ou image de film. */
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

  var riseH = sunRiseSet(ctrlJour + 1, e, eps, pibar, latR, lon);
  if (riseH.rise < 0) {
    document.getElementById('vstatus').textContent = 'Nuit polaire — pas d\'ombre';
    if (videoRunning && videoFrameReady) videoFrameReady();
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
    var hLoc = tStart + t * 0.25;
    var pos  = sunPos(ctrlJour + 1, hLoc, e, eps, pibar, latR, lon);
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

    if (videoRunning && videoFrameReady) { videoFrameReady(); return; }

    var osc2 = currentOSC();
    if (osc2) {
      var tmpCv2  = new OffscreenCanvas(W, H);
      var tmpCtx2 = tmpCv2.getContext('2d');
      tmpCtx2.drawImage(osc2, 0, 0, imgW, imgH, 0, 0, W, H);
      ombrePasse3Src = tmpCtx2.getImageData(0, 0, W, H);
    }

    var r2 = insolRise ? insolRise[ctrlJour] : -1;
    var s2 = insolSet  ? insolSet[ctrlJour]  : -1;
    if (r2 >= 0 && s2 >= 0) {
      if (ctrlHeure < r2 || ctrlHeure > s2) ctrlHeure = r2 + 0.001;
      insolHour = ctrlHeure;
    }
    ctrlRendrePanneau();

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

/* ── stopOmbre ── E : aucune → T : termine les Workers, ombreRunning faux,
   bouton remis, redessin → S : aucune. */
function stopOmbre() {
  ombreRunning = false;
  ombreOsc     = null;
  if (ombreRafId) { cancelAnimationFrame(ombreRafId); ombreRafId = 0; }
  ombrePool.forEach(function(w){ w.terminate(); });
  ombrePool = [];
  if (ombreWorkerActif) { ombreWorkerActif.terminate(); ombreWorkerActif = null; }
  document.getElementById('btn-ombre').textContent = '🌑 Ombre';
  document.getElementById('btn-ombre').classList.remove('active');
  render();
}

/* Surcharge de render : pendant une ombre, l'image ombrée remplace le fond. */
(function() {
  var _renderOrig = render;
  render = function() {
    if (ombreRunning && ombreOsc) { ombreRedessiner(); return; }
    _renderOrig();
  };
})();

/* ═══ SIMULATION « ROBINET » (clic droit) ═══════════════════════════
   Modèle : l'eau ne monte que dans le bassin terminal (le plus aval) ;
   les bassins amont, pleins jusqu'à leur seuil, sont gelés et gardent
   leur front. Chaque bassin = racine d'un union-find, avec son niveau
   de surface et un tas-min de son front. Un débordement (cellule de
   front plus basse que le niveau) crée un nouveau bassin terminal ;
   un bassin gelé voisin est absorbé quand le niveau terminal atteint
   le sien (entrée « lien » du tas, clé = niveau du bassin voisin).
   Pont : si la surface (sol + épaisseur d'eau) dépasse l'altitude du
   pixel situé PONT_PORTEE pixels plus loin, l'eau passe sous l'obstacle
   (entrée « pont » du tas, clé = altitude d'atterrissage + PONT_EPS).
   ═══════════════════════════════════════════════════════════════════ */
let eauParent=null, eauNiv=null, eauTas=null;
let eauActif=-1, eauNb=0, eauBassins=0, eauFin='';
let simRunning=false, faucetIdx=-1, waterLevel=0;
const EAU_BUDGET_MS=12;
const EAU_COULEUR='rgba(0,20,80,.88)';
const PONT_PORTEE=2;     // distance (px) du bord mouillé au pixel d'atterrissage
const PONT_EPS=0.01;     // m : la surface doit dépasser strictement l'atterrissage

/* ── TasMin ── E : capacité initiale → T : tas binaire min sur (indice,
   clé) en tableaux typés, doublement à saturation → S : objet push/pop ;
   pop renvoie l'indice et laisse la clé dans this.cle. */
function TasMin(cap){
  this.i=new Int32Array(cap); this.k=new Float32Array(cap); this.n=0; this.cle=0;
}
TasMin.prototype.push=function(idx,key){
  if(this.n===this.i.length){
    const ni=new Int32Array(this.n*2), nk=new Float32Array(this.n*2);
    ni.set(this.i); nk.set(this.k); this.i=ni; this.k=nk;
  }
  let j=this.n++;
  while(j>0){
    const p=(j-1)>>1;
    if(this.k[p]<=key) break;
    this.i[j]=this.i[p]; this.k[j]=this.k[p]; j=p;
  }
  this.i[j]=idx; this.k[j]=key;
};
TasMin.prototype.pop=function(){
  const top=this.i[0]; this.cle=this.k[0];
  const n=--this.n, li=this.i[n], lk=this.k[n];
  let j=0;
  for(;;){
    let m=2*j+1; if(m>=n) break;
    if(m+1<n&&this.k[m+1]<this.k[m]) m++;
    if(this.k[m]>=lk) break;
    this.i[j]=this.i[m]; this.k[j]=this.k[m]; j=m;
  }
  this.i[j]=li; this.k[j]=lk;
  return top;
};

/* ── eauRacine ── E : indice de pixel mouillé → T : remontée union-find
   avec compression par demi-chemin → S : indice racine du bassin. */
function eauRacine(x){
  const p=eauParent;
  while(p[x]!==x){ p[x]=p[p[x]]; x=p[x]; }
  return x;
}

/* ── eauNiveau ── E : indice de pixel → T : niveau de la racine si
   mouillé → S : altitude de surface (m) ou NaN si sec. */
function eauNiveau(idx){
  return (eauParent&&eauParent[idx]!==-1) ? eauNiv[eauRacine(idx)] : NaN;
}

/* ── eauMouiller ── E : pixel, racine de son bassin, contexte 2D →
   T : rattache le pixel, le peint, pousse ses 8 voisins dans le tas du
   bassin (sec : clé = altitude ; mouillé d'un autre bassin : clé =
   niveau de ce bassin ; nodata ≥ 9000 ignoré = paroi) ; dans chaque
   direction, si le voisin est plus haut que le pixel courant et que le
   pixel à PONT_PORTEE, pousse ce dernier en entrée « pont » (sec : clé =
   altitude + PONT_EPS ; autre bassin : clé = son niveau) ; pixel au bord
   de grille → fin « bord » → S : aucune. */
function eauMouiller(idx,rac,c){
  eauParent[idx]=rac; eauNb++;
  const row=(idx/imgW)|0, col=idx-row*imgW;
  c.fillRect(col,row,1,1);
  if(row===0||col===0||row===imgH-1||col===imgW-1) eauFin='bord';
  const T=eauTas.get(rac);
  for(let dr=-1;dr<=1;dr++) for(let dc=-1;dc<=1;dc++){
    if(!dr&&!dc) continue;
    const nr=row+dr, nc=col+dc;
    if(nr<0||nr>=imgH||nc<0||nc>=imgW) continue;
    const n=nr*imgW+nc;
    if(eauParent[n]===-1){
      const v=elevGrid[n];
      if(v<9000) T.push(n,v);
      const lr=row+PONT_PORTEE*dr, lc=col+PONT_PORTEE*dc;
      if(lr<0||lr>=imgH||lc<0||lc>=imgW) continue;
      const l=lr*imgW+lc, vl=elevGrid[l];
      if(vl>=9000) continue;
      if(eauParent[l]===-1){
        if(v>elevGrid[idx]&&v>vl+PONT_EPS) T.push(l,vl+PONT_EPS);
      } else {
        const r=eauRacine(l);
        if(r!==rac&&v>elevGrid[idx]&&v>eauNiv[r]) T.push(l,eauNiv[r]);
      }
    } else {
      const r=eauRacine(n);
      if(r!==rac) T.push(n,eauNiv[r]);
    }
  }
}

/* ── eauFusion ── E : racine d'un bassin gelé → T : union avec le bassin
   actif, le plus petit tas versé dans le plus grand, niveau = max des
   deux, la racine au plus grand tas devient l'actif → S : aucune. */
function eauFusion(r){
  const a=eauActif, Ta=eauTas.get(a), Tr=eauTas.get(r);
  const [gr,pt,Tg,Tp]= Ta.n>=Tr.n ? [a,r,Ta,Tr] : [r,a,Tr,Ta];
  for(let j=0;j<Tp.n;j++) Tg.push(Tp.i[j],Tp.k[j]);
  eauTas.delete(pt);
  eauParent[pt]=gr;
  eauNiv[gr]=Math.max(eauNiv[a],eauNiv[r]);
  eauActif=gr; eauBassins--;
}

/* ── eauEtape ── E : contexte 2D → T : dépile le minimum du front du
   bassin actif ; lien vers autre bassin → fusion ; mer → fin « mer » ;
   entrée « pont » (clé > altitude) → le niveau monte à la clé, puis
   débordement sous l'obstacle ; altitude ≥ niveau → le bassin monte et
   absorbe le pixel ; altitude < niveau → débordement : le pixel fonde
   un nouveau bassin actif ; front vide → fin « fermé » → S : aucune. */
function eauEtape(c){
  const T=eauTas.get(eauActif);
  if(T.n===0){ eauFin='fermé'; return; }
  const idx=T.pop(), cle=T.cle;
  if(eauParent[idx]!==-1){
    const r=eauRacine(idx);
    if(r!==eauActif) eauFusion(r);
    return;
  }
  const v=elevGrid[idx];
  if(v<=0.5){ eauFin='mer'; return; }
  if(cle>v&&eauNiv[eauActif]<cle) eauNiv[eauActif]=cle;
  if(v>=eauNiv[eauActif]){
    eauNiv[eauActif]=v;
    eauMouiller(idx,eauActif,c);
  } else {
    eauNiv[idx]=v; eauTas.set(idx,new TasMin(16));
    eauActif=idx; eauBassins++;
    eauMouiller(idx,idx,c);
  }
}

/* ── drawFaucetMarker ── E : contexte 2D, colonne, ligne → T : carré
   rouge 5×5 centré → S : aucune. */
function drawFaucetMarker(c,col,row){
  c.fillStyle='rgb(220,40,40)'; c.fillRect(col-2,row-2,5,5);
  c.fillStyle=EAU_COULEUR;
}

/* ── eauStatut ── E : aucune → T : texte d'état selon eauFin → S :
   chaîne pour #vstatus. */
function eauStatut(){
  const s=`surf. ${waterLevel.toFixed(0)} m — ${eauNb.toLocaleString()} px — ${eauBassins} bassin(s)`;
  if(eauFin==='mer')   return 'Mer atteinte — '+s;
  if(eauFin==='bord')  return 'Bord de carte atteint — '+s;
  if(eauFin==='fermé') return 'Cuvette fermée noyée — '+s;
  return 'Remplissage — '+s;
}

/* ── simTick ── E : aucune → T : enchaîne eauEtape pendant EAU_BUDGET_MS,
   met à jour waterLevel (niveau du bassin actif), le statut et le rendu,
   arrête la simulation si eauFin est posé → S : aucune. */
function simTick(){
  const c=oscWater.getContext('2d');
  c.fillStyle=EAU_COULEUR;
  const t0=performance.now();
  while(!eauFin&&performance.now()-t0<EAU_BUDGET_MS)
    for(let k=0;k<512&&!eauFin;k++) eauEtape(c);
  waterLevel=eauNiv[eauRacine(eauActif)];
  drawFaucetMarker(c,faucetIdx%imgW,(faucetIdx/imgW)|0);
  if(eauFin) simRunning=false;
  document.getElementById('vstatus').textContent=eauStatut();
  render();
}

/* ── resetSim ── E : aucune → T : arrête la simulation, libère les
   structures, efface le calque eau, redessine → S : aucune. */
function resetSim(){
  simRunning=false;
  eauParent=null; eauNiv=null; eauTas=null;
  eauActif=-1; eauNb=0; eauBassins=0; eauFin='';
  faucetIdx=-1; waterLevel=0;
  if(oscWater) oscWater.getContext('2d').clearRect(0,0,oscWater.width,oscWater.height);
  render();
  document.getElementById('vstatus').textContent=
    'Clic droit = poser le robinet  |  Espace = reset';
}

/* ── placeFaucet ── E : colonne, ligne dans la grille → T : refuse mer et
   nodata, réinitialise, crée le bassin initial (racine = robinet, niveau
   = sol), mouille le robinet, lance la boucle d'animation → S : aucune. */
function placeFaucet(col,row){
  if(!elevGrid||col<0||col>=imgW||row<0||row>=imgH) return;
  const idx=row*imgW+col, v=elevGrid[idx];
  if(v<=0.5||v>=9000) return;
  resetSim();
  const N=imgW*imgH;
  eauParent=new Int32Array(N).fill(-1);
  eauNiv=new Float32Array(N);
  eauTas=new Map();
  faucetIdx=idx; eauActif=idx; eauBassins=1;
  eauNiv[idx]=v; waterLevel=v;
  eauTas.set(idx,new TasMin(64));
  const c=oscWater.getContext('2d');
  c.fillStyle=EAU_COULEUR;
  eauMouiller(idx,idx,c);
  drawFaucetMarker(c,col,row);
  render();
  document.getElementById('vstatus').textContent=`Robinet — sol ${v.toFixed(0)} m`;
  simRunning=true; requestAnimationFrame(simLoop);
}

/* ── simLoop ── E : aucune → T : un simTick par trame tant que
   simRunning → S : aucune. */
function simLoop(){ if(!simRunning) return; simTick(); if(simRunning) requestAnimationFrame(simLoop); }

canvas.addEventListener('contextmenu',e=>{
  e.preventDefault(); if(!elevGrid) return;
  const r=canvas.getBoundingClientRect();
  const cx=(e.clientX-r.left)/r.width, cy=(e.clientY-r.top)/r.height;
  placeFaucet(Math.round(srcX+cx*DISP*srcPPx), Math.round(srcY+cy*DISP*srcPPx));
});
window.addEventListener('keydown',e=>{ if(e.code==='Space'){e.preventDefault(); resetSim();} });
