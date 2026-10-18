/* ═══════════════════════════════════════════════════════════════════
   FICHIER : dsm-worker-barrage.js - v27/09/2026
   OBJET   : coulée de lave (calculLave : film mince de Bingham, thermo-
             rhéologie FLOWGO, figeage, voir le bloc COULÉE DE LAVE) et
             onde de rupture instantanée d'un barrage sur la grille du DSM :
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
   EXPOSE  : BARRAGE_FABRIQUE { calcul (onde ou lave selon E.lave),
             essaiRitter, essaiHuppert }, BARRAGEWORKER { lancer, arreter }
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
     · charge solide (Takahashi 2007, « Debris Flow : Mechanics,
       Prediction and Countermeasures », CRC ; formulation 2D de
       Nakatani et al. 2008, Kanako 2D, IJECE 1:62-72) : volume de grains
       par unité d'aire S = C·h transporté avec l'eau (flux amont) ;
       concentration d'équilibre C∞ selon la pente de la surface
       tan θ : lave pierreuse ρ·tanθ/((σ−ρ)(tanφ−tanθ)) au-delà de
       0,138, lave immature 6,7·(idem)² de 0,03 à 0,138, charriage
       (1+5tanθ)·tanθ/(σ/ρ−1)·(1−α0²·τ*c/τ*)(1−α0·√(τ*c/τ*)) en deçà,
       τ*c = 0,04·10^(1,72 tanθ), 0,9·C* au-delà de tanφ ; érosion
       i = δe·(C∞−C)/(C*−C∞)·|V|·h/d, dépôt i = δd·(C∞−C)/C*·|V|,
       δe = 0,0007, δd = 0,05 ; ravinement non traité : ni le relief ni
       la lame ne changent, seule la composition de la lame évolue ;
       résistance de la lave (C ≥ 0,4·C* : |V|·d²/(8h³·(C+(1−C)ρ/σ)·
       ((C* ÷ C)^(1/3)−1)²) ; 0,01 ≤ C < 0,4·C* : |V|·d²/(0,49·h³)),
       jamais inférieure à celle de l'eau claire (Manning) : elle ne
       croît qu'en lame mince, au front et sur les bords ; d = 0,10 m,
       σ = 2650, ρ = 1000 kg/m³, C* = 0,6, tanφ = 0,7 ;
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
  var D_GRAIN = 0.10;         /* m : diamètre représentatif du sol nu */
  var SIGMA = 2650, RHO = 1000;   /* kg/m³ : grains, eau */
  var C_ETOILE = 0.6;         /* concentration du lit (Kanako) */
  var TAN_PHI = 0.7;          /* frottement interne, φ ≈ 35° */
  var DELTA_E = 0.0007, DELTA_D = 0.05;   /* Takahashi 2007 */
  var C_EAU = 0.01;           /* sous ce seuil : écoulement d'eau */
  var C_PLAFOND = 0.9 * C_ETOILE;

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
    this.boue = false;                      /* charge solide active */
    this.S = new Float64Array(N);           /* volume de grains par unité d'aire (m) */
    this.C = new Float32Array(N);           /* concentration volumique */
    this.cMax = new Float32Array(N);
    this.Vero = 0; this.Vdep = 0;           /* m³ de grains pris et déposés */
    this.Vsortie = 0;                       /* m³ de grains sortis (mer, bords, brèche) */
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
    var S = this.S, C = this.C, boue = this.boue;
    if (boue) {
      /* flux de grains = flux d'eau × concentration du pixel amont */
      for (k = 0; k < nL; k++) {
        p = L[k]; r = (p / W) | 0; c = p - r * W;
        var qe = QX[p], qs = QY[p];
        var bs = -qe * (qe > 0 ? C[p] : C[p + 1]) * dy - qs * (qs > 0 ? C[p] : C[p + W]) * this.wS[r];
        if (c > 0) { var qw = QX[p - 1]; bs += qw * (qw > 0 ? C[p - 1] : C[p]) * dy; }
        if (r > 0) { var qn = QY[p - W]; bs += qn * (qn > 0 ? C[p - W] : C[p]) * this.wS[r - 1]; }
        fac[p] = bs;
      }
    }
    for (k = 0; k < nL; k++) {
      p = L[k]; r = (p / W) | 0; c = p - r * W;
      var bil = -QX[p] * dy - QY[p] * this.wS[r];
      if (c > 0) bil += QX[p - 1] * dy;
      if (r > 0) bil += QY[p - W] * this.wS[r - 1];
      var hn = h[p] + dt * bil / this.aire[r];
      h[p] = hn > 0 ? hn : 0;
      if (boue) {
        var sn = S[p] + dt * fac[p] / this.aire[r];
        if (h[p] <= H_SEC) { if (sn > 0) this.Vdep += sn * this.aire[r]; S[p] = 0; C[p] = 0; }
        else { S[p] = sn > 0 ? sn : 0; C[p] = Math.min(S[p] / h[p], C_PLAFOND); }
      }
    }
  };

  /* ── cEquilibre ── E : pente de la surface tan θ, lame h → T : régime
     de Takahashi (2007) : au-delà de tanφ 0,9·C* ; lave pierreuse ;
     lave immature ; charriage (Ashida-Michiue) ; rien sous le seuil
     τ*c → S : concentration d'équilibre C∞. */
  function cEquilibre(t, h) {
    if (t >= TAN_PHI) return C_PLAFOND;
    var x = RHO * t / ((SIGMA - RHO) * (TAN_PHI - t));
    if (t > 0.138) return Math.min(C_PLAFOND, x);
    if (t > 0.03) return 6.7 * x * x;
    if (t <= 0) return 0;
    var ts = RHO * h * t / ((SIGMA - RHO) * D_GRAIN), tc = 0.04 * Math.pow(10, 1.72 * t);
    if (ts <= tc) return 0;
    var a = SIGMA * t / (SIGMA - RHO), a02 = 2 * (0.425 - a) / (1 - a), q = a02 * tc / ts;
    return Math.max(0, (1 + 5 * t) * t / (SIGMA / RHO - 1) * (1 - q) * (1 - Math.sqrt(q)));
  }

  /* ── echange ── E : dt, état après continuité → T : pour chaque pixel
     mouillé hors puits et brèche : pente de la surface (différences
     centrées, voisin sec ou mur remplacé par le pixel), vitesse au
     centre, C∞ ; érosion vers C∞ si C < C∞, dépôt vers C∞ sinon, sans
     dépasser C∞ ; lame et relief inchangés → S : S, C, cMax, Vero,
     Vdep à jour. */
  Grille.prototype.echange = function (dt) {
    if (!this.boue) return;
    var W = this.W, H = this.H, z = this.z, h = this.h, U = this.U, V = this.V, S = this.S, C = this.C, m = this.m;
    for (var k = 0; k < this.nL; k++) {
      var p = this.L[k], hp = h[p]; if (hp <= H_SEC || m[p] !== 0) continue;
      var r = (p / W) | 0, c = p - r * W, dx = this.dxR[r], ep = z[p] + hp;
      var q = p + 1, eE = (c < W - 1 && h[q] > H_SEC && m[q] !== M_MUR) ? z[q] + h[q] : ep;
      q = p - 1; var eW = (c > 0 && h[q] > H_SEC && m[q] !== M_MUR) ? z[q] + h[q] : ep;
      q = p + W; var eS = (r < H - 1 && h[q] > H_SEC && m[q] !== M_MUR) ? z[q] + h[q] : ep;
      q = p - W; var eN = (r > 0 && h[q] > H_SEC && m[q] !== M_MUR) ? z[q] + h[q] : ep;
      var gx = (eE - eW) / (2 * dx), gy = (eS - eN) / (2 * this.dy);
      var uc = 0.5 * (U[p] + (c > 0 ? U[p - 1] : U[p])), vc = 0.5 * (V[p] + (r > 0 ? V[p - W] : V[p]));
      var vit = Math.sqrt(uc * uc + vc * vc); if (vit === 0) continue;
      var ce = cEquilibre(Math.sqrt(gx * gx + gy * gy), hp), cp = S[p] / hp, sn;
      if (cp < ce) sn = Math.min(S[p] + dt * DELTA_E * (ce - cp) / (C_ETOILE - ce) * vit * hp / D_GRAIN * C_ETOILE, ce * hp);
      else sn = Math.max(S[p] + dt * DELTA_D * (ce - cp) * vit, ce * hp);
      var dS = (sn - S[p]) * this.aire[r];
      if (dS > 0) this.Vero += dS; else this.Vdep -= dS;
      S[p] = sn; C[p] = Math.min(sn / hp, C_PLAFOND);
      if (C[p] > this.cMax[p]) this.cMax[p] = C[p];
    }
  };

  /* ── frottement ── E : lame de face ĥ, vitesse |V|, concentration de
     face → T : coefficient a de la décélération a·u : Manning g·n²·|V|/ĥ^(4/3) ;
     lave pierreuse ou immature de Takahashi selon C ; le plus fort des
     deux → S : a (1/s). */
  Grille.prototype.frottement = function (hf, vit, cf) {
    var a = G * this.n2 * vit / Math.pow(hf, 4 / 3);
    if (cf < C_EAU) return a;
    var d2h3 = D_GRAIN * D_GRAIN / (hf * hf * hf), ad;
    if (cf >= 0.4 * C_ETOILE) {
      var e = Math.cbrt(C_ETOILE / cf) - 1;
      ad = vit * d2h3 / (8 * (cf + (1 - cf) * RHO / SIGMA) * e * e);
    } else ad = vit * d2h3 / 0.49;
    return ad > a ? ad : a;
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
            Un[p] /= 1 + dt * this.frottement(hfx, Math.sqrt(u * u + vtx * vtx), 0.5 * (this.C[p] + this.C[q]));
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
            Vn[p] /= 1 + dt * this.frottement(hfy, Math.sqrt(v * v + uty * uty), 0.5 * (this.C[p] + this.C[s]));
          }
        }
      }
    }
    var t1 = this.U; this.U = Un; this.Un = t1;
    var t2 = this.V; this.V = Vn; this.Vn = t2;
    this.nuMax = nuMax;
  };

  /* ── isochrones ── E : dates d'arrivée arr (s), pixels atteints wp[0..nW),
     W, H, portée du front minute par minute frontMin (m) et pixel du front
     frontPix, taille de pixel pixM (m), pas permis (min, croissants) → T :
     plus petit pas, jamais inférieur au pas précédent, donnant au moins
     ECART_ISO_PX pixels d'avancée du front (sinon le plus grand) ; un
     pixel atteint borde l'isochrone t si un voisin est atteint après t
     et lui avant → S : [{t (s), pas (min), trans (changement de pas),
     px Int32 (pixels du front), lab (pixel de l'étiquette)}]. */
  function isochrones(arr, wp, nW, W, H, frontMin, frontPix, pixM, pasIso) {
    var nMin = frontMin.length - 1, choix = [], dern = 0, pasPrec = 0, i;
    while (dern < nMin) {
      var pris = 0;
      for (var k2 = 0; k2 < pasIso.length; k2++) {
        if (pasIso[k2] < pasPrec) continue;
        var cand = dern + pasIso[k2]; if (cand > nMin) break;
        if ((frontMin[cand] - frontMin[dern]) / pixM >= ECART_ISO_PX) { pris = pasIso[k2]; break; }
      }
      if (!pris) { pris = pasIso[pasIso.length - 1]; if (dern + pris > nMin) break; }
      dern += pris;
      choix.push({ t: dern * 60, pas: pris, trans: pris !== pasPrec });
      pasPrec = pris;
    }
    var nI = choix.length, tI = new Float64Array(nI);
    for (i = 0; i < nI; i++) tI[i] = choix[i].t;
    var seaux = []; for (i = 0; i < nI; i++) seaux.push([]);
    for (i = 0; i < nW; i++) {
      var p = wp[i], ap = arr[p], r = (p / W) | 0, c4 = p - r * W, aq = -1;
      var vs = [r > 0 ? p - W : -1, r < H - 1 ? p + W : -1, c4 > 0 ? p - 1 : -1, c4 < W - 1 ? p + 1 : -1];
      for (var v4 = 0; v4 < 4; v4++) { var qq = vs[v4]; if (qq >= 0 && arr[qq] > ap && arr[qq] > aq) aq = arr[qq]; }
      if (aq < 0) continue;
      var lo2 = 0, hi2 = nI;
      while (lo2 < hi2) { var mi2 = (lo2 + hi2) >> 1; if (tI[mi2] < ap) lo2 = mi2 + 1; else hi2 = mi2; }
      for (var kI = lo2; kI < nI && tI[kI] < aq; kI++) seaux[kI].push(p);
    }
    var iso = [];
    for (i = 0; i < nI; i++) iso.push({ t: tI[i], pas: choix[i].pas, trans: choix[i].trans, px: Int32Array.from(seaux[i]), lab: frontPix[Math.min(frontPix.length - 1, Math.round(tI[i] / 60))] });
    return iso;
  }

  /* ── clichesPaquet ── E : clichés [Uint16Array] → T : concaténation et
     table des débuts → S : {snapOff Float64, snapData Uint16}. */
  function clichesPaquet(snaps) {
    var snapOff = new Float64Array(snaps.length + 1), i;
    for (i = 0; i < snaps.length; i++) snapOff[i + 1] = snapOff[i] + snaps[i].length;
    var snapData = new Uint16Array(snapOff[snaps.length]);
    for (i = 0; i < snaps.length; i++) snapData.set(snaps[i], snapOff[i]);
    return { snapOff: snapOff, snapData: snapData };
  }

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
     vitesse maximales), wc (concentration maximale), snapT, snapOff,
     snapData (lames en cm), info} ; charge solide (echange) à chaque pas ;
     frottement de Manning N_MANNING sur toute la grille. */
  function calcul(E, envoyer) {
    if (E.lave) return calculLave(E, envoyer);
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
    Gr.boue = true;
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
      for (i = 0; i < nB; i++) { h[B[i]] = Math.max(0, niv - z[B[i]]); Gr.Vsortie += Gr.S[B[i]] * airePix(B[i]); Gr.S[B[i]] = 0; Gr.C[B[i]] = 0; }
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
          h[p] = 0; Gr.Vsortie += Gr.S[p] * airePix(p); Gr.S[p] = 0; Gr.C[p] = 0; continue;
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
      Gr.echange(dt);
      Gr.mouvement(dt);
      while (frontMin.length * 60 <= t) { frontMin.push(Rmax); frontPix.push(pixFront); }
      if (t - snapT[snapT.length - 1] >= dtCli) cliche(t);
      if (t > 600 && t - tDernier > T_CALME) break;
      if (Date.now() - mesure > DT_INSTANT_MS) { mesure = Date.now(); instant(t); }
    }
    instant(t);
    var tFin = t;

    var iso = isochrones(arr, wp, nW, W, H, frontMin, frontPix, pixM, PAS_ISO);

    var Vcharge = 0;
    for (k = 0; k < Gr.nL; k++) Vcharge += Gr.S[Gr.L[k]] * airePix(Gr.L[k]);
    var wpF = wp.slice(0, nW), wh = new Float32Array(nW), wv = new Float32Array(nW), wc = new Float32Array(nW);
    for (i = 0; i < nW; i++) { wh[i] = hMax[wpF[i]]; wv[i] = vMax[wpF[i]]; wc[i] = Gr.cMax[wpF[i]]; }
    var pq = clichesPaquet(snaps);
    return {
      arr: arr, iso: iso, wp: wpF, wh: wh, wv: wv, wc: wc,
      snapT: Float64Array.from(snapT), snapOff: pq.snapOff, snapData: pq.snapData,
      info: {
        zres: zres, zf: zf, Bd: lig.Bd, nBreche: nB, qMax: qMax, tFin: tFin, V0: E.V, Vreste: Vres,
        perduMer: perduMer, perduBord: perduBord, fin: fin, frontKm: Rmax / 1000, frontMin: frontMin,
        nMouilles: nW, breche: br.pied, parement: br.parement, mode: E.mode,
        nRetenue: nRetenue, manning: N_MANNING,
        boue: { d: D_GRAIN, Vero: Gr.Vero, Vdep: Gr.Vdep, Vsortie: Gr.Vsortie, Vcharge: Vcharge }
      }
    };
  }

  /* ═══ COULÉE DE LAVE ═════════════════════════════════════════════
     Film mince de Bingham (approximation de lubrification, inertie
     négligée : nombre de Reynolds ≪ 1) ; flux par unité de largeur
     q = ρ·g·S·Y²·(3ĥ − Y) / (6μ), Y = ĥ − τy/(ρ·g·S) (Liu & Mei 1989,
     J. Fluid Mech. 207:505 ; Balmforth et al. 2000, J. Fluid Mech.
     403:37), nul sous le seuil (la lave s'arrête) ; thermo-rhéologie de
     FLOWGO (Harris & Rowland 2001, Bull. Volcanol. 63:20 ; PyFLOWGO,
     Chevrel et al. 2018, Comput. Geosci. 111:167), appliquée pixel par
     pixel : cristaux φ = φ0 + (Te − T)·Δφ/(Te − Ts) ; viscosité du bain
     fondu GRD (Giordano, Russell & Dingwell 2008, EPSL 271:123) ×
     Einstein-Roscoe (1 − 1,51·φ)^(−2,5) ; seuil 0,01·(e^(0,08·(Te − T))
     − 1) + 6500·φ^2,85 Pa (Dragoni 1989, Ryerson et al. 1988) ; pertes :
     rayonnement de la surface, croûte à 773 K sur la fraction
     f = fc·e^(α·v), fissures chaudes à T − 140 K ailleurs, convection
     forcée par un vent de 5 m/s, conduction vers le sol à 773 K ;
     inertie thermique sensible et latente (c + L·Δφ/(Te − Ts),
     L = 350 kJ/kg) ; figeage sous Ts, la lave figée devient relief
     (MAGFLOW : Vicari et al. 2007, Environ. Model. Softw. 22:1465) ;
     schéma implicite en niveau (Euler rétrograde, deux passes de Picard
     sur la diffusivité, gradient conjugué préconditionné par la
     diagonale) ; chaleur transportée par les flux (donneur amont,
     mélange convexe : bornée pour tout pas). Validation : essaiHuppert()
     (étalement visqueux, solution exacte). */
  var LAVE_RHO = 2600, LAVE_CP = 1150, LAVE_EPS = 0.95, SIGMA_SB = 5.670374e-8, T_AIR = 293.15;
  var LAVE_L = 350000;         /* J/kg : chaleur latente de cristallisation (FLOWGO) */
  var T_CROUTE = 773.15, T_TAMPON = 140, T_BASE = 773.15;   /* K (FLOWGO) */
  var H_CONV = 0.0036 * 0.4412 * 1099 * 5;   /* W/m²/K : ch·ρair·cair·vent (FLOWGO) */
  var K_LAVE = 0.87;           /* W/m/K : (1,929 − 1,554·0,64)² (FLOWGO, vésicules 0,64) */
  var H_ARRIVEE_LAVE = 0.10;   /* m de lave (fluide ou figée) qui date l'arrivée */
  var DT_LAVE_MAX = 120;       /* s */
  var DT_LAVE_MIN = 0.01;      /* s */
  var DH_CIBLE = 0.5;          /* m : variation de lame visée par pas */
  var T_CALME_LAVE = 6 * 3600; /* s sans pixel nouveau après l'éruption → fin */
  var T_APRES_LAVE = 30 * 86400;
  var MARGE_BOITE = 16;        /* pixels ajoutés quand la lave approche du bord de la boîte */
  var PCG_TOL = 1e-4, PCG_MAX = 4000;
  var PAS_ISO_LAVE = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 360, 720, 1440];   /* min */

  /* ── laveCristaux ── E : lave L, T (K) → T : croissance linéaire de φ0
     à φ0 + Δφ entre Te et Ts (FLOWGO « basic ») → S : φ. */
  function laveCristaux(L, T) {
    var f = (L.Te - T) / (L.Te - L.Ts); f = f < 0 ? 0 : f > 1 ? 1 : f;
    return L.phi0 + L.dphi * f;
  }
  /* ── laveViscosite ── E : lave L, T → T : GRD × Einstein-Roscoe → S : μ (Pa·s). */
  function laveViscosite(L, T) {
    var phi = laveCristaux(L, T), g = 1 - 1.51 * phi;
    return Math.pow(10, L.A + L.B / (T - L.C)) * Math.pow(g > 0.01 ? g : 0.01, -2.5);
  }
  /* ── laveSeuilT ── E : lave L, T → T : Dragoni 1989 + Ryerson 1988 → S : τy (Pa). */
  function laveSeuilT(L, T) {
    var phi = laveCristaux(L, T);
    return 0.01 * (Math.exp(0.08 * Math.max(0, L.Te - T)) - 1) + 6500 * Math.pow(phi, 2.85);
  }
  /* ── lavePertes ── E : lave L, T (K), vitesse v (m/s), lame h → T :
     fraction de croûte f = fc·e^(α·v) ; rayonnement ε·σ·[f(Tc⁴ − Ta⁴) +
     (1 − f)((T − 140)⁴ − Ta⁴)] ; convection forcée sur la température
     de surface caractéristique ; conduction k·(T − Tbase)/(h/2) → S :
     flux perdu (W/m²). */
  function lavePertes(L, T, v, h) {
    var f = L.fc * Math.exp(L.alpha * v), Th = Math.max(T_AIR, T - T_TAMPON);
    var c4 = Math.pow(T_CROUTE, 4), h4 = Math.pow(Th, 4), a4 = Math.pow(T_AIR, 4);
    var ray = LAVE_EPS * SIGMA_SB * (f * (c4 - a4) + (1 - f) * (h4 - a4));
    var conv = H_CONV * (Math.pow(f * c4 + (1 - f) * h4, 0.25) - T_AIR);
    var cond = K_LAVE * Math.max(0, T - T_BASE) / Math.max(0.05, h / 2);
    return ray + conv + cond;
  }

  /* ── calculLave ── E : {elev, W, H, dy, dxR, vent (pixel de l'évent),
     lave {nom, A, B, C (VFT de GRD), Te, Ts (K), phi0, dphi (cristaux à
     l'évent et gagnés jusqu'à Ts), fc, alpha (croûte), Q (m³/s), duree (s)}},
     envoyer → T : boîte de calcul autour de la lave (agrandie par
     MARGE_BOITE) ; à chaque pas : diffusivités de face (lame amont
     au-dessus du seuil de face, pente de la surface, viscosité et seuil
     à la température amont), système implicite en niveau (mer et bords :
     niveau imposé au sol, la lave qui y entre sort ; sans donnée : mur),
     débit Q à l'évent tant que t < durée ; pas refusé et divisé par deux
     si une lame devient négative de plus de 5 cm ; chaleur, rayonnement,
     figeage (lave figée ajoutée au relief) ; pas suivant borné par
     DT_LAVE_MAX, 1,5 × pas, ½ pixel à la vitesse maximale et DH_CIBLE ;
     fin quand plus aucun pixel n'est atteint pendant T_CALME_LAVE après
     l'éruption (ou plus de lave fluide) → S : même structure que calcul
     (wh = épaisseur finale, wv = vitesse maximale, clichés = épaisseur
     totale en cm, info de lave). */
  function calculLave(E, envoyer) {
    var W = E.W, H = E.H, N = W * H, dy = E.dy, dxR = E.dxR, L = E.lave, p, i, k;
    var z = Float64Array.from(E.elev), h = new Float64Array(N), T = new Float32Array(N), dep = new Float32Array(N);
    var m = new Uint8Array(N);
    for (p = 0; p < N; p++) {
      var v0 = z[p], r0 = (p / W) | 0, c0 = p - r0 * W;
      if (v0 >= 9000) m[p] = M_MUR;
      else if (v0 <= 0.5) m[p] = M_MER;
      else if (r0 === 0 || c0 === 0 || r0 === H - 1 || c0 === W - 1) m[p] = M_BORD;
    }
    var vent = E.vent;
    if (m[vent]) throw new Error('évent en mer, au bord ou sans donnée');
    var aire = function (q) { return dxR[(q / W) | 0] * dy; };
    var visc = function (t) { return Math.pow(10, L.A + L.B / (t - L.C)); };
    var rV = (vent / W) | 0, cV = vent - rV * W, dxV = dxR[rV], pixM = Math.sqrt(dxV * dy);

    /* boîte de calcul et tableaux locaux */
    var bR0, bR1, bC0, bC1, bW, bH, nb, KE, KS, dg, rhs, x, rr, zz, pp, ap, typ, act, nAct;
    function boite(r0b, r1b, c0b, c1b) {
      bR0 = Math.max(0, r0b); bR1 = Math.min(H - 1, r1b); bC0 = Math.max(0, c0b); bC1 = Math.min(W - 1, c1b);
      bW = bC1 - bC0 + 1; bH = bR1 - bR0 + 1; nb = bW * bH;
      KE = new Float64Array(nb); KS = new Float64Array(nb); dg = new Float64Array(nb); rhs = new Float64Array(nb);
      x = new Float64Array(nb); rr = new Float64Array(nb); zz = new Float64Array(nb); pp = new Float64Array(nb);
      ap = new Float64Array(nb); typ = new Uint8Array(nb); act = new Int32Array(nb);
      for (var j = 0; j < nb; j++) {
        var q = (bR0 + ((j / bW) | 0)) * W + bC0 + (j % bW);
        typ[j] = m[q] === M_MUR ? 0 : (m[q] === M_MER || m[q] === M_BORD) ? 2 : 1;
      }
    }
    boite(rV - MARGE_BOITE, rV + MARGE_BOITE, cV - MARGE_BOITE, cV + MARGE_BOITE);
    var glob = function (j) { return (bR0 + ((j / bW) | 0)) * W + bC0 + (j % bW); };

    /* diffusivités de face (m²/s par m de face ÷ distance) depuis la lame hk */
    function faces(hk) {
      for (var j = 0; j < nb; j++) {
        KE[j] = 0; KS[j] = 0;
        if (!typ[j]) continue;
        var rl = (j / bW) | 0, cl = j - rl * bW, q = glob(j), r = bR0 + rl, dx = dxR[r];
        for (var f = 0; f < 2; f++) {
          var jn = f ? j + bW : j + 1;
          if (f ? rl >= bH - 1 : cl >= bW - 1) continue;
          if (!typ[jn]) continue;
          var qn = f ? q + W : q + 1, ep = z[q] + hk[q], en = z[qn] + hk[qn];
          var up = ep >= en ? q : qn, seuil = Math.max(z[q], z[qn]), hu = (ep >= en ? ep : en) - seuil;
          if (hu <= 1e-4 || hk[up] <= 0 || T[up] <= L.Ts) continue;
          var dist = f ? dy : dx, larg = f ? 0.5 * (dx + dxR[Math.min(H - 1, r + 1)]) : dy;
          var S = Math.abs(ep - en) / dist; if (S < 1e-9) continue;
          var Y = hu - (L.sansSeuil ? 0 : laveSeuilT(L, T[up]) / (LAVE_RHO * G * S)); if (Y <= 0) continue;
          var K = LAVE_RHO * G * Y * Y * (3 * hu - Y) / (6 * (L.isotherme ? visc(T[up]) : laveViscosite(L, T[up]))) * larg / dist;
          if (f) KS[j] = K; else KE[j] = K;
        }
      }
    }

    /* système implicite en niveau, gradient conjugué préconditionné */
    function resoudre(dt, hn, src) {
      nAct = 0;
      for (var j = 0; j < nb; j++) {
        if (typ[j] !== 1) continue;
        var q = glob(j), a = aire(q) / dt, kk = KE[j] + KS[j] + (j % bW > 0 ? KE[j - 1] : 0) + (j >= bW ? KS[j - bW] : 0);
        dg[j] = a + kk; rhs[j] = a * (z[q] + hn[q]) + (q === vent ? src : 0); x[j] = z[q] + hn[q];
        if (kk > 0) act[nAct++] = j; else x[j] = rhs[j] / dg[j];
      }
      /* voisins à niveau imposé (mer, bord) : passés au second membre */
      for (j = 0; j < nb; j++) {
        if (typ[j] !== 2) continue;
        var zj = z[glob(j)];
        if (j % bW < bW - 1 && typ[j + 1] === 1) rhs[j + 1] += KE[j] * zj;
        if (j % bW > 0 && typ[j - 1] === 1) rhs[j - 1] += KE[j - 1] * zj;
        if (j + bW < nb && typ[j + bW] === 1) rhs[j + bW] += KS[j] * zj;
        if (j >= bW && typ[j - bW] === 1) rhs[j - bW] += KS[j - bW] * zj;
      }
      var matvec = function (v, out) {
        for (var a2 = 0; a2 < nAct; a2++) {
          var jj = act[a2], s = dg[jj] * v[jj], cl = jj % bW;
          if (cl < bW - 1 && typ[jj + 1] === 1) s -= KE[jj] * v[jj + 1];
          if (cl > 0 && typ[jj - 1] === 1) s -= KE[jj - 1] * v[jj - 1];
          if (jj + bW < nb && typ[jj + bW] === 1) s -= KS[jj] * v[jj + bW];
          if (jj >= bW && typ[jj - bW] === 1) s -= KS[jj - bW] * v[jj - bW];
          out[jj] = s;
        }
      };
      matvec(x, ap);
      var rz = 0, a3, jj;
      for (a3 = 0; a3 < nAct; a3++) { jj = act[a3]; rr[jj] = rhs[jj] - ap[jj]; zz[jj] = rr[jj] / dg[jj]; pp[jj] = zz[jj]; rz += rr[jj] * zz[jj]; }
      for (var it = 0; it < PCG_MAX; it++) {
        var err = 0;
        for (a3 = 0; a3 < nAct; a3++) { jj = act[a3]; var e = Math.abs(rr[jj] / dg[jj]); if (e > err) err = e; }
        if (err < PCG_TOL) break;
        matvec(pp, ap);
        var pAp = 0; for (a3 = 0; a3 < nAct; a3++) { jj = act[a3]; pAp += pp[jj] * ap[jj]; }
        if (pAp <= 0) break;
        var al = rz / pAp, rz2 = 0;
        for (a3 = 0; a3 < nAct; a3++) { jj = act[a3]; x[jj] += al * pp[jj]; rr[jj] -= al * ap[jj]; zz[jj] = rr[jj] / dg[jj]; rz2 += rr[jj] * zz[jj]; }
        var be = rz2 / rz; rz = rz2;
        for (a3 = 0; a3 < nAct; a3++) { jj = act[a3]; pp[jj] = zz[jj] + be * pp[jj]; }
      }
    }

    var arr = new Float32Array(N).fill(-1), vMax = new Float32Array(N);
    var capW = 1 << 14, nW = 0, wp = new Int32Array(capW);
    var hEtoile = new Float64Array(N), hDemi = new Float64Array(N);
    var vPas = new Float32Array(N), sortie = new Float64Array(N), chInV = new Float64Array(N), chInT = new Float64Array(N);
    var Rmax = 0, pixFront = vent, frontMin = [0], frontPix = [vent], tDernier = 0;
    var Vemis = 0, Vmer = 0, Vbord = 0, Vcoupe = 0, nRefus = 0, nPas = 0;
    var snaps = [], snapT = [], nSnapTot = 0, dtCli = DT_CLICHE, nEnv = 0;
    var epais = function (q) { var x2 = Math.round((h[q] + dep[q]) * 100); return x2 > 65535 ? 65535 : x2; };
    function cliche(t) {
      var d = new Uint16Array(nW);
      for (var j = 0; j < nW; j++) d[j] = epais(wp[j]);
      snaps.push(d); snapT.push(t); nSnapTot += nW;
      if (nSnapTot > CLICHE_MAX) {
        var s2 = [], t2 = []; nSnapTot = 0;
        for (var j2 = 0; j2 < snaps.length; j2 += 2) { s2.push(snaps[j2]); t2.push(snapT[j2]); nSnapTot += snaps[j2].length; }
        snaps = s2; snapT = t2; dtCli *= 2;
      }
    }
    function instant(t, q) {
      var mp = wp.slice(nEnv, nW), ma = new Float32Array(mp.length), pr = new Uint16Array(nW);
      for (var j = 0; j < mp.length; j++) ma[j] = arr[mp[j]];
      for (j = 0; j < nW; j++) pr[j] = epais(wp[j]);
      nEnv = nW;
      envoyer({ type: 'instant', t: t, frontKm: Rmax / 1000, q: q, reste: Math.max(0, 1 - Vemis / (L.Q * L.duree)), p: mp, a: ma, prof: pr },
              [mp.buffer, ma.buffer, pr.buffer]);
    }

    if (E.hInit) for (p = 0; p < N; p++) if (E.hInit[p] > 0) { h[p] = E.hInit[p]; T[p] = L.Te; }
    var t = 0, dt = 1, mesure = Date.now(), nLiq = 1, tStop = L.tMax || L.duree + T_APRES_LAVE;
    cliche(0);
    while (t < tStop) {
      var Qc = t < L.duree ? L.Q : 0;
      if (t < L.duree && t + dt > L.duree) dt = L.duree - t;
      /* deux passes de Picard */
      faces(h);
      resoudre(dt, h, Qc);
      var ok = true, j;
      for (j = 0; j < nb; j++) if (typ[j] === 1) { p = glob(j); hEtoile[p] = Math.max(0, x[j] - z[p]); }
      for (j = 0; j < nb; j++) if (typ[j] === 1) { p = glob(j); hDemi[p] = 0.5 * (h[p] + hEtoile[p]); }
      faces(hDemi);
      resoudre(dt, h, Qc);
      var coupe = 0;
      for (j = 0; j < nb; j++) {
        if (typ[j] !== 1) continue;
        p = glob(j); var hn = x[j] - z[p];
        if (hn < -0.05) { ok = false; break; }
        if (hn < 0) coupe -= hn * aire(p);
      }
      if (!ok && dt > DT_LAVE_MIN) { dt *= 0.5; nRefus++; continue; }
      /* flux de face définitifs, chaleur transportée */
      var vmaxPas = 0, dhMax = 0;
      for (j = 0; j < nb; j++) { if (typ[j]) { p = glob(j); sortie[p] = 0; chInV[p] = 0; chInT[p] = 0; vPas[p] = 0; } }
      for (j = 0; j < nb; j++) {
        if (!typ[j]) continue;
        var rl = (j / bW) | 0, cl = j - rl * bW, q0 = glob(j);
        for (var f = 0; f < 2; f++) {
          var K = f ? KS[j] : KE[j]; if (!K) continue;
          var jn = f ? j + bW : j + 1, qn = f ? q0 + W : q0 + 1;
          var ea = typ[j] === 2 ? z[q0] : x[j], eb = typ[jn] === 2 ? z[qn] : x[jn];
          var F = K * (ea - eb) * dt, don = F > 0 ? q0 : qn, rec = F > 0 ? qn : q0, Fa = Math.abs(F);
          sortie[don] += Fa;
          if (m[rec] === M_MER) Vmer += Fa; else if (m[rec] === M_BORD) Vbord += Fa;
          else { chInV[rec] += Fa; chInT[rec] += Fa * T[don]; }
          var dist = f ? dy : dxR[bR0 + rl], larg = f ? dxR[bR0 + rl] : dy;
          var hu = Math.max(z[q0] + h[q0], z[qn] + h[qn]) - Math.max(z[q0], z[qn]);
          if (hu > 0.01) { var vit = Fa / dt / (larg * hu); if (vit > vmaxPas) vmaxPas = vit; if (vit > vMax[don]) vMax[don] = vit; if (vit > vPas[don]) vPas[don] = vit; }
          void dist;
        }
      }
      t += dt; nPas++;
      Vemis += Qc * dt; Vcoupe += coupe;
      /* nouvelles lames, température, rayonnement, figeage, arrivées */
      nLiq = 0;
      var bordAtteint = false;
      for (j = 0; j < nb; j++) {
        if (typ[j] !== 1) continue;
        p = glob(j);
        var hOld = h[p], hNew = Math.max(0, x[j] - z[p]), A = aire(p);
        if (Math.abs(hNew - hOld) > dhMax) dhMax = Math.abs(hNew - hOld);
        var garde = Math.max(0, hOld * A - sortie[p]), srcV = p === vent ? Qc * dt : 0;
        var den = garde + chInV[p] + srcV;
        var Tn = den > 0 ? (garde * T[p] + chInT[p] + srcV * L.Te) / den : 0;
        h[p] = hNew;
        if (hNew > 0 && L.isotherme) nLiq++;
        else if (hNew > 0) {
          Tn -= dt * lavePertes(L, Tn, vPas[p], hNew) / (LAVE_RHO * hNew * (LAVE_CP + (Tn > L.Ts && Tn < L.Te ? LAVE_L * L.dphi / (L.Te - L.Ts) : 0)));
          if (Tn < T_AIR) Tn = T_AIR;
          if (Tn <= L.Ts || hNew < 1e-3) { dep[p] += hNew; z[p] += hNew; h[p] = 0; Tn = 0; }
          else nLiq++;
        } else Tn = 0;
        T[p] = Tn;
        if (arr[p] < 0 && h[p] + dep[p] >= H_ARRIVEE_LAVE) {
          arr[p] = t; tDernier = t;
          if (nW === capW) { capW *= 2; var nw = new Int32Array(capW); nw.set(wp); wp = nw; }
          wp[nW++] = p;
          var rr2 = (p / W) | 0, cc2 = p - rr2 * W, dd = Math.hypot((cc2 - cV) * dxV, (rr2 - rV) * dy);
          if (dd > Rmax) { Rmax = dd; pixFront = p; }
        }
        if (h[p] > 0) {
          var rl2 = ((j / bW) | 0), cl2 = j % bW;
          if (rl2 < 2 || cl2 < 2 || rl2 > bH - 3 || cl2 > bW - 3) bordAtteint = true;
        }
      }
      if (bordAtteint) {
        var nR0 = bR0, nR1 = bR1, nC0 = bC0, nC1 = bC1;
        for (j = 0; j < nb; j++) {
          if (typ[j] !== 1 || h[glob(j)] <= 0) continue;
          var rl3 = (j / bW) | 0, cl3 = j % bW;
          if (rl3 < 2) nR0 = bR0 - MARGE_BOITE; if (rl3 > bH - 3) nR1 = bR1 + MARGE_BOITE;
          if (cl3 < 2) nC0 = bC0 - MARGE_BOITE; if (cl3 > bW - 3) nC1 = bC1 + MARGE_BOITE;
        }
        boite(nR0, nR1, nC0, nC1);
      }
      while (frontMin.length * 60 <= t) { frontMin.push(Rmax); frontPix.push(pixFront); }
      if (t - snapT[snapT.length - 1] >= dtCli) cliche(t);
      if (Date.now() - mesure > DT_INSTANT_MS) { mesure = Date.now(); instant(t, Qc); }
      if (!L.tMax && t >= L.duree && (nLiq === 0 || t - tDernier > T_CALME_LAVE)) break;
      /* pas suivant */
      var dtN = Math.min(DT_LAVE_MAX, dt * 1.5);
      if (vmaxPas > 0) dtN = Math.min(dtN, 0.5 * Math.min(dxV, dy) / vmaxPas);
      if (dhMax > 0) dtN = Math.min(dtN, dt * DH_CIBLE / dhMax);
      dt = Math.max(DT_LAVE_MIN, dtN);
    }
    instant(t, 0);
    var tFin = t;
    var iso = isochrones(arr, wp, nW, W, H, frontMin, frontPix, pixM, PAS_ISO_LAVE);
    var Vliq = 0, Vfig = 0;
    for (i = 0; i < nW; i++) { p = wp[i]; Vliq += h[p] * aire(p); Vfig += dep[p] * aire(p); }
    var wpF = wp.slice(0, nW), wh = new Float32Array(nW), wv = new Float32Array(nW);
    for (i = 0; i < nW; i++) { wh[i] = h[wpF[i]] + dep[wpF[i]]; wv[i] = vMax[wpF[i]]; }
    var pq = clichesPaquet(snaps);
    void k;
    return {
      arr: arr, iso: iso, wp: wpF, wh: wh, wv: wv, wc: null,
      snapT: Float64Array.from(snapT), snapOff: pq.snapOff, snapData: pq.snapData,
      info: {
        lave: true, nom: L.nom, tFin: tFin, V0: L.Q * L.duree, Vemis: Vemis, Vliq: Vliq, Vfig: Vfig,
        perduMer: Vmer, perduBord: Vbord, Vcoupe: Vcoupe, nPas: nPas, nRefus: nRefus,
        fin: Vmer > 0 ? 'mer' : (Vbord > 0 ? 'bord' : ''), frontKm: Rmax / 1000, frontMin: frontMin,
        nMouilles: nW, vent: vent, Q: L.Q, qMax: L.Q, duree: L.duree
      }
    };
  }


  /* ── essaiHuppert ── E : volume V (m³), viscosité μ (Pa·s), durée t
     (s), maille dx (m) → T : calculLave sur un plan horizontal, lave
     isotherme sans seuil, cylindre initial de 3 pixels de rayon ; rayon
     du front (lame ≥ 1 cm) comparé à la solution de similitude de
     Huppert (1982, J. Fluid Mech. 121:43) r = 0,894·(g·V³/(3ν))^(1/8)·t^(1/8)
     → S : {rCalc, rHuppert (m), masse (écart relatif du volume)}. */
  function essaiHuppert(V, mu, tFin, dx) {
    V = V || 1e5; mu = mu || 1e4; tFin = tFin || 86400; dx = dx || 10;
    var W = 201, H = 201, N = W * H, c = 100, z = new Float32Array(N).fill(100), h0 = new Float64Array(N), n0 = 0, p, r, cc;
    for (r = 0; r < H; r++) for (cc = 0; cc < W; cc++) if (Math.hypot(r - c, cc - c) <= 3) n0++;
    for (r = 0; r < H; r++) for (cc = 0; cc < W; cc++) if (Math.hypot(r - c, cc - c) <= 3) h0[r * W + cc] = V / (n0 * dx * dx);
    var R = calculLave({ elev: z, W: W, H: H, dy: dx, dxR: new Float64Array(H).fill(dx), vent: c * W + c, hInit: h0,
      lave: { nom: 'Huppert', A: Math.log10(mu), B: 0, C: 0, Te: 1400, Ts: 0, Q: 0, duree: 0, tMax: tFin, isotherme: true, sansSeuil: true } }, function () {});
    var rMax = 0, vol = 0;
    for (p = 0; p < N; p++) {
      var e = R.snapData.length ? 0 : 0; void e;
    }
    var der = R.snapT.length - 1, off = R.snapOff[der];
    for (var i = 0; i < R.wp.length; i++) {
      p = R.wp[i]; var hh = R.wh[i];
      vol += hh * dx * dx;
      if (hh >= 0.01) { var d = Math.hypot(((p / W) | 0) - c, p % W - c) * dx; if (d > rMax) rMax = d; }
    }
    void off;
    return { rCalc: rMax, rHuppert: 0.894 * Math.pow(G * V * V * V / (3 * mu / LAVE_RHO), 1 / 8) * Math.pow(tFin, 1 / 8), masse: (vol - V) / V };
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

  return { calcul: calcul, essaiRitter: essaiRitter, essaiHuppert: essaiHuppert };
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
      'var tr=[R.arr.buffer,R.wp.buffer,R.wh.buffer,R.wv.buffer,R.snapT.buffer,R.snapOff.buffer,R.snapData.buffer];if(R.wc)tr.push(R.wc.buffer);' +
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
