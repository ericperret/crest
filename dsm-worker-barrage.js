/* ═══════════════════════════════════════════════════════════════════
   FICHIER : dsm-worker-barrage.js - v27/09/2026
   OBJET   : onde de rupture instantanée d'un barrage sur la grille du DSM :
             hauteur d'eau h et vitesse (u, v) en chaque pixel et à chaque
             instant, au-dessus du relief z ; datation de l'arrivée du
             front pixel par pixel, lame et vitesse maximales, isochrones ;
             envoi en cours de calcul des pixels atteints et des lames
             (affichage vivant), clichés des lames (rejeu).
             La source du Worker est BARRAGE_FABRIQUE.toString() : un seul
             code de calcul, ni importScripts ni dépendance réseau,
             ouverture file:// possible.
   AUTEUR  : Eric P.
   RELECTURE : Opus 5.5
   LICENCE : CC BY-NC 4.0 — source à citer : https://github.com/ericperret/crest/
             usage commercial interdit sauf accord écrit de l'auteur (voir LICENSE)
   DÉPEND  : aucune (données reçues par message)
   EXPOSE  : BARRAGE_FABRIQUE, BARRAGEWORKER { lancer, arreter }
   MESSAGES : « instant » {t, frontKm, q, reste, p, a, prof} ; « fin » {res} ;
             « erreur » {msg}.
   MODÈLES (publiés, aucun paramètre ajusté) :
     · équations de Saint-Venant bidimensionnelles (eaux peu profondes) :
       masse ∂h/∂t + ∇·(h·V) = 0 ; quantité de mouvement ∂V/∂t + (V·∇)V
       + g·∇(h + z) = ν·∇²V. Le terme d'inertie (V·∇)V porte l'eau tout
       droit dans un virage ; face à une rive, g·∇(h + z) la freine :
       l'énergie ½V² devient hauteur (au plus V²/2g), puis la pente la
       ramène ; rien n'est imposé en plus ;
     · schéma décalé conservatif de Stelling & Duinmeijer (2003), « A
       staggered conservative scheme for every Froude number in rapidly
       varied shallow water flows », Int. J. Numer. Meth. Fluids
       43:1329-1354 : h aux centres, u et v aux faces, profondeur de face
       prise en amont au-dessus du seuil de face max(z gauche, z droit)
       (fronts secs sans hauteur négative), advection conservant la
       quantité de mouvement, transport transverse sous la même forme
       (Kramer & Stelling 2008, Int. J. Numer. Meth. Fluids 58:183-212) ;
     · frottement de fond de Manning (1891), n = 0,020 s·m^(-1/3) (sol
       nu), semi-implicite par face : u ← u* / (1 + g·n²·|V|·Δt / ĥ^(4/3)),
       ĥ = lame de face, |V| avec la vitesse transverse moyennée (freine
       sans jamais inverser la vitesse, stable pour toute lame) ; essai de
       Ritter sans frottement ; frottement de l'eau sur l'eau par viscosité turbulente
       horizontale de Smagorinsky (1963, Monthly Weather Review 91:99-164)
       ν = (Cs·Δ)²·|S|, Cs = 0,17 (Lilly 1967, IBM Scientific Computing
       Symposium on Environmental Sciences), Δ = √(dx·dy), glissement
       libre contre le sec ;
     · retenue en réservoir à niveau horizontal (« level-pool routing »,
       Fread 1988, NWS BREACH / DAMBRK) : volume V, hauteur h0, section
       prismatique (niveau = zf + h0·Vrestant/V) ; brèche totale et
       instantanée sur toute la largeur de la vallée au pied de l'ouvrage
       (ou sur la longueur de digue connue), niveau de la retenue imposé
       aux pixels de brèche, débit sortant calculé par le schéma ; seul
       l'aval est modélisé : la retenue (cas pire conventionnel zf + h0)
       est hors domaine, sa surface au MNT n'intervient pas ;
     · parement aval de digue : pente plus raide que 1/5 (talus 2H/1V à
       4H/1V, USBR 1987, Design of Small Dams, ch. 6) ; embase ≤ 6 h0 ;
     · validation : essaiRitter() compare le schéma à la solution exacte
       de Ritter (1892), rupture sur fond plat sec sans frottement.
   CONVENTIONS : altitudes, niveaux, hauteurs en m ; temps en s ; pixels
             indexés ligne·W + colonne ; u positive vers l'est (colonnes
             croissantes), v positive vers le sud (lignes croissantes) ;
             U[p] = vitesse de la face est du pixel p, V[p] = face sud ;
             dx par ligne (111 320 m/° × cos lat), dy constant.
   ═══════════════════════════════════════════════════════════════════ */

"use strict";

function BARRAGE_FABRIQUE() {
  "use strict";

  var G = 9.81;
  var H_SEC = 0.01;           /* m : face sèche sous cette lame */
  var H_ARRIVEE = 0.10;       /* m : lame qui date l'arrivée du front */
  var CFL = 0.5;
  var DT_MAX = 10;            /* s */
  var CS_SMAG = 0.17;         /* Lilly 1967 */
  var T_MAX = 48 * 3600;      /* s */
  var T_CALME = 3600;         /* s sans pixel nouveau → fin */
  var T_DEMARRAGE = 30;       /* s : transitoire de la discontinuité initiale exclu du débit de pointe */
  var DT_CLICHE = 60;         /* s : pas initial des clichés de lames */
  var CLICHE_MAX = 6e7;       /* lames stockées au plus (Uint16) ; au-delà un cliché sur deux est retiré */
  var DT_INSTANT_MS = 250;    /* ms réelles entre deux envois « instant » */
  var PAS_ISO = [1, 2, 5, 10, 15, 20, 30, 60, 120];   /* min */
  var ECART_ISO_PX = 10;
  var DEMI_FEN_COURBE = 5;    /* stations de lissage de la tangente */
  var PENTE_PAREMENT = 0.20;  /* USBR 1987 */
  var D_RECHERCHE = 2000;     /* m : écart toléré entre le point de l'ouvrage et son parement */
  var L_LIGNE_MAX = 20000;    /* m : demi-longueur maximale de la ligne de digue */
  var M_MUR = 1, M_MER = 2, M_BORD = 3, M_BRECHE = 4;
  var N_MANNING = 0.020;      /* s·m^(-1/3) : sol nu */

  /* ── geometrieChemin ── E : chemin (pixels), W, dx, dy → T : positions
     (m, y vers le nord), distances cumulées, tangente lissée sur
     ±DEMI_FEN_COURBE → S : {ds, cum, tx, ty}. */
  function geometrieChemin(ch, W, dx, dy) {
    var n = ch.length, x = new Float64Array(n), y = new Float64Array(n), i;
    for (i = 0; i < n; i++) { x[i] = (ch[i] % W) * dx; y[i] = -Math.floor(ch[i] / W) * dy; }
    var ds = new Float64Array(Math.max(1, n - 1)), cum = new Float64Array(n);
    for (i = 0; i < n - 1; i++) { ds[i] = Math.hypot(x[i + 1] - x[i], y[i + 1] - y[i]); cum[i + 1] = cum[i] + ds[i]; }
    var tx = new Float64Array(n), ty = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var i0 = Math.max(0, i - DEMI_FEN_COURBE), i1 = Math.min(n - 1, i + DEMI_FEN_COURBE);
      var ux = x[i1] - x[i0], uy = y[i1] - y[i0], nu = Math.hypot(ux, uy) || 1;
      tx[i] = ux / nu; ty[i] = uy / nu;
    }
    return { ds: ds, cum: cum, tx: tx, ty: ty };
  }

  /* ── brecheLocaliser ── E : {elev, W, dx, dy, chemin, mode, h0} → T :
     ouvrage de bibliothèque : parement = première suite de pas de pente
     < −PENTE_PAREMENT (paliers de ≤ 2 pas tolérés) de dénivelée ≥ h0/2
     sur les 6 h0 + D_RECHERCHE premiers mètres du chemin du robinet ;
     pied = bas du parement ; sans parement repéré : point le plus bas du
     chemin sur 6 h0 ; saisie manuelle : le clic ; zf = z(pied) ; sens
     de l'écoulement = tangente du chemin au pied → S : {pied, zf, tx, ty,
     parement}. */
  function brecheLocaliser(E) {
    var z = E.elev, ch = E.chemin, np = ch.length, geo = geometrieChemin(ch, E.W, E.dx, E.dy);
    var iP = 0, parement = false, k;
    if (E.mode === 'bib') {
      var pente = function (q) { return (z[ch[q + 1]] - z[ch[q]]) / Math.max(geo.ds[q], 1); };
      k = 0;
      var dScan = 6 * E.h0 + D_RECHERCHE;
      while (k < np - 1 && geo.cum[k] <= dScan && !parement) {
        if (pente(k) >= -PENTE_PAREMENT) { k++; continue; }
        var deb = k, finS = k + 1, j2 = k + 1, palier = 0;
        while (j2 < np - 1) {
          if (pente(j2) < -PENTE_PAREMENT) { palier = 0; finS = j2 + 1; }
          else if (++palier > 2) break;
          j2++;
        }
        if (z[ch[deb]] - z[ch[finS]] >= E.h0 / 2) { parement = true; iP = finS; }
        k = finS;
      }
      if (!parement) for (k = 1; k < np && geo.cum[k] <= 6 * E.h0; k++) if (z[ch[k]] < z[ch[iP]]) iP = k;
    }
    return { pied: ch[iP], zf: z[ch[iP]], tx: geo.tx[iP], ty: geo.ty[iP], parement: parement };
  }

  /* ── brecheTracer ── E : z, W, H, dxR, dy, brèche localisée, zres,
     longueur de digue (m, 0 = inconnue), masque → T : ligne de digue
     perpendiculaire à l'écoulement passant par le pied, pixellisée en
     4-connexité (étanche pour un schéma à 4 faces), parcourue de chaque
     côté jusqu'au premier pixel de sol ≥ zres (appui) ; pixels de brèche
     = pixels de la ligne sous zres, contigus au pied, à moins de L/2 si
     L est connue ; autres pixels de la ligne = murs → S : {B Int32
     (pixels de brèche), Bd (m)}. */
  function brecheTracer(z, W, H, dxR, dy, br, zres, Ldig, masque) {
    var r0 = Math.floor(br.pied / W), c0 = br.pied - r0 * W;
    var dc = -br.ty, dr = -br.tx;           /* normale (−ty, tx) en repère nord → lignes vers le sud */
    var B = [br.pied], dMax = 0;
    for (var sgn = -1; sgn <= 1; sgn += 2) {
      var prec = br.pied, breche = true;
      for (var k = 1; ; k++) {
        var s = 0.25 * k, c = Math.round(c0 + sgn * s * dc), r = Math.round(r0 + sgn * s * dr);
        if (r < 0 || r >= H || c < 0 || c >= W) break;
        var q = r * W + c; if (q === prec) continue;
        var pr = Math.floor(prec / W), pc = prec - pr * W, cand = [];
        if (pr !== r && pc !== c) cand.push(pr * W + c);
        cand.push(q);
        var arret = false;
        for (var j = 0; j < cand.length; j++) {
          var e = cand[j], er = Math.floor(e / W), ec = e - er * W;
          var d = Math.hypot((ec - c0) * dxR[r0], (er - r0) * dy);
          if (z[e] >= zres || d > L_LIGNE_MAX) { masque[e] = M_MUR; arret = true; break; }
          if (breche && (Ldig <= 0 || d <= Ldig / 2)) { B.push(e); if (d > dMax) dMax = d; }
          else { breche = false; masque[e] = M_MUR; }
        }
        prec = q;
        if (arret) break;
      }
    }
    for (var i = 0; i < B.length; i++) masque[B[i]] = M_BRECHE;
    return { B: Int32Array.from(B), Bd: Math.max(Math.sqrt(dxR[r0] * dy), 2 * dMax + Math.sqrt(dxR[r0] * dy)) };
  }

  /* ── retenueExclure ── E : z, W, H, dxR, dy, brèche localisée, zres,
     masque (ligne de digue déjà posée) → T : germe = premier pixel libre
     sous zres en remontant la tangente depuis le pied (corps de digue
     sauté, au plus D_RECHERCHE) ; remplissage 4-connexe des pixels libres
     sous zres du demi-plan amont de la ligne, marqués murs : la retenue
     est une réserve virtuelle au niveau du cas pire conventionnel, hors
     domaine ; l'onde aval ne peut ni l'envahir ni s'y étaler → S : nombre
     de pixels exclus (0 si aucun germe). */
  function retenueExclure(z, W, H, dxR, dy, br, zres, masque) {
    var r0 = Math.floor(br.pied / W), c0 = br.pied - r0 * W, dx0 = dxR[r0];
    var amont = function (r, c) { return (c - c0) * dx0 * br.tx - (r - r0) * dy * br.ty < 0; };
    var pas = 0.5 * Math.min(dx0, dy), germe = -1;
    for (var s = pas; s <= D_RECHERCHE; s += pas) {
      var c = Math.round(c0 - s * br.tx / dx0), r = Math.round(r0 + s * br.ty / dy);
      if (r < 0 || r >= H || c < 0 || c >= W) break;
      var q = r * W + c;
      if (masque[q] === 0 && z[q] < zres) { germe = q; break; }
    }
    if (germe < 0) return 0;
    var pile = [germe], n = 0;
    masque[germe] = M_MUR;
    while (pile.length) {
      var p = pile.pop(), pr = (p / W) | 0, pc = p - pr * W; n++;
      var vs = [pc > 0 ? p - 1 : -1, pc < W - 1 ? p + 1 : -1, pr > 0 ? p - W : -1, pr < H - 1 ? p + W : -1];
      for (var j = 0; j < 4; j++) {
        var v = vs[j]; if (v < 0 || masque[v] !== 0 || z[v] >= zres) continue;
        var vr = (v / W) | 0; if (!amont(vr, v - vr * W)) continue;
        masque[v] = M_MUR; pile.push(v);
      }
    }
    return n;
  }

  /* ── Grille ── E : z, W, H, dxR (m par ligne), dy, masque (M_MUR,
     M_MER, M_BORD, M_BRECHE ou 0), ferme (bit 1 face est, bit 2 face sud
     fermées) → T : état h (Float64), U, V (faces est et sud), flux par
     unité de largeur QX, QY, liste des pixels actifs (mouillés et leurs
     4 voisins) ; pas(dt) = continuité puis quantité de mouvement →
     S : objet grille. */
  function Grille(z, W, H, dxR, dy, masque, ferme) {
    var N = W * H;
    this.z = z; this.W = W; this.H = H; this.dxR = dxR; this.dy = dy;
    this.m = masque; this.f = ferme;
    this.h = new Float64Array(N);
    this.U = new Float32Array(N); this.V = new Float32Array(N);
    this.Un = new Float32Array(N); this.Vn = new Float32Array(N);
    this.QX = new Float32Array(N); this.QY = new Float32Array(N);
    this.fac = new Float32Array(N);
    this.etat = new Uint8Array(N);          /* 0 inactif, 1 actif, 2 actif et voisins activés */
    this.L = new Int32Array(1 << 16); this.nL = 0;
    this.wS = new Float64Array(H);          /* largeur des faces sud (m) */
    this.aire = new Float64Array(H);
    for (var r = 0; r < H; r++) {
      this.wS[r] = r < H - 1 ? 0.5 * (dxR[r] + dxR[r + 1]) : dxR[r];
      this.aire[r] = dxR[r] * dy;
    }
    this.nuMax = 0;
    this.n2 = 0;                            /* n² de Manning (0 : sans frottement) */
  }
  /* E : pixel → T : ajout à la liste active (doublement) → S : aucune. */
  Grille.prototype.activer = function (p) {
    if (this.etat[p] || this.m[p] === M_MUR) return;
    if (this.nL === this.L.length) { var n = new Int32Array(this.nL * 2); n.set(this.L); this.L = n; }
    this.etat[p] = 1; this.L[this.nL++] = p;
  };
  /* E : pixel mouillé → T : active ses 4 voisins → S : aucune. */
  Grille.prototype.voisins = function (p) {
    var W = this.W, r = (p / W) | 0, c = p - r * W;
    this.etat[p] = 2;
    if (c > 0) this.activer(p - 1);
    if (c < W - 1) this.activer(p + 1);
    if (r > 0) this.activer(p - W);
    if (r < this.H - 1) this.activer(p + W);
  };
  /* E : pixel, face ('x' est, 'y' sud) → T : face hors grille, touchant un
     mur ou fermée → S : booléen. */
  Grille.prototype.fermeeX = function (p, c) {
    return c >= this.W - 1 || (this.f[p] & 1) || this.m[p] === M_MUR || this.m[p + 1] === M_MUR;
  };
  Grille.prototype.fermeeY = function (p, r) {
    return r >= this.H - 1 || (this.f[p] & 2) || this.m[p] === M_MUR || this.m[p + this.W] === M_MUR;
  };

  /* ── dtCFL ── E : état → T : pas de Courant ≤ CFL sur les pixels
     mouillés, (|u| + c)/dx + (|v| + c)/dy, c = √(g·h) ; stabilité de la
     viscosité explicite dt ≤ Δ²/(8·νmax) ; plafond DT_MAX → S : dt (s). */
  Grille.prototype.dtCFL = function () {
    var dt = DT_MAX, W = this.W, h = this.h, U = this.U, V = this.V, L = this.L;
    for (var k = 0; k < this.nL; k++) {
      var p = L[k]; if (h[p] < H_SEC) continue;
      var r = (p / W) | 0, c = p - r * W, ce = Math.sqrt(G * h[p]);
      var uu = Math.max(Math.abs(U[p]), c > 0 ? Math.abs(U[p - 1]) : 0);
      var vv = Math.max(Math.abs(V[p]), r > 0 ? Math.abs(V[p - W]) : 0);
      var inv = (uu + ce) / this.dxR[r] + (vv + ce) / this.dy;
      if (CFL / inv < dt) dt = CFL / inv;
    }
    if (this.nuMax > 0) {
      var d2 = Math.min(this.dxR[0], this.dxR[this.H - 1], this.dy); d2 *= d2;
      if (d2 / (8 * this.nuMax) < dt) dt = d2 / (8 * this.nuMax);
    }
    return dt;
  };

  /* ── continuite ── E : dt → T : (1) flux de face q = u·ĥ, ĥ = niveau du
     pixel amont (sens de u) moins le seuil de face max(z gauche, z
     droit), nul si négatif ; (2) limiteur de positivité : les flux
     sortant d'un pixel sont réduits si leur volume dépasse l'eau
     disponible ; (3) bilan volumique de chaque pixel actif → S : aucune
     (h, QX, QY à jour). */
  Grille.prototype.continuite = function (dt) {
    var W = this.W, z = this.z, h = this.h, U = this.U, V = this.V;
    var QX = this.QX, QY = this.QY, fac = this.fac, L = this.L, nL = this.nL, dy = this.dy, k, p, r, c, u, up, hf;
    for (k = 0; k < nL; k++) fac[L[k]] = 0;
    for (k = 0; k < nL; k++) {
      p = L[k]; r = (p / W) | 0; c = p - r * W;
      if (this.fermeeX(p, c)) QX[p] = 0;
      else {
        u = U[p]; up = u > 0 ? p : p + 1;
        hf = u === 0 ? 0 : z[up] + h[up] - Math.max(z[p], z[p + 1]);
        QX[p] = hf > 0 ? u * hf : 0;
        if (QX[p] > 0) fac[p] += QX[p] * dy; else if (QX[p] < 0) fac[p + 1] -= QX[p] * dy;
      }
      if (this.fermeeY(p, r)) QY[p] = 0;
      else {
        u = V[p]; up = u > 0 ? p : p + W;
        hf = u === 0 ? 0 : z[up] + h[up] - Math.max(z[p], z[p + W]);
        QY[p] = hf > 0 ? u * hf : 0;
        if (QY[p] > 0) fac[p] += QY[p] * this.wS[r]; else if (QY[p] < 0) fac[p + W] -= QY[p] * this.wS[r];
      }
    }
    for (k = 0; k < nL; k++) {
      p = L[k]; r = (p / W) | 0;
      var sortie = fac[p] * dt, dispo = h[p] * this.aire[r];
      fac[p] = sortie > dispo ? dispo / sortie : 1;
    }
    for (k = 0; k < nL; k++) {
      p = L[k];
      if (QX[p] > 0) QX[p] *= fac[p]; else if (QX[p] < 0) QX[p] *= fac[p + 1];
      if (QY[p] > 0) QY[p] *= fac[p]; else if (QY[p] < 0) QY[p] *= fac[p + W];
    }
    for (k = 0; k < nL; k++) {
      p = L[k]; r = (p / W) | 0; c = p - r * W;
      var bil = -QX[p] * dy - QY[p] * this.wS[r];
      if (c > 0) bil += QX[p - 1] * dy;
      if (r > 0) bil += QY[p - W] * this.wS[r - 1];
      var hn = h[p] + dt * bil / this.aire[r];
      h[p] = hn > 0 ? hn : 0;
    }
  };

  /* ── mouvement ── E : dt, h et flux de ce pas → T : pour chaque face
     mouillée (niveau max − seuil ≥ H_SEC) : advection conservative
     longitudinale [(q̄R·u*R − q̄L·u*L) − u·(q̄R − q̄L)] / (h̄·Δx) et
     transverse sous la même forme avec les flux des faces voisines, u*
     pris en amont selon le signe du flux ; pente de surface g·Δ(h+z)/Δx ;
     viscosité de Smagorinsky ν·∇²u, voisins secs remplacés par la face
     elle-même (glissement libre) ; face sèche → vitesse nulle → S :
     U, V du pas suivant, νmax. */
  Grille.prototype.mouvement = function (dt) {
    var W = this.W, H = this.H, z = this.z, h = this.h, U = this.U, V = this.V, Un = this.Un, Vn = this.Vn;
    var QX = this.QX, QY = this.QY, L = this.L, nL = this.nL, dy = this.dy, nuMax = 0;
    for (var k = 0; k < nL; k++) {
      var p = L[k], r = (p / W) | 0, c = p - r * W, dx = this.dxR[r];
      var D = Math.sqrt(dx * dy), C2 = (CS_SMAG * D) * (CS_SMAG * D);
      /* face est : p | q */
      if (this.fermeeX(p, c)) Un[p] = 0;
      else {
        var q = p + 1, zp = z[p] + h[p], zq = z[q] + h[q];
        if (Math.max(zp, zq) - Math.max(z[p], z[q]) < H_SEC) Un[p] = 0;
        else {
          var u = U[p], hx = 0.5 * (h[p] + h[q]);
          var uw = c > 0 ? U[p - 1] : u, ue = c + 1 < W - 1 ? U[q] : u;
          var un = r > 0 ? U[p - W] : u, us = r < H - 1 ? U[p + W] : u;
          var adv = 0;
          if (hx > H_SEC) {
            var qcL = 0.5 * ((c > 0 ? QX[p - 1] : 0) + QX[p]), qcR = 0.5 * (QX[p] + (c + 1 < W - 1 ? QX[q] : 0));
            var usL = qcL > 0 ? uw : u, usR = qcR > 0 ? u : ue;
            var qyN = r > 0 ? 0.5 * (QY[p - W] + QY[q - W]) : 0, qyS = r < H - 1 ? 0.5 * (QY[p] + QY[q]) : 0;
            var usN = qyN > 0 ? un : u, usS = qyS > 0 ? u : us;
            adv = ((qcR * usR - qcL * usL) - u * (qcR - qcL)) / (hx * dx) +
                  ((qyS * usS - qyN * usN) - u * (qyS - qyN)) / (hx * dy);
          }
          /* Smagorinsky */
          var mw = c > 0 && (h[p - 1] > H_SEC || h[p] > H_SEC), me = c + 1 < W - 1 && (h[q] > H_SEC || h[q + 1] > H_SEC);
          var mn = r > 0 && (h[p - W] > H_SEC || h[q - W] > H_SEC), ms = r < H - 1 && (h[p + W] > H_SEC || h[q + W] > H_SEC);
          var aW = mw ? uw : u, aE = me ? ue : u, aN = mn ? un : u, aS = ms ? us : u;
          var vcp = 0.5 * (V[p] + (r > 0 ? V[p - W] : V[p])), vcq = 0.5 * (V[q] + (r > 0 ? V[q - W] : V[q]));
          var ux = (aE - aW) / (2 * dx), uy = (aS - aN) / (2 * dy), vx = (vcq - vcp) / dx;
          var vy = 0.5 * ((V[p] + V[q]) - (r > 0 ? V[p - W] + V[q - W] : V[p] + V[q])) / dy;
          var nu = C2 * Math.sqrt(2 * ux * ux + 2 * vy * vy + (uy + vx) * (uy + vx));
          if (nu > nuMax) nuMax = nu;
          var lap = (aE - 2 * u + aW) / (dx * dx) + (aS - 2 * u + aN) / (dy * dy);
          Un[p] = u - dt * (adv + G * (zq - zp) / dx - nu * lap);
          if (this.n2 > 0) {
            var hfx = Math.max(zp, zq) - Math.max(z[p], z[q]), vtx = 0.5 * (vcp + vcq);
            Un[p] /= 1 + dt * G * this.n2 * Math.sqrt(u * u + vtx * vtx) / Math.pow(hfx, 4 / 3);
          }
        }
      }
      /* face sud : p | s */
      if (this.fermeeY(p, r)) Vn[p] = 0;
      else {
        var s = p + W, zp2 = z[p] + h[p], zs = z[s] + h[s];
        if (Math.max(zp2, zs) - Math.max(z[p], z[s]) < H_SEC) Vn[p] = 0;
        else {
          var v = V[p], hy = 0.5 * (h[p] + h[s]), wf = this.wS[r];
          var vn = r > 0 ? V[p - W] : v, vs = r + 1 < H - 1 ? V[s] : v;
          var vw = c > 0 ? V[p - 1] : v, ve = c < W - 1 ? V[p + 1] : v;
          var adv2 = 0;
          if (hy > H_SEC) {
            var qcN = 0.5 * ((r > 0 ? QY[p - W] : 0) + QY[p]), qcS = 0.5 * (QY[p] + (r + 1 < H - 1 ? QY[s] : 0));
            var vsN = qcN > 0 ? vn : v, vsS = qcS > 0 ? v : vs;
            var qxW = c > 0 ? 0.5 * (QX[p - 1] + QX[s - 1]) : 0, qxE = c < W - 1 ? 0.5 * (QX[p] + QX[s]) : 0;
            var vsW = qxW > 0 ? vw : v, vsE = qxE > 0 ? v : ve;
            adv2 = ((qcS * vsS - qcN * vsN) - v * (qcS - qcN)) / (hy * dy) +
                   ((qxE * vsE - qxW * vsW) - v * (qxE - qxW)) / (hy * wf);
          }
          var mn2 = r > 0 && (h[p - W] > H_SEC || h[p] > H_SEC), ms2 = r + 1 < H - 1 && (h[s] > H_SEC || h[s + W] > H_SEC);
          var mw2 = c > 0 && (h[p - 1] > H_SEC || h[s - 1] > H_SEC), me2 = c < W - 1 && (h[p + 1] > H_SEC || h[s + 1] > H_SEC);
          var bN = mn2 ? vn : v, bS = ms2 ? vs : v, bW = mw2 ? vw : v, bE = me2 ? ve : v;
          var ucp = 0.5 * (U[p] + (c > 0 ? U[p - 1] : U[p])), ucs = 0.5 * (U[s] + (c > 0 ? U[s - 1] : U[s]));
          var vy2 = (bS - bN) / (2 * dy), vx2 = (bE - bW) / (2 * wf), uy2 = (ucs - ucp) / dy;
          var ux2 = 0.5 * ((U[p] + U[s]) - (c > 0 ? U[p - 1] + U[s - 1] : U[p] + U[s])) / wf;
          var nu2 = C2 * Math.sqrt(2 * ux2 * ux2 + 2 * vy2 * vy2 + (uy2 + vx2) * (uy2 + vx2));
          if (nu2 > nuMax) nuMax = nu2;
          var lap2 = (bS - 2 * v + bN) / (dy * dy) + (bE - 2 * v + bW) / (wf * wf);
          Vn[p] = v - dt * (adv2 + G * (zs - zp2) / dy - nu2 * lap2);
          if (this.n2 > 0) {
            var hfy = Math.max(zp2, zs) - Math.max(z[p], z[s]), uty = 0.5 * (ucp + ucs);
            Vn[p] /= 1 + dt * G * this.n2 * Math.sqrt(v * v + uty * uty) / Math.pow(hfy, 4 / 3);
          }
        }
      }
    }
    var t1 = this.U; this.U = Un; this.Un = t1;
    var t2 = this.V; this.V = Vn; this.Vn = t2;
    this.nuMax = nuMax;
  };

  /* ── calcul ── E : {elev, W, H, dy, dxR (m par ligne), chemin (robinet,
     sert à trouver le pied), fin, mode ('bib'|'manuel'), V (m³), h0 (m),
     Ldigue (m, 0 = inconnue)}, envoyer(message, transferts) → T : pied et
     ligne de digue ; masque (murs : sans donnée, ligne de digue, retenue
     amont hors domaine (retenueExclure) ; puits :
     mer z ≤ 0,5 m et bords de grille, l'eau qui y entre sort du domaine) ;
     faces amont des pixels de brèche fermées ; réservoir à niveau
     horizontal ; intégration jusqu'à T_CALME sans pixel nouveau ; date
     d'arrivée (lame ≥ H_ARRIVEE), lame et vitesse maximales ; front =
     pixel atteint le plus éloigné du pied ; clichés des lames ; isochrones
     (pas de 1 min allongé tant que le front avance de moins de
     ECART_ISO_PX pixels) → S : {arr Float32 (s, −1 sec), iso [{t, pas, px,
     lab, trans}], wp (pixels atteints, ordre d'arrivée), wh, wv (lame et
     vitesse maximales), snapT, snapOff, snapData (lames en cm), info} ;
     frottement de Manning N_MANNING sur toute la grille. */
  function calcul(E, envoyer) {
    var z = E.elev, W = E.W, H = E.H, dy = E.dy, dxR = E.dxR, N = W * H, p, i, k;
    var br = brecheLocaliser({ elev: z, W: W, dx: dxR[Math.floor(H / 2)], dy: dy, chemin: E.chemin, mode: E.mode, h0: E.h0 });
    var zf = br.zf, zres = zf + E.h0;
    var masque = new Uint8Array(N), ferme = new Uint8Array(N);
    for (p = 0; p < N; p++) {
      var v0 = z[p], r0 = (p / W) | 0, c0 = p - r0 * W;
      if (v0 >= 9000) masque[p] = M_MUR;
      else if (v0 <= 0.5) masque[p] = M_MER;
      else if (r0 === 0 || c0 === 0 || r0 === H - 1 || c0 === W - 1) masque[p] = M_BORD;
    }
    var lig = brecheTracer(z, W, H, dxR, dy, br, zres, E.Ldigue || 0, masque);
    var B = lig.B, nB = B.length;
    var nRetenue = retenueExclure(z, W, H, dxR, dy, br, zres, masque);
    /* faces amont des pixels de brèche : produit scalaire (Δcol, −Δlig)·t < 0 */
    for (i = 0; i < nB; i++) {
      var b = B[i], rb = (b / W) | 0, cb = b - rb * W;
      if (cb < W - 1 && masque[b + 1] !== M_BRECHE && br.tx < 0) ferme[b] |= 1;
      if (cb > 0 && masque[b - 1] !== M_BRECHE && -br.tx < 0) ferme[b - 1] |= 1;
      if (rb < H - 1 && masque[b + W] !== M_BRECHE && -br.ty < 0) ferme[b] |= 2;
      if (rb > 0 && masque[b - W] !== M_BRECHE && br.ty < 0) ferme[b - W] |= 2;
    }
    var Gr = new Grille(z, W, H, dxR, dy, masque, ferme), h = Gr.h;
    Gr.n2 = N_MANNING * N_MANNING;
    var Vres = E.V, niv = zres, airePix = function (q) { return Gr.aire[(q / W) | 0]; };
    for (i = 0; i < nB; i++) { h[B[i]] = Math.max(0, niv - z[B[i]]); Gr.activer(B[i]); }
    for (i = 0; i < nB; i++) Gr.voisins(B[i]);

    var arr = new Float32Array(N).fill(-1), hMax = new Float32Array(N), vMax = new Float32Array(N);
    var capW = 1 << 16, nW = 0, wp = new Int32Array(capW);
    var rP = Math.floor(br.pied / W), cP = br.pied - rP * W, dxP = dxR[rP];
    var Rmax = 0, pixFront = br.pied, frontMin = [0], frontPix = [br.pied];
    var tDernier = 0, qMax = 0, qCour = 0, perduMer = 0, perduBord = 0, fin = '';
    var pixM = Math.sqrt(dxP * dy);

    /* clichés */
    var snaps = [], snapT = [], nSnapTot = 0, dtCli = DT_CLICHE;
    /* E : instant → T : lames (cm) des pixels atteints ; au-delà de
       CLICHE_MAX lames stockées, un cliché sur deux est retiré et le pas
       doublé → S : aucune. */
    function cliche(t) {
      var d = new Uint16Array(nW);
      for (var j = 0; j < nW; j++) { var x = Math.round(h[wp[j]] * 100); d[j] = x > 65535 ? 65535 : x; }
      snaps.push(d); snapT.push(t); nSnapTot += nW;
      if (nSnapTot > CLICHE_MAX) {
        var s2 = [], t2 = []; nSnapTot = 0;
        for (var j2 = 0; j2 < snaps.length; j2 += 2) { s2.push(snaps[j2]); t2.push(snapT[j2]); nSnapTot += snaps[j2].length; }
        snaps = s2; snapT = t2; dtCli *= 2;
      }
    }
    var nEnv = 0;
    /* E : instant → T : pixels atteints depuis le dernier envoi, lames
       courantes (cm) de tous les pixels atteints, front, débit de brèche,
       part restante de la retenue → S : message « instant ». */
    function instant(t) {
      var mp = wp.slice(nEnv, nW), ma = new Float32Array(mp.length), pr = new Uint16Array(nW);
      for (var j = 0; j < mp.length; j++) ma[j] = arr[mp[j]];
      for (j = 0; j < nW; j++) { var x = Math.round(h[wp[j]] * 100); pr[j] = x > 65535 ? 65535 : x; }
      nEnv = nW;
      envoyer({ type: 'instant', t: t, frontKm: Rmax / 1000, q: qCour, reste: Math.max(0, Vres) / E.V, p: mp, a: ma, prof: pr },
              [mp.buffer, ma.buffer, pr.buffer]);
    }

    var t = 0, mesure = Date.now();
    cliche(0);
    while (t < T_MAX) {
      var dt = Gr.dtCFL();
      Gr.continuite(dt);
      /* retenue : volume sorti par la brèche, nouveau niveau imposé */
      var sorti = 0;
      for (i = 0; i < nB; i++) { var bb = B[i]; sorti += (Math.max(0, niv - z[bb]) - h[bb]) * airePix(bb); }
      Vres -= sorti; if (Vres < 0) Vres = 0;
      niv = zf + E.h0 * Vres / E.V;
      for (i = 0; i < nB; i++) h[B[i]] = Math.max(0, niv - z[B[i]]);
      qCour = sorti / dt;
      t += dt;
      if (t >= T_DEMARRAGE && qCour > qMax) qMax = qCour;
      /* puits, arrivées, maxima, activation */
      var nL = Gr.nL, L = Gr.L, U = Gr.U, V = Gr.V;
      for (k = 0; k < nL; k++) {
        p = L[k]; var hp = h[p]; if (hp <= 0) continue;
        var mk = masque[p];
        if (mk === M_MER || mk === M_BORD) {
          if (mk === M_MER) { perduMer += hp * airePix(p); if (!fin) fin = 'mer'; }
          else { perduBord += hp * airePix(p); if (!fin) fin = 'bord'; }
          h[p] = 0; continue;
        }
        if (hp > H_SEC && Gr.etat[p] === 1) Gr.voisins(p);
        if (hp >= H_ARRIVEE) {
          if (arr[p] < 0) {
            arr[p] = t; tDernier = t;
            if (nW === capW) { capW *= 2; var nw = new Int32Array(capW); nw.set(wp); wp = nw; }
            wp[nW++] = p;
            var rr = (p / W) | 0, cc = p - rr * W, dd = Math.hypot((cc - cP) * dxP, (rr - rP) * dy);
            if (dd > Rmax) { Rmax = dd; pixFront = p; }
          }
          if (hp > hMax[p]) hMax[p] = hp;
          var rq = (p / W) | 0, cq = p - rq * W;
          var uc = 0.5 * (U[p] + (cq > 0 ? U[p - 1] : U[p])), vc = 0.5 * (V[p] + (rq > 0 ? V[p - W] : V[p]));
          var sp = Math.sqrt(uc * uc + vc * vc); if (sp > vMax[p]) vMax[p] = sp;
        }
      }
      Gr.mouvement(dt);
      while (frontMin.length * 60 <= t) { frontMin.push(Rmax); frontPix.push(pixFront); }
      if (t - snapT[snapT.length - 1] >= dtCli) cliche(t);
      if (t > 600 && t - tDernier > T_CALME) break;
      if (Date.now() - mesure > DT_INSTANT_MS) { mesure = Date.now(); instant(t); }
    }
    instant(t);
    var tFin = t;

    /* isochrones : plus petit pas de PAS_ISO, jamais inférieur au pas
       précédent, donnant ≥ ECART_ISO_PX pixels d'avancée du front */
    var nMin = frontMin.length - 1, choix = [], dern = 0, pasPrec = 0;
    while (dern < nMin) {
      var pris = 0;
      for (var k2 = 0; k2 < PAS_ISO.length; k2++) {
        if (PAS_ISO[k2] < pasPrec) continue;
        var cand = dern + PAS_ISO[k2]; if (cand > nMin) break;
        if ((frontMin[cand] - frontMin[dern]) / pixM >= ECART_ISO_PX) { pris = PAS_ISO[k2]; break; }
      }
      if (!pris) { pris = PAS_ISO[PAS_ISO.length - 1]; if (dern + pris > nMin) break; }
      dern += pris;
      choix.push({ t: dern * 60, pas: pris, trans: pris !== pasPrec });
      pasPrec = pris;
    }
    var nI = choix.length, tI = new Float64Array(nI);
    for (i = 0; i < nI; i++) tI[i] = choix[i].t;
    var seaux = []; for (i = 0; i < nI; i++) seaux.push([]);
    for (i = 0; i < nW; i++) {
      p = wp[i]; var ap = arr[p], r = (p / W) | 0, c4 = p - r * W, aq = -1;
      var vs = [r > 0 ? p - W : -1, r < H - 1 ? p + W : -1, c4 > 0 ? p - 1 : -1, c4 < W - 1 ? p + 1 : -1];
      for (var v4 = 0; v4 < 4; v4++) { var qq = vs[v4]; if (qq >= 0 && arr[qq] > ap && arr[qq] > aq) aq = arr[qq]; }
      if (aq < 0) continue;
      var lo2 = 0, hi2 = nI;
      while (lo2 < hi2) { var mi2 = (lo2 + hi2) >> 1; if (tI[mi2] < ap) lo2 = mi2 + 1; else hi2 = mi2; }
      for (var kI = lo2; kI < nI && tI[kI] < aq; kI++) seaux[kI].push(p);
    }
    var iso = [];
    for (i = 0; i < nI; i++) iso.push({ t: tI[i], pas: choix[i].pas, trans: choix[i].trans, px: Int32Array.from(seaux[i]), lab: frontPix[Math.round(tI[i] / 60)] });

    var wpF = wp.slice(0, nW), wh = new Float32Array(nW), wv = new Float32Array(nW);
    for (i = 0; i < nW; i++) { wh[i] = hMax[wpF[i]]; wv[i] = vMax[wpF[i]]; }
    var snapOff = new Float64Array(snaps.length + 1);
    for (i = 0; i < snaps.length; i++) snapOff[i + 1] = snapOff[i] + snaps[i].length;
    var snapData = new Uint16Array(snapOff[snaps.length]);
    for (i = 0; i < snaps.length; i++) snapData.set(snaps[i], snapOff[i]);
    return {
      arr: arr, iso: iso, wp: wpF, wh: wh, wv: wv,
      snapT: Float64Array.from(snapT), snapOff: snapOff, snapData: snapData,
      info: {
        zres: zres, zf: zf, Bd: lig.Bd, nBreche: nB, qMax: qMax, tFin: tFin, V0: E.V, Vreste: Vres,
        perduMer: perduMer, perduBord: perduBord, fin: fin, frontKm: Rmax / 1000, frontMin: frontMin,
        nMouilles: nW, breche: br.pied, parement: br.parement, mode: E.mode,
        nRetenue: nRetenue, manning: N_MANNING
      }
    };
  }

  /* ── essaiRitter ── E : h0 (m), longueur du bief (m), durée t (s),
     taille de maille dx (m) → T : canal plat à parois (3 lignes, murs
     haut et bas), retenue h0 sur la moitié gauche, sec à droite, sans
     viscosité, intégration par le même schéma ; solution de Ritter
     (1892) : h = 4/9 h0 au droit du barrage ; profil h = (2c0 − x/t)²/9g,
     d'où la lame H_ARRIVEE à x = (2c0 − 3·√(g·H_ARRIVEE))·t, c0 = √(g h0)
     → S : {hBarrage, hRitter (4/9 h0), xFront (m, dernière maille ≥
     H_ARRIVEE), xRitter, masse (écart relatif)}. */
  function essaiRitter(h0, Lbief, t, dx) {
    h0 = h0 || 10; Lbief = Lbief || 20000; t = t || 60; dx = dx || 10;
    var W = Math.round(2 * Lbief / dx), H = 3, N = W * H, z = new Float32Array(N), m = new Uint8Array(N), f = new Uint8Array(N);
    for (var c = 0; c < W; c++) { m[c] = M_MUR; m[2 * W + c] = M_MUR; }
    var dxR = new Float64Array(H).fill(dx), Gr = new Grille(z, W, H, dxR, dx, m, f), c0 = Math.floor(W / 2), V0 = 0;
    for (c = 0; c < W; c++) { var p = W + c; Gr.activer(p); if (c < c0) { Gr.h[p] = h0; V0 += h0; } }
    var sauveCS = CS_SMAG; CS_SMAG = 0;
    var tt = 0;
    while (tt < t) {
      var dt = Math.min(Gr.dtCFL(), t - tt);
      Gr.continuite(dt);
      for (var k = 0; k < Gr.nL; k++) { var q = Gr.L[k]; if (Gr.h[q] > H_SEC && Gr.etat[q] === 1) Gr.voisins(q); }
      Gr.mouvement(dt); tt += dt;
    }
    CS_SMAG = sauveCS;
    var xf = 0, V1 = 0;
    for (c = 0; c < W; c++) { V1 += Gr.h[W + c]; if (Gr.h[W + c] >= H_ARRIVEE) xf = (c + 0.5 - c0) * dx; }
    return { hBarrage: 0.5 * (Gr.h[W + c0 - 1] + Gr.h[W + c0]), hRitter: 4 / 9 * h0,
             xFront: xf, xRitter: (2 * Math.sqrt(G * h0) - 3 * Math.sqrt(G * H_ARRIVEE)) * t, masse: (V1 - V0) / V0 };
  }

  return { calcul: calcul, essaiRitter: essaiRitter };
}

/* ── BARRAGEWORKER ── lanceur : un Worker dont la source est
   BARRAGE_FABRIQUE.toString() ; repli dans le fil principal si Worker
   indisponible. */
const BARRAGEWORKER = (function () {
  var _w = null;

  /* ── source ── E : aucune → T : fabrique + onmessage (calcul, messages
     « instant » puis « fin » avec tampons transférés, « erreur ») → S :
     texte du Worker. */
  function source() {
    return 'var BARRAGE=(' + BARRAGE_FABRIQUE.toString() + ')();\n' +
      'onmessage=function(e){try{var R=BARRAGE.calcul(e.data,function(m,tr){postMessage(m,tr||[]);});' +
      'var tr=[R.arr.buffer,R.wp.buffer,R.wh.buffer,R.wv.buffer,R.snapT.buffer,R.snapOff.buffer,R.snapData.buffer];' +
      'R.iso.forEach(function(i){tr.push(i.px.buffer);});' +
      'postMessage({type:"fin",res:R},tr);}catch(x){postMessage({type:"erreur",msg:String(x&&x.message||x)});}};';
  }

  /* ── lancer ── E : entrées de calcul, rappels message(m) (« instant »),
     fin(res), erreur(msg) → T : arrête un calcul en cours, démarre le
     Worker (ou calcule sur place) → S : aucune. */
  function lancer(E, message, fin, erreur) {
    arreter();
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined') {
      try { fin(BARRAGE_FABRIQUE().calcul(E, function (m) { message(m); })); } catch (x) { erreur(String(x.message || x)); }
      return;
    }
    var url = URL.createObjectURL(new Blob([source()], { type: 'application/javascript' }));
    _w = new Worker(url);
    URL.revokeObjectURL(url);
    _w.onmessage = function (e) {
      var m = e.data;
      if (m.type === 'fin') { arreter(); fin(m.res); }
      else if (m.type === 'erreur') { arreter(); erreur(m.msg); }
      else message(m);
    };
    _w.postMessage(E, [E.elev.buffer]);
  }

  /* ── arreter ── E : aucune → T : termine le Worker actif → S : aucune. */
  function arreter() { if (_w) { _w.terminate(); _w = null; } }

  return { lancer: lancer, arreter: arreter };
})();
