/* ═══════════════════════════════════════════════════════════════════
   FICHIER : dsm-filet.js - v27/09/2026
   OBJET   : « filet » adaptatif de la grille 1024² : quadtree raffiné là
             où le relief s'écarte d'un plan, deux triangles par maille,
             puis coalescence des triangles quasi coplanaires en facettes.
             Support du bilan de masse (dsm-worker-glacier.js) et de
             l'écoulement (dsm-flux.js).
   AUTEUR  : Eric P.
   RELECTURE : Opus 5.5
   DÉPEND  : aucun
   EXPOSE  : DSMFILET { construire, stats, coalescer }
   CONVENTIONS : normales en (est, sud, haut) et repère métrique ;
             triOfPix = triangle (ou facette) de chaque pixel, −1 sinon ;
             actif = 1 si le triangle peut accumuler (ni mer ni « chaud »)
   ═══════════════════════════════════════════════════════════════════ */

"use strict";

/* ── DSMFILET (module) ── E : aucune → T : définit les fonctions →
   S : { construire, stats, coalescer }. */
const DSMFILET = (() => {

  const D = 1024;

  /* ── metricCell ─────────────────────────────────────────────────────
     ENTRÉE     : elev 1024², coin (x0, y0), côté s (px)
     TRAITEMENT : plan z = c0 + c1·x + c2·y ajusté aux moindres carrés sur
                  les pixels terrestres (> 0,5 m), système 3×3 par Cramer ;
                  résidus : écart-type et écart maximal
     SORTIE     : max(écart-type, écart max / 2) en m ; 0 si < 3 pixels ou
                  système singulier
     ALGO       : « Rugosité d'une maille : écart au plan des moindres
                  carrés, combinaison écart-type / demi-écart maximal. »
     ─────────────────────────────────────────────────────────────────── */
  function metricCell(elev, x0, y0, s) {
    var n = 0, Sx = 0, Sy = 0, Sz = 0, Sxx = 0, Syy = 0, Sxy = 0, Sxz = 0, Syz = 0;
    var x1 = Math.min(x0 + s, D), y1 = Math.min(y0 + s, D);
    for (var y = y0; y < y1; y++)
      for (var x = x0; x < x1; x++) {
        var z = elev[y * D + x];
        if (z <= 0.5) continue;
        var fx = x - x0, fy = y - y0;
        n++; Sx += fx; Sy += fy; Sz += z;
        Sxx += fx * fx; Syy += fy * fy; Sxy += fx * fy; Sxz += fx * z; Syz += fy * z;
      }
    if (n < 3) return 0;
    var A11 = n, A12 = Sx, A13 = Sy, A22 = Sxx, A23 = Sxy, A33 = Syy;
    var det = A11 * (A22 * A33 - A23 * A23) - A12 * (A12 * A33 - A23 * A13) + A13 * (A12 * A23 - A22 * A13);
    if (Math.abs(det) < 1e-6) return 0;
    var b1 = Sz, b2 = Sxz, b3 = Syz;
    var c0 = (b1 * (A22 * A33 - A23 * A23) - A12 * (b2 * A33 - A23 * b3) + A13 * (b2 * A23 - A22 * b3)) / det;
    var c1 = (A11 * (b2 * A33 - A23 * b3) - b1 * (A12 * A33 - A23 * A13) + A13 * (A12 * b3 - b2 * A13)) / det;
    var c2 = (A11 * (A22 * b3 - b2 * A23) - A12 * (A12 * b3 - b2 * A13) + b1 * (A12 * A23 - A22 * A13)) / det;
    var sse = 0, gap = 0;
    for (var yy = y0; yy < y1; yy++)
      for (var xx = x0; xx < x1; xx++) {
        var zp = elev[yy * D + xx];
        if (zp <= 0.5) continue;
        var fxp = xx - x0, fyp = yy - y0;
        var d = zp - (c0 + c1 * fxp + c2 * fyp);
        sse += d * d;
        var ad = Math.abs(d); if (ad > gap) gap = ad;
      }
    var rms = Math.sqrt(sse / n);
    return Math.max(rms, gap * 0.5);
  }

  /* ── triNorm ── E : sommets a, b, c = [colonne, ligne, z], échelle {x, y} (m)
     → T : (b−a)×(c−a) en mètres, normalisé (pas d'orientation forcée ; le
     sens des sommets donne nz > 0) → S : { nx, ny, nz, aire (m², surface
     inclinée) }. */
  function triNorm(a, b, c, sc) {
    var ux = (b[0] - a[0]) * sc.x, uy = (b[1] - a[1]) * sc.y, uz = b[2] - a[2];
    var vx = (c[0] - a[0]) * sc.x, vy = (c[1] - a[1]) * sc.y, vz = c[2] - a[2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    var l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    return { nx: nx / (l || 1), ny: ny / (l || 1), nz: nz / (l || 1), aire: l / 2 };
  }

  /* ── diagCrete ── E : masque de crêtes, coin (x0, y0), côté s → T : compte
     les pixels de crête à moins de s/8 de chaque diagonale → S : 1 (A-E),
     0 (B-C, aussi en cas d'égalité), −1 sans crête ou sans masque.
     ⚠ Convention inverse de dsm-mesh.js (_diagCrete : 0 = A-E). */
  function diagCrete(partage, x0, y0, s) {
    if (!partage) return -1;
    var x1 = Math.min(x0 + s, D - 1), y1 = Math.min(y0 + s, D - 1);
    var bande = Math.max(1, s >> 3), cBC = 0, cAD = 0, tot = 0;
    for (var y = y0; y <= y1; y++)
      for (var x = x0; x <= x1; x++) {
        if (partage[y * D + x] < 0.5) continue;
        tot++;
        var fx = (x - x0) / s, fy = (y - y0) / s;
        if (Math.abs(fx + fy - 1) * s <= bande) cBC++;
        if (Math.abs(fx - fy) * s <= bande) cAD++;
      }
    if (tot === 0) return -1;
    return cAD > cBC ? 1 : 0;
  }

  /* ── construire ─────────────────────────────────────────────────────
     ENTRÉE     : elev 1024² (m), partage (masque de crêtes ou null),
                  opts { budget (triangles), scaleXY (m ou {x, y}),
                  estChaud(idxPixel, z) → booléen }
     TRAITEMENT : taille de maille initiale S0 = plus grande puissance de 2
                  compatible avec le budget ; rugosité (metricCell) de chaque
                  maille ; seuil = médiane des rugosités initiales ; tas max :
                  on scinde en 4 la maille la plus rugueuse tant qu'elle
                  dépasse le seuil, reste au-dessus de 4 px et que le budget
                  le permet ; chaque maille donne deux triangles (diagonale de
                  crête sinon la plus plane), sommets aux coins ; centroïde,
                  normale, aire, rugosité, actif (ni mer ni chaud) ; table
                  pixel → triangle
     SORTIE     : filet { nTri, nActifs, centIdx, centZ, cosT, surf, nx, ny, nz,
                  actif, triOfPix, sigma, nCells, s0 }
     ALGO       : « Quadtree adaptatif piloté par l'écart au plan, puis deux
                  triangles par maille. »
     ⚠ Seuil = médiane des rugosités initiales : la moitié des mailles
       initiales n'est jamais raffinée, quel que soit le budget restant.
     ⚠ Mailles de tailles différentes accolées : sommets en T, maillage non
       conforme (sans effet sur les calculs, qui passent par triOfPix).
     ⚠ surf est l'aire inclinée ; dsm-flux.js s'en sert comme aire de base
       des volumes (H · surf) : volume surestimé de 1/cos(pente) sur les
       versants raides.
     ─────────────────────────────────────────────────────────────────── */
  function construire(elev, partage, opts) {
    opts = opts || {};
    var budget  = opts.budget  || 8192;
    var s0 = opts.scaleXY || 10;
    var scaleXY = typeof s0 === 'object' ? { x: s0.x, y: s0.y } : { x: s0, y: s0 };
    var estChaud = opts.estChaud || null;
    var S_MIN = 4;

    var S0 = 512;
    while (S0 > S_MIN && 2 * (D / (S0 >> 1)) * (D / (S0 >> 1)) <= budget / 2) S0 >>= 1;

    var heap = [];
    /* hPush / hPop : tas binaire max sur la rugosité sg — E : maille →
       T : remontée / descente → S : maille la plus rugueuse (hPop). */
    function hPush(c){ heap.push(c); var i=heap.length-1;
      while(i>0){ var p=(i-1)>>1; if(heap[p].sg>=heap[i].sg) break;
        var t=heap[p]; heap[p]=heap[i]; heap[i]=t; i=p; } }
    function hPop(){ var top=heap[0], last=heap.pop();
      if(heap.length){ heap[0]=last; var i=0;
        for(;;){ var l=2*i+1, r=l+1, m=i;
          if(l<heap.length && heap[l].sg>heap[m].sg) m=l;
          if(r<heap.length && heap[r].sg>heap[m].sg) m=r;
          if(m===i) break; var t=heap[m]; heap[m]=heap[i]; heap[i]=t; i=m; } }
      return top; }
    var sgInit = [];
    for (var y = 0; y < D; y += S0)
      for (var x = 0; x < D; x += S0) {
        var sg0 = metricCell(elev, x, y, S0);
        hPush({ x0: x, y0: y, s: S0, sg: sg0 });
        sgInit.push(sg0);
      }
    sgInit.sort(function (a, b) { return a - b; });
    var seuil = sgInit[sgInit.length >> 1];

    var cells = [], nCellTot = heap.length;
    while (heap.length) {
      var c = hPop();
      if (c.s <= S_MIN || c.sg <= seuil || 2 * (nCellTot + 3) > budget) { cells.push(c); continue; }
      var h = c.s >> 1; nCellTot += 3;
      hPush({ x0: c.x0,     y0: c.y0,     s: h, sg: metricCell(elev, c.x0,     c.y0,     h) });
      hPush({ x0: c.x0 + h, y0: c.y0,     s: h, sg: metricCell(elev, c.x0 + h, c.y0,     h) });
      hPush({ x0: c.x0,     y0: c.y0 + h, s: h, sg: metricCell(elev, c.x0,     c.y0 + h, h) });
      hPush({ x0: c.x0 + h, y0: c.y0 + h, s: h, sg: metricCell(elev, c.x0 + h, c.y0 + h, h) });
    }

    var nC = cells.length, nTri = 2 * nC;
    var centIdx = new Int32Array(nTri), centZ = new Float32Array(nTri);
    var cosT = new Float32Array(nTri), surf = new Float32Array(nTri);
    var nrx = new Float32Array(nTri), nry = new Float32Array(nTri), nrz = new Float32Array(nTri);
    var actif = new Uint8Array(nTri), sigma = new Float32Array(nTri);
    var triOfPix = new Int32Array(D * D); triOfPix.fill(-1);

    /* zAt — E : (x, y) px → T : altitude du pixel, bornée à la grille → S : m. */
    function zAt(x, y) { return elev[Math.min(y, D - 1) * D + Math.min(x, D - 1)]; }

    for (var ci = 0; ci < nC; ci++) {
      var cl = cells[ci], x0 = cl.x0, y0 = cl.y0, s = cl.s;
      var x1 = Math.min(x0 + s, D - 1), y1 = Math.min(y0 + s, D - 1);
      var A = [x0, y0, zAt(x0, y0)], B = [x1, y0, zAt(x1, y0)];
      var C = [x0, y1, zAt(x0, y1)], E = [x1, y1, zAt(x1, y1)];

      var dg = diagCrete(partage, x0, y0, s);
      if (dg < 0) {
        var n0a = triNorm(A, B, C, scaleXY), n0b = triNorm(B, E, C, scaleXY);
        var n1a = triNorm(A, B, E, scaleXY), n1b = triNorm(A, E, C, scaleXY);
        var cos0 = n0a.nx * n0b.nx + n0a.ny * n0b.ny + n0a.nz * n0b.nz;
        var cos1 = n1a.nx * n1b.nx + n1a.ny * n1b.ny + n1a.nz * n1b.nz;
        dg = cos1 > cos0 ? 1 : 0;
      }

      var t0 = 2 * ci, t1 = t0 + 1;
      var T0, T1;
      if (dg === 0) { T0 = [A, B, C]; T1 = [B, E, C]; }
      else          { T0 = [A, B, E]; T1 = [A, E, C]; }

      for (var k = 0; k < 2; k++) {
        var T = k === 0 ? T0 : T1, ti = k === 0 ? t0 : t1;
        var nrm = triNorm(T[0], T[1], T[2], scaleXY);
        var cx = (T[0][0] + T[1][0] + T[2][0]) / 3;
        var cy = (T[0][1] + T[1][1] + T[2][1]) / 3;
        var cz = (T[0][2] + T[1][2] + T[2][2]) / 3;
        centIdx[ti] = Math.round(cy) * D + Math.round(cx);
        centZ[ti] = cz;
        cosT[ti] = Math.abs(nrm.nz);
        surf[ti] = nrm.aire;
        nrx[ti] = nrm.nx; nry[ti] = nrm.ny; nrz[ti] = nrm.nz;
        sigma[ti] = cl.sg;
        actif[ti] = 1;
        if (cz <= 0.5) actif[ti] = 0;
        else if (estChaud && estChaud(centIdx[ti], cz)) actif[ti] = 0;
      }

      for (var py = y0; py < Math.min(y0 + s, D); py++)
        for (var px = x0; px < Math.min(x0 + s, D); px++) {
          var fx = (px - x0) / s, fy = (py - y0) / s;
          var side;
          if (dg === 0) side = (fx + fy <= 1) ? 0 : 1;
          else          side = (fy <= fx) ? 0 : 1;
          triOfPix[py * D + px] = side === 0 ? t0 : t1;
        }
    }

    var nActifs = 0;
    for (var t = 0; t < nTri; t++) if (actif[t]) nActifs++;

    return { nTri: nTri, nActifs: nActifs, centIdx: centIdx, centZ: centZ,
             cosT: cosT, surf: surf, nx: nrx, ny: nry, nz: nrz,
             actif: actif, triOfPix: triOfPix,
             sigma: sigma, nCells: nC, s0: S0 };
  }

  /* ── stats ── E : filet → T : compte triangles, actifs, mailles, rugosité
     moyenne → S : objet texte pour la console. */
  function stats(f) {
    var sMoy = 0; for (var t = 0; t < f.nTri; t++) sMoy += f.sigma[t];
    return { triangles: f.nTri, actifs: f.nActifs, mailles: f.nCells,
             mailleInit: f.s0 + 'px', sigmaMoy: (sMoy / f.nTri).toFixed(1) + 'm' };
  }

  /* ── coalescer ──────────────────────────────────────────────────────
     ENTRÉE     : filet f, opts { seuilCos } (0,999 par défaut, ≈ 2,6°)
     TRAITEMENT : paires de triangles voisins relevées sur la grille ;
                  croissance de régions à cône borné (union-find qui garde
                  par groupe la somme des normales pondérées et le rayon du
                  cône) : fusion seulement entre triangles de même état actif
                  et si le cône fusionné reste sous acos(seuil) ; agrégats par
                  facette (aire, centroïde, altitude, normale, rugosité
                  pondérés) ; centroïde hors de sa facette ramené au pixel le
                  plus proche de la facette
     SORTIE     : filet de même structure, une entrée par facette
     ALGO       : « Fusionne les triangles voisins en facettes dont toutes les
                  normales restent dans un cône de demi-angle acos(seuil). »
     ─────────────────────────────────────────────────────────────────── */
  function coalescer(f, opts) {
    opts = opts || {};
    var seuil = opts.seuilCos !== undefined ? opts.seuilCos : 0.999;
    var nTri = f.nTri, top = f.triOfPix;

    var seen = new Set();
    var pa = [], pb = [];
    for (var y = 0; y < D - 1; y++) {
      for (var x = 0; x < D - 1; x++) {
        var i = y * D + x, a = top[i];
        if (a < 0) continue;
        var b1 = top[i + 1], b2 = top[i + D];
        if (b1 >= 0 && b1 !== a) { var k1 = a < b1 ? a * 1e7 + b1 : b1 * 1e7 + a; if (!seen.has(k1)) { seen.add(k1); pa.push(Math.min(a, b1)); pb.push(Math.max(a, b1)); } }
        if (b2 >= 0 && b2 !== a) { var k2 = a < b2 ? a * 1e7 + b2 : b2 * 1e7 + a; if (!seen.has(k2)) { seen.add(k2); pa.push(Math.min(a, b2)); pb.push(Math.max(a, b2)); } }
      }
    }

    /* Cône borné : le seul critère entre voisins laissait dériver la fusion
       de proche en proche (un versant courbé devenait une seule facette). */
    var tMax = Math.acos(Math.min(1, seuil)), rad = new Float64Array(nTri);
    /* ang — E : deux vecteurs → T : angle par acos du cosinus borné → S : rad. */
    function ang(x1, y1, z1, x2, y2, z2) {
      var l = (Math.hypot(x1, y1, z1) * Math.hypot(x2, y2, z2)) || 1;
      return Math.acos(Math.max(-1, Math.min(1, (x1 * x2 + y1 * y2 + z1 * z2) / l)));
    }
    var parent = new Int32Array(nTri); for (var u = 0; u < nTri; u++) parent[u] = u;
    var sNx = new Float64Array(nTri), sNy = new Float64Array(nTri), sNz = new Float64Array(nTri);
    for (var u2 = 0; u2 < nTri; u2++) {
      var au = f.surf[u2] || 1;
      sNx[u2] = f.nx[u2] * au; sNy[u2] = f.ny[u2] * au; sNz[u2] = f.nz[u2] * au;
    }
    /* find — E : x → T : racine avec compression de chemin → S : racine. */
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    for (var p = 0; p < pa.length; p++) {
      var A = pa[p], B = pb[p];
      if (f.actif[A] !== f.actif[B]) continue;
      var rA = find(A), rB = find(B);
      if (rA === rB) continue;
      var mx = sNx[rA] + sNx[rB], my = sNy[rA] + sNy[rB], mz = sNz[rA] + sNz[rB];
      var rN = Math.max(rad[rA] + ang(sNx[rA], sNy[rA], sNz[rA], mx, my, mz),
                        rad[rB] + ang(sNx[rB], sNy[rB], sNz[rB], mx, my, mz));
      if (rN > tMax) continue;
      parent[rA] = rB;
      sNx[rB] = mx; sNy[rB] = my; sNz[rB] = mz; rad[rB] = rN;
    }

    var groupId = new Int32Array(nTri).fill(-1);
    var nG = 0;
    for (var t0 = 0; t0 < nTri; t0++) { var r = find(t0); if (groupId[r] === -1) groupId[r] = nG++; }
    var gSurf = new Float64Array(nG), gCx = new Float64Array(nG), gCy = new Float64Array(nG), gCz = new Float64Array(nG);
    var gNx = new Float64Array(nG), gNy = new Float64Array(nG), gNz = new Float64Array(nG);
    var gSig = new Float64Array(nG), gActif = new Uint8Array(nG);
    for (var t1 = 0; t1 < nTri; t1++) {
      var g = groupId[find(t1)], s = f.surf[t1];
      var cx = f.centIdx[t1] % D, cy = (f.centIdx[t1] / D) | 0;
      gSurf[g] += s;
      gCx[g] += cx * s; gCy[g] += cy * s; gCz[g] += f.centZ[t1] * s;
      gNx[g] += f.nx[t1] * s; gNy[g] += f.ny[t1] * s; gNz[g] += f.nz[t1] * s;
      gSig[g] += f.sigma[t1] * s;
      if (f.actif[t1]) gActif[g] = 1;
    }
    var centIdx = new Int32Array(nG), centZ = new Float32Array(nG), cosT = new Float32Array(nG);
    var surf = new Float32Array(nG), nrx = new Float32Array(nG), nry = new Float32Array(nG), nrz = new Float32Array(nG);
    var sigma = new Float32Array(nG), actif = gActif;
    for (var gi = 0; gi < nG; gi++) {
      var S = gSurf[gi] || 1;
      var cxg = gCx[gi] / S, cyg = gCy[gi] / S;
      centIdx[gi] = Math.round(cyg) * D + Math.round(cxg);
      centZ[gi] = gCz[gi] / S;
      var nl = Math.sqrt(gNx[gi] * gNx[gi] + gNy[gi] * gNy[gi] + gNz[gi] * gNz[gi]) || 1;
      nrx[gi] = gNx[gi] / nl; nry[gi] = gNy[gi] / nl; nrz[gi] = gNz[gi] / nl;
      cosT[gi] = Math.abs(nrz[gi]);
      surf[gi] = gSurf[gi];
      sigma[gi] = gSig[gi] / S;
    }
    var triOfPix = new Int32Array(D * D);
    for (var pi = 0; pi < D * D; pi++) { var o = top[pi]; triOfPix[pi] = o < 0 ? -1 : groupId[find(o)]; }
    /* Centroïde hors de sa facette (groupe concave) : ramené sur le pixel
       de la facette le plus proche du centre de masse. */
    var ok = new Uint8Array(nG), best = new Float64Array(nG).fill(Infinity);
    for (var g0 = 0; g0 < nG; g0++) if (triOfPix[centIdx[g0]] === g0) ok[g0] = 1;
    for (var pj = 0; pj < D * D; pj++) {
      var gp = triOfPix[pj]; if (gp < 0 || ok[gp]) continue;
      var ddx = (pj % D) - gCx[gp] / (gSurf[gp] || 1), ddy = ((pj / D) | 0) - gCy[gp] / (gSurf[gp] || 1);
      var d2 = ddx * ddx + ddy * ddy;
      if (d2 < best[gp]) { best[gp] = d2; centIdx[gp] = pj; }
    }
    var nActifs = 0; for (var na = 0; na < nG; na++) if (actif[na]) nActifs++;

    return { nTri: nG, nActifs: nActifs, centIdx: centIdx, centZ: centZ,
             cosT: cosT, surf: surf, nx: nrx, ny: nry, nz: nrz,
             actif: actif, triOfPix: triOfPix,
             sigma: sigma, nCells: f.nCells, s0: f.s0 };
  }

  return { construire, stats, coalescer };

})();

if (typeof module !== "undefined" && module.exports) module.exports = { DSMFILET };
