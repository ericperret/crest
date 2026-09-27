/* ═══════════════════════════════════════════════════════════════════
   FICHIER : dsm-mesh.js - v27/09/2026
   OBJET   : maillage régulier de la grille 1024² : deux triangles par
             cellule, diagonale choisie selon le relief ou le masque des
             crêtes, puis fusion des triangles coplanaires en facettes.
             Sortie : sommets, triangles, normales, voisinages, facettes.
             Voisinages calculés analytiquement (maillage régulier) :
             aucune table de hachage d'arêtes, O(nCellules).
   AUTEUR  : Eric P.
   RELECTURE : Opus 5.5
   DÉPEND  : aucun
   EXPOSE  : DSMMESH { construire, fusionner, pixNorm, stats }
   CONVENTIONS : sommets en (colonne, ligne, altitude) ; normales en
             (est, sud, haut), nz > 0
   ⚠ Utilisation : dsm.html construit ce maillage au bouton Partage
     (≈ 2 M triangles) mais n'en garde que les statistiques ; plus aucun
     calcul ne le lit depuis le retrait de dsmCalcPixNorm.
   ═══════════════════════════════════════════════════════════════════ */

"use strict";

/* ── DSMMESH (module) ── E : aucune → T : définit les fonctions → S : objet
   { construire, fusionner, pixNorm, stats }. */
const DSMMESH = (function () {

  const D = 1024;

  /* ─── Numérotation locale des arêtes ──────────────────────────────────
     Triangle t, sommets (s0,s1,s2) : arête 0 = s0-s1, 1 = s1-s2, 2 = s2-s0.

     Cellule ABEC :  A ── B      diagonale 0 = A-E   diagonale 1 = B-C
                     │    │
                     C ── E

     diag 0 : T0 = A,B,E  (arêtes N, E, diag)     T1 = A,E,C  (diag, S, O)
     diag 1 : T0 = A,B,C  (arêtes N, diag, O)     T1 = B,E,C  (E, S, diag)

     D'où, quelle que soit la diagonale :
       arête Nord  = (t0, 0)          arête Sud   = (t1, 1)
       arête Ouest = diag 0 ? (t1,2) : (t0,2)
       arête Est   = diag 0 ? (t0,1) : (t1,0)                              */

  /* ─── Union-find ──────────────────────────────────────────────────── */

  /* ufFind — E : parents p, x → T : remonte à la racine avec compression de
     chemin par demi-pas → S : racine. ALGO : « find d'union-find. » */
  function ufFind(p, x) { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; }
  /* ufUnion — E : p, a, b → T : relie la racine de a à celle de b → S : true si
     fusion effective. ALGO : « union d'union-find sans rang. » */
  function ufUnion(p, a, b) {
    var ra = ufFind(p, a), rb = ufFind(p, b);
    if (ra !== rb) { p[ra] = rb; return true; }
    return false;
  }

  /* ── triNorm ── E : trois sommets (colonne, ligne, z), échelle {x, y} (m),
     tampon out, offset o → T : produit vectoriel (B−A)×(C−A) en mètres,
     orienté nz > 0, normalisé → S : aire (m²) ; normale unitaire dans out.
     ALGO : « Normale ascendante et aire d'un triangle en repère métrique. » */
  function triNorm(ax, ay, az, bx, by, bz, cx, cy, cz, sxy, out, o) {
    var ux = (bx - ax) * sxy.x, uy = (by - ay) * sxy.y, uz = bz - az;
    var vx = (cx - ax) * sxy.x, vy = (cy - ay) * sxy.y, vz = cz - az;
    var nx = uy * vz - uz * vy;
    var ny = uz * vx - ux * vz;
    var nz = ux * vy - uy * vx;
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    out[o] = nx / l; out[o + 1] = ny / l; out[o + 2] = nz / l;
    return l / 2;
  }

  /* ── construire ─────────────────────────────────────────────────────
     ENTRÉE     : elev Float32Array 1024² (m, ≤ 0,5 = mer), partage (masque
                  des crêtes ou null), scaleXY (m, nombre ou {x, y}), pas (px)
     TRAITEMENT : grille de sommets au pas P ; par cellule, diagonale
                  alignée sur la crête (_diagCrete) sinon celle qui maximise
                  le cosinus entre les normales des deux triangles ; normales,
                  aires, centroïdes, drapeaux mer et crête ; voisinages
                  analytiques (diagonale interne, nord, ouest) ; table pixel →
                  triangle ; puis fusionner()
     SORTIE     : maillage m (sommets, tri, nrm, aire, centZ, centIdx,
                  voisin, diag, crete, mer, triOfPix, patch, patchNrm, …)
     ALGO       : « Triangule une grille régulière en choisissant pour chaque
                  cellule la diagonale la plus plane (ou celle de la crête),
                  puis regroupe les triangles coplanaires. »
     ⚠ Avec pas = 1, les cellules couvrent les pixels 0..1022 : la dernière
       ligne et la dernière colonne de triOfPix restent à −1.
     ─────────────────────────────────────────────────────────────────── */
  function construire(elev, partage, scaleXY, pas) {
    var sxy = (scaleXY && typeof scaleXY === 'object')
      ? { x: scaleXY.x, y: scaleXY.y }
      : { x: scaleXY || 10, y: scaleXY || 10 };
    var P   = Math.max(1, (pas | 0) || 1);

    var nCx = Math.floor((D - 1) / P), nCy = nCx;
    var nVx = nCx + 1, nVy = nCy + 1;
    var nV  = nVx * nVy;
    var nC  = nCx * nCy;
    var nT  = 2 * nC;

    /* Sommets : x et y en pixels, z en mètres */
    var vX = new Float32Array(nV), vY = new Float32Array(nV), vZ = new Float32Array(nV);
    for (var gy = 0; gy < nVy; gy++)
      for (var gx = 0; gx < nVx; gx++) {
        var px = Math.min(gx * P, D - 1), py = Math.min(gy * P, D - 1);
        var k = gy * nVx + gx;
        vX[k] = px; vY[k] = py; vZ[k] = elev[py * D + px];
      }

    var tri     = new Int32Array(3 * nT);
    var nrm     = new Float32Array(3 * nT);
    var aire    = new Float32Array(nT);
    var centZ   = new Float32Array(nT);
    var centIdx = new Int32Array(nT);
    var diag    = new Uint8Array(nC);
    var crete   = new Uint8Array(nT);
    var mer     = new Uint8Array(nT);
    var nSurCrete = 0;

    var n1 = new Float32Array(3), n2 = new Float32Array(3);

    for (var cy = 0; cy < nCy; cy++) {
      for (var cx = 0; cx < nCx; cx++) {
        var ci = cy * nCx + cx;
        var A = cy * nVx + cx, B = A + 1, C = A + nVx, E = C + 1;

        /* Diagonale : alignée sur la crête si la cellule en porte une,
           sinon celle qui minimise la rupture de pente entre les deux
           triangles (cosinus des normales maximal).                      */
        var d = partage ? _diagCrete(partage, vX[A], vY[A], P) : -1;
        if (d < 0) {
          triNorm(vX[A], vY[A], vZ[A], vX[B], vY[B], vZ[B], vX[E], vY[E], vZ[E], sxy, n1, 0);
          triNorm(vX[A], vY[A], vZ[A], vX[E], vY[E], vZ[E], vX[C], vY[C], vZ[C], sxy, n2, 0);
          var cosAE = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2];
          triNorm(vX[A], vY[A], vZ[A], vX[B], vY[B], vZ[B], vX[C], vY[C], vZ[C], sxy, n1, 0);
          triNorm(vX[B], vY[B], vZ[B], vX[E], vY[E], vZ[E], vX[C], vY[C], vZ[C], sxy, n2, 0);
          var cosBC = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2];
          d = cosAE >= cosBC ? 0 : 1;
        }
        diag[ci] = d;

        var t0 = 2 * ci, t1 = t0 + 1, i0, i1, i2, j0, j1, j2;
        if (d === 0) { i0 = A; i1 = B; i2 = E;  j0 = A; j1 = E; j2 = C; }
        else         { i0 = A; i1 = B; i2 = C;  j0 = B; j1 = E; j2 = C; }

        tri[3 * t0] = i0; tri[3 * t0 + 1] = i1; tri[3 * t0 + 2] = i2;
        tri[3 * t1] = j0; tri[3 * t1 + 1] = j1; tri[3 * t1 + 2] = j2;

        aire[t0] = triNorm(vX[i0], vY[i0], vZ[i0], vX[i1], vY[i1], vZ[i1],
                           vX[i2], vY[i2], vZ[i2], sxy, nrm, 3 * t0);
        aire[t1] = triNorm(vX[j0], vY[j0], vZ[j0], vX[j1], vY[j1], vZ[j1],
                           vX[j2], vY[j2], vZ[j2], sxy, nrm, 3 * t1);

        centZ[t0] = (vZ[i0] + vZ[i1] + vZ[i2]) / 3;
        centZ[t1] = (vZ[j0] + vZ[j1] + vZ[j2]) / 3;
        centIdx[t0] = Math.round((vY[i0] + vY[i1] + vY[i2]) / 3) * D
                    + Math.round((vX[i0] + vX[i1] + vX[i2]) / 3);
        centIdx[t1] = Math.round((vY[j0] + vY[j1] + vY[j2]) / 3) * D
                    + Math.round((vX[j0] + vX[j1] + vX[j2]) / 3);

        mer[t0] = centZ[t0] <= 0.5 ? 1 : 0;
        mer[t1] = centZ[t1] <= 0.5 ? 1 : 0;

        if (partage && _celluleCrete(partage, vX[A], vY[A], P)) {
          crete[t0] = 1; crete[t1] = 1; nSurCrete += 2;
        }
      }
    }

    /* ─── Voisinages, analytiques ─────────────────────────────────────── */

    var voisin = new Int32Array(3 * nT).fill(-1);
    /* coupler — E : deux emplacements d'arête (3·t + k) → T : chacun reçoit le
       triangle de l'autre → S : aucune. */
    function coupler(sa, sb) { voisin[sa] = (sb / 3) | 0; voisin[sb] = (sa / 3) | 0; }

    for (var cy2 = 0; cy2 < nCy; cy2++) {
      for (var cx2 = 0; cx2 < nCx; cx2++) {
        var ci2 = cy2 * nCx + cx2, dd = diag[ci2];
        var a0 = 2 * ci2, a1 = a0 + 1;

        /* diagonale interne */
        if (dd === 0) coupler(3 * a0 + 2, 3 * a1 + 0);
        else          coupler(3 * a0 + 1, 3 * a1 + 2);

        /* Nord : (t0,0) contre le Sud (t1,1) de la cellule du dessus */
        if (cy2 > 0) {
          var hb = 2 * ((cy2 - 1) * nCx + cx2) + 1;
          coupler(3 * a0 + 0, 3 * hb + 1);
        }
        /* Ouest : contre l'Est de la cellule de gauche */
        if (cx2 > 0) {
          var cg = cy2 * nCx + (cx2 - 1), dg = diag[cg], g0 = 2 * cg, g1 = g0 + 1;
          var slotO = dd === 0 ? 3 * a1 + 2 : 3 * a0 + 2;
          var slotE = dg === 0 ? 3 * g0 + 1 : 3 * g1 + 0;
          coupler(slotO, slotE);
        }
      }
    }

    /* ─── Correspondance pixel → triangle ─────────────────────────────── */

    var triOfPix = new Int32Array(D * D).fill(-1);
    for (var cy3 = 0; cy3 < nCy; cy3++) {
      var y0 = cy3 * P, yEnd = Math.min(y0 + P, D);
      for (var cx3 = 0; cx3 < nCx; cx3++) {
        var ci3 = cy3 * nCx + cx3, d3 = diag[ci3];
        var x0 = cx3 * P, xEnd = Math.min(x0 + P, D);
        var ta = 2 * ci3, tb = ta + 1;
        for (var py2 = y0; py2 < yEnd; py2++) {
          var fy = (py2 - y0) / P, row = py2 * D;
          for (var px2 = x0; px2 < xEnd; px2++) {
            var fx = (px2 - x0) / P;
            var side = d3 === 0 ? (fy <= fx ? 0 : 1) : (fx + fy <= 1 ? 0 : 1);
            triOfPix[row + px2] = side === 0 ? ta : tb;
          }
        }
      }
    }

    var m = {
      D: D, pas: P, scaleXY: sxy,
      nV: nV, nVx: nVx, nVy: nVy, vX: vX, vY: vY, vZ: vZ,
      nT: nT, nC: nC, tri: tri, nrm: nrm, aire: aire,
      centZ: centZ, centIdx: centIdx,
      voisin: voisin, diag: diag, crete: crete, mer: mer,
      triOfPix: triOfPix, surCrete: nSurCrete,
      patch: null, nPatch: 0, patchNrm: null, patchAire: null
    };

    return fusionner(m);
  }

  /* ── fusionner ──────────────────────────────────────────────────────
     ENTRÉE     : maillage m, opts { seuilCos } (0,9995 par défaut)
     TRAITEMENT : union-find sur les paires de triangles voisins de même
                  nature (mer, crête) dont le cosinus des normales ≥ seuil ;
                  numérotation des facettes ; normale moyenne pondérée par
                  l'aire et aire totale par facette
     SORTIE     : m complété (patch, nPatch, patchNrm, patchAire)
     ALGO       : « Regroupe les triangles voisins quasi coplanaires en
                  facettes (union-find), normale moyenne pondérée. »
     ⚠ Critère entre voisins seulement : la fusion dérive de proche en
       proche et une surface régulièrement courbée finit en une seule
       facette. dsm-filet.js a été corrigé (cône borné), pas ce module.
     ─────────────────────────────────────────────────────────────────── */
  function fusionner(m, opts) {
    opts = opts || {};
    var seuil = opts.seuilCos !== undefined ? opts.seuilCos : 0.9995;
    var nT = m.nT, nrm = m.nrm, voisin = m.voisin;

    var p = new Int32Array(nT);
    for (var i = 0; i < nT; i++) p[i] = i;

    for (var t = 0; t < nT; t++) {
      var bx = nrm[3 * t], by = nrm[3 * t + 1], bz = nrm[3 * t + 2];
      for (var e = 0; e < 3; e++) {
        var u = voisin[3 * t + e];
        if (u < 0 || u < t) continue;                 /* une fois par arête */
        if (m.mer[t]   !== m.mer[u])   continue;      /* mer et terre séparées */
        if (m.crete[t] !== m.crete[u]) continue;      /* crêtes préservées */
        var dot = bx * nrm[3 * u] + by * nrm[3 * u + 1] + bz * nrm[3 * u + 2];
        if (dot >= seuil) ufUnion(p, t, u);
      }
    }

    var patch = new Int32Array(nT).fill(-1), nP = 0;
    for (var t2 = 0; t2 < nT; t2++) {
      var r = ufFind(p, t2);
      if (patch[r] === -1) patch[r] = nP++;
    }
    for (var t3 = 0; t3 < nT; t3++) patch[t3] = patch[ufFind(p, t3)];

    var pNx = new Float64Array(nP), pNy = new Float64Array(nP), pNz = new Float64Array(nP);
    var pA  = new Float64Array(nP);
    for (var t4 = 0; t4 < nT; t4++) {
      var g = patch[t4], a = m.aire[t4];
      pA[g]  += a;
      pNx[g] += nrm[3 * t4]     * a;
      pNy[g] += nrm[3 * t4 + 1] * a;
      pNz[g] += nrm[3 * t4 + 2] * a;
    }
    var patchNrm = new Float32Array(3 * nP), patchAire = new Float32Array(nP);
    for (var g2 = 0; g2 < nP; g2++) {
      var l = Math.sqrt(pNx[g2] * pNx[g2] + pNy[g2] * pNy[g2] + pNz[g2] * pNz[g2]) || 1;
      patchNrm[3 * g2]     = pNx[g2] / l;
      patchNrm[3 * g2 + 1] = pNy[g2] / l;
      patchNrm[3 * g2 + 2] = pNz[g2] / l;
      patchAire[g2] = pA[g2];
    }

    m.patch = patch; m.nPatch = nP;
    m.patchNrm = patchNrm; m.patchAire = patchAire;
    return m;
  }

  /* ── pixNorm ── E : maillage m → T : normale de la facette du triangle de
     chaque pixel, ny inversé (repère est, nord, haut) ; pixel sans triangle →
     (0, 0, 1) → S : Float32Array 3·1024². ALGO : « Normale de facette par
     pixel, au format attendu par dsm-insol.js. » */
  function pixNorm(m) {
    var out = new Float32Array(3 * D * D);
    var top = m.triOfPix, patch = m.patch, pn = m.patchNrm;
    for (var i = 0; i < D * D; i++) {
      var t = top[i];
      if (t < 0) { out[3 * i + 2] = 1; continue; }
      var g = patch[t];
      out[3 * i]     = pn[3 * g];
      out[3 * i + 1] = -pn[3 * g + 1];
      out[3 * i + 2] = pn[3 * g + 2];
    }
    return out;
  }

  /* ── stats ── E : maillage m → T : compte sommets, triangles, triangles de
     crête, facettes, taux de fusion → S : objet texte pour la console. */
  function stats(m) {
    return {
      sommets:   m.nV,
      triangles: m.nT,
      surCrete:  m.surCrete,
      patches:   m.nPatch,
      fusion:    m.nPatch ? (m.nT / m.nPatch).toFixed(2) + '\u00d7' : '\u2014',
      pas:       m.pas + 'px'
    };
  }

  /* ─── Utilitaires internes ───────────────────────────────────────── */

  /* ── _celluleCrete ── E : masque, coin (x0, y0), côté s → T : cherche un
     pixel de crête (≥ 0,5) dans la cellule → S : 1 ou 0. */
  function _celluleCrete(partage, x0, y0, s) {
    var x1 = Math.min(x0 + s, D - 1), y1 = Math.min(y0 + s, D - 1);
    for (var y = y0; y <= y1; y++)
      for (var x = x0; x <= x1; x++)
        if (partage[y * D + x] >= 0.5) return 1;
    return 0;
  }

  /* ── _diagCrete ── E : masque, coin (x0, y0), côté s → T : compte les pixels
     de crête à moins de s/4 de chaque diagonale → S : 0 (A-E), 1 (B-C), −1 si
     aucun ou égalité. ALGO : « Diagonale qui suit la crête dans la cellule. » */
  function _diagCrete(partage, x0, y0, s) {
    var x1 = Math.min(x0 + s, D - 1), y1 = Math.min(y0 + s, D - 1);
    var bande = Math.max(1, s >> 2), cAE = 0, cBC = 0, tot = 0;
    for (var y = y0; y <= y1; y++)
      for (var x = x0; x <= x1; x++) {
        if (partage[y * D + x] < 0.5) continue;
        tot++;
        var fx = (x - x0) / s, fy = (y - y0) / s;
        if (Math.abs(fx - fy) * s <= bande) cAE++;
        if (Math.abs(fx + fy - 1) * s <= bande) cBC++;
      }
    if (tot === 0 || cAE === cBC) return -1;
    return cAE > cBC ? 0 : 1;
  }

  return { construire, fusionner, pixNorm, stats };

})();

if (typeof module !== "undefined" && module.exports) module.exports = { DSMMESH };
