/* ═══════════════════════════════════════════════════════════════════
   FICHIER : dsm-flux.js - v27/09/2026
   OBJET   : écoulement de la glace sur le filet (graphe de facettes) :
             approximation de la couche mince (SIA) en volumes finis,
             schéma implicite en épaisseur, itérations de Picard sur la
             diffusivité, résolution par gradient conjugué préconditionné ;
             glissement basal, fronts, sorties aux bords et vêlage ;
             rejeu des volumes par phase de l'année entre deux recalages.
   AUTEUR  : Eric P.
   RELECTURE : Opus 5.5
   DÉPEND  : aucun (même code dans le Worker de dsm-worker-flux.js)
   EXPOSE  : DSMFLUX_FABRIQUE, DSMFLUX { adjacence, pas, pasBP, A_GLEN,
             config, sonde, progres }
   CONVENTIONS : glace en m d'équivalent eau en entrée/sortie (densité
             0,917), épaisseur H en m de glace en interne ; flux Glen
             n = 3, A = 2,4·10⁻²⁴ Pa⁻³·s⁻¹ × E ; glissement u_b = c1·τ_b
   ═══════════════════════════════════════════════════════════════════ */
"use strict";
/* ── DSMFLUX_FABRIQUE ── E : aucune → T : constantes physiques, config par
   défaut, fonctions du module → S : { adjacence, pas, pasBP, A_GLEN,
   config }. ALGO : « Fabrique sérialisable (toString) pour exécuter le même
   code sur le fil principal et dans un Worker. » */
function DSMFLUX_FABRIQUE() {
  const D = 1024, RHO = 917, G = 9.81, DENS_G = 0.917, N_GLEN = 3;
  const A_GLEN = 2.4e-24;
  const CONFIG = { E: 3, c1: 0, c1Tab: null, glissTab: null };
  const SEC_J  = 86400;

  /* ── adjacence ───────────────────────────────────────────────────────────
     ENTRÉE     : filet F (triOfPix, centIdx, centZ, nx/ny/nz), scaleXY (m,
                  nombre ou {x, y}), mode ('A' distance entre barycentres,
                  'B' distance perpendiculaire à la frontière), flood (inutilisé)
     TRAITEMENT : paires de facettes voisines relevées sur la grille ;
                  longueur de frontière = min(somme des côtés de pixels,
                  étendue + un pixel) en m ; distance selon le mode ; dénivelé
                  du lit = centZ[a] − centZ[b] (lit intégrable) ; puis
                  longueur de bord de tuile et pente sortante du lit par
                  facette, drapeau mer (centZ ≤ 0,5)
     SORTIE     : adj { n, a, b, len, dist, cs (pente du lit a→b), rail,
                  mode, bordL, bordS, mer }
     ALGO       : « Graphe de volumes finis entre facettes : longueur
                  d'interface, distance et pente du lit par arête, plus les
                  conditions aux limites. »
     ─────────────────────────────────────────────────────────────────── */
  function adjacence(F, scaleXY, mode, flood1024) {
    mode = mode === 'A' ? 'A' : 'B';
    var rx = typeof scaleXY === 'object' ? scaleXY.x : scaleXY;
    var ry = typeof scaleXY === 'object' ? scaleXY.y : scaleXY;
    var top = F.triOfPix;
    var map = new Map();
    for (var y = 0; y < D - 1; y++)
      for (var x = 0; x < D - 1; x++) {
        var i = y * D + x, a = top[i];
        if (a < 0) continue;
        var b1 = top[i + 1], b2 = top[i + D];
        if (b1 >= 0 && b1 !== a) _acc(map, a, b1, x + 1, y + 0.5, ry);
        if (b2 >= 0 && b2 !== a) _acc(map, a, b2, x + 0.5, y + 1, rx);
      }
    var n = map.size;
    var eA = new Int32Array(n), eB = new Int32Array(n);
    var eL = new Float32Array(n), eD = new Float32Array(n);
    var eC = new Float32Array(n);
    var j = 0;
    map.forEach(function (r, k) {
      var a = Math.floor(k / 1e6), b = k % 1e6;
      eA[j] = a; eB[j] = b;
      var ax = F.centIdx[a] % D, ay = (F.centIdx[a] / D) | 0;
      var bx = F.centIdx[b] % D, by = (F.centIdx[b] / D) | 0;
      var cxv = (bx - ax) * rx, cyv = (by - ay) * ry;
      var cl  = Math.hypot(cxv, cyv) || 1;
      var sx = (r.x1 - r.x0) * rx, sy = (r.y1 - r.y0) * ry;
      var lenM = Math.min(r.lm, Math.hypot(sx, sy) + (rx + ry) / 2);
      var dx, dy, distM;
      if (mode === 'B' && (sx !== 0 || sy !== 0)) {
        var sl = Math.hypot(sx, sy);
        dx = sy / sl; dy = -sx / sl;
        if (dx * cxv + dy * cyv < 0) { dx = -dx; dy = -dy; }
        distM = Math.abs(cxv * dx + cyv * dy);
      } else {
        dx = cxv / cl; dy = cyv / cl;
        distM = cl;
      }
      eL[j] = lenM;
      eD[j] = Math.max(Math.min(rx, ry), distM);
      if (F.centZ) {
        /* Dénivelé réel entre barycentres : champ de lit intégrable (la
           somme des B le long d'une boucle est nulle, pas de cuvette
           fictive). Les pentes issues des normales ne l'étaient pas.    */
        eC[j] = (F.centZ[a] - F.centZ[b]) / eD[j];
      } else if (F.nx) {
        var wa = F.surf[a] / (F.surf[a] + F.surf[b]), wb = 1 - wa;
        var gx = wa * (-F.nx[a] / (F.nz[a] || 1)) + wb * (-F.nx[b] / (F.nz[b] || 1));
        var gy = wa * (-F.ny[a] / (F.nz[a] || 1)) + wb * (-F.ny[b] / (F.nz[b] || 1));
        eC[j] = -(gx * dx + gy * dy);
      }
      j++;
    });
    var eR = new Int8Array(n);
    if (flood1024) {
      for (var jr = 0; jr < n; jr++) {
        var fa = flood1024[F.centIdx[eA[jr]]], fb = flood1024[F.centIdx[eB[jr]]];
        if      (fb < fa) eR[jr] = 1;
        else if (fa < fb) eR[jr] = -1;
        else if (F.centZ) {
          var za = F.centZ[eA[jr]], zb = F.centZ[eB[jr]];
          eR[jr] = zb < za ? 1 : za < zb ? -1 : 0;
        }
      }
    }
    /* Bords de tuile (sortie libre) et mer (vêlage). bordL : longueur de
       bord en m ; bordS : pente du lit vers l'extérieur, moyenne sur le
       bord ; mer : barycentre au niveau de la mer.                     */
    var nT = F.nTri, bordL = new Float32Array(nT), bordS = new Float32Array(nT), mer = new Uint8Array(nT);
    /* bord — E : facette, longueur de côté (m), direction sortante (ux, uy)
       → T : cumule la longueur de bord et la pente du lit vers l'extérieur
       (depuis la normale) pondérée → S : aucune. */
    function bord(t, L, ux, uy) {
      if (t < 0) return;
      bordL[t] += L;
      if (F.nx) {
        var nz = F.nz[t] || 1, gx = -F.nx[t] / nz, gy = -F.ny[t] / nz;
        var s = -(gx * ux + gy * uy);
        if (s > 0) bordS[t] += L * s;
      }
    }
    for (var xb = 0; xb < D; xb++) { bord(top[xb], rx, 0, -1); bord(top[(D - 1) * D + xb], rx, 0, 1); }
    for (var yb = 0; yb < D; yb++) { bord(top[yb * D], ry, -1, 0); bord(top[yb * D + D - 1], ry, 1, 0); }
    for (var tb = 0; tb < nT; tb++) {
      if (bordL[tb] > 0) bordS[tb] /= bordL[tb];
      if (F.centZ && F.centZ[tb] <= 0.5) mer[tb] = 1;
    }
    return { n: n, a: eA, b: eB, len: eL, dist: eD, cs: eC, rail: eR, mode: mode,
             bordL: bordL, bordS: bordS, mer: mer };
  }
  /* ── _acc ── E : table, facettes a, b, point de frontière, longueur du côté
     de pixel (m) → T : crée ou complète l'entrée de la paire (compte,
     longueur, extrémités) → S : aucune. */
  function _acc(map, a, b, px, py, lPix) {
    var k = a < b ? a * 1e6 + b : b * 1e6 + a;
    var r = map.get(k);
    if (!r) { map.set(k, { c: 1, lm: lPix, x0: px, y0: py, x1: px, y1: py }); return; }
    r.c++; r.lm += lPix;
    if (px < r.x0) r.x0 = px; if (px > r.x1) r.x1 = px;
    if (py < r.y0) r.y0 = py; if (py > r.y1) r.y1 = py;
  }

  /* ── pas ──────────────────────────────────────────────────────────────────
     ENTRÉE     : F filet, adj (adjacence), glaceWE Float32Array (m éq. eau,
                  modifié en place), dtJours, wantVit, phase (0..72),
                  recale (recalage imposé par l'appelant)
     TRAITEMENT : caches d'arêtes (1/d, len/d, listes d'incidence) ;
                  recalage si imposé, sans volumes mémorisés pour la phase, ou
                  si une épaisseur a dérivé de plus de 20 m + 10 % depuis le
                  dernier recalage ; RECALAGE — « postier » puis solveSeg sur
                  le pas complet, volumes par arête mémorisés pour la phase ;
                  SINON — rejeu des volumes mémorisés, limités par la glace
                  disponible à la source ; puis pertes aux bords (flux SIA
                  explicite, pente sortante = max(lit, surface entrante), ≤ 90 %
                  du volume) et vêlage en mer ; vitesses depuis les volumes
     SORTIE     : glaceWE mis à jour ; F.vx, F.vy, F.vit (m/an) si wantVit ;
                  DSMFLUX.sonde (top 3 des transferts, convergence, recalage,
                  postier, sorties, vêlage)
     ALGO       : « Un pas SIA implicite sur le graphe de facettes, recalculé
                  par phase seulement quand la géométrie a changé, rejoué
                  sinon. »
     ⚠ Le « postier » (recalage) vide d'un coup toute facette de front plus
       épaisse que 4 × l'épaisseur moyenne jusqu'à 10 m, en répartissant
       l'excédent sur ses voisines vides : transfert instantané, non
       physique.
     ⚠ Vitesses : somme vectorielle des vitesses de sortie sur toutes les
       arêtes, en direction pixel (non métrique) ; indicatif seulement.
     ─────────────────────────────────────────────────────────────────── */
  function pas(F, adj, glaceWE, dtJours, wantVit, phase, recale) {
    var nT = F.nTri, nE = adj.n;
    if (!F.vx) { F.vx = new Float32Array(nT); F.vy = new Float32Array(nT); F.vit = new Float32Array(nT); }
    if (wantVit) { F.vx.fill(0); F.vy.fill(0); F.vit.fill(0); }
    var g    = G;
    var cfg  = DSMFLUX.config || CONFIG;
    var kDef = (cfg.E||1) * (2 * A_GLEN / (N_GLEN + 2)) * (RHO*g)*(RHO*g)*(RHO*g);
    var kLin = (cfg.c1||0) * (RHO*g);
    var c1Tab = cfg.c1Tab || null;
    var GLISS = (cfg.gliss > 0) ? cfg.gliss : 5;
    var glissTab = cfg.glissTab || null;
    if (!adj.invD) {
      adj.invD = new Float32Array(nE);
      for (var e0 = 0; e0 < nE; e0++) adj.invD[e0] = 1 / adj.dist[e0];
    }
    if (!adj._geo) {
      adj._geo = new Float64Array(nE);
      for (var eg = 0; eg < nE; eg++) adj._geo[eg] = adj.len[eg] * adj.invD[eg];
    }
    if (!adj._cOff) {
      var cnt = new Int32Array(nT);
      for (var ec = 0; ec < nE; ec++) { cnt[adj.a[ec]]++; cnt[adj.b[ec]]++; }
      adj._cOff = new Int32Array(nT + 1);
      for (var tc = 0; tc < nT; tc++) adj._cOff[tc + 1] = adj._cOff[tc] + cnt[tc];
      adj._cEdge = new Int32Array(adj._cOff[nT]);
      adj._cSgn  = new Int8Array(adj._cOff[nT]);
      var fill = Int32Array.from(adj._cOff.subarray(0, nT));
      for (var ef = 0; ef < nE; ef++) {
        var pa = fill[adj.a[ef]]++; adj._cEdge[pa] = ef; adj._cSgn[pa] = 1;
        var pb = fill[adj.b[ef]]++; adj._cEdge[pb] = ef; adj._cSgn[pb] = -1;
      }
    }
    if (!adj._K) {
      adj._K   = new Float64Array(nE);
      adj._B   = new Float64Array(nE);
      adj._H0  = new Float64Array(nT);
      adj._H   = new Float64Array(nT);
      adj._dVc = new Float64Array(nE);
      for (var eb = 0; eb < nE; eb++) adj._B[eb] = adj.cs[eb] * adj.dist[eb];
    }
    phase = phase | 0;
    var CAMION_VIDE = 10;
    if (!adj._camion) adj._camion = new Uint8Array(nT);
    var camion = adj._camion, camionN = 0;
    if (!adj._slot) adj._slot = [];
    var slot = adj._slot[phase];
    var recaleP = recale || !slot;
    var K = adj._K, B = adj._B, H0 = adj._H0, H = adj._H, dVc = adj._dVc, geo = adj._geo;
    var cOff = adj._cOff, cEdge = adj._cEdge, cSgn = adj._cSgn;
    for (var t0 = 0; t0 < nT; t0++) { H0[t0] = glaceWE[t0] > 0 ? glaceWE[t0] / DENS_G : 0; H[t0] = H0[t0]; }

    /* Recalage automatique : rejouer les volumes d'une phase n'est valable
       que tant que la géométrie de la glace reste proche de celle du
       dernier recalage. Au-delà de RECAL_DH + RECAL_REL·H (sur un seul
       triangle), la phase est recalculée. Sans ce garde-fou, un triangle
       récepteur reçoit indéfiniment le même apport alors que sa sortie,
       figée quand il était vide, reste nulle : épaisseurs de plusieurs
       dizaines de km après 99 ans de copie.                           */
    var RECAL_DH = cfg.recalDH > 0 ? cfg.recalDH : 20, RECAL_REL = 0.1;
    if (!adj._slotH) adj._slotH = [];
    var recaleAuto = 0;
    if (!recaleP) {
      var refH = adj._slotH[phase];
      if (!refH) { recaleP = true; recaleAuto = 1; }
      else for (var tr = 0; tr < nT; tr++) {
        var dh = H0[tr] - refH[tr]; if (dh < 0) dh = -dh;
        if (dh > RECAL_DH + RECAL_REL * refH[tr]) { recaleP = true; recaleAuto = 1; break; }
      }
    }

    if (!adj._actC) { adj._actC = new Int32Array(nT); adj._actE = new Int32Array(nE); adj._inAct = new Uint8Array(nT); }
    var actC = adj._actC, actE = adj._actE, inAct = adj._inAct;
    var dtTot = dtJours * SEC_J;
    var PICARD_MAX = 16, GS_MAX = 30, TOL_GS = 1e-2, RELAX = 0.7;
    /* Convergence d'un sous-pas : résolution linéaire (TOL_CONV, écart
       d'un balayage) ET itération de Picard (TOL_PIC, variation maximale
       d'épaisseur entre deux itérations de Picard successives).        */
    var TOL_CONV = 0.1, TOL_PIC = 0.1, REL_PIC = 0.05;
    var dPicMax = 0, picNonConv = 0;
    var MAX_PROF = 9;
    var GS_BUDGET = 40000;
    var FOC_MAX = 3000;
    var nSeg = 0, gsTot = 0, picTot = 0, neg = 0, cgTot = 0;
    var nonConv = 0, nonConvMax = 0, nonConvProfMin = 99;
    /* Signe de vie, au plus une fois par seconde, si DSMFLUX.progres est posé */
    var _tP = 0, _prof = 0;
    /* progres — E : étape, écart courant → T : au plus une fois par seconde,
       appelle DSMFLUX.progres avec l'état du solveur → S : aucune. */
    function progres(etape, dM) {
      var cb = DSMFLUX.progres; if (!cb) return;
      var t = Date.now(); if (t - _tP < 1000) return; _tP = t;
      cb({ etape: etape, seg: nSeg, prof: _prof, picard: picTot, gs: gsTot,
           budget: GS_BUDGET, cg: cgTot, nAC: nAC, dMax: dM, dt: curDt });
    }
    dVc.fill(0);
    var X  = adj._X  || (adj._X  = new Float64Array(nT));
    var fS = adj._fS || (adj._fS = new Float64Array(nT));
    var H0s = adj._H0s || (adj._H0s = new Float64Array(nT));
    var sgnUp = adj._sgnUp || (adj._sgnUp = new Int8Array(nE));
    var frontT = adj._frontT || (adj._frontT = new Uint8Array(nE));   // 0 intérieur, 1 front, 2 front bloqué (rail)
    var cand = adj._cand || (adj._cand = new Int32Array(nE));
    var dC = adj._dC || (adj._dC = new Float64Array(nT));
    var curDt = 0, nAE = 0, nAC = 0;
    inAct.fill(0);

    /* ── balaye ── E : liste de facettes, sens → T : un balayage de Gauss-Seidel
       du système implicite H_i = (A/dt·H0_i + Σ K(H_j − sgn·B)) / (A/dt + Σ K),
       projeté sur H ≥ 0 → S : correction maximale (m) ; écarts par facette
       dans dC. */
    function balaye(liste, nL, sens) {
      var dM = 0;
      for (var q0 = 0; q0 < nL; q0++) {
        var i = liste[sens ? nL - 1 - q0 : q0];
        var Adt = F.surf[i] / curDt;
        var num = Adt * H0s[i], den = Adt;
        for (var p = cOff[i]; p < cOff[i + 1]; p++) {
          var ei = cEdge[p], ke = K[ei];
          if (ke === 0) continue;
          var j = cSgn[p] > 0 ? adj.b[ei] : adj.a[ei];
          num += ke * H[j] - cSgn[p] * ke * B[ei];
          den += ke;
        }
        var Hn = num / den;
        if (Hn < 0) Hn = 0;
        var dl = Hn - H[i]; if (dl < 0) dl = -dl;
        dC[i] = dl;
        if (dl > dM) dM = dl;
        H[i] = Hn;
      }
      return dM;
    }

    /* Réglages du gradient conjugué : itérations max, tolérance (m),
       passes d'ensemble actif, balayages tentés avant d'y recourir. */
    var CG_MAX = 600, TOL_CG = 5e-3, CG_PASSES = 5, GS_PRE = 6;

    /* ── precond ── E : liste, fixés, positions, résidu r, diagonale, sortie z
       → T : Gauss-Seidel symétrique (SSOR, ω = 1) dans l'ordre de la liste,
       z = (D+U)⁻¹·D·(D+L)⁻¹·r, facettes fixées exclues → S : z. */
    function precond(liste, nL, fixe, pos, r, dg, z) {
      var q0, i, p, ei, ke, j, s;
      for (q0 = 0; q0 < nL; q0++) {
        i = liste[q0];
        if (fixe[i]) { z[i] = 0; continue; }
        s = r[i];
        for (p = cOff[i]; p < cOff[i + 1]; p++) {
          ei = cEdge[p]; ke = K[ei]; if (ke === 0) continue;
          j = cSgn[p] > 0 ? adj.b[ei] : adj.a[ei];
          if (pos[j] >= 0 && pos[j] < q0 && !fixe[j]) s += ke * z[j];
        }
        z[i] = s / dg[i];
      }
      for (q0 = nL - 1; q0 >= 0; q0--) {
        i = liste[q0];
        if (fixe[i]) continue;
        s = 0;
        for (p = cOff[i]; p < cOff[i + 1]; p++) {
          ei = cEdge[p]; ke = K[ei]; if (ke === 0) continue;
          j = cSgn[p] > 0 ? adj.b[ei] : adj.a[ei];
          if (pos[j] > q0 && !fixe[j]) s += ke * z[j];
        }
        z[i] += s / dg[i];
      }
    }

    /* ── cgCoeur ── E : liste, fixés → T : gradient conjugué préconditionné
       (precond) sur les facettes libres du système
       (A/dt + Σ K)·H_i − Σ K·H_j = A/dt·H0_i − Σ sgn·K·B, sans matrice ; arrêt
       quand max |r_i/d_i| < 5 mm ou après 600 itérations → S : nombre
       d'itérations ; H mis à jour. */
    function cgCoeur(liste, nL, fixe) {
      var r = adj._cgR || (adj._cgR = new Float64Array(nT));
      var zc = adj._cgZ || (adj._cgZ = new Float64Array(nT));
      var pc = adj._cgP || (adj._cgP = new Float64Array(nT));
      var qc = adj._cgQ || (adj._cgQ = new Float64Array(nT));
      var dg = adj._cgD || (adj._cgD = new Float64Array(nT));
      var pos = adj._cgPos || (adj._cgPos = new Int32Array(nT).fill(-1));
      var rz = 0, q0, i, p, ei, ke, j, s, rMax = 0;
      for (q0 = 0; q0 < nL; q0++) pos[liste[q0]] = q0;
      for (q0 = 0; q0 < nL; q0++) {
        i = liste[q0];
        if (fixe[i]) { r[i] = 0; pc[i] = 0; continue; }
        var Adt = F.surf[i] / curDt, d = Adt, b = Adt * H0s[i];
        s = 0;
        for (p = cOff[i]; p < cOff[i + 1]; p++) {
          ei = cEdge[p]; ke = K[ei];
          if (ke === 0) continue;
          j = cSgn[p] > 0 ? adj.b[ei] : adj.a[ei];
          d += ke; b -= cSgn[p] * ke * B[ei]; s += ke * H[j];
        }
        dg[i] = d; r[i] = b - (d * H[i] - s);
        var e0 = r[i] / d; if (e0 < 0) e0 = -e0; if (e0 > rMax) rMax = e0;
      }
      var it = 0;
      if (rMax >= TOL_CG) {
        precond(liste, nL, fixe, pos, r, dg, zc);
        for (q0 = 0; q0 < nL; q0++) { i = liste[q0]; if (!fixe[i]) { pc[i] = zc[i]; rz += r[i] * zc[i]; } }
        while (it < CG_MAX) {
          it++;
          var pq = 0;
          for (q0 = 0; q0 < nL; q0++) {
            i = liste[q0];
            if (fixe[i]) continue;
            s = 0;
            for (p = cOff[i]; p < cOff[i + 1]; p++) {
              ei = cEdge[p]; ke = K[ei];
              if (ke === 0) continue;
              s += ke * pc[cSgn[p] > 0 ? adj.b[ei] : adj.a[ei]];
            }
            qc[i] = dg[i] * pc[i] - s; pq += pc[i] * qc[i];
          }
          if (!(pq > 0)) break;
          var al = rz / pq;
          rMax = 0;
          for (q0 = 0; q0 < nL; q0++) {
            i = liste[q0];
            if (fixe[i]) continue;
            H[i] += al * pc[i];
            r[i] -= al * qc[i];
            var er = r[i] / dg[i]; if (er < 0) er = -er; if (er > rMax) rMax = er;
          }
          progres('CG', rMax);
          if (rMax < TOL_CG) break;
          precond(liste, nL, fixe, pos, r, dg, zc);
          var rzN = 0;
          for (q0 = 0; q0 < nL; q0++) { i = liste[q0]; if (!fixe[i]) rzN += r[i] * zc[i]; }
          var be = rzN / rz; rz = rzN;
          for (q0 = 0; q0 < nL; q0++) { i = liste[q0]; if (!fixe[i]) pc[i] = zc[i] + be * pc[i]; }
        }
      }
      for (q0 = 0; q0 < nL; q0++) pos[liste[q0]] = -1;
      return it;
    }

    /* ── pcg ── E : liste de facettes actives → T : cgCoeur, puis fixe à 0 les
       facettes devenues négatives et recommence sur les autres (≤ 5 passes) →
       S : itérations totales. ALGO : « Gradient conjugué à ensemble actif pour
       la contrainte H ≥ 0. » */
    function pcg(liste, nL) {
      var fixe = adj._cgF || (adj._cgF = new Uint8Array(nT));
      for (var q0 = 0; q0 < nL; q0++) fixe[liste[q0]] = 0;
      var it = 0;
      for (var passe = 0; passe < CG_PASSES; passe++) {
        it += cgCoeur(liste, nL, fixe);
        var nNeuf = 0;
        for (q0 = 0; q0 < nL; q0++) {
          var i = liste[q0];
          if (!fixe[i] && H[i] < 0) { H[i] = 0; fixe[i] = 1; nNeuf++; }
        }
        if (!nNeuf) break;
      }
      return it;
    }

    /* ── solveSeg ─────────────────────────────────────────────────────────────
       ENTRÉE     : dtSeg (s), profondeur de découpe
       TRAITEMENT : itérations de Picard (≤ 16) — diffusivité par arête
                    D = k_def·H⁵·s² + k_lin·H² (H de la facette amont, s pente
                    de surface), × longueur / distance, × facteur de patinage
                    aux fronts (état de front figé après la 1re itération),
                    relaxée (0,7, divisée par 2 si la correction stagne) ;
                    arêtes et facettes actives ; 6 balayages, sinon gradient
                    conjugué puis balayages de finition et zones focalisées ;
                    arrêt si résolution < 0,1 m et correction de Picard
                    < 0,1 m ou < 5 % de la variation du pas ; si la résolution
                    n'a pas convergé, découpe dt en deux (≤ 9 niveaux) ;
                    flux par arête Q = K·(B + H_a − H_b)·dt, limité par la glace
                    source, appliqué explicitement
       SORTIE     : H mis à jour, volumes par arête cumulés dans dVc
       ALGO       : « Pas implicite non linéaire de diffusion SIA : Picard sur
                    la diffusivité, gradient conjugué pour le système linéaire,
                    bilan de volume conservatif par arête. »
       ─────────────────────────────────────────────────────────────────── */
    function solveSeg(dtSeg, prof) {
      _prof = prof;
      H0s.set(H);
      curDt = dtSeg;
      var dMax = 1e9, nCand = 0, dPic = 1e9, picOK = false;
      /* Relaxation adaptative : si la correction de Picard ne décroît
         plus (cycle d'ordre 2 typique de D ∝ H⁵), elle est divisée par 2. */
      var relax = RELAX, dPicPrec = 1e9;
      var Hp = adj._Hpic || (adj._Hpic = new Float64Array(nT));
      Hp.set(H);
      for (var pic = 0; pic < PICARD_MAX; pic++) {
        picTot++;
        var nL = pic === 0 ? nE : nCand;
        if (pic === 0) nCand = 0;
        for (var q = 0; q < nL; q++) {
          var e = pic === 0 ? q : cand[q];
          var a = adj.a[e], b = adj.b[e];
          var Ha = H[a], Hb = H[b];
          if (Ha <= 0 && Hb <= 0) { K[e] = 0; continue; }
          if (pic === 0) cand[nCand++] = e;
          var s  = adj.cs[e] + (Ha - Hb) * adj.invD[e];
          var sg = s > 0 ? 1 : -1;
          /* État de front figé après la première itération : le basculer
             à chaque itération (triangle vide ↔ plein, patinage ×GLISS)
             rend K discontinu et Picard oscille sans converger.       */
          var frontE;
          if (pic === 0) { frontE = (Ha > 0.01) !== (Hb > 0.01); frontT[e] = frontE ? 1 : 0; }
          else {
            if (frontT[e] === 2) { K[e] = 0; continue; }
            frontE = frontT[e] === 1;
          }
          if (frontE && pic === 0) {
            var videB = Hb <= 0.01;
            var railE = adj.rail ? adj.rail[e] : 0;
            if (railE !== 0 && railE === (videB ? -1 : 1)) { frontT[e] = 2; K[e] = 0; continue; }
            sgnUp[e] = videB ? 1 : -1;
          } else if (frontE) {
            /* sens amont conservé */
          } else if (pic === 0) {
            sgnUp[e] = sg;
          } else if (sg !== sgnUp[e]) {
            if (adj.rail && adj.rail[e] !== 0) sgnUp[e] = adj.rail[e];
          }
          var Hup = sgnUp[e] > 0 ? Ha : Hb;
          if (Hup <= 0.01 && pic === 0) { K[e] = 0; continue; }
          if (Hup <= 0) { K[e] = 0; continue; }
          var h2 = Hup * Hup;
          var kLinE = c1Tab ? c1Tab[sgnUp[e] > 0 ? a : b] * (RHO * g) : kLin;
          var Df = kDef * h2 * h2 * Hup * s * s + kLinE * h2;
          var kNew = Df * geo[e];
          if (frontE) kNew *= glissTab ? glissTab[sgnUp[e] > 0 ? b : a] : GLISS;
          K[e] = pic === 0 ? kNew : K[e] + relax * (kNew - K[e]);
        }
        for (var zc = 0; zc < nAC; zc++) inAct[actC[zc]] = 0;
        nAE = 0; nAC = 0;
        for (var ez = 0; ez < nCand; ez++) {
          var ek = cand[ez];
          if (K[ek] === 0) continue;
          actE[nAE++] = ek;
          var za = adj.a[ek], zb = adj.b[ek];
          if (!inAct[za]) { inAct[za] = 1; actC[nAC++] = za; }
          if (!inAct[zb]) { inAct[zb] = 1; actC[nAC++] = zb; }
        }
        /* Système facile : quelques balayages suffisent. Sinon, gradient
           conjugué, puis balayages de finition.                        */
        var gs = 0; dMax = 1e9;
        while (gs < GS_PRE && dMax > TOL_GS) { gs++; dMax = balaye(actC, nAC, (gs & 1) === 0); }
        if (dMax > TOL_GS) { cgTot += pcg(actC, nAC); dMax = 1e9; }
        while (gs < GS_MAX && dMax > TOL_GS && gsTot + gs < GS_BUDGET) { gs++; dMax = balaye(actC, nAC, (gs & 1) === 0); progres('GS', dMax); }
        gsTot += gs;
        var rep = 0;
        while (dMax > TOL_GS && rep < 3 && gsTot < GS_BUDGET) {
          rep++;
          var foc = adj._foc || (adj._foc = new Int32Array(nT));
          var inF = adj._inF || (adj._inF = new Uint8Array(nT));
          inF.fill(0); var nF = 0;
          for (var q1 = 0; q1 < nAC; q1++) {
            var ci = actC[q1];
            if (dC[ci] <= TOL_GS * 0.25) continue;
            if (!inF[ci]) { inF[ci] = 1; foc[nF++] = ci; }
            for (var p1 = cOff[ci]; p1 < cOff[ci + 1]; p1++) {
              var ej = cEdge[p1]; if (K[ej] === 0) continue;
              var vj = cSgn[p1] > 0 ? adj.b[ej] : adj.a[ej];
              if (!inF[vj]) { inF[vj] = 1; foc[nF++] = vj; }
            }
          }
          if (nF === 0) break;
          var gf = 0, dF = 1e9;
          while (gf < FOC_MAX && dF > TOL_GS && gsTot + gf < GS_BUDGET) { gf++; dF = balaye(foc, nF, (gf & 1) === 0); progres('focus', dF); }
          gsTot += (gf * nF / (nAC || 1)) | 0;
          dMax = balaye(actC, nAC, false); gsTot++;
        }
        /* Picard convergé : dernière correction < TOL_PIC (m) ou < REL_PIC
           de la variation totale du sous-pas.                          */
        dPic = 0; var dPas = 0;
        for (var qp = 0; qp < nAC; qp++) {
          var ip = actC[qp], dp = H[ip] - Hp[ip], ds = H[ip] - H0s[ip];
          if (dp < 0) dp = -dp; if (dp > dPic) dPic = dp;
          if (ds < 0) ds = -ds; if (ds > dPas) dPas = ds;
          Hp[ip] = H[ip];
        }
        var picOK = dPic < TOL_PIC || dPic < REL_PIC * dPas;
        if (pic >= 1 && dPic > 0.8 * dPicPrec && relax > 0.05) relax *= 0.5;
        dPicPrec = dPic;
        if (pic > 0 && dMax < TOL_CONV && picOK) break;
        if (gsTot >= GS_BUDGET) break;
      }
      if (!picOK) { picNonConv++; if (dPic > dPicMax) dPicMax = dPic; }
      /* Découpe du pas de temps : seulement si la résolution linéaire n'a
         pas convergé (réduire dt n'accélère pas Picard, mesuré).       */
      var ecart = dMax;
      if (ecart > TOL_CONV && prof < MAX_PROF && gsTot < GS_BUDGET) {
        H.set(H0s);
        nSeg--;
        nSeg++; solveSeg(dtSeg / 2, prof + 1);
        nSeg++; solveSeg(dtSeg / 2, prof + 1);
        return;
      }
      if (ecart > TOL_CONV) {
        nonConv++;
        if (ecart > nonConvMax) nonConvMax = ecart;
        if (prof < nonConvProfMin) nonConvProfMin = prof;
      }
      X.fill(0);
      for (var ie = 0; ie < nAE; ie++) {
        var eq = actE[ie];
        var Q = K[eq] * (B[eq] + H[adj.a[eq]] - H[adj.b[eq]]);
        var dVe = Q * dtSeg;
        adj._Qseg[eq] = dVe;
        X[dVe > 0 ? adj.a[eq] : adj.b[eq]] += dVe > 0 ? dVe : -dVe;
      }
      for (var tf0 = 0; tf0 < nAC; tf0++) {
        var tf = actC[tf0];
        var st = H0s[tf] * F.surf[tf];
        fS[tf] = X[tf] > st ? (st > 0 ? st / X[tf] : 0) : 1;
      }
      for (var tr0 = 0; tr0 < nAC; tr0++) H[actC[tr0]] = H0s[actC[tr0]];
      for (var ia = 0; ia < nAE; ia++) {
        var ea = actE[ia];
        var dV = adj._Qseg[ea]; if (dV === 0) continue;
        var up = dV > 0 ? adj.a[ea] : adj.b[ea], dn = dV > 0 ? adj.b[ea] : adj.a[ea];
        var adV = (dV > 0 ? dV : -dV) * fS[up];
        dVc[ea] += dV > 0 ? adV : -adV;
        H[up] -= adV / F.surf[up];
        H[dn] += adV / F.surf[dn];
      }
      for (var tw0 = 0; tw0 < nAC; tw0++) {
        var tw = actC[tw0];
        if (H[tw] < 0) { if (H[tw] < -0.01) neg++; H[tw] = 0; }
      }
    }

    if (!adj._Qseg) adj._Qseg = new Float64Array(nE);
    var recaleVol = 0;
    var postierN = 0, postierM3 = 0;
    if (recaleP) {
      var sH = 0, sA = 0;
      for (var tm = 0; tm < nT; tm++) if (H[tm] > 0.01) { sH += H[tm] * F.surf[tm]; sA += F.surf[tm]; }
      var SEUIL_POSTIER = 4 * (sA > 0 ? sH / sA : 0);
      var dest = new Map();
      for (var ep = 0; ep < nE; ep++) {
        var ap = adj.a[ep], bp = adj.b[ep];
        var Hap = H[ap], Hbp = H[bp];
        if ((Hap > 0.01) === (Hbp > 0.01)) continue;
        var fullT = Hap > Hbp ? ap : bp, emptyT = Hap > Hbp ? bp : ap;
        if (H[fullT] <= SEUIL_POSTIER) continue;
        var railP = adj.rail ? adj.rail[ep] : 0;
        var emptyEstAval = (fullT === ap) ? (railP === 1) : (railP === -1);
        if (railP !== 0 && !emptyEstAval) continue;
        var sFull = (fullT === ap) ? adj.cs[ep] : -adj.cs[ep];
        var Hf = H[fullT], h2f = Hf * Hf;
        var kLinF = c1Tab ? c1Tab[fullT] * (RHO * g) : kLin;
        var Df = kDef * h2f * h2f * Hf * sFull * sFull + kLinF * h2f;
        var kEdge = Df * adj.len[ep] * adj.invD[ep] * (glissTab ? glissTab[emptyT] : GLISS);
        if (kEdge <= 0) continue;
        var liste = dest.get(fullT); if (!liste) dest.set(fullT, liste = []);
        liste.push({ t: emptyT, k: kEdge });
      }
      dest.forEach(function (voisins, fullT) {
        var kTot = 0;
        for (var iv = 0; iv < voisins.length; iv++) kTot += voisins[iv].k;
        if (kTot <= 0) return;
        var excedent = (H[fullT] - CAMION_VIDE) * F.surf[fullT];
        for (var iv2 = 0; iv2 < voisins.length; iv2++) {
          var vt = voisins[iv2].t;
          H[vt] += (excedent * voisins[iv2].k / kTot) / F.surf[vt];
          H0[vt] = H[vt];
        }
        H[fullT] = CAMION_VIDE; H0[fullT] = CAMION_VIDE;
        postierN++; postierM3 += excedent;
      });
      progres('postier', 0);
      nSeg = 1; solveSeg(dtTot, 0);
      if (!slot) slot = adj._slot[phase] = new Float64Array(nE);
      slot.set(dVc);
      if (!adj._slotH[phase]) adj._slotH[phase] = new Float32Array(nT);
      adj._slotH[phase].set(H0);
      camion.fill(0);
      for (var ef2 = 0; ef2 < nE; ef2++) {
        var af = adj.a[ef2], bf = adj.b[ef2];
        if ((H[af] > 0.01) !== (H[bf] > 0.01)) {
          var pleinT = H[af] > H[bf] ? af : bf;
          if (H[pleinT] > CAMION_VIDE) camion[pleinT] = 1;
        }
      }
      for (var ec2 = 0; ec2 < nT; ec2++) if (camion[ec2]) camionN++;
    } else {
      var Xc = adj._X || (adj._X = new Float64Array(nT));
      Xc.fill(0); dVc.fill(0);
      for (var ec = 0; ec < nE; ec++) {
        var dv = slot[ec]; if (dv === 0) continue;
        Xc[dv > 0 ? adj.a[ec] : adj.b[ec]] += dv > 0 ? dv : -dv;
      }
      for (var tc = 0; tc < nT; tc++) {
        var stc = H0[tc] * F.surf[tc];
        fS[tc] = Xc[tc] > stc ? (stc > 0 ? stc / Xc[tc] : 0) : 1;
      }
      for (var ea2 = 0; ea2 < nE; ea2++) {
        var dv2 = slot[ea2]; if (dv2 === 0) continue;
        var up = dv2 > 0 ? adj.a[ea2] : adj.b[ea2], dn = dv2 > 0 ? adj.b[ea2] : adj.a[ea2];
        var adV = (dv2 > 0 ? dv2 : -dv2) * fS[up];
        dVc[ea2] = dv2 > 0 ? adV : -adV;
        recaleVol += adV;
        H[up] -= adV / F.surf[up]; H[dn] += adV / F.surf[dn];
      }
      for (var tp = 0; tp < nT; tp++) if (H[tp] < 0) { if (H[tp] < -0.01) neg++; H[tp] = 0; }
    }
    /* ── Pertes aux limites ─────────────────────────────────────────
       Mer : la glace qui l'atteint vêle (retirée).
       Bord de tuile : sortie libre, flux SIA explicite avec la pente
       sortante = max(pente du lit vers l'extérieur, pente de surface
       qui amène la glace sur le triangle), borné à 90 % du volume.    */
    var sortieM3 = 0, velageM3 = 0;
    if (adj.mer || adj.bordL) {
      for (var tl = 0; tl < nT; tl++) {
        if (H[tl] <= 0) continue;
        if (adj.mer && adj.mer[tl]) { velageM3 += H[tl] * F.surf[tl]; H[tl] = 0; continue; }
        if (!adj.bordL || adj.bordL[tl] <= 0 || H[tl] <= 0.01) continue;
        var zt = F.centZ ? F.centZ[tl] : 0, St = zt + H[tl], sIn = 0;
        for (var pl = cOff[tl]; pl < cOff[tl + 1]; pl++) {
          var el = cEdge[pl], jl = cSgn[pl] > 0 ? adj.b[el] : adj.a[el];
          var sj = ((F.centZ ? F.centZ[jl] : 0) + H[jl] - St) / adj.dist[el];
          if (sj > sIn) sIn = sj;
        }
        var so = adj.bordS[tl] > sIn ? adj.bordS[tl] : sIn;
        if (so <= 0) continue;
        var hl = H[tl], hl2 = hl * hl;
        var kLl = c1Tab ? c1Tab[tl] * (RHO * g) : kLin;
        var vol = (kDef * hl2 * hl2 * hl * so * so + kLl * hl2) * so * adj.bordL[tl] * dtTot;
        var vmx = 0.9 * hl * F.surf[tl];
        if (vol > vmx) vol = vmx;
        H[tl] -= vol / F.surf[tl];
        sortieM3 += vol;
      }
    }

    for (var tg = 0; tg < nT; tg++) glaceWE[tg] = H[tg] > 0 ? H[tg] * DENS_G : 0;
    var dt = dtTot;

    var _top3 = [];
    if (wantVit) {
      if (!adj._ex) {
        adj._ex = new Float32Array(nE); adj._ey = new Float32Array(nE);
        for (var eu = 0; eu < nE; eu++) {
          var ux0 = (F.centIdx[adj.b[eu]] % D) - (F.centIdx[adj.a[eu]] % D);
          var uy0 = ((F.centIdx[adj.b[eu]] / D) | 0) - ((F.centIdx[adj.a[eu]] / D) | 0);
          var ul0 = Math.sqrt(ux0 * ux0 + uy0 * uy0) || 1;
          adj._ex[eu] = ux0 / ul0; adj._ey[eu] = uy0 / ul0;
        }
      }
      var ex = adj._ex, ey = adj._ey;
      for (var ev = 0; ev < nE; ev++) {
        var dvs = dVc[ev]; if (dvs === 0) continue;
        var sgv = dvs > 0 ? 1 : -1;
        var src = sgv > 0 ? adj.a[ev] : adj.b[ev], dst = sgv > 0 ? adj.b[ev] : adj.a[ev];
        var av = sgv > 0 ? dvs : -dvs;
        var Hs = H[src] > 0.01 ? H[src] : 0.01;
        var u = (av / (adj.len[ev] * dt) / Hs) * SEC_J * 365;
        F.vx[src] += u * ex[ev] * sgv; F.vy[src] += u * ey[ev] * sgv;
        if (_top3.length < 3 || av > _top3[_top3.length - 1].dV) {
          _top3.push({ up: src, dn: dst, dV: Math.round(av),
                       Hu: +H[src].toFixed(1), Hd: +H[dst].toFixed(1) });
          _top3.sort(function (x, y) { return y.dV - x.dV; });
          if (_top3.length > 3) _top3.pop();
        }
      }
      for (var t = 0; t < nT; t++) F.vit[t] = Math.sqrt(F.vx[t] * F.vx[t] + F.vy[t] * F.vy[t]);
    }
    DSMFLUX.sonde = { top: _top3, neg: neg, seg: nSeg, picard: picTot, picNonConv: picNonConv, dPic: +dPicMax.toFixed(2), gs: gsTot, cg: cgTot,
                      nonConv: nonConv, nonConvMax: nonConvMax,
                      recale: recaleP ? 1 : 0, phase: phase, camion: camion, camionN: camionN,
                      postierN: postierN, postierM3: +(postierM3 / 1e6).toFixed(2),
                      libM: +(recaleVol / 1e6).toFixed(1), recaleAuto: recaleAuto,
                      sortieM3: +(sortieM3 / 1e6).toFixed(2), velageM3: +(velageM3 / 1e6).toFixed(2) };
  }

  /* pasBP — E : aucune → T : lève une erreur → S : aucune. Réservé à un futur
     solveur Blatter-Pattyn. */
  function pasBP() { throw new Error('DSMFLUX.pasBP : Blatter-Pattyn non actif (version future)'); }

  return { adjacence, pas, pasBP, A_GLEN, config: CONFIG };
}
const DSMFLUX = DSMFLUX_FABRIQUE();
if (typeof module !== "undefined" && module.exports) module.exports = { DSMFLUX };
