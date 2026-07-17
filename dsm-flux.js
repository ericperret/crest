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
  const G_MULT = 1;            // DEBUG : multiplicateur de gravité
  const C_SL   = 3e-22;        // glissement basal Weertman (décision « 2+ ») —
                               // calibré : u_b ≈ 50 m/an pour H=200 m, pente 10 %
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

  // ── Un pas SIA PUR : diffusion non linéaire explicite sous-cyclée ──
  // Boucle de sous-pas jusqu'à consommer dtJours :
  //   1) par arête : pente motrice s = cs + ΔH/dist (métrique unique),
  //      H amont, D = kDef·H⁵·s² + kSl·H⁴·s², débit Q = D·|s|·len [m³/s] ;
  //      cumul du taux de vidange R_t = Σ Q sur les mailles amont.
  //   2) dtSub = min(reste, CFL_SAFE · min_t [ H_t·A_t / R_t ]) — aucune
  //      maille ne peut perdre plus de CFL_SAFE de son stock par sous-pas,
  //      ce qui borne aussi l'égalisation des surfaces (monotonie).
  //   3) application Jacobi : dV = Q·dtSub·f_up, f_up = min(1, stock/exports)
  //      (garde de positivité, rarement active avec le CFL), H mis à jour,
  //      ΣdV cumulé par arête (signé a→b) pour les vitesses.
  // Vitesses en sortie : u = ΣdV/(len·dtTotal)/H_source — débit MOYEN
  // réellement transféré sur le pas, en m/an, porté par la maille source.
  function pas(F, adj, glaceWE, dtJours) {
    var nT = F.nTri, nE = adj.n;
    if (!F.vx) { F.vx = new Float32Array(nT); F.vy = new Float32Array(nT); F.vit = new Float32Array(nT); }
    F.vx.fill(0); F.vy.fill(0); F.vit.fill(0);
    var g    = G * G_MULT;
    var kDef = (2 * A_GLEN / (N_GLEN + 2)) * (RHO*g)*(RHO*g)*(RHO*g);   // ·H⁵·s³
    var kSl  = C_SL * (RHO*g)*(RHO*g)*(RHO*g);                          // ·H⁴·s³
    if (!adj.invD) {                                  // précalcul (1 fois)
      adj.invD = new Float32Array(nE);
      for (var e0 = 0; e0 < nE; e0++) adj.invD[e0] = 1 / adj.dist[e0];
    }
    // Tampons de travail (résidents sur adj — alloués 1 fois)
    if (!adj._Q) {
      adj._Q    = new Float64Array(nE);   // débit signé a→b du sous-pas (m³/s)
      adj._dVc  = new Float64Array(nE);   // ΣdV signé a→b sur le pas (m³)
      adj._H    = new Float64Array(nT);   // épaisseur de travail (m glace)
      adj._R    = new Float64Array(nT);   // taux de vidange par maille (m³/s)
      adj._X    = new Float64Array(nT);   // exports demandés du sous-pas (m³)
      adj._fS   = new Float64Array(nT);   // facteur de positivité par maille
    }
    var Q = adj._Q, dVc = adj._dVc, H = adj._H, R = adj._R, X = adj._X, fS = adj._fS;
    dVc.fill(0);
    for (var t0 = 0; t0 < nT; t0++) H[t0] = glaceWE[t0] > 0 ? glaceWE[t0] / DENS_G : 0;

    var dtRest = dtJours * SEC_J, dtMin = Infinity, nSub = 0;
    while (dtRest > 0) {
      if (++nSub > MAX_SOUS_PAS) {
        console.warn('[DSMFLUX] MAX_SOUS_PAS atteint (' + MAX_SOUS_PAS +
          ') — reste ' + (dtRest/SEC_J).toFixed(3) + ' j non intégrés dans ce pas');
        break;
      }
      // 1) Débits Jacobi sur l'état courant + taux de vidange par maille
      R.fill(0);
      var dtCFL = Infinity;
      for (var e = 0; e < nE; e++) {
        var a = adj.a[e], b = adj.b[e];
        var Ha = H[a], Hb = H[b];
        if (Ha <= 0 && Hb <= 0) { Q[e] = 0; continue; }
        // Pente motrice SIGNÉE a→b : socle projeté + ΔH réel / dist (métrique unique)
        var s = adj.cs[e] + (Ha - Hb) * adj.invD[e];
        var up, Hup;
        if (s > 0) { up = a; Hup = Ha; } else { up = b; Hup = Hb; }
        if (Hup <= 0.01) { Q[e] = 0; continue; }
        var s2 = s * s, as = s > 0 ? s : -s;
        // SIA exacte : D = (kDef·H⁵ + kSl·H⁴)·s² ; q = D·|s| [m²/s]
        var h2 = Hup * Hup, h4 = h2 * h2;
        var q  = (kDef * h4 * Hup + kSl * h4) * s2 * as;
        var Qe = q * adj.len[e];                        // m³/s, module
        Q[e] = s > 0 ? Qe : -Qe;                        // signé a→b
        R[up] += Qe;
      }
      // 2) CFL : aucune maille ne perd plus de CFL_SAFE de son stock par sous-pas
      for (var tc = 0; tc < nT; tc++) {
        if (R[tc] <= 0) continue;
        var dtc = H[tc] * F.surf[tc] / R[tc];
        if (dtc < dtCFL) dtCFL = dtc;
      }
      var dtSub = dtCFL === Infinity ? dtRest : Math.min(dtRest, CFL_SAFE * dtCFL);
      if (dtSub < dtMin) dtMin = dtSub;
      // 3) Positivité : exports demandés vs stock, réduction au prorata
      X.fill(0);
      for (var e1 = 0; e1 < nE; e1++) {
        var Qs = Q[e1]; if (Qs === 0) continue;
        X[Qs > 0 ? adj.a[e1] : adj.b[e1]] += (Qs > 0 ? Qs : -Qs) * dtSub;
      }
      for (var tf = 0; tf < nT; tf++) {
        var st = H[tf] * F.surf[tf];
        fS[tf] = X[tf] > st ? (st > 0 ? st / X[tf] : 0) : 1;
      }
      // 4) Application conservative + cumul par arête
      for (var e2 = 0; e2 < nE; e2++) {
        var Q2 = Q[e2]; if (Q2 === 0) continue;
        var a2 = adj.a[e2], b2 = adj.b[e2];
        var up2 = Q2 > 0 ? a2 : b2, dn2 = Q2 > 0 ? b2 : a2;
        var dV = (Q2 > 0 ? Q2 : -Q2) * dtSub * fS[up2];
        if (dV <= 0) continue;
        H[up2] -= dV / F.surf[up2];
        H[dn2] += dV / F.surf[dn2];
        dVc[e2] += Q2 > 0 ? dV : -dV;
      }
      dtRest -= dtSub;
    }
    // Retour en m w.e. (écrasement complet : H est l'état exact)
    for (var tw = 0; tw < nT; tw++) glaceWE[tw] = H[tw] > 0 ? H[tw] * DENS_G : 0;

    // Vitesses : débit MOYEN réellement transféré sur le pas, porté par la source
    var dtTot = dtJours * SEC_J;
    var _top3 = [];
    for (var ev = 0; ev < nE; ev++) {
      var dvs = dVc[ev]; if (dvs === 0) continue;
      var src = dvs > 0 ? adj.a[ev] : adj.b[ev], dst = dvs > 0 ? adj.b[ev] : adj.a[ev];
      var adV = dvs > 0 ? dvs : -dvs;
      var Hs = H[src] > 0.01 ? H[src] : 0.01;
      var u = (adV / (adj.len[ev] * dtTot) / Hs) * SEC_J * 365;   // m/an
      var ux = (F.centIdx[dst] % D) - (F.centIdx[src] % D);
      var uy = ((F.centIdx[dst] / D) | 0) - ((F.centIdx[src] / D) | 0);
      var ul = Math.hypot(ux, uy) || 1;
      F.vx[src] += u * ux / ul; F.vy[src] += u * uy / ul;
      if (_top3.length < 3 || adV > _top3[_top3.length - 1].dV) {
        _top3.push({ up: src, dn: dst, dV: Math.round(adV),
                     Hu: +H[src].toFixed(1), Hd: +H[dst].toFixed(1) });
        _top3.sort(function (x, y) { return y.dV - x.dV; });
        if (_top3.length > 3) _top3.pop();
      }
    }
    for (var t = 0; t < nT; t++) F.vit[t] = Math.hypot(F.vx[t], F.vy[t]);
    // SONDE : top-3 transferts + glaces négatives + charge CFL du pas
    var neg = 0; for (var tn = 0; tn < nT; tn++) if (glaceWE[tn] < 0) neg++;
    DSMFLUX.sonde = { top: _top3, neg: neg, sousPas: nSub,
                      dtMinS: dtMin === Infinity ? 0 : +dtMin.toFixed(1) };
  }

  // ── Blatter-Pattyn : NON ACTIF — réservé version future ─────────
  function pasBP() { throw new Error('DSMFLUX.pasBP : Blatter-Pattyn non actif (version future)'); }

  return { adjacence, pas, pasBP, A_GLEN, C_SL };
})();
if (typeof module !== "undefined" && module.exports) module.exports = { DSMFLUX };
