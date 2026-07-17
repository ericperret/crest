/*
 * dsm-filet.js
 * Projet  : DSM Copernicus — filet virtuel de facettes terrain
 * Rôle    : Fait tomber un filet de pêche virtuel et mou depuis le ciel sur le
 *           terrain. Chaque nœud se plaque à l'altitude du sol ; les bords des
 *           mailles restent RECTILIGNES (télescopiques) : la maille moyenne le
 *           micro-relief, elle ne le suit pas. Chaque maille est coupée en 2
 *           triangles :
 *             — coupe de moindre divergence (dièdre minimal), SAUF sur la ligne
 *               de partage des eaux où la diagonale suit la ligne.
 *           Les triangles en zone chaude (T moy > 0 °C au 1er mars, époque
 *           initiale) sont éliminés d'office : jamais de glacier là (mais un
 *           glacier d'en haut pourra y couler plus tard — géométrie conservée,
 *           actif=0).
 *           Second passage : les mailles dont le moyennage d'altitude est trop
 *           agressif (écart-type σ des pixels couverts élevé) sont subdivisées
 *           en 4, par priorité σ décroissant, jusqu'au budget de triangles que
 *           les workers peuvent traiter dans le délai cible.
 *           Le vecteur (normale, cos θ) de chaque triangle est au CENTROÏDE.
 *
 * Entrée  : elev     Float32Array 1024×1024 (ombreElev1024)
 *           partage  Float32Array 1024×1024 (1=crête) ou null
 *           opts     { budget, scaleXY, estChaud(idxCentroid)→bool }
 * Sortie  : FILET {
 *             nTri     : nombre de triangles
 *             nActifs  : nombre de triangles actifs (hors zone chaude)
 *             centIdx  : Int32Array[nTri]   index pixel du centroïde
 *             centZ    : Float32Array[nTri] altitude centroïde (m)
 *             cosT     : Float32Array[nTri] |nz| de la normale au centroïde
 *             surf     : Float32Array[nTri] surface 3D réelle (m²)
 *             actif    : Uint8Array[nTri]   1 = accumulé, 0 = zone chaude
 *             triOfPix : Int32Array[1024²]  pixel → triangle (-1 = aucun)
 *             sigma    : Float32Array[nTri] σ altitude des pixels couverts (m)
 *           }
 * Dépend  : rien. HTML/JS pur, aucune librairie. 1024 en dur.
 * Auteur  : Eric Perret / implémentation Claude
 * Date    : 2026-07-11
 * Version : 1.5.0  (normale complète (nx,ny,nz) conservée par triangle — demande projet
 *                    pour le gradient de socle projeté ; équilibrage 2:1 RETIRÉ (rejeté) ;
 *                    base fonctionnelle = v1.2, raffinement σ/pics inchangé)
 *                    — fin du gel O(n²·log n) au-delà de ~10 000 mailles)
 */

"use strict";

const DSMFILET = (() => {

  const D = 1024;

  // ── Métrique de maille : max(σ, écart sommital) ───────────────────
  // σ : dispersion d'altitude (moyennage agressif diffus).
  // gap : z_max des pixels − moyenne des 4 coins plaqués (pic noyé dans la
  //       moyenne — invisible au σ si le reste de la maille est régulier).
  function metricCell(elev, x0, y0, s) {
    var n = 0, m = 0, m2 = 0, zMax = -1e9;
    var x1 = Math.min(x0 + s, D), y1 = Math.min(y0 + s, D);
    for (var y = y0; y < y1; y++)
      for (var x = x0; x < x1; x++) {
        var z = elev[y * D + x];
        if (z <= 0.5) continue;          // mer : ignorée
        n++; var d = z - m; m += d / n; m2 += d * (z - m);
        if (z > zMax) zMax = z;
      }
    if (n < 2) return 0;
    var sg = Math.sqrt(m2 / (n - 1));
    function zc(x, y) { return elev[Math.min(y, D - 1) * D + Math.min(x, D - 1)]; }
    var zCoins = (zc(x0, y0) + zc(x0 + s, y0) + zc(x0, y0 + s) + zc(x0 + s, y0 + s)) / 4;
    var gap = zMax - zCoins;             // pic au-dessus du plan plaqué
    return Math.max(sg, gap);
  }

  // ── Normale (composantes) d'un triangle 3D, sommets plaqués ──────
  // a,b,c : [x_px, y_px, z_m] ; scaleXY : m/pixel. Renvoie {nx,ny,nz,aire}
  function triNorm(a, b, c, scaleXY) {
    var ux = (b[0] - a[0]) * scaleXY, uy = (b[1] - a[1]) * scaleXY, uz = b[2] - a[2];
    var vx = (c[0] - a[0]) * scaleXY, vy = (c[1] - a[1]) * scaleXY, vz = c[2] - a[2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    var l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    return { nx: nx / (l || 1), ny: ny / (l || 1), nz: nz / (l || 1), aire: l / 2 };
  }

  // ── La maille contient-elle des pixels de crête, et sur quelle diagonale ? ──
  // Renvoie : 0 = diag B–C (haut-droit → bas-gauche), 1 = diag A–D, -1 = pas de crête
  function diagCrete(partage, x0, y0, s) {
    if (!partage) return -1;
    var x1 = Math.min(x0 + s, D - 1), y1 = Math.min(y0 + s, D - 1);
    // Comptage de crête près de chaque diagonale (bande de ±s/8 px)
    var bande = Math.max(1, s >> 3), cBC = 0, cAD = 0, tot = 0;
    for (var y = y0; y <= y1; y++)
      for (var x = x0; x <= x1; x++) {
        if (partage[y * D + x] < 0.5) continue;
        tot++;
        var fx = (x - x0) / s, fy = (y - y0) / s;          // 0..1 dans la maille
        if (Math.abs(fx + fy - 1) * s <= bande) cBC++;      // proche diag B–C
        if (Math.abs(fx - fy) * s <= bande) cAD++;          // proche diag A–D
      }
    if (tot === 0) return -1;
    return cAD > cBC ? 1 : 0;
  }

  // ── construire ────────────────────────────────────────────────────
  function construire(elev, partage, opts) {
    opts = opts || {};
    var budget  = opts.budget  || 8192;
    var scaleXY = opts.scaleXY || 10;
    var estChaud = opts.estChaud || null;   // fn(idxCentroid, zCentroid) → bool
    var S_MIN = 4;                          // taille minimale de maille (px)


    // 1. Taille initiale : à rebours du budget. 2·(1024/S)² ≤ budget/2
    //    (moitié du budget réservée au raffinement σ)
    var S0 = 512;
    while (S0 > S_MIN && 2 * (D / (S0 >> 1)) * (D / (S0 >> 1)) <= budget / 2) S0 >>= 1;

    // 2. Mailles dans un TAS binaire (max-heap sur la métrique).
    //    Seuil d'arrêt = médiane de la grille initiale, calculée UNE fois
    //    (l'ancien tri complet à chaque split était en O(n²·log n) → gel).
    var heap = [];
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
    var seuil = sgInit[sgInit.length >> 1];   // médiane initiale : moyennage cohérent

    // 3. Raffinement : pop la pire maille, split ×4 sous budget et au-dessus du seuil.
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

    // 4. Triangulation : 2 triangles par maille, nœuds PLAQUÉS aux coins.
    var nC = cells.length, nTri = 2 * nC;
    var centIdx = new Int32Array(nTri), centZ = new Float32Array(nTri);
    var cosT = new Float32Array(nTri), surf = new Float32Array(nTri);
    var nrx = new Float32Array(nTri), nry = new Float32Array(nTri), nrz = new Float32Array(nTri);  // normale complète (demande projet)
    var actif = new Uint8Array(nTri), sigma = new Float32Array(nTri);
    var triOfPix = new Int32Array(D * D); triOfPix.fill(-1);

    function zAt(x, y) { return elev[Math.min(y, D - 1) * D + Math.min(x, D - 1)]; }

    for (var ci = 0; ci < nC; ci++) {
      var cl = cells[ci], x0 = cl.x0, y0 = cl.y0, s = cl.s;
      var x1 = Math.min(x0 + s, D - 1), y1 = Math.min(y0 + s, D - 1);
      // Coins plaqués : A(x0,y0) B(x1,y0) C(x0,y1) E(x1,y1)
      var A = [x0, y0, zAt(x0, y0)], B = [x1, y0, zAt(x1, y0)];
      var C = [x0, y1, zAt(x0, y1)], E = [x1, y1, zAt(x1, y1)];

      // Choix de diagonale : crête prioritaire, sinon moindre divergence
      var dg = diagCrete(partage, x0, y0, s);
      if (dg < 0) {
        var n0a = triNorm(A, B, C, scaleXY), n0b = triNorm(B, E, C, scaleXY);   // diag B–C
        var n1a = triNorm(A, B, E, scaleXY), n1b = triNorm(A, E, C, scaleXY);   // diag A–E
        var cos0 = n0a.nx * n0b.nx + n0a.ny * n0b.ny + n0a.nz * n0b.nz;
        var cos1 = n1a.nx * n1b.nx + n1a.ny * n1b.ny + n1a.nz * n1b.nz;
        dg = cos1 > cos0 ? 1 : 0;
      }

      var t0 = 2 * ci, t1 = t0 + 1;
      var T0, T1;   // [ [x,y,z] ×3 ]
      if (dg === 0) { T0 = [A, B, C]; T1 = [B, E, C]; }   // diag B–C
      else          { T0 = [A, B, E]; T1 = [A, E, C]; }   // diag A–E

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
        nrx[ti] = nrm.nx; nry[ti] = nrm.ny; nrz[ti] = nrm.nz;   // conservée (plus jetée)
        sigma[ti] = cl.sg;
        actif[ti] = 1;
        if (cz <= 0.5) actif[ti] = 0;                       // mer
        else if (estChaud && estChaud(centIdx[ti], cz)) actif[ti] = 0;  // zone chaude
      }

      // 5. Rasterisation pixel → triangle : test de côté de la diagonale
      for (var py = y0; py < Math.min(y0 + s, D); py++)
        for (var px = x0; px < Math.min(x0 + s, D); px++) {
          var fx = (px - x0) / s, fy = (py - y0) / s;
          var side;
          if (dg === 0) side = (fx + fy <= 1) ? 0 : 1;       // diag B–C
          else          side = (fy <= fx) ? 0 : 1;           // diag A–E
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

  // ── stats ─────────────────────────────────────────────────────────
  function stats(f) {
    var sMoy = 0; for (var t = 0; t < f.nTri; t++) sMoy += f.sigma[t];
    return { triangles: f.nTri, actifs: f.nActifs, mailles: f.nCells,
             mailleInit: f.s0 + 'px', sigmaMoy: (sMoy / f.nTri).toFixed(1) + 'm' };
  }

  return { construire, stats };

})();

if (typeof module !== "undefined" && module.exports) module.exports = { DSMFILET };
