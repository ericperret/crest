/* ═══════════════════════════════════════════════════════════════════
   FICHIER : dsm-insol.js - v27/09/2026
   OBJET   : insolation directe par pixel avec masques d'horizon :
             moyenne annuelle (bouton Insol) et carte d'une journée (bilan
             de masse glacier). Histogramme solaire (azimut × élévation)
             calculé une fois, puis intégré par pixel dans un pool de
             Workers qui gardent l'horizon en mémoire.
   AUTEUR  : Eric P.
   RELECTURE : Opus 5.5
   DÉPEND  : dsm-astro.js (orbital, sunRiseSet, sunPos), dsm-ombre.js
             (ombreElev1024, ombreHorizonCopy, ombreResX, ombreResY,
             OMBRE_DIM, OMBRE_N_AZ), dsm.html (ctx, render, ctrlTka,
             ctrlAnnee, vue courante, GEO)
   EXPOSE  : insolHistogramme, insolHistogrammeJour, insolCumuls,
             insolCarte, insolationJour, insolationEpoque, insolPoolFermer,
             insolRecalcul, insolAfficher, INSOL_*
   CONVENTIONS : histogramme en heures pondérées par la transmission ;
             W/m² = heures × S0 / 8766 (moyenne annuelle) ; azimut 0 =
             nord ; élévation par pas de 0,25°
   ⚠ Rayonnement direct seul : pas de diffus ni de réfléchi, qui dominent
     à l'ombre et sur neige. Transmission 0,75^masse d'air sans altitude.
   ═══════════════════════════════════════════════════════════════════ */
"use strict";

const INSOL_ATM     = true;
const INSOL_EL_PAS  = 0.25;
const INSOL_EL_NB   = 360;
const INSOL_JOUR_PAS = 5;
const INSOL_H_PAS   = 0.25;
const INSOL_S0      = 1361;
const INSOL_W_PAR_H = INSOL_S0 / 8766;
const INSOL_PCT_BAS  = 2;
const INSOL_PCT_HAUT = 98;

let insolActive  = false;
let insolMap     = null;
let insolMapTka  = null;
let insolCache   = [];
let insolEnCours = null;
let insolTestsFaits = false;
let insolLUTtab  = null;
let insolMn = 0, insolMx = 1;
let insolImgData = null;
let insolOsc     = null;

/* ── insolHistogramme ─────────────────────────────────────────────────
   ENTRÉE     : t_ka ; GEO (centre de la tuile)
   TRAITEMENT : orbite de l'époque ; un jour sur 5 (73 jours), pas de
                15 min entre lever et coucher ; position du Soleil ; poids =
                0,25 h × 5 j × 0,75^(1/sin él) (masse d'air plafonnée à 40),
                cumulé dans la case (azimut sur 64, élévation par 0,25°)
   SORTIE     : Float64Array nAz × 361 (heures pondérées par an)
   ALGO       : « Histogramme annuel des positions du Soleil au centre de la
                tuile, pondéré par la durée et la transmission
                atmosphérique. »
   ─────────────────────────────────────────────────────────────────── */
function insolHistogramme(t_ka) {
  var nAz   = OMBRE_N_AZ;
  var NB    = INSOL_EL_NB + 1;
  var W     = new Float64Array(nAz * NB);
  var orb   = orbital(t_ka);
  var pibar = orb.pib + Math.PI;
  var latR  = (GEO.latMax + GEO.latMin) / 2 * Math.PI / 180;
  var lon   = (GEO.lonMax + GEO.lonMin) / 2;
  var azPas = 360.0 / nAz;

  for (var j = 1; j <= 361; j += INSOL_JOUR_PAS) {
    var rs = sunRiseSet(j, orb.e, orb.eps, pibar, latR, lon);
    if (rs.rise < 0) continue;
    for (var h = rs.rise + INSOL_H_PAS / 2; h < rs.set; h += INSOL_H_PAS) {
      var pos = sunPos(j, h, orb.e, orb.eps, pibar, latR, lon);
      if (pos.el <= 0) continue;
      var azBin = Math.round(pos.az / azPas) % nAz;
      var elBin = Math.min(INSOL_EL_NB - 1, Math.floor(pos.el / INSOL_EL_PAS));
      var w = INSOL_H_PAS * INSOL_JOUR_PAS;
      if (INSOL_ATM) {
        var sinEl = Math.sin(pos.el * Math.PI / 180);
        w *= Math.pow(0.75, Math.min(40, 1 / Math.max(sinEl, 1e-6)));
      }
      W[azBin * NB + elBin] += w;
    }
  }
  return W;
}

/* ── insolCumuls ── E : histogramme W → T : pour chaque azimut, sommes
   cumulées depuis le haut de w·cos(él) et w·sin(él) → S : { cumCos, cumSin }
   ALGO : « Tables telles que cumCos/cumSin[a][b] = énergie horizontale et
   verticale du Soleil vu au-dessus de l'élévation b dans l'azimut a :
   l'horizon d'un pixel devient un simple indice. » */
function insolCumuls(W) {
  var nAz = OMBRE_N_AZ, NB = INSOL_EL_NB + 1;
  var cumCos = new Float32Array(nAz * NB);
  var cumSin = new Float32Array(nAz * NB);
  for (var a = 0; a < nAz; a++) {
    var cc = 0.0, cs = 0.0;
    cumCos[a * NB + INSOL_EL_NB] = 0;
    cumSin[a * NB + INSOL_EL_NB] = 0;
    for (var b = INSOL_EL_NB - 1; b >= 0; b--) {
      var elc = (b + 0.5) * INSOL_EL_PAS * Math.PI / 180;
      var w   = W[a * NB + b];
      cc += w * Math.cos(elc);
      cs += w * Math.sin(elc);
      cumCos[a * NB + b] = cc;
      cumSin[a * NB + b] = cs;
    }
  }
  return { cumCos: cumCos, cumSin: cumSin };
}

const INSOLMAP_WORKER_SRC = `
"use strict";
// 'init' : bande persistante (élévation, horizon, résolutions, normales)
// 'insolband' : seuls les cumuls solaires voyagent, le reste vient de B
var B = null;
/* ── Worker « insolband » ─────────────────────────────────────────────
   ENTRÉE     : 'init' — bande de lignes [r0, r1[ : élévation (±1 ligne),
                horizon (centi-degrés, 64 azimuts), resX par ligne, resY,
                normales ou null ; 'insolband' — cumCos, cumSin
   TRAITEMENT : par pixel terrestre, normale (fournie, sinon différences
                centrées en mètres, repère est/nord/haut) ; pour chaque
                azimut, case d'élévation = horizon arrondi au-dessus,
                contribution = (nx·sin az + ny·cos az)·cumCos + nz·cumSin,
                gardée si positive ; statistiques versants nord/sud
   SORTIE     : { type:'done', r0, insol Float32Array (heures eff.), stats }
   ALGO       : « Intègre l'énergie directe reçue par une facette : pour
                chaque azimut, somme du Soleil au-dessus de l'horizon
                projetée sur la normale. »
   ⚠ Écrêtage par azimut après intégration en élévation : l'auto-
     ombrage d'une pente n'est qu'approché.
   ─────────────────────────────────────────────────────────────────── */
self.onmessage = function(ev) {
  var d = ev.data;
  if (d.type === 'init') { B = d; return; }
  if (d.type !== 'insolband') return;
  if (B) for (var k in B) if (d[k] === undefined) d[k] = B[k];

  var r0   = d.r0, r1 = d.r1, r0e = d.r0e;
  var W    = d.W,  H  = d.H,  nAz = d.nAz;
  var elev = d.elev, horizon = d.horizon;
  var cumCos = d.cumCos, cumSin = d.cumSin;
  var resX = d.resX, resY = d.resY;
  var norm = d.norm;                      // normale coagulée par pixel (3 floats) ou null
  var NB   = 361;
  var nbRowsE = elev.length / W;          // lignes dans la bande élévation

  // sin/cos des 64 azimuts (convention azIdx : azDeg = a·360/nAz, 0 = nord)
  var sinAz = new Float64Array(nAz), cosAz = new Float64Array(nAz);
  for (var a = 0; a < nAz; a++) {
    var azR = a * 2 * Math.PI / nAz;
    sinAz[a] = Math.sin(azR);
    cosAz[a] = Math.cos(azR);
  }

  var insol = new Float32Array((r1 - r0) * W);
  var sumN = 0, nN = 0, sumS = 0, nS = 0;   // stats versants N/S (|ny|>0,3)

  for (var r = r0; r < r1; r++) {
    var rb = r - r0e;                        // ligne dans la bande élévation
    var rx = resX[r];
    for (var c = 0; c < W; c++) {
      var z = elev[rb * W + c];
      var outIdx = (r - r0) * W + c;
      if (z <= 0.5 || z >= 9000) { insol[outIdx] = 0; continue; }   // mer

      // Normale : coagulée (patch) si fournie, sinon gradients pixel par pixel
      var nx, ny, nz;
      if (norm) {
        var nb3 = ((r - r0) * W + c) * 3;
        nx = norm[nb3]; ny = norm[nb3 + 1]; nz = norm[nb3 + 2];
      } else {
        var zE = (c < W - 1) ? elev[rb * W + c + 1] : z;
        var zW = (c > 0)     ? elev[rb * W + c - 1] : z;
        var dx = (c > 0 && c < W - 1) ? (zE - zW) / (2 * rx)
                                      : (zE - zW) / rx;
        var zNn = (rb > 0)           ? elev[(rb - 1) * W + c] : z;     // ligne nord
        var zSs = (rb < nbRowsE - 1) ? elev[(rb + 1) * W + c] : z;     // ligne sud
        var dn = (rb > 0 && rb < nbRowsE - 1) ? (zNn - zSs) / (2 * resY)
                                              : (zNn - zSs) / resY;
        nx = -dx; ny = -dn; nz = 1.0;
        var inv = 1.0 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx *= inv; ny *= inv; nz *= inv;
      }

      // Σ sur les 64 azimuts — clamp max(0,·) par azimut (auto-ombrage approx.)
      var s = 0.0;
      var hBase = ((r - r0) * W + c) * nAz;
      for (var a2 = 0; a2 < nAz; a2++) {
        var hCd  = horizon[hBase + a2];                 // centi-degrés
        var bin  = hCd > 0 ? Math.ceil(hCd / 25) : 0;   // bin 0,25° SUPÉRIEUR
        if (bin > 360) bin = 360;
        var base = a2 * NB + bin;
        var contrib = (nx * sinAz[a2] + ny * cosAz[a2]) * cumCos[base]
                    + nz * cumSin[base];
        if (contrib > 0) s += contrib;
      }
      insol[outIdx] = s;

      if (ny >  0.3) { sumN += s; nN++; }
      else if (ny < -0.3) { sumS += s; nS++; }
    }
  }

  self.postMessage(
    { type:'done', r0:r0, insol:insol,
      stats:{ sumN:sumN, nN:nN, sumS:sumS, nS:nS } },
    [insol.buffer]
  );
};
`;

/* ── insolHistogrammeJour ── E : t_ka, jour → T : comme insolHistogramme
   sur la seule journée (poids 0,25 h) → S : Float64Array nAz × 361.
   ALGO : « Histogramme solaire d'une journée. » */
function insolHistogrammeJour(t_ka, jour) {
  var nAz   = OMBRE_N_AZ;
  var NB    = INSOL_EL_NB + 1;
  var W     = new Float64Array(nAz * NB);
  var orb   = orbital(t_ka);
  var pibar = orb.pib + Math.PI;
  var latR  = (GEO.latMax + GEO.latMin) / 2 * Math.PI / 180;
  var lon   = (GEO.lonMax + GEO.lonMin) / 2;
  var azPas = 360.0 / nAz;
  var rs = sunRiseSet(jour, orb.e, orb.eps, pibar, latR, lon);
  if (rs.rise < 0) return W;
  for (var h = rs.rise + INSOL_H_PAS / 2; h < rs.set; h += INSOL_H_PAS) {
    var pos = sunPos(jour, h, orb.e, orb.eps, pibar, latR, lon);
    if (pos.el <= 0) continue;
    var azBin = Math.round(pos.az / azPas) % nAz;
    var elBin = Math.min(INSOL_EL_NB - 1, Math.floor(pos.el / INSOL_EL_PAS));
    var w = INSOL_H_PAS;
    if (INSOL_ATM) {
      var sinEl = Math.sin(pos.el * Math.PI / 180);
      w *= Math.pow(0.75, Math.min(40, 1 / Math.max(sinEl, 1e-6)));
    }
    W[azBin * NB + elBin] += w;
  }
  return W;
}

/* ── Pool persistant : chaque Worker garde sa bande d'horizon (≈134 Mo au
   total pour 1024²×64) ; seuls cumCos / cumSin circulent par carte.
   Reconstruit si l'horizon ou les normales changent. Les requêtes sont
   mises en file : un Worker ne traite qu'une carte à la fois.          */
var _insolPP = { cle: null, norm: null, workers: [], file: Promise.resolve() };

/* ── insolPoolFermer ── E : aucune → T : termine les Workers, oublie la clé
   d'horizon → S : aucune. */
function insolPoolFermer() {
  _insolPP.workers.forEach(function (w) { w.terminate(); });
  _insolPP.workers = []; _insolPP.cle = null; _insolPP.norm = null;
}

/* ── _insolPoolPret ── E : ombreHorizonCopy, dsmPixNorm → T : si l'horizon
   ou les normales ont changé, recrée jusqu'à 8 Workers, chacun avec sa
   bande de lignes (élévation ±1 ligne, horizon, résolutions) → S : pool
   prêt. ALGO : « Pool persistant : l'horizon (≈ 134 Mo) n'est envoyé
   qu'une fois. » */
function _insolPoolPret() {
  var norm = (typeof window !== 'undefined' && window.dsmPixNorm) || null;
  if (_insolPP.cle === ombreHorizonCopy && _insolPP.norm === norm && _insolPP.workers.length) return;
  insolPoolFermer();
  var Wd = OMBRE_DIM, Hd = OMBRE_DIM, nAz = OMBRE_N_AZ;
  var NW = Math.min(navigator.hardwareConcurrency || 4, 8);
  var bande = Math.ceil(Hd / NW);
  var url = URL.createObjectURL(new Blob([INSOLMAP_WORKER_SRC], { type: 'application/javascript' }));
  for (var k = 0; k < NW; k++) {
    var r0 = k * bande, r1 = Math.min(Hd, r0 + bande);
    if (r0 >= r1) break;
    var r0e = Math.max(0, r0 - 1), r1e = Math.min(Hd, r1 + 1);
    var elevB  = new Float32Array(ombreElev1024.subarray(r0e * Wd, r1e * Wd));
    var horizB = new Int16Array(ombreHorizonCopy.subarray(r0 * Wd * nAz, r1 * Wd * nAz));
    var resXB  = new Float32Array(ombreResX);
    var normB  = norm ? new Float32Array(norm.subarray(r0 * Wd * 3, r1 * Wd * 3)) : null;
    var w = new Worker(url);
    var tr = [elevB.buffer, horizB.buffer, resXB.buffer];
    if (normB) tr.push(normB.buffer);
    w.postMessage({ type: 'init', r0: r0, r1: r1, r0e: r0e, W: Wd, H: Hd, nAz: nAz,
                    elev: elevB, horizon: horizB, resX: resXB, resY: ombreResY, norm: normB }, tr);
    _insolPP.workers.push(w);
  }
  URL.revokeObjectURL(url);
  _insolPP.cle = ombreHorizonCopy; _insolPP.norm = norm;
}

/* ── insolCarte ── E : cumuls { cumCos, cumSin } → T : en file derrière la
   requête précédente, envoie les cumuls à chaque Worker, assemble les
   bandes et les statistiques → S : Promise({ carte Float32Array 1024²,
   stats }). ALGO : « Une carte d'insolation par passage des cumuls dans le
   pool, requêtes sérialisées. » */
function insolCarte(cum) {
  var tache = _insolPP.file.then(function () {
    if (!ombreHorizonCopy || !ombreElev1024) throw new Error('Passe 1 (horizon) non calculée');
    _insolPoolPret();
    var Wd = OMBRE_DIM, ws = _insolPP.workers;
    return new Promise(function (resolve, reject) {
      var carte = new Float32Array(Wd * Wd);
      var stats = { sumN: 0, nN: 0, sumS: 0, nS: 0 };
      var fini = 0;
      ws.forEach(function (w) {
        w.onmessage = function (ev) {
          var r = ev.data;
          if (r.type !== 'done') return;
          carte.set(r.insol, r.r0 * Wd);
          stats.sumN += r.stats.sumN; stats.nN += r.stats.nN;
          stats.sumS += r.stats.sumS; stats.nS += r.stats.nS;
          if (++fini === ws.length) resolve({ carte: carte, stats: stats });
        };
        w.onerror = function (err) { insolPoolFermer(); reject(err); };
        var cc = new Float32Array(cum.cumCos), cs = new Float32Array(cum.cumSin);
        w.postMessage({ type: 'insolband', cumCos: cc, cumSin: cs }, [cc.buffer, cs.buffer]);
      });
    });
  });
  _insolPP.file = tache.catch(function () {});
  return tache;
}

/* ── insolationJour ── E : t_ka, jour → T : insolHistogrammeJour → cumuls →
   insolCarte → S : Promise(carte 1024², heures effectives du jour). */
function insolationJour(t_ka, jour) {
  if (!ombreHorizonCopy || !ombreElev1024)
    return Promise.reject(new Error('Passe 1 (horizon) non calculée'));
  return insolCarte(insolCumuls(insolHistogrammeJour(t_ka, jour)))
    .then(function (r) { return r.carte; });
}

/* ── _cleTka ── E : t_ka → T : arrondi au millionième de ka (≈ 9 h) →
   S : clé entière. ALGO : « Évite que −20 et −20,0000001 soient deux
   entrées de cache. » */
function _cleTka(t_ka) { return Math.round(t_ka * 1e6); }

/* ── insolationEpoque ── E : t_ka → T : cache LRU de 2 époques ; sinon
   insolHistogramme → cumuls → insolCarte, mise en cache avec les stats →
   S : Promise(carte annuelle 1024², heures effectives par an). */
function insolationEpoque(t_ka) {
  var cle = _cleTka(t_ka);
  for (var i = 0; i < insolCache.length; i++) {
    if (_cleTka(insolCache[i].tka) === cle) {
      var hit = insolCache.splice(i, 1)[0];
      insolCache.push(hit);
      return Promise.resolve(hit.map);
    }
  }
  if (!ombreHorizonCopy || !ombreElev1024) {
    return Promise.reject(new Error('Passe 1 (horizon) non calculée'));
  }
  document.getElementById('vstatus').textContent = '☀️ Insolation annuelle…';
  return insolCarte(insolCumuls(insolHistogramme(t_ka))).then(function (r) {
    insolCache.push({ tka: t_ka, map: r.carte, stats: r.stats });
    if (insolCache.length > 2) insolCache.shift();
    return r.carte;
  });
}

/* ── insolLUT ── E : aucune → T : 3 paliers bleu → jaune → rouge sur 256
   niveaux, mémorisé → S : table RGB. */
function insolLUT() {
  if (insolLUTtab) return insolLUTtab;
  var stops = [[0.0, 30, 60, 200], [0.5, 250, 220, 80], [1.0, 215, 45, 30]];
  var lut = new Uint8Array(256 * 3);
  for (var i = 0; i < 256; i++) {
    var t = i / 255, s0 = stops[0], s1 = stops[1];
    for (var k = 0; k < stops.length - 1; k++)
      if (t >= stops[k][0] && t <= stops[k + 1][0]) { s0 = stops[k]; s1 = stops[k + 1]; break; }
    var f = (t - s0[0]) / (s1[0] - s0[0]);
    lut[i * 3]     = Math.round(s0[1] + f * (s1[1] - s0[1]));
    lut[i * 3 + 1] = Math.round(s0[2] + f * (s1[2] - s0[2]));
    lut[i * 3 + 2] = Math.round(s0[3] + f * (s1[3] - s0[3]));
  }
  insolLUTtab = lut;
  return lut;
}

/* ── insolAfficher ── E : carte, t_ka → T : bornes aux centiles 2 et 98
   (histogramme 4096 cases, terre seule), coloration par insolLUT, mer en
   noir, message min/max/moyenne en W/m² → S : insolOsc, insolMap,
   insolMn/Mx ; affichage. */
function insolAfficher(map, t_ka) {
  var Wd = OMBRE_DIM, N = Wd * Wd;
  var lut = insolLUT();

  var mn = Infinity, mx = -Infinity, somme = 0, nT = 0;
  for (var i = 0; i < N; i++) {
    var z = ombreElev1024[i];
    if (z <= 0.5 || z >= 9000) continue;
    var v = map[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    somme += v; nT++;
  }

  if (nT > 0 && mx > mn) {
    var NBH = 4096, hist = new Uint32Array(NBH), inv = (NBH - 1) / (mx - mn);
    for (var ih = 0; ih < N; ih++) {
      var zh = ombreElev1024[ih];
      if (zh <= 0.5 || zh >= 9000) continue;
      hist[((map[ih] - mn) * inv) | 0]++;
    }
    var seuilBas = nT * INSOL_PCT_BAS / 100, seuilHaut = nT * INSOL_PCT_HAUT / 100;
    var cumH = 0, pBas = mn, pHaut = mx, basFait = false;
    for (var b = 0; b < NBH; b++) {
      cumH += hist[b];
      if (!basFait && cumH >= seuilBas) { pBas = mn + b / inv; basFait = true; }
      if (cumH >= seuilHaut) { pHaut = mn + b / inv; break; }
    }
    if (pHaut > pBas) { mn = pBas; mx = pHaut; }
  }
  var plage = (mx - mn) || 1;

  var img = ctx.createImageData(Wd, Wd);
  var dst = img.data;
  for (var i2 = 0; i2 < N; i2++) {
    var p = i2 * 4;
    var z2 = ombreElev1024[i2];
    if (z2 <= 0.5 || z2 >= 9000) {
      dst[p] = 0; dst[p + 1] = 0; dst[p + 2] = 0;
    } else {
      var li = Math.min(255, Math.max(0,
        Math.round((map[i2] - mn) / plage * 255))) * 3;
      dst[p] = lut[li]; dst[p + 1] = lut[li + 1]; dst[p + 2] = lut[li + 2];
    }
    dst[p + 3] = 255;
  }
  if (!insolOsc) insolOsc = new OffscreenCanvas(Wd, Wd);
  insolOsc.getContext('2d').putImageData(img, 0, 0);

  insolMap     = map;
  insolMapTka  = t_ka;
  insolMn      = mn;
  insolMx      = mx;
  insolImgData = img;
  insolRedessiner();
  document.getElementById('vstatus').textContent =
    '☀️ Insol an ' + ctrlAnnee
    + ' — min ' + (mn * INSOL_W_PAR_H).toFixed(0)
    + ' / max ' + (mx * INSOL_W_PAR_H).toFixed(0)
    + ' / moy ' + (somme / nT * INSOL_W_PAR_H).toFixed(0)
    + ' W/m² (moy. annuelle — échelle ' + INSOL_PCT_BAS + '–' + INSOL_PCT_HAUT + ' centiles)';
}

/* ── insolRedessiner ── E : insolOsc, vue courante → T : recadre et dessine,
   met à jour zoom et légende → S : dessin. */
function insolRedessiner() {
  if (!insolOsc) return;
  var sw = DISP * srcPPx, sh = DISP * srcPPx;
  srcX = Math.max(0, Math.min(imgW - sw, srcX));
  srcY = Math.max(0, Math.min(imgH - sh, srcY));
  var sx = OMBRE_DIM / imgW, sy = OMBRE_DIM / imgH;
  ctx.clearRect(0, 0, DISP, DISP);
  ctx.drawImage(insolOsc, srcX * sx, srcY * sy, sw * sx, sh * sy, 0, 0, DISP, DISP);
  document.getElementById('vinfo').textContent = 'zoom \u00d7' + (1 / srcPPx).toFixed(2);
  drawLegendInsol();
}

/* ── drawLegendInsol ── E : insolMn/Mx → T : barre de couleur, 5
   graduations en W/m², pastille « mer » → S : dessin sur #lcv. */
function drawLegendInsol() {
  var lcv = document.getElementById('lcv');
  if (!lcv || insolMx <= insolMn) return;
  var lt = document.querySelector('#legend-panel .leg-title');
  var lu = document.querySelector('#legend-panel .leg-unit');
  if (lt) lt.textContent = 'INSOLATION';
  if (lu) lu.textContent = 'W/m\u00b2';
  var lh = lcv.height, lw = lcv.width;
  if (lh < 10) return;
  var lctx = lcv.getContext('2d');
  lctx.clearRect(0, 0, lw, lh);
  var lut  = insolLUT();
  var barX = 0, barW = 22, textX = barW + 3, barH = lh - 18, barY = 2;

  for (var y = 0; y < barH; y++) {
    var t = 1 - y / barH, i = Math.round(t * 255) * 3;
    lctx.fillStyle = 'rgb(' + lut[i] + ',' + lut[i+1] + ',' + lut[i+2] + ')';
    lctx.fillRect(barX, barY + y, barW, 1);
  }
  lctx.font = '8px monospace';
  for (var k = 0; k < 5; k++) {
    var t2 = k / 4;
    var w  = (insolMn + t2 * (insolMx - insolMn)) * INSOL_W_PAR_H;
    var y2 = barY + Math.round((1 - t2) * barH);
    lctx.fillStyle = 'rgba(180,190,210,.6)'; lctx.fillRect(barX + barW, y2, 4, 1);
    lctx.fillStyle = '#a6adc8'; lctx.fillText(Math.round(w) + '', textX + 4, y2 + 3);
  }
  lctx.fillStyle = '#a6adc8';
  lctx.fillText('W/m²', barX, barY + barH + 8);
  lctx.fillStyle = '#000'; lctx.fillRect(barX, barY + barH + 10, 10, 6);
  lctx.strokeStyle = '#45475a'; lctx.strokeRect(barX + 0.5, barY + barH + 10.5, 10, 6);
  lctx.fillStyle = '#a6adc8'; lctx.fillText('mer', barX + 14, barY + barH + 16);
}

/* ── insolRecalcul ── E : ctrlTka() → T : si aucun calcul en cours,
   insolationEpoque puis insolAfficher ; relance si l'année a changé
   entre-temps, sinon tests au premier affichage → S : aucune. */
function insolRecalcul() {
  if (!insolActive) return;
  if (insolEnCours) return;
  var tka = ctrlTka();
  insolEnCours = insolationEpoque(tka)
    .then(function(map) {
      insolEnCours = null;
      if (!insolActive) return;
      insolAfficher(map, tka);
      if (tka !== ctrlTka()) insolRecalcul();
      else insolTests(tka);
    })
    .catch(function(err) {
      insolEnCours = null;
      document.getElementById('vstatus').textContent = '☀️ Insol : ' + err.message;
    });
}

/* ── insolTests ── E : t_ka affiché → T : une fois — rapport versants
   sud/nord (attendu > 1 dans l'hémisphère nord), écart d'insolation avec
   −10 ka (précession) → S : journal console. */
function insolTests(tkaCourant) {
  if (insolTestsFaits) return;
  insolTestsFaits = true;

  var entree = null;
  for (var i = 0; i < insolCache.length; i++)
    if (insolCache[i].tka === tkaCourant) entree = insolCache[i];
  if (entree && entree.stats.nN > 0 && entree.stats.nS > 0) {
    var moyN = entree.stats.sumN / entree.stats.nN;
    var moyS = entree.stats.sumS / entree.stats.nS;
    console.log('[insol test 1] versants — moy ny>0,3 (nord) = ' + moyN.toFixed(1)
      + ' ; moy ny<−0,3 (sud) = ' + moyS.toFixed(1)
      + ' ; ratio S/N = ' + (moyS / moyN).toFixed(3)
      + ' (attendu > 1 aux latitudes boréales)');
  }

  var Wd = OMBRE_DIM, nAz = OMBRE_N_AZ, NB = INSOL_EL_NB + 1;
  var best = -1, bestPente = Infinity;
  for (var idx = 0; idx < Wd * Wd; idx++) {
    if (ombreHmaxCopy[idx] >= 500) continue;
    var z = ombreElev1024[idx];
    if (z <= 0.5 || z >= 9000) continue;
    var r = (idx / Wd) | 0, c = idx % Wd;
    if (r < 1 || r >= Wd - 1 || c < 1 || c >= Wd - 1) continue;
    var dx = Math.abs(ombreElev1024[idx + 1]  - ombreElev1024[idx - 1]);
    var dn = Math.abs(ombreElev1024[idx - Wd] - ombreElev1024[idx + Wd]);
    var pente = dx + dn;
    if (pente < bestPente) { bestPente = pente; best = idx; }
  }
  if (best >= 0 && entree) {
    var cum = insolCumuls(insolHistogramme(tkaCourant));
    var analytique = 0;
    for (var a = 0; a < nAz; a++) analytique += cum.cumSin[a * NB + 0];
    var mesure = entree.map[best];
    var ecart  = Math.abs(mesure - analytique) / analytique * 100;
    console.log('[insol test 3] pixel plat dégagé idx=' + best
      + ' (hmax=' + (ombreHmaxCopy[best] / 100).toFixed(2) + '°) : carte = '
      + mesure.toFixed(1) + ' vs analytique plat = ' + analytique.toFixed(1)
      + ' → écart ' + ecart.toFixed(2) + ' % (attendu < 1 %)');
  } else {
    console.log('[insol test 3] aucun pixel plat dégagé (hmax<5°) sur cette tuile');
  }

  var tkaRef = (Math.abs(tkaCourant + 10) < 1e-6) ? 0 : -10;
  insolationEpoque(tkaRef).then(function(mapRef) {
    var s1 = 0, s2 = 0, n = 0;
    for (var i2 = 0; i2 < Wd * Wd; i2++) {
      var z2 = ombreElev1024[i2];
      if (z2 <= 0.5 || z2 >= 9000) continue;
      s1 += entree.map[i2]; s2 += mapRef[i2]; n++;
    }
    var m1 = s1 / n, m2 = s2 / n;
    console.log('[insol test 2] précession — moy(t=' + tkaCourant.toFixed(2)
      + ' ka) = ' + m1.toFixed(1) + ' ; moy(t=' + tkaRef + ' ka) = ' + m2.toFixed(1)
      + ' ; écart ' + ((m2 - m1) / m1 * 100).toFixed(2)
      + ' % (attendu non nul, ordre de quelques %)');
  });
}

/* Bouton Insol : active la carte d'insolation annuelle (horizon requis) et
   grise jour/heure ; désactivation → retour à l'affichage normal. */
document.getElementById('btn-insol').addEventListener('click', function() {
  if (insolActive) {
    insolActive = false;
    insolImgData = null;
    insolOsc = null;
    var lt = document.querySelector('#legend-panel .leg-title');
    var lu = document.querySelector('#legend-panel .leg-unit');
    if (lt) lt.textContent = 'ALTITUDE';
    if (lu) lu.textContent = 'm\u00e8tres';
    this.classList.remove('active');
    if (typeof tempActive === 'undefined' || !tempActive) {
      var b1 = document.getElementById('ctrl-bloc-1');
      var b2 = document.getElementById('ctrl-bloc-2');
      if (b1) { b1.style.opacity = ''; b1.style.pointerEvents = ''; }
      if (b2) { b2.style.opacity = ''; b2.style.pointerEvents = ''; }
    }
    render();
    document.getElementById('vstatus').textContent = '☀️ Insol désactivée';
    return;
  }
  if (!ombreHorizonCopy) {
    document.getElementById('vstatus').textContent =
      '☀️ Lancer 🌑 Ombre d\'abord (la passe 1 calcule l\'horizon)';
    return;
  }
  insolActive = true;
  this.classList.add('active');
  var b1 = document.getElementById('ctrl-bloc-1');
  var b2 = document.getElementById('ctrl-bloc-2');
  if (b1) { b1.style.opacity = '0.25'; b1.style.pointerEvents = 'none'; }
  if (b2) { b2.style.opacity = '0.25'; b2.style.pointerEvents = 'none'; }
  insolRecalcul();
});
