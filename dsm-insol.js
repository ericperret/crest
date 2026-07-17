/*
  Fichier  : dsm-insol.js
  Date     : 2026-06-17
  Version  : 3.14 — Normale coagulée injectable : le worker utilise window.dsmPixNorm
             (normale moyenne par patch du maillage) si fournie, sinon gradients.
             insolationJour passe la bande norm. Coagulation des pentes AVANT insol.
  v3.13    — insolationJour(t_ka, jour) : carte d'insolation d'UN jour
             (histogramme restreint à un jour, mêmes étapes B/C/workers, pool
             local). Sert au glacier pour 73 cartes par tranche de 5 jours.
  v3.12    — Grisage JOUR/HEURE au toggle insol (moyenne annuelle).
  Rôle     : Insolation différentielle 20 000 ans — énergie solaire annuelle
             reçue par pixel, tenant compte (a) du masquage topographique
             (horizon passe 1) et (b) de l'angle d'incidence sur la pente
             locale (versant nord vs sud). Terme de correction pour la future
             simulation de vitesse d'avancée des glaciers.
  Algo     : factorisation par histogramme solaire — PAS de force brute.
             A) ~3 500 positions solaires par époque (73 jours × pas 15 min)
                → histogramme pondéré W[azBin][elBin] (64 × 360, pas 0,25°).
             B) cumuls descendants CumCos/CumSin[az][el] (64 × 361 Float32).
             C) par pixel : Σ sur 64 azimuts seulement, O(1) par azimut :
                  Σ_visibles W·(n·s) = (nx·sinAz + ny·cosAz)·CumCos[az][elHor]
                                     + nz·CumSin[az][elHor]
                clampée à max(0,·) par azimut — approximation de l'auto-
                ombrage, justifiée car l'horizon local, calculé depuis le
                pixel lui-même, capture déjà la pente amont.
             Unité : heures·équivalent-zénith/an (relative, suffisante pour un
             terme différentiel).
  Échantillonnage : 1 jour sur 5 (×5 en poids), pas 15 min lever→coucher ;
             époques pilotées par le slider ANNÉE (recalcul à la demande,
             cache LRU 2 entrées — 200 cartes Float32 = 800 Mo : interdit).
  Workers  : INSOLMAP_WORKER_SRC (étape C) — pool min(hardwareConcurrency, 8),
             partition par bandes de lignes (+1 ligne de marge pour les
             gradients), transferts zero-copy sur des COPIES (jamais
             ombreHorizonCopy ni ombreElev1024 eux-mêmes — pattern
             lancerPasse2Seule). Géométrie pure : pas d'astro injectée.
  Source   : Laskar et al. 2004 / IMCCE (La2004) ; insolsub_f.f (BDL) ;
             transmission atmosphérique simple m(el)=0,75^(1/sin el).
  Expose   : insolationEpoque(t_ka), insolRecalcul(), insolActive, insolMap.
  Dépend   : dsm-astro.js (orbital, sunRiseSet, sunPos) ; dsm-ombre.js
             (ombreHorizonCopy, ombreHmaxCopy, ombreElev1024, ombreResX,
             ombreResY, OMBRE_DIM, OMBRE_N_AZ) ; dsm.html (GEO, ctx, ctrlTka,
             ctrlAnnee, render). Résolues à l'exécution.
  Ordre    : charger EN DERNIER (après dsm-ombre.js).
  Note 3.9 : mer rendue en NOIR et exclue de la normalisation (elle écrasait
             l'échelle vers le rouge) ; conversion W/m² (P = insol·S0/8766,
             S0=1361 W/m² hors atmosphère — l'atténuation m(el) est déjà dans
             l'histogramme) ; légende verticale dédiée drawLegendInsol() en
             W/m², ImageData cachée pour redessins (resize, render).
  Note 3.10: normalisation par CENTILES (p2–p98 des pixels terre) au lieu de
             min/max — quelques pixels extrêmes (fonds de ravines ~0, falaises
             très exposées) écrasaient l'échelle vers le rouge. La légende
             affiche la plage p2–p98 ; valeurs hors plage clampées.
  Note 3.11: carte insol ZOOMABLE/PANABLE — colorisation dans un OffscreenCanvas
             (insolOsc) dessiné via srcX/srcY/srcPPx comme l'hypso (le pipeline
             render délègue à insolRedessiner). Titre/unité du panneau légende
             basculés INSOLATION/W m⁻² ↔ ALTITUDE/mètres au toggle.
*/
"use strict";

// ── Constantes ───────────────────────────────────────────────────────────────
const INSOL_ATM     = true;   // facteur atmosphérique m(el)=0,75^(1/sin el) (coupable)
const INSOL_EL_PAS  = 0.25;   // degrés par bin d'élévation
const INSOL_EL_NB   = 360;    // bins 0..90° (indices 0..359 ; 360 = sentinelle cumuls)
const INSOL_JOUR_PAS = 5;     // 1 jour échantillonné sur 5 (poids ×5)
const INSOL_H_PAS   = 0.25;   // pas temporel 15 min
const INSOL_S0      = 1361;   // constante solaire TOA (W/m²) — réf. de l'unité
const INSOL_W_PAR_H = INSOL_S0 / 8766;  // h·éq-zénith/an → W/m² moyen annuel
const INSOL_PCT_BAS  = 2;     // centile bas de la normalisation couleur
const INSOL_PCT_HAUT = 98;    // centile haut

// ── État ─────────────────────────────────────────────────────────────────────
let insolActive  = false;     // vue insol affichée
let insolMap     = null;      // Float32Array[OMBRE_DIM²] carte courante
let insolMapTka  = null;      // époque de la carte courante
let insolCache   = [];        // LRU 2 entrées : {tka, map, stats}
let insolPool    = [];        // workers étape C actifs
let insolEnCours = null;      // Promise du calcul en cours (anti-réentrance)
let insolTestsFaits = false;  // tests de validation exécutés une fois
let insolLUTtab  = null;      // LUT 256×3 froid→chaud
let insolMn = 0, insolMx = 1; // min/max terre de la carte affichée (unité native)
let insolImgData = null;      // ImageData cachée (garde des délégations dsm.html)
let insolOsc     = null;      // OffscreenCanvas colorisé — source du zoom/pan

// ════════════════════════════════════════════════════════════════
// ÉTAPE A — histogramme solaire pondéré d'une époque (fil principal)
// W[azBin*361 + elBin], azBin aligné sur la grille horizon (azIdx,
// plus proche — erreur ≤ 2,8° négligeable une fois sommée),
// elBin = floor(el/0,25°). Poids = 0,25 h × 5 jours × m(el) optionnel.
// ════════════════════════════════════════════════════════════════
function insolHistogramme(t_ka) {
  var nAz   = OMBRE_N_AZ;
  var NB    = INSOL_EL_NB + 1;                 // 361 (sentinelle incluse)
  var W     = new Float64Array(nAz * NB);
  var orb   = orbital(t_ka);
  var pibar = orb.pib + Math.PI;
  var latR  = (GEO.latMax + GEO.latMin) / 2 * Math.PI / 180;
  var lon   = (GEO.lonMax + GEO.lonMin) / 2;
  var azPas = 360.0 / nAz;

  for (var j = 1; j <= 361; j += INSOL_JOUR_PAS) {           // 73 jours
    var rs = sunRiseSet(j, orb.e, orb.eps, pibar, latR, lon);
    if (rs.rise < 0) continue;                               // nuit polaire
    for (var h = rs.rise + INSOL_H_PAS / 2; h < rs.set; h += INSOL_H_PAS) {
      var pos = sunPos(j, h, orb.e, orb.eps, pibar, latR, lon);
      if (pos.el <= 0) continue;
      var azBin = Math.round(pos.az / azPas) % nAz;          // plus proche
      var elBin = Math.min(INSOL_EL_NB - 1, Math.floor(pos.el / INSOL_EL_PAS));
      var w = INSOL_H_PAS * INSOL_JOUR_PAS;                  // heures × pondération jour
      if (INSOL_ATM) {
        // Transmission atmosphérique simple ; exposant clampé (el très basse)
        var sinEl = Math.sin(pos.el * Math.PI / 180);
        w *= Math.pow(0.75, Math.min(40, 1 / Math.max(sinEl, 1e-6)));
      }
      W[azBin * NB + elBin] += w;
    }
  }
  return W;
}

// ════════════════════════════════════════════════════════════════
// ÉTAPE B — tables cumulées descendantes par azimut (Float64 → Float32)
// CumCos[az][el] = Σ_{el'≥el} W[az][el']·cos(el')   (idem CumSin avec sin)
// el' pris au centre du bin. Index 360 = sentinelle 0 (rien au-dessus).
// Taille : 64 × 361 × 4 o × 2 ≈ 185 Ko — trivial à poster aux workers.
// ════════════════════════════════════════════════════════════════
function insolCumuls(W) {
  var nAz = OMBRE_N_AZ, NB = INSOL_EL_NB + 1;
  var cumCos = new Float32Array(nAz * NB);
  var cumSin = new Float32Array(nAz * NB);
  for (var a = 0; a < nAz; a++) {
    var cc = 0.0, cs = 0.0;
    cumCos[a * NB + INSOL_EL_NB] = 0;          // sentinelle
    cumSin[a * NB + INSOL_EL_NB] = 0;
    for (var b = INSOL_EL_NB - 1; b >= 0; b--) {
      var elc = (b + 0.5) * INSOL_EL_PAS * Math.PI / 180;   // centre du bin (rad)
      var w   = W[a * NB + b];
      cc += w * Math.cos(elc);
      cs += w * Math.sin(elc);
      cumCos[a * NB + b] = cc;
      cumSin[a * NB + b] = cs;
    }
  }
  return { cumCos: cumCos, cumSin: cumSin };
}

// ════════════════════════════════════════════════════════════════
// ÉTAPE C — INSOLMAP_WORKER_SRC : accumulation par pixel (géométrie pure)
// Reçoit : { type:'insolband', r0, r1, r0e, W, H, nAz,
//            elev (bande [r0e..r1e) avec marge), horizon (bande [r0..r1)),
//            cumCos, cumSin, resX (Float32Array[H]), resY }
// Envoie : { type:'done', r0, insol (Float32Array (r1-r0)*W),
//            stats {sumN,nN,sumS,nS} }  — différentiel versant nord/sud
// Normale locale : gradients centraux sur la bande d'élévation
//   dz/dx    = (z[r][c+1] − z[r][c−1]) / (2·resX[r])     (est)
//   dz/dnord = (z[r−1][c] − z[r+1][c]) / (2·resY)        (row croissant = sud)
//   n = normaliser( −dz/dx, −dz/dnord, 1 ).  Bords : gradients décentrés.
// Pixels mer (z ≤ 0,5) → insol = 0.
// ════════════════════════════════════════════════════════════════
const INSOLMAP_WORKER_SRC = `
"use strict";
self.onmessage = function(ev) {
  var d = ev.data;
  if (d.type !== 'insolband') return;

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

// ════════════════════════════════════════════════════════════════
// insolationEpoque — API publique
// Carte d'insolation annuelle pour une époque (calcul à la demande).
// Pré-requis : ombreHorizonCopy non null (passe 1 terminée).
// Résolution : OMBRE_DIM × OMBRE_DIM (1024²).
// Retour : Promise<Float32Array[1024*1024]> — heures·éq-zénith/an.
// Cache LRU 2 entrées (époque courante + précédente) pour la future sim
// glacier qui itérera époque par époque (200 cartes = 800 Mo : interdit).
// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════
// HISTOGRAMME D'UN SEUL JOUR — pour les cartes par tranche de 5 jours
// (mêmes bins que insolHistogramme, mais un jour, poids = heures sans ×5).
// La carte journalière inclut déjà l'ombre topographique (horizon passe 1).
// ════════════════════════════════════════════════════════════════
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
  if (rs.rise < 0) return W;                                  // nuit polaire → carte nulle
  for (var h = rs.rise + INSOL_H_PAS / 2; h < rs.set; h += INSOL_H_PAS) {
    var pos = sunPos(jour, h, orb.e, orb.eps, pibar, latR, lon);
    if (pos.el <= 0) continue;
    var azBin = Math.round(pos.az / azPas) % nAz;
    var elBin = Math.min(INSOL_EL_NB - 1, Math.floor(pos.el / INSOL_EL_PAS));
    var w = INSOL_H_PAS;                                      // un jour, pas de ×5
    if (INSOL_ATM) {
      var sinEl = Math.sin(pos.el * Math.PI / 180);
      w *= Math.pow(0.75, Math.min(40, 1 / Math.max(sinEl, 1e-6)));
    }
    W[azBin * NB + elBin] += w;
  }
  return W;
}

// ════════════════════════════════════════════════════════════════
// insolationJour — carte d'insolation d'UN jour (Promise<Float32Array[N]>).
// Réutilise étape C (INSOLMAP_WORKER_SRC). Pool LOCAL (n'altère pas insolPool
// du slider). Aucun cache, aucun affichage, ne touche pas insolMap.
// ════════════════════════════════════════════════════════════════
function insolationJour(t_ka, jour) {
  if (!ombreHorizonCopy || !ombreElev1024)
    return Promise.reject(new Error('Passe 1 (horizon) non calculée'));
  var cum = insolCumuls(insolHistogrammeJour(t_ka, jour));
  var Wd = OMBRE_DIM, Hd = OMBRE_DIM, nAz = OMBRE_N_AZ;
  var NW = Math.min(navigator.hardwareConcurrency || 4, 8);
  var bande = Math.ceil(Hd / NW);
  return new Promise(function (resolve, reject) {
    var carte = new Float32Array(Wd * Hd);
    var fini = 0, total = 0, pool = [];
    for (var k = 0; k < NW; k++) {
      var r0 = k * bande, r1 = Math.min(Hd, r0 + bande);
      if (r0 >= r1) break;
      total++;
      var r0e = Math.max(0, r0 - 1), r1e = Math.min(Hd, r1 + 1);
      var elevB  = new Float32Array(ombreElev1024.subarray(r0e * Wd, r1e * Wd));
      var horizB = new Int16Array(ombreHorizonCopy.subarray(r0 * Wd * nAz, r1 * Wd * nAz));
      var cumCosB = new Float32Array(cum.cumCos);
      var cumSinB = new Float32Array(cum.cumSin);
      var resXB   = new Float32Array(ombreResX);
      // Normale coagulée par patch (convention worker), si disponible → bande [r0,r1)
      var normB = (typeof window !== 'undefined' && window.dsmPixNorm)
        ? new Float32Array(window.dsmPixNorm.subarray(r0 * Wd * 3, r1 * Wd * 3))
        : null;
      var blob = new Blob([INSOLMAP_WORKER_SRC], { type: 'application/javascript' });
      var url  = URL.createObjectURL(blob);
      var w    = new Worker(url);
      URL.revokeObjectURL(url);
      pool.push(w);
      w.onmessage = function (ev) {
        var res = ev.data;
        if (res.type !== 'done') return;
        this.terminate();
        var pi = pool.indexOf(this); if (pi >= 0) pool.splice(pi, 1);
        carte.set(res.insol, res.r0 * Wd);
        fini++;
        if (fini === total) resolve(carte);
      };
      w.onerror = function (err) { pool.forEach(function(x){x.terminate();}); reject(err); };
      var _msg = {
        type: 'insolband', r0: r0, r1: r1, r0e: r0e,
        W: Wd, H: Hd, nAz: nAz,
        elev: elevB, horizon: horizB,
        cumCos: cumCosB, cumSin: cumSinB,
        resX: resXB, resY: ombreResY, norm: normB
      };
      var _tr = [elevB.buffer, horizB.buffer, cumCosB.buffer, cumSinB.buffer, resXB.buffer];
      if (normB) _tr.push(normB.buffer);
      w.postMessage(_msg, _tr);
    }
  });
}

function insolationEpoque(t_ka) {
  // Cache
  for (var i = 0; i < insolCache.length; i++) {
    if (insolCache[i].tka === t_ka) {
      var hit = insolCache.splice(i, 1)[0];
      insolCache.push(hit);                       // remonte en tête LRU
      return Promise.resolve(hit.map);
    }
  }
  if (!ombreHorizonCopy || !ombreElev1024) {
    return Promise.reject(new Error('Passe 1 (horizon) non calculée'));
  }

  // Étapes A + B — recalculées à chaque époque : e/eps/pibar changent,
  // c'est précisément le signal de précession recherché sur 20 ka.
  var cum = insolCumuls(insolHistogramme(t_ka));

  var Wd = OMBRE_DIM, Hd = OMBRE_DIM, nAz = OMBRE_N_AZ;
  var NW = Math.min(navigator.hardwareConcurrency || 4, 8);
  var bande = Math.ceil(Hd / NW);

  return new Promise(function(resolve, reject) {
    var carte = new Float32Array(Wd * Hd);
    var stats = { sumN: 0, nN: 0, sumS: 0, nS: 0 };
    var fini  = 0, total = 0;

    insolPool.forEach(function(w){ w.terminate(); });
    insolPool = [];

    for (var k = 0; k < NW; k++) {
      var r0 = k * bande;
      var r1 = Math.min(Hd, r0 + bande);
      if (r0 >= r1) break;
      total++;

      var r0e = Math.max(0, r0 - 1);                 // marge gradients
      var r1e = Math.min(Hd, r1 + 1);

      // COPIES pour transfert zero-copy (jamais les originaux)
      var elevB  = new Float32Array(ombreElev1024.subarray(r0e * Wd, r1e * Wd));
      var horizB = new Int16Array(
        ombreHorizonCopy.subarray(r0 * Wd * nAz, r1 * Wd * nAz));
      var cumCosB = new Float32Array(cum.cumCos);
      var cumSinB = new Float32Array(cum.cumSin);
      var resXB   = new Float32Array(ombreResX);

      var blob = new Blob([INSOLMAP_WORKER_SRC], {type:'application/javascript'});
      var url  = URL.createObjectURL(blob);
      var w    = new Worker(url);
      URL.revokeObjectURL(url);
      insolPool.push(w);

      w.onmessage = function(ev) {
        var res = ev.data;
        if (res.type !== 'done') return;
        this.terminate();
        var pi = insolPool.indexOf(this);
        if (pi >= 0) insolPool.splice(pi, 1);

        carte.set(res.insol, res.r0 * Wd);
        stats.sumN += res.stats.sumN; stats.nN += res.stats.nN;
        stats.sumS += res.stats.sumS; stats.nS += res.stats.nS;
        fini++;
        document.getElementById('vstatus').textContent =
          '☀️ Insol bande ' + fini + '/' + total + '…';

        if (fini === total) {
          insolCache.push({ tka: t_ka, map: carte, stats: stats });
          if (insolCache.length > 2) insolCache.shift();    // LRU 2
          resolve(carte);
        }
      };
      w.onerror = function(err) { reject(err); };

      w.postMessage({
        type:'insolband', r0:r0, r1:r1, r0e:r0e,
        W:Wd, H:Hd, nAz:nAz,
        elev:elevB, horizon:horizB,
        cumCos:cumCosB, cumSin:cumSinB,
        resX:resXB, resY:ombreResY
      }, [elevB.buffer, horizB.buffer, cumCosB.buffer, cumSinB.buffer, resXB.buffer]);
    }
  });
}

// ════════════════════════════════════════════════════════════════
// RENDU — LUT froid→chaud (bleu → jaune → rouge), normalisée min/max
// de la carte ; pixels mer = bleu mer existant (20,60,130).
// putImageData direct (comme ombreRendreFrame).
// ════════════════════════════════════════════════════════════════
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

function insolAfficher(map, t_ka) {
  var Wd = OMBRE_DIM, N = Wd * Wd;
  var lut = insolLUT();

  // min/max/moyenne sur la TERRE uniquement — la mer est à part (noir),
  // hors normalisation : elle écrasait l'échelle vers le rouge.
  var mn = Infinity, mx = -Infinity, somme = 0, nT = 0;
  for (var i = 0; i < N; i++) {
    var z = ombreElev1024[i];
    if (z <= 0.5 || z >= 9000) continue;
    var v = map[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    somme += v; nT++;
  }

  // Normalisation par CENTILES (p2–p98) : quelques pixels extrêmes ne doivent
  // pas écraser l'échelle. Histogramme 4096 bins sur [mn,mx] → bornes p2/p98.
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
      dst[p] = 0; dst[p + 1] = 0; dst[p + 2] = 0;              // mer : NOIR
    } else {
      var li = Math.min(255, Math.max(0,
        Math.round((map[i2] - mn) / plage * 255))) * 3;
      dst[p] = lut[li]; dst[p + 1] = lut[li + 1]; dst[p + 2] = lut[li + 2];
    }
    dst[p + 3] = 255;
  }
  // Coloriser dans l'OffscreenCanvas → affichage via le pipeline zoom/pan
  if (!insolOsc) insolOsc = new OffscreenCanvas(Wd, Wd);
  insolOsc.getContext('2d').putImageData(img, 0, 0);

  insolMap     = map;
  insolMapTka  = t_ka;
  insolMn      = mn;
  insolMx      = mx;
  insolImgData = img;                       // garde des délégations dsm.html
  insolRedessiner();
  document.getElementById('vstatus').textContent =
    '☀️ Insol an ' + ctrlAnnee
    + ' — min ' + (mn * INSOL_W_PAR_H).toFixed(0)
    + ' / max ' + (mx * INSOL_W_PAR_H).toFixed(0)
    + ' / moy ' + (somme / nT * INSOL_W_PAR_H).toFixed(0)
    + ' W/m² (moy. annuelle — échelle ' + INSOL_PCT_BAS + '–' + INSOL_PCT_HAUT + ' centiles)';
}

// ── insolRedessiner — repeint la carte via srcX/srcY/srcPPx (zoom/pan) ──
// Appelé par render() (délégation) : molette et drag fonctionnent comme l'hypso.
// La grille insol (OMBRE_DIM²) couvre l'emprise image → facteur d'échelle sx/sy.
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

// ════════════════════════════════════════════════════════════════
// LÉGENDE — barre verticale dédiée, graduée en W/m² (moyenne annuelle)
// Même géométrie que drawLegend (altitude) ; mer = pavé noir en pied.
// Conversion : P(W/m²) = insol(h·éq-zénith/an) × S0/8766.
// ════════════════════════════════════════════════════════════════
function drawLegendInsol() {
  var lcv = document.getElementById('lcv');
  if (!lcv || insolMx <= insolMn) return;
  // Titre et unité du panneau : vue insolation
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
  // Mer : pavé noir
  lctx.fillStyle = '#000'; lctx.fillRect(barX, barY + barH + 10, 10, 6);
  lctx.strokeStyle = '#45475a'; lctx.strokeRect(barX + 0.5, barY + barH + 10.5, 10, 6);
  lctx.fillStyle = '#a6adc8'; lctx.fillText('mer', barX + 14, barY + barH + 16);
}

// ════════════════════════════════════════════════════════════════
// insolRecalcul — appelé au clic ☀️ et par le slider ANNÉE (dirty)
// ════════════════════════════════════════════════════════════════
function insolRecalcul() {
  if (!insolActive) return;
  if (insolEnCours) return;            // anti-réentrance (slider rapide)
  var tka = ctrlTka();
  insolEnCours = insolationEpoque(tka)
    .then(function(map) {
      insolEnCours = null;
      if (!insolActive) return;
      insolAfficher(map, tka);
      if (tka !== ctrlTka()) insolRecalcul();      // l'année a re-bougé
      else insolTests(tka);
    })
    .catch(function(err) {
      insolEnCours = null;
      document.getElementById('vstatus').textContent = '☀️ Insol : ' + err.message;
    });
}

// ════════════════════════════════════════════════════════════════
// TESTS DE VALIDATION (console.log, une seule fois, au 1er affichage)
// 1. Différentiel N/S : versant exposé sud ≫ versant nord (boréal).
// 2. Précession : moyenne globale époque courante vs 10 ka — écart non nul.
// 3. Cohérence : pixel plat dégagé (hmax < 5°) ≈ intégrale analytique plate
//    Σ W·sin(el) — écart < 1 %.
// ════════════════════════════════════════════════════════════════
function insolTests(tkaCourant) {
  if (insolTestsFaits) return;
  insolTestsFaits = true;

  // ── Test 1 : différentiel versants (stats agrégées par les workers) ──
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

  // ── Test 3 : pixel plat dégagé vs intégrale analytique plate ──
  var Wd = OMBRE_DIM, nAz = OMBRE_N_AZ, NB = INSOL_EL_NB + 1;
  var best = -1, bestPente = Infinity;
  for (var idx = 0; idx < Wd * Wd; idx++) {
    if (ombreHmaxCopy[idx] >= 500) continue;             // hmax ≥ 5°
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

  // ── Test 2 : précession — moyenne globale courante vs 10 ka ──
  var tkaRef = (Math.abs(tkaCourant) === 10) ? 0 : 10;   // 10 ka avant 1950
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

// ════════════════════════════════════════════════════════════════
// BOUTON ☀️ Insol — toggle vue (activé par dsm-ombre.js fin passe 1)
// ════════════════════════════════════════════════════════════════
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
    // Restaurer jour/heure — sauf si temp est aussi active (moyenne annuelle)
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
  // Griser JOUR et HEURE — insolation = moyenne annuelle
  var b1 = document.getElementById('ctrl-bloc-1');
  var b2 = document.getElementById('ctrl-bloc-2');
  if (b1) { b1.style.opacity = '0.25'; b1.style.pointerEvents = 'none'; }
  if (b2) { b2.style.opacity = '0.25'; b2.style.pointerEvents = 'none'; }
  insolRecalcul();
});
