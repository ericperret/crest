/*
 * dsm-flux.js
 * Projet  : DSM — écoulement de la glace sur le filet (arêtes entre triangles)
 * Modèle  : SIA PUR (Shallow Ice Approximation, Hutter 1983) + glissement
 *           basal Weertman. Diffusion NON LINÉAIRE résolue en volumes finis :
 *             q = D · |∇s|          [m²/s, flux par unité de largeur]
 *             D = (2A/(n+2))·(ρg)ⁿ·Hⁿ⁺²·|∇s|ⁿ⁻¹ + C_sl·(ρg)³·H⁴·|∇s|²
 *           ∇s = pente de la SURFACE (socle par normales de facettes + ΔH),
 *           sur UNE SEULE métrique par arête (mode A ou B, cf. adjacence).
 *           H amont (upwind) dans D : le front avance, jamais de flux depuis
 *           une maille vide. Schéma EXPLICITE de type Jacobi (tous les flux
 *           calculés sur l'état du début de sous-pas, puis appliqués) —
 *           l'ordre des arêtes est indifférent, le résultat est déterministe.
 *           STABILITÉ PAR CFL SEUL : le pas de 5 j est sous-cyclé, chaque
 *           sous-pas dtSub ≤ CFL_SAFE · min_t [ A_t / Σ_arêtes(D·len/dist) ].
 *           AUCUN plafond ad hoc : les caps dVeq/Nye/séracs des v2.3→3.4
 *           sont SUPPRIMÉS — c'est cette pile de brides qui bloquait le
 *           front (chaque arête limitée à l'égalisation des surfaces : dès
 *           que la langue s'amincit, l'export tombe sous la fonte aval).
 *           Seule garde restante : positivité (si les exports d'une maille
 *           dans un sous-pas dépassent son stock, ils sont réduits au
 *           prorata — jamais de glace négative, conservation exacte).
 * API     : adjacence(F, scaleXY, mode)          — 1 fois ; mode 'A'|'B'
 *             'A' = tout-centroïde : direction/distance centroïde→centroïde,
 *                   gradients de facettes (nx,ny,nz) pondérés par AIRE,
 *                   projetés sur cette direction.
 *             'B' = contact inter-triangles : direction = NORMALE au segment
 *                   de contact réel (corde des extrémités du chapelet de
 *                   pixels frontière), distance = séparation des centroïdes
 *                   le long de cette normale, largeur = longueur VRAIE du
 *                   segment (corrige le biais √2 de l'escalier de pixels).
 *           pas(F, adj, glaceWE, dtJours)        — 1 pas ; remplit F.vx/vy/vit (m/an)
 *             sonde : { top (3 plus gros ΣdV du pas), neg (glaces négatives),
 *                       sousPas (nb de sous-pas CFL), dtMinS (plus petit dtSub, s) }
 *           pasBP()                              — Blatter-Pattyn : NON ACTIF
 * Unités  : glaceWE m w.e. ; H = we/0.917 m glace (ρ=917 kg/m³ unifiée) ; distances m ; vitesses m/an.
 * Dépend  : rien. JS pur.
 * Auteur  : Eric Perret / implémentation Claude
 * Date    : 2026-07-15
 * Version : 5.1.0  (ROBUSTESSE + PERFORMANCE, physique inchangée :
 *                    — ensemble ACTIF (arêtes K>0 et leurs mailles seulement) ;
 *                    — balayages Gauss-Seidel ALTERNÉS (aller/retour) ;
 *                    — GS à DEUX PHASES : plein, puis focalisé sur l'amas non
 *                      convergé + couronne (les configurations ultra-raides
 *                      convergent en local, coût borné) ;
 *                    — SEGMENTS ADAPTATIFS : pas découpé en dt/2…dt/128 tant
 *                      que non convergé (avertit au-delà, jamais silencieux).
 *                    Tue l'effet cliquet des états dégénérés (H≈2000 m sur
 *                    une maille : décroît sainement au lieu de s'emballer —
 *                    cause probable du « tri 4288 à 2252 m »). Précision
 *                    mesurée vs référence explicite fine : 0,69 m / 5 ans en
 *                    régime normal ; l'état dégénéré coûte temporairement
 *                    cher mais s'auto-résorbe. Sonde : {seg, picard, gs, neg}.)
 * Version : 5.0.1  (BUG VECTEURS : la diffusivité locale « var D » masquait la
 *                    constante de grille D=1024 dans pas() → le bloc vitesse
 *                    calculait centIdx % diffusivité → toutes les flèches en
 *                    ±y. Renommée Df. Physique inchangée (les flux n'utilisaient
 *                    pas D-grille), seules les directions affichées étaient fausses.)
 * Version : 5.0.0  (SOLVEUR IMPLICITE : Euler implicite, Picard (gel de D,
 *                    sous-relaxation 0,7) + Gauss-Seidel (CSR maille→arêtes),
 *                    inconditionnellement stable — le pas de 5 j se résout en
 *                    ~2-8 Picard × ≤60 balayages quel que soit H. Remplace le
 *                    sous-cyclage CFL explicite 4.x qui monopolisait un cœur
 *                    (dt global dicté par la pire arête). Physique STRICTEMENT
 *                    identique : mêmes D (Glen×E + till c1), même pente motrice,
 *                    H amont, conservation exacte (mise à jour en forme flux),
 *                    garde de stock au prorata. Sonde : {picard, gs, neg}.)
 * Version : 4.2.1  (purge : suppression du multiplicateur de gravité de debug
 *                    G_MULT — plus aucun by-pass dans le module.)
 * Version : 4.2.0  (glissement basal LINÉAIRE u_b = c1·τ — rhéologie de till
 *                    visqueux (Boulton & Hindmarsh 1987), régime des lobes de
 *                    piémont sur sédiments saturés. Remplace le Weertman cubique
 *                    du glissement (source de l'explosion CFL au C « à plat » :
 *                    u ∝ τ³ → 50 km/an dans les couloirs raides, sous-cyclage
 *                    par milliers = workers saturés). La déformation reste Glen
 *                    cubique ×E. q = E·kGlen·H⁵·|s|³ + c1·ρg·H²·|s|.)
 * Version : 4.1.1  (glissement : cSl n'a plus de défaut physique dans le module —
 *                    fourni par l'hôte, dérivé de la spécification « vitesse à
 *                    plat » (contresens pente 10 % corrigé). Physique inchangée.)
 * Version : 4.1.0  (rhéologie PALÉO paramétrable : DSMFLUX.config = {E, cSl}.
 *                    E = facteur d'accroissement (glace pléistocène, défaut 3,
 *                    sourcé EISMINT/Paterson) sur la déformation ; cSl =
 *                    Weertman exposé (paramètre libre cat. B, calibrage sur
 *                    moraines). Réglable depuis dsm.html sans toucher au module.)
 * Version : 4.0.1  (densité de la glace UNIFIÉE : DENS_G = 0.917 — cohérent avec
 *                    RHO = 917 kg/m³ utilisé dans kDef/kSl. L'ancien 0.9 créait un
 *                    écart systématique de ~2 % sur H, donc ~9 % sur le flux (H⁵).
 *                    Audit des constantes, décision « valeur connue = on l'utilise ».)
 * Version : 4.0.0  (SIA PUR : diffusion non linéaire explicite Jacobi, H amont,
 *                    sous-cyclage CFL adaptatif (CFL_SAFE=0.2, garde-fou
 *                    MAX_SOUS_PAS=20000 avec avertissement console — la physique
 *                    n'est jamais bridée en silence). SUPPRIMÉS : dVeq
 *                    d'égalisation, cap Nye 100 kPa, chute de séracs, tri en
 *                    cascade gravitaire. Vitesses = débit moyen réellement
 *                    transféré sur le pas (ΣdV par arête). Adjacence 3.4
 *                    inchangée (modes A/B, longueur de contact vraie).)
 * Version : 3.4.0  (suppression cellules partielles φ/Href ; métrique unique ;
 *                    adjacence modes A/B)
 * Version : 3.3.0  (verrou pleine, blocage unifié, dVeq frais, vitesse réelle)
 * Version : 3.2.0  (dV_max universel ; Href cliquet ; pente = Csocle + ΔH/dist)
 * Version : 3.1.0  (canalisation socle descendant)
 * Version : 3.0.0  (cellules de front partielles, schéma PISM)
 * Version : 2.5.0  (distance via milieu de frontière aux raccords gros↔petits)
 * Version : 2.4.0  (glissement basal Weertman activé, C_SL=3e-22)
 * Version : 2.3.0  (chute de séracs : pente > 35° → transfert de l'excédent)
 */
"use strict";
const DSMFLUX = (() => {
  const D = 1024, RHO = 917, G = 9.81, DENS_G = 0.917, N_GLEN = 3;
  const A_GLEN = 2.4e-24;      // Pa⁻³·s⁻¹ — glace tempérée (Cuffey & Paterson 2010)
  // Paramètres RÉGLABLES depuis l'hôte via DSMFLUX.config (défauts ci-dessous) :
  //  E   — facteur d'accroissement de la déformation (enhancement factor).
  //        Glace pléistocène (poussières, fabrique orientée) : E ≈ 3, standard
  //        des modèles paléo (EISMINT, PISM ; Paterson 1991). E=1 = loi de Glen pure.
  //  c1  — glissement basal LINÉAIRE u_b = c1·τ (till visqueux, Boulton &
  //        Hindmarsh 1987 — lits sédimentaires saturés, régime des lobes LGM).
  //        FOURNI PAR L'HÔTE, dérivé de la spec « vitesse à plat » (FLUX_UB_PLAT
  //        @ FLUX_PENTE_REF/FLUX_H_REF dans dsm.html). u ∝ τ : pas d'explosion
  //        cubique en pente (le cubique Weertman reste la loi de la DÉFORMATION).
  const CONFIG = { E: 3, c1: 0 };        // défauts sûrs — l'hôte DOIT fournir c1 (spec « à plat »)
  const SEC_J  = 86400;
  const CFL_SAFE = 0.2;        // fraction du pas de stabilité (marge non linéaire)
  const MAX_SOUS_PAS = 20000;  // garde-fou anti-boucle : AVERTIT en console,
                               // ne bride jamais en silence

  // ── Adjacence entre triangles via triOfPix — CALCULÉE UNE FOIS ──
  // mode 'A' (centroïdes) ou 'B' (contact inter-triangles). Défaut : 'B'.
  // Par arête : a, b, len (largeur de flux, m), dist (bras de levier du
  // gradient, m), cs (pente de socle projetée, SIGNÉE : >0 descend a→b).
  function adjacence(F, scaleXY, mode) {
    mode = mode === 'A' ? 'A' : 'B';
    var top = F.triOfPix;
    // Accumulateurs par arête : cnt, bornes du chapelet de traversées.
    var map = new Map();   // clé → {c, x0, y0, x1, y1}  (bornes en px)
    for (var y = 0; y < D - 1; y++)
      for (var x = 0; x < D - 1; x++) {
        var i = y * D + x, a = top[i];
        if (a < 0) continue;
        var b1 = top[i + 1], b2 = top[i + D];
        // traversée horizontale (pixel de droite) : point (x+1, y+0.5)
        if (b1 >= 0 && b1 !== a) _acc(map, a, b1, x + 1, y + 0.5);
        // traversée verticale (pixel du dessous) : point (x+0.5, y+1)
        if (b2 >= 0 && b2 !== a) _acc(map, a, b2, x + 0.5, y + 1);
      }
    var n = map.size;
    var eA = new Int32Array(n), eB = new Int32Array(n);
    var eL = new Float32Array(n), eD = new Float32Array(n);
    var eC = new Float32Array(n);   // pente socle projetée (a→b, signée)
    var j = 0;
    map.forEach(function (r, k) {
      var a = Math.floor(k / 1e6), b = k % 1e6;
      eA[j] = a; eB[j] = b;
      var ax = F.centIdx[a] % D, ay = (F.centIdx[a] / D) | 0;
      var bx = F.centIdx[b] % D, by = (F.centIdx[b] / D) | 0;
      var cxv = bx - ax, cyv = by - ay;                 // vecteur centroïdes a→b (px)
      var cl  = Math.hypot(cxv, cyv) || 1;
      // Segment de contact : corde des extrémités du chapelet (+1 px de largeur
      // unitaire aux bouts). Exact pour contact rectiligne ; corrige le √2.
      var sx = r.x1 - r.x0, sy = r.y1 - r.y0;
      var lenPx = Math.min(r.c, Math.hypot(sx, sy) + 1);  // jamais > escalier
      // Direction du flux (unitaire, a→b) et bras de levier selon le mode
      var dx, dy, distPx;
      if (mode === 'B' && (sx !== 0 || sy !== 0)) {
        // normale au segment de contact, orientée de a vers b
        var sl = Math.hypot(sx, sy);
        dx = sy / sl; dy = -sx / sl;
        if (dx * cxv + dy * cyv < 0) { dx = -dx; dy = -dy; }
        distPx = Math.abs(cxv * dx + cyv * dy);          // séparation projetée
      } else {
        // mode A — ou repli B si segment dégénéré (1 seule traversée)
        dx = cxv / cl; dy = cyv / cl;
        distPx = cl;
      }
      eL[j] = lenPx * scaleXY;
      eD[j] = Math.max(scaleXY, distPx * scaleXY);
      // Gradient de socle par facette : ∇z = (−nx/nz, −ny/nz), pondéré par AIRE.
      // cs = −(∇z_pondéré · direction) : POSITIF = le socle descend de a vers b.
      if (F.nx) {
        var wa = F.surf[a] / (F.surf[a] + F.surf[b]), wb = 1 - wa;
        var gx = wa * (-F.nx[a] / (F.nz[a] || 1)) + wb * (-F.nx[b] / (F.nz[b] || 1));
        var gy = wa * (-F.ny[a] / (F.nz[a] || 1)) + wb * (-F.ny[b] / (F.nz[b] || 1));
        eC[j] = -(gx * dx + gy * dy);
      }
      j++;
    });
    return { n: n, a: eA, b: eB, len: eL, dist: eD, cs: eC, mode: mode };
  }
  function _acc(map, a, b, px, py) {
    var k = a < b ? a * 1e6 + b : b * 1e6 + a;
    var r = map.get(k);
    if (!r) { map.set(k, { c: 1, x0: px, y0: py, x1: px, y1: py }); return; }
    r.c++;
    if (px < r.x0) r.x0 = px; if (px > r.x1) r.x1 = px;
    if (py < r.y0) r.y0 = py; if (py > r.y1) r.y1 = py;
  }

  // ── Un pas : diffusion non linéaire IMPLICITE (Picard + Gauss-Seidel) ──
  // Même physique que 4.x (mêmes D, même pente motrice, mêmes E/c1) ; seule
  // l'INTÉGRATION TEMPORELLE change : Euler implicite, inconditionnellement
  // stable — le pas de 5 j se résout d'un bloc, quelle que soit l'épaisseur.
  // (Le schéma explicite 4.x sous-cyclait au CFL GLOBAL : une seule arête
  // épaisse/raide dictait dt pour toute la carte → milliers de sous-pas,
  // worker monopolisant un cœur pendant que le pool attendait.)
  //
  // Formulation : Q_e = k_e·(b_e + Ha − Hb), k_e = D_e·len/dist (D gelé par
  // itération de Picard, H AMONT), b_e = cs_e·dist_e (part socle de la pente).
  // Système linéaire (I·A/dt + L)·H⁺ = A/dt·Hⁿ + sources socle, résolu par
  // balayages Gauss-Seidel (matrice à diagonale dominante → convergence),
  // puis Picard réévalue D(H⁺) et re-résout ; sous-relaxation 0,7 sur D.
  // Conservation : mise à jour finale en FORME FLUX (Hⁿ + dt/A·Σ±Q) — exacte
  // par antisymétrie des Q ; au point fixe elle coïncide avec la solution GS.
  // Positivité : D(H amont) → 0 quand H → 0 (H⁵, H²) : une maille qui se vide
  // coupe elle-même son export ; clampage résiduel compté dans la sonde.
  function pas(F, adj, glaceWE, dtJours) {
    var nT = F.nTri, nE = adj.n;
    if (!F.vx) { F.vx = new Float32Array(nT); F.vy = new Float32Array(nT); F.vit = new Float32Array(nT); }
    F.vx.fill(0); F.vy.fill(0); F.vit.fill(0);
    var g    = G;
    var cfg  = DSMFLUX.config || CONFIG;
    var kDef = (cfg.E||1) * (2 * A_GLEN / (N_GLEN + 2)) * (RHO*g)*(RHO*g)*(RHO*g); // ·H⁵·s³ (Glen)
    var kLin = (cfg.c1||0) * (RHO*g);                                              // ·H²·s  (till linéaire)
    if (!adj.invD) {
      adj.invD = new Float32Array(nE);
      for (var e0 = 0; e0 < nE; e0++) adj.invD[e0] = 1 / adj.dist[e0];
    }
    // Table maille → arêtes (construite 1 fois) : offsets CSR + id d'arête signé
    if (!adj._cOff) {
      var cnt = new Int32Array(nT);
      for (var ec = 0; ec < nE; ec++) { cnt[adj.a[ec]]++; cnt[adj.b[ec]]++; }
      adj._cOff = new Int32Array(nT + 1);
      for (var tc = 0; tc < nT; tc++) adj._cOff[tc + 1] = adj._cOff[tc] + cnt[tc];
      adj._cEdge = new Int32Array(adj._cOff[nT]);   // id d'arête
      adj._cSgn  = new Int8Array(adj._cOff[nT]);    // +1 si maille = a, −1 si b
      var fill = Int32Array.from(adj._cOff.subarray(0, nT));
      for (var ef = 0; ef < nE; ef++) {
        var pa = fill[adj.a[ef]]++; adj._cEdge[pa] = ef; adj._cSgn[pa] = 1;
        var pb = fill[adj.b[ef]]++; adj._cEdge[pb] = ef; adj._cSgn[pb] = -1;
      }
    }
    if (!adj._K) {
      adj._K   = new Float64Array(nE);   // k_e = D·len/dist (gelé par Picard)
      adj._B   = new Float64Array(nE);   // b_e = cs·dist (part socle, m)
      adj._H0  = new Float64Array(nT);   // Hⁿ (début de pas)
      adj._H   = new Float64Array(nT);   // itéré courant H⁺
      adj._dVc = new Float64Array(nE);   // dV final par arête (vitesses)
      for (var eb = 0; eb < nE; eb++) adj._B[eb] = adj.cs[eb] * adj.dist[eb];
    }
    var K = adj._K, B = adj._B, H0 = adj._H0, H = adj._H, dVc = adj._dVc;
    var cOff = adj._cOff, cEdge = adj._cEdge, cSgn = adj._cSgn;
    for (var t0 = 0; t0 < nT; t0++) { H0[t0] = glaceWE[t0] > 0 ? glaceWE[t0] / DENS_G : 0; H[t0] = H0[t0]; }

    // Ensemble actif (5.1) : seules les mailles englacées et leurs voisines
    // participent — les arêtes K=0 et les mailles vides sont hors des balayages.
    if (!adj._actC) { adj._actC = new Int32Array(nT); adj._actE = new Int32Array(nE); adj._inAct = new Uint8Array(nT); }
    var actC = adj._actC, actE = adj._actE, inAct = adj._inAct;
    var dtTot = dtJours * SEC_J;
    var PICARD_MAX = 4, GS_MAX = 40, TOL_GS = 1e-3, RELAX = 0.7;
    var TOL_CONV = 0.02;      // m — au-delà, le segment n'est PAS convergé → découpage
    var MAX_PROF = 7;         // découpage jusqu'à dt/128 ; avertit si atteint
    var nSeg = 0, gsTot = 0, picTot = 0, neg = 0;
    dVc.fill(0);
    var X  = adj._X  || (adj._X  = new Float64Array(nT));
    var fS = adj._fS || (adj._fS = new Float64Array(nT));
    var H0s = adj._H0s || (adj._H0s = new Float64Array(nT));   // début de segment

    function solveSeg(dtSeg, prof) {
      H0s.set(H);
      // ── Picard : gel de K, résolution GS, réévaluation ──
      var dMax = 1e9, nAE = 0, nAC = 0;
      for (var pic = 0; pic < PICARD_MAX; pic++) {
        picTot++;
        for (var e = 0; e < nE; e++) {
          var a = adj.a[e], b = adj.b[e];
          var Ha = H[a], Hb = H[b];
          if (Ha <= 0 && Hb <= 0) { K[e] = 0; continue; }
          var s  = adj.cs[e] + (Ha - Hb) * adj.invD[e];
          var Hup = s > 0 ? Ha : Hb;
          if (Hup <= 0.01) { K[e] = 0; continue; }
          var h2 = Hup * Hup;
          var Df = kDef * h2 * h2 * Hup * s * s + kLin * h2;
          var kNew = Df * adj.len[e] * adj.invD[e];
          K[e] = pic === 0 ? kNew : K[e] + RELAX * (kNew - K[e]);
        }
        // ensemble actif du segment
        nAE = 0; nAC = 0; inAct.fill(0);
        for (var ez = 0; ez < nE; ez++) {
          if (K[ez] === 0) continue;
          actE[nAE++] = ez;
          var za = adj.a[ez], zb = adj.b[ez];
          if (!inAct[za]) { inAct[za] = 1; actC[nAC++] = za; }
          if (!inAct[zb]) { inAct[zb] = 1; actC[nAC++] = zb; }
        }
        // Gauss-Seidel alterné à deux phases : plein, puis FOCALISÉ sur les
        // mailles non convergées + voisines (l'amas raide se résout en local).
        var dC = adj._dC || (adj._dC = new Float64Array(nT));
        function balaye(liste, nL, sens) {
          var dM = 0;
          for (var q0 = 0; q0 < nL; q0++) {
            var i = liste[sens ? nL - 1 - q0 : q0];
            var Adt = F.surf[i] / dtSeg;
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
        var gs = 0; dMax = 1e9;
        while (gs < GS_MAX && dMax > TOL_GS) { gs++; dMax = balaye(actC, nAC, (gs & 1) === 0); }
        gsTot += gs;
        // Phase focalisée : amas non convergé + première couronne
        var rep = 0;
        while (dMax > TOL_GS && rep < 3) {
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
          while (gf < 3000 && dF > TOL_GS) { gf++; dF = balaye(foc, nF, (gf & 1) === 0); }
          gsTot += (gf * nF / (nAC || 1)) | 0;
          dMax = balaye(actC, nAC, false); gsTot++;
        }
        if (pic > 0 && dMax < TOL_CONV) break;
      }
      // ── Non convergé → découpage du segment (implicite sur dt/2, deux fois) ──
      if (dMax > TOL_CONV && prof < MAX_PROF) {
        H.set(H0s);
        nSeg--;                        // ce segment est remplacé par ses deux moitiés
        nSeg++; solveSeg(dtSeg / 2, prof + 1);
        nSeg++; solveSeg(dtSeg / 2, prof + 1);
        return;
      }
      if (dMax > TOL_CONV) console.warn('[DSMFLUX] segment non convergé à prof ' + prof + ' (dMax=' + dMax.toFixed(3) + ' m)');
      // ── Application en forme flux (conservation exacte) + garde de stock ──
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
        if (H[tw] < 0) { if (H[tw] < -1e-6) neg++; H[tw] = 0; }
      }
    }

    if (!adj._Qseg) adj._Qseg = new Float64Array(nE);
    nSeg = 1; solveSeg(dtTot, 0);
    for (var tg = 0; tg < nT; tg++) glaceWE[tg] = H[tg] > 0 ? H[tg] * DENS_G : 0;
    var dt = dtTot;   // pour le bloc vitesses

    // 5) Vitesses : débit du pas par arête, porté par la maille source
    var _top3 = [];
    for (var ev = 0; ev < nE; ev++) {
      var dvs = dVc[ev]; if (dvs === 0) continue;
      var src = dvs > 0 ? adj.a[ev] : adj.b[ev], dst = dvs > 0 ? adj.b[ev] : adj.a[ev];
      var av = dvs > 0 ? dvs : -dvs;
      var Hs = H[src] > 0.01 ? H[src] : 0.01;
      var u = (av / (adj.len[ev] * dt) / Hs) * SEC_J * 365;   // m/an
      var ux = (F.centIdx[dst] % D) - (F.centIdx[src] % D);
      var uy = ((F.centIdx[dst] / D) | 0) - ((F.centIdx[src] / D) | 0);
      var ul = Math.hypot(ux, uy) || 1;
      F.vx[src] += u * ux / ul; F.vy[src] += u * uy / ul;
      if (_top3.length < 3 || av > _top3[_top3.length - 1].dV) {
        _top3.push({ up: src, dn: dst, dV: Math.round(av),
                     Hu: +H[src].toFixed(1), Hd: +H[dst].toFixed(1) });
        _top3.sort(function (x, y) { return y.dV - x.dV; });
        if (_top3.length > 3) _top3.pop();
      }
    }
    for (var t = 0; t < nT; t++) F.vit[t] = Math.hypot(F.vx[t], F.vy[t]);
    // SONDE : itérations du solveur + clampages
    DSMFLUX.sonde = { top: _top3, neg: neg, seg: nSeg, picard: picTot, gs: gsTot };
  }

  // ── Blatter-Pattyn : NON ACTIF — réservé version future ─────────
  function pasBP() { throw new Error('DSMFLUX.pasBP : Blatter-Pattyn non actif (version future)'); }

  return { adjacence, pas, pasBP, A_GLEN, config: CONFIG };
})();
if (typeof module !== "undefined" && module.exports) module.exports = { DSMFLUX };
