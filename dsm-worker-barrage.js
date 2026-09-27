/* ═══════════════════════════════════════════════════════════════════
   FICHIER : dsm-worker-barrage.js - v27/09/2026
   OBJET   : calcul de l'onde de rupture instantanée d'un barrage le long
             d'une trajectoire de référence (chemin du « robinet »), et
             tracé des isochrones du front minute par minute ; envoi en
             cours de calcul des pixels nouvellement atteints et des
             niveaux de rive (affichage vivant), clichés des niveaux à la
             minute (rejeu), enveloppe des niveaux maximaux.
             La source du Worker est BARRAGE_FABRIQUE.toString() : un seul
             code de calcul, ni importScripts ni dépendance réseau,
             ouverture file:// possible.
   AUTEUR  : Eric P.
   RELECTURE : Opus 5.5
   LICENCE : CC BY-NC 4.0 — source à citer : https://github.com/ericperret/crest/
             usage commercial interdit sauf accord écrit de l'auteur (voir LICENSE)
   DÉPEND  : aucune (données reçues par message)
   EXPOSE  : BARRAGE_FABRIQUE, BARRAGEWORKER { lancer, arreter }
   MESSAGES : « geom » {M, lit} ; « instant » {t, frontKm, q, reste, p, a,
             m, g, prof} ; « fin » {res} ; « erreur » {msg}.
   MODÈLES (publiés, aucun paramètre inventé) :
     · Saint-Venant 1D (1871), forme conservative volume / vitesse, sur
       sections en travers extraites du DSM ;
     · schéma décalé conservatif de Stelling & Duinmeijer (2003),
       « A staggered conservative scheme for every Froude number in
       rapidly varied shallow water flows », Int. J. Numer. Meth. Fluids
       43:1329-1354 — valable en torrentiel, fronts secs, ressauts ;
     · frottement de Manning, coefficient de Cowan (1956) « Estimating
       hydraulic roughness coefficients », Agricultural Engineering 37 :
       n = n0 · m5, n0 = 0,020 (terre nue, cas le pire, pas de végétation),
       m5 = 1,00 / 1,15 / 1,30 selon la sinuosité < 1,2 / < 1,5 / ≥ 1,5
       (repris par Chow 1959, Open-Channel Hydraulics, tab. 5-5) ;
     · surélévation en courbe Δy = C · v² · B / (g · Rc), C = 0,5 fluvial,
       1,0 torrentiel (USACE EM 1110-2-1601, Hydraulic Design of Flood
       Control Channels), plafonnée par la charge cinétique v²/2g de
       chaque rive (conservation de l'énergie) ;
     · rupture instantanée totale, lit aval sec (problème de Ritter 1892) :
       la retenue est un bief prismatique de hauteur h0, de largeur égale
       à la longueur de digue, de volume V ; le schéma restitue la
       solution de Ritter (h = 4/9 h0 au droit du barrage) sans formule
       imposée ;
     · parement aval de digue : pente plus raide que 1/5 (talus 2H/1V à
       4H/1V, USBR 1987, Design of Small Dams, ch. 6) ; embase ≤ 6 h0.
   CONVENTIONS : altitudes et niveaux en m ; temps en s ; pixels indexés
             ligne·W + colonne ; x vers l'est, y vers le nord (repère
             direct) ; côté gauche = à gauche du sens d'écoulement.
   ═══════════════════════════════════════════════════════════════════ */

"use strict";

function BARRAGE_FABRIQUE() {
  "use strict";

  var G = 9.81;
  var N0_COWAN = 0.020;       /* terre, Cowan 1956 */
  var K_NIV = 256;            /* niveaux par table de section */
  var H_SEC = 0.01;           /* m : hauteur sous laquelle une face est sèche */
  var H_ARRIVEE = 0.10;       /* m : lame d'eau qui date l'arrivée du front */
  var CFL = 0.5;
  var DT_MAX = 10;            /* s */
  var DT_CLICHE = 60;         /* s : pas des clichés de niveaux (rejeu) */
  var DT_INSTANT_MS = 250;    /* ms réelles entre deux envois « instant » */
  var T_MAX = 48 * 3600;      /* s */
  var T_CALME = 3600;         /* s sans pixel nouveau → fin */
  var T_DEMARRAGE = 30;       /* s : transitoire numérique de la discontinuité initiale exclu du débit de pointe */
  var PAS_ISO = [1, 2, 5, 10, 15, 20, 30, 60, 120];   /* min */
  var ECART_ISO_PX = 10;
  var N_RES_MAX = 400;        /* mailles maxi du bief de retenue */
  var RES_RAISON = 1.05;      /* croissance des mailles vers l'amont */
  var DEMI_FEN_COURBE = 5;    /* stations de lissage de la trajectoire */
  var DEMI_FEN_SINUO = 10;    /* stations pour la sinuosité de Cowan */
  var PENTE_PAREMENT = 0.20;  /* parements de digue 2H/1V à 4H/1V (25 à 50 %), USBR 1987 */
  var D_RECHERCHE = 2000;     /* m : écart toléré entre le point de l'ouvrage et son parement */

  /* ── Tas ── E : capacité → T : tas binaire min (indice Int32, clé
     Float64), doublement à saturation → S : objet push/pop, clé du
     dernier pop dans .cle. */
  function Tas(cap) { this.i = new Int32Array(cap); this.k = new Float64Array(cap); this.n = 0; this.cle = 0; }
  Tas.prototype.push = function (idx, key) {
    if (this.n === this.i.length) {
      var ni = new Int32Array(this.n * 2), nk = new Float64Array(this.n * 2);
      ni.set(this.i); nk.set(this.k); this.i = ni; this.k = nk;
    }
    var j = this.n++;
    while (j > 0) {
      var p = (j - 1) >> 1;
      if (this.k[p] <= key) break;
      this.i[j] = this.i[p]; this.k[j] = this.k[p]; j = p;
    }
    this.i[j] = idx; this.k[j] = key;
  };
  Tas.prototype.pop = function () {
    var top = this.i[0]; this.cle = this.k[0];
    var n = --this.n, li = this.i[n], lk = this.k[n], j = 0;
    for (;;) {
      var m = 2 * j + 1; if (m >= n) break;
      if (m + 1 < n && this.k[m + 1] < this.k[m]) m++;
      if (this.k[m] >= lk) break;
      this.i[j] = this.i[m]; this.k[j] = this.k[m]; j = m;
    }
    this.i[j] = li; this.k[j] = lk;
    return top;
  };

  /* ── geometrieChemin ── E : chemin (pixels), W, dx, dy → T : positions
     (m), distances entre stations, longueurs de contrôle (demi-distances),
     tangente lissée sur ±DEMI_FEN_COURBE, courbure κ = dθ/ds, sinuosité
     arc/corde sur ±DEMI_FEN_SINUO → S : {x, y, ds, len, tx, ty, kappa,
     sinuo, cum}. */
  function geometrieChemin(ch, W, dx, dy) {
    var n = ch.length, x = new Float64Array(n), y = new Float64Array(n), i;
    for (i = 0; i < n; i++) { x[i] = (ch[i] % W) * dx; y[i] = -Math.floor(ch[i] / W) * dy; }
    var ds = new Float64Array(Math.max(1, n - 1)), cum = new Float64Array(n);
    for (i = 0; i < n - 1; i++) { ds[i] = Math.hypot(x[i + 1] - x[i], y[i + 1] - y[i]); cum[i + 1] = cum[i] + ds[i]; }
    var len = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var a = i > 0 ? ds[i - 1] : ds[0], b = i < n - 1 ? ds[i] : ds[n - 2 >= 0 ? n - 2 : 0];
      len[i] = 0.5 * (a + b) || dx;
    }
    var w = DEMI_FEN_COURBE, tx = new Float64Array(n), ty = new Float64Array(n), th = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var i0 = Math.max(0, i - w), i1 = Math.min(n - 1, i + w);
      var ux = x[i1] - x[i0], uy = y[i1] - y[i0], nu = Math.hypot(ux, uy) || 1;
      tx[i] = ux / nu; ty[i] = uy / nu; th[i] = Math.atan2(uy, ux);
      if (i > 0) { while (th[i] - th[i - 1] > Math.PI) th[i] -= 2 * Math.PI; while (th[i] - th[i - 1] < -Math.PI) th[i] += 2 * Math.PI; }
    }
    var kappa = new Float64Array(n), sinuo = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var j0 = Math.max(0, i - w), j1 = Math.min(n - 1, i + w), s = cum[j1] - cum[j0];
      kappa[i] = s > 0 ? (th[j1] - th[j0]) / s : 0;
      var k0 = Math.max(0, i - DEMI_FEN_SINUO), k1 = Math.min(n - 1, i + DEMI_FEN_SINUO);
      var corde = Math.hypot(x[k1] - x[k0], y[k1] - y[k0]);
      sinuo[i] = corde > 0 ? (cum[k1] - cum[k0]) / corde : 1;
    }
    return { x: x, y: y, ds: ds, len: len, tx: tx, ty: ty, kappa: kappa, sinuo: sinuo, cum: cum };
  }

  /* ── sections ── E : DSM, W, H, dx, dy, chemin, i0 (brèche), iF (pied
     aval, en stations), géométrie du chemin, zPlaf (niveau maximal
     atteignable = surface de retenue) → T : (1) Voronoï géodésique
     approché (propagation de la graine la plus proche, distance
     euclidienne) sur le domaine z < zPlaf ; (2) retenue exclue : cellules
     du chemin amont et des stations de l'embase situées en amont de la
     brèche (produit scalaire avec la tangente < 0) — la retenue est
     modélisée par le bief prismatique ; (3) remplissage prioritaire
     depuis chaque station restreint à sa cellule, graines à l'altitude
     DSM, clé = seuil de connexion max(z, clé parente) ; (4) second
     remplissage libre pour les pixels isolés de leur cellule (affluents)
     → S : {st Int32 (station ≥ 0, -1 retenue, -2 hors), sig Float32
     (seuil de connexion)}. */
  function sections(z, W, H, dx, dy, ch, i0, iF, geo, zPlaf) {
    var N = W * H, i, p, q, dr, dc, r, c, nr, nc;
    var vor = new Int32Array(N).fill(-2), graine = new Int32Array(N).fill(-1);
    var best = new Float64Array(N).fill(Infinity);
    var T = new Tas(1 << 16);
    for (i = 0; i < ch.length; i++) {
      p = ch[i]; if (vor[p] !== -2) continue;
      vor[p] = i < i0 ? -1 : i - i0; graine[p] = p; best[p] = 0; T.push(p, 0);
    }
    while (T.n) {
      p = T.pop(); if (T.cle > best[p]) continue;
      var g = graine[p], gr = Math.floor(g / W), gc = g - gr * W;
      r = Math.floor(p / W); c = p - r * W;
      for (dr = -1; dr <= 1; dr++) for (dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        nr = r + dr; nc = c + dc;
        if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
        q = nr * W + nc;
        var v = z[q]; if (v <= 0.5 || v >= 9000 || v >= zPlaf) continue;
        var ex = (nc - gc) * dx, ey = (nr - gr) * dy, d = ex * ex + ey * ey;
        if (d < best[q]) { best[q] = d; graine[q] = g; vor[q] = vor[p]; T.push(q, d); }
      }
    }
    best = null; graine = null;

    var st = new Int32Array(N).fill(-2), sig = new Float32Array(N);
    var nAmont = Math.max(iF, 1), bx = geo.x[i0], by = geo.y[i0], btx = geo.tx[i0], bty = geo.ty[i0];
    for (p = 0; p < N; p++) {
      var vp = vor[p];
      if (vp === -1) { st[p] = -1; continue; }
      if (vp >= 0 && vp < nAmont) {
        var ox = (p % W) * dx - bx, oy = -Math.floor(p / W) * dy - by;
        if (ox * btx + oy * bty < 0) st[p] = -1;
      }
    }
    T = new Tas(1 << 16);
    for (i = i0; i < ch.length; i++) {
      p = ch[i]; if (st[p] >= 0) continue;
      st[p] = vor[p] >= 0 ? vor[p] : i - i0; sig[p] = z[p]; T.push(p, sig[p]);
    }
    function remplir(restreint) {
      while (T.n) {
        p = T.pop(); var k = T.cle, s = st[p];
        r = Math.floor(p / W); c = p - r * W;
        for (dr = -1; dr <= 1; dr++) for (dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          nr = r + dr; nc = c + dc;
          if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
          q = nr * W + nc;
          if (st[q] !== -2) continue;
          if (restreint && vor[q] !== s) continue;
          var v = z[q]; if (v <= 0.5 || v >= 9000 || v >= zPlaf) continue;
          var kq = v > k ? v : k;
          st[q] = s; sig[q] = kq; T.push(q, kq);
        }
      }
    }
    remplir(true);
    for (p = 0; p < N; p++) if (st[p] !== -2) T.push(p, sig[p]);
    remplir(false);
    return { st: st, sig: sig };
  }

  /* ── calcul ── E : {elev, W, H, dx, dy, chemin, fin ('mer'|'bord'|
     'fermé'), mode ('bib'|'manuel'), iDigue (pixel du barrage), V (m³),
     h0 (m), Ldigue (m, 0 = inconnue)}, envoyer(message, transferts) → T :
     trajectoire et niveaux de retenue, sections, bief de retenue
     prismatique, intégration de Saint-Venant (Stelling & Duinmeijer),
     emprise datée pixel par pixel à chaque pas de calcul, niveau de chaque
     rive à chaque pas, envois « geom » (une fois) puis « instant » (toutes
     les DT_INSTANT_MS), clichés des niveaux toutes les DT_CLICHE s ; arrêt
     quand plus aucun pixel n'est atteint pendant T_CALME (onde amortie :
     l'emprise est l'enveloppe complète, vidange totale comprise) ; choix
     des isochrones (pas de 1 min allongé tant que le front avance de moins
     de ECART_ISO_PX pixels) → S : {arr Float32 (s, -1 sec), iso [{t, pas,
     px Int32, lab, trans}], wp/wm/wg (pixels mouillés dans l'ordre
     d'arrivée : indice, rive 2·station+côté, seuil de connexion), snaps
     Uint16 (nSnap × 2M lames en cm au-dessus du lit), lit Float32 (M),
     maxNiv Float32 (2M, niveau maximal de rive), info}. */
  function calcul(E, envoyer) {
    var z = E.elev, W = E.W, H = E.H, dx = E.dx, dy = E.dy, ch = E.chemin, N = W * H;
    var np = ch.length, i, j, s, p;
    var pixM = Math.sqrt(dx * dy);

    /* niveaux de retenue. Ouvrage de bibliothèque (présent dans le DSM) :
       la trajectoire part du point de l'ouvrage, peut errer sur le plan
       d'eau ou le couronnement, puis descend le parement aval. Parement =
       première suite de pas de pente < −PENTE_PAREMENT (paliers de ≤ 2
       pas tolérés) dont la dénivelée atteint h0/2, cherchée sur les
       6 h0 + D_RECHERCHE premiers mètres ; i0 = sommet (brèche), iMin =
       pied ; zf = z(pied), zres = zf + h0 (hauteur sur terrain naturel,
       retenue pleine) ; les stations du parement sont arasées à zf
       (ouvrage emporté) ; le chemin amont de i0 appartient à la retenue.
       Ouvrage sans parement repéré (coordonnées hors de l'ouvrage) : pied
       = point le plus bas du chemin sur 6 h0, zf = z(pied), brèche au
       départ. Saisie manuelle : le clic est le fond de vallée au droit
       d'un barrage fictif, zf = z(clic). Dans tous les cas zres = zf + h0. */
    var geo = geometrieChemin(ch, W, dx, dy);
    var zres, zf, i0 = 0, iF = 0, parement = false;
    if (E.mode === 'bib') {
      var pente = function (k) { return (z[ch[k + 1]] - z[ch[k]]) / Math.max(geo.ds[k], 1); };
      var k = 0, dScan = 6 * E.h0 + D_RECHERCHE;
      while (k < np - 1 && geo.cum[k] <= dScan && !parement) {
        if (pente(k) >= -PENTE_PAREMENT) { k++; continue; }
        var deb = k, finS = k + 1, j2 = k + 1, palier = 0;
        while (j2 < np - 1) {
          if (pente(j2) < -PENTE_PAREMENT) { palier = 0; finS = j2 + 1; }
          else if (++palier > 2) break;
          j2++;
        }
        if (z[ch[deb]] - z[ch[finS]] >= E.h0 / 2) { parement = true; i0 = deb; iF = finS - deb; zf = z[ch[finS]]; }
        k = finS;
      }
    }
    if (!parement) {
      i0 = 0; iF = 0; zf = z[ch[0]];
      if (E.mode === 'bib') {
        var iB = 0;
        for (k = 1; k < np && geo.cum[k] <= 6 * E.h0; k++) if (z[ch[k]] < z[ch[iB]]) iB = k;
        zf = z[ch[iB]]; iF = iB;
      }
    }
    zres = zf + E.h0;
    var M = np - i0;
    if (M < 3) throw new Error('trajectoire trop courte');
    var lit = new Float64Array(M);
    for (s = 0; s < M; s++) lit[s] = s < iF ? zf : z[ch[i0 + s]];

    /* sections et tables volume / surface plane / surface mouillée */
    var sec = sections(z, W, H, dx, dy, ch, i0, iF, geo, zres);
    var st = sec.st, sig = sec.sig;
    var nb = new Int32Array(M + 1);
    for (p = 0; p < N; p++) if (st[p] >= 0) nb[st[p] + 1]++;
    for (s = 0; s < M; s++) nb[s + 1] += nb[s];
    var liste = new Int32Array(nb[M]), rempl = nb.slice(0, M);
    var cote = new Int8Array(N);
    for (p = 0; p < N; p++) {
      s = st[p]; if (s < 0) continue;
      liste[rempl[s]++] = p;
      var k = i0 + s, px = (p % W) * dx - geo.x[k], py = -Math.floor(p / W) * dy - geo.y[k];
      cote[p] = geo.tx[k] * py - geo.ty[k] * px >= 0 ? 1 : -1;
    }
    var K1 = K_NIV + 1;
    var tVol = new Float64Array(M * K1), tPlan = new Float64Array(M * K1), tMou = new Float64Array(M * K1);
    var bas = new Float64Array(M), pasN = new Float64Array(M);
    var lenS = new Float64Array(M);
    for (s = 0; s < M; s++) lenS[s] = geo.len[i0 + s];
    for (s = 0; s < M; s++) {
      var d = nb[s], f = nb[s + 1];
      var sub = Array.prototype.slice.call(liste.subarray(d, f));
      sub.sort(function (u, v) { return sig[u] - sig[v]; });
      for (j = 0; j < sub.length; j++) liste[d + j] = sub[j];
      var top = Math.max(zres, lit[s] + 1);
      bas[s] = lit[s]; pasN[s] = (top - lit[s]) / K_NIV;
      var cA = 0, cAZ = 0, cS = 0, jj = d;
      for (var kk = 0; kk < K1; kk++) {
        var eta = lit[s] + kk * pasN[s];
        while (jj < f && sig[liste[jj]] < eta) {
          var q = liste[jj], rq = Math.floor(q / W), cq = q - rq * W;
          var a1 = dx * dy;
          var gx = (z[rq * W + Math.min(W - 1, cq + 1)] - z[rq * W + Math.max(0, cq - 1)]) / (2 * dx);
          var gy = (z[Math.min(H - 1, rq + 1) * W + cq] - z[Math.max(0, rq - 1) * W + cq]) / (2 * dy);
          if (!(Math.abs(gx) < 10)) gx = 0; if (!(Math.abs(gy) < 10)) gy = 0;
          cA += a1; cAZ += a1 * z[q]; cS += a1 * Math.sqrt(1 + gx * gx + gy * gy);
          jj++;
        }
        tVol[s * K1 + kk] = cA * eta - cAZ;
        tPlan[s * K1 + kk] = cA; tMou[s * K1 + kk] = cS;
      }
    }

    envoyer({ type: 'geom', M: M, lit: Float32Array.from(lit) });

    /* largeur de brèche */
    var Bd = E.Ldigue > 0 ? E.Ldigue : 0;
    if (!Bd) {
      var nm = 0;
      for (s = iF; s < Math.min(M, iF + 5); s++) {
        var kz = Math.min(K_NIV, Math.max(0, Math.round((zres - bas[s]) / pasN[s])));
        Bd += tPlan[s * K1 + kz] / lenS[s]; nm++;
      }
      Bd = Math.max(pixM, nm ? Bd / nm : pixM);
    }

    /* grille de calcul : bief de retenue (rectangulaire) puis stations */
    /* bief de retenue : mailles de pixM au droit du barrage, croissance
       géométrique ×RES_RAISON vers l'amont jusqu'à la longueur V/(h0·B) */
    var Lres = E.V / (E.h0 * Bd), mailles = [], cumul = 0, dm = pixM;
    while (cumul < Lres && mailles.length < N_RES_MAX) {
      var m1 = Math.min(dm, Lres - cumul);
      mailles.push(m1); cumul += m1; dm *= RES_RAISON;
    }
    if (cumul < Lres) mailles[mailles.length - 1] += Lres - cumul;
    var nR = mailles.length;
    var nN = nR + M;
    var len = new Float64Array(nN), bed = new Float64Array(nN), rect = new Float64Array(nN), nMan = new Float64Array(nN);
    for (i = 0; i < nR; i++) { len[i] = mailles[nR - 1 - i]; bed[i] = zf; rect[i] = Bd; nMan[i] = N0_COWAN; }
    for (s = 0; s < M; s++) {
      var n_ = nR + s, sn = geo.sinuo[i0 + s];
      len[n_] = lenS[s]; bed[n_] = lit[s]; rect[n_] = s < iF ? Bd : 0;
      nMan[n_] = N0_COWAN * (sn < 1.2 ? 1.0 : sn < 1.5 ? 1.15 : 1.30);
    }
    var dist = new Float64Array(nN - 1);
    for (j = 0; j < nN - 1; j++) dist[j] = 0.5 * (len[j] + len[j + 1]);

    /* E : nœud, volume → T : niveau par table (recherche dichotomique et
       interpolation linéaire ; au-delà du sommet, surface plane du
       sommet) ou section rectangulaire → S : niveau (m). */
    var kMem = new Int32Array(nN);
    /* E : nœud, volume → T : section rectangulaire, ou table : intervalle
       [k, k+1] de volumes encadrant V cherché pas à pas depuis celui du
       pas précédent (kMem), interpolation linéaire ; au-delà du sommet,
       surface plane du sommet ; écrit aussi Bn (surface plane / longueur)
       et Pn (surface mouillée / longueur) → S : niveau (m). */
    function niveau(n, V) {
      if (rect[n] > 0) {
        var hh = V / (rect[n] * len[n]);
        Bn[n] = rect[n]; Pn[n] = rect[n] + 2 * hh;
        return bed[n] + hh;
      }
      var s = n - nR, o = s * K1, k = kMem[n];
      if (V >= tVol[o + K_NIV]) {
        Bn[n] = Math.max(tPlan[o + K_NIV], dx * dy) / len[n]; Pn[n] = Math.max(tMou[o + K_NIV], dx * dy) / len[n];
        kMem[n] = K_NIV - 1;
        return bas[s] + K_NIV * pasN[s] + (V - tVol[o + K_NIV]) / Math.max(tPlan[o + K_NIV], dx * dy);
      }
      while (k > 0 && tVol[o + k] > V) k--;
      while (k < K_NIV - 1 && tVol[o + k + 1] <= V) k++;
      kMem[n] = k;
      var v0 = tVol[o + k], v1 = tVol[o + k + 1], fr = v1 > v0 ? (V - v0) / (v1 - v0) : 0;
      if (fr < 0) fr = 0;
      Bn[n] = Math.max(tPlan[o + k], dx * dy) / len[n]; Pn[n] = Math.max(tMou[o + k], dx * dy) / len[n];
      return bas[s] + (k + fr) * pasN[s];
    }
    /* E : nœud, niveau → T : aire mouillée de la section du nœud à ce
       niveau (table ou rectangle) → S : aire (m²). */
    function aireA(n, e) {
      if (e <= bed[n]) return 0;
      if (rect[n] > 0) return rect[n] * (e - bed[n]);
      var s = n - nR, o = s * K1, x = (e - bas[s]) / pasN[s];
      if (x >= K_NIV) return (tVol[o + K_NIV] + (x - K_NIV) * pasN[s] * Math.max(tPlan[o + K_NIV], dx * dy)) / len[n];
      var k = Math.floor(x), fr = x - k;
      return (tVol[o + k] * (1 - fr) + tVol[o + k + 1] * fr) / len[n];
    }

    /* état initial */
    var Vn = new Float64Array(nN), eta = new Float64Array(nN), A = new Float64Array(nN);
    var Bn = new Float64Array(nN), Pn = new Float64Array(nN);
    var u = new Float64Array(nN - 1), uNouv = new Float64Array(nN - 1), Q = new Float64Array(nN + 1), qb = new Float64Array(nN);
    for (i = 0; i < nR; i++) Vn[i] = Bd * E.h0 * len[i];
    var V0 = 0; for (i = 0; i < nR; i++) V0 += Vn[i];
    var ouvert = E.fin !== 'fermé';
    function etat() {
      for (var n = 0; n < nN; n++) { eta[n] = niveau(n, Vn[n]); A[n] = Vn[n] / len[n]; }
    }
    etat();

    /* emprise datée */
    var arr = new Float32Array(N).fill(-1);
    var ptr = new Int32Array(2 * M), maxNiv = new Float64Array(2 * M).fill(-Infinity);
    var listeG = [new Int32Array(nb[M]), new Int32Array(nb[M])], debG = [new Int32Array(M + 1), new Int32Array(M + 1)];
    (function () {
      for (var cc2 = 0; cc2 < 2; cc2++) {
        var sgn = cc2 === 0 ? 1 : -1, w = 0;
        for (var s2 = 0; s2 < M; s2++) {
          debG[cc2][s2] = w;
          for (var j2 = nb[s2]; j2 < nb[s2 + 1]; j2++) { var p2 = liste[j2]; if (cote[p2] === sgn) listeG[cc2][w++] = p2; }
        }
        debG[cc2][M] = w;
      }
      for (var s3 = 0; s3 < M; s3++) { ptr[2 * s3] = debG[0][s3]; ptr[2 * s3 + 1] = debG[1][s3]; }
    })();
    var tDernier = 0, levR = new Float64Array(2 * M);
    var capW = 1 << 16, nW = 0, wp = new Int32Array(capW), wm = new Int32Array(capW), wg = new Float32Array(capW);

    /* ── ajouter ── E : pixel atteint, rive (2·station + côté) → T : ajout
       aux listes d'arrivée, doublement des tableaux à saturation → S :
       wp, wm, wg, nW. */
    function ajouter(p, m) {
      if (nW === capW) {
        capW *= 2;
        var a1 = new Int32Array(capW); a1.set(wp); wp = a1;
        var a2 = new Int32Array(capW); a2.set(wm); wm = a2;
        var a3 = new Float32Array(capW); a3.set(wg); wg = a3;
      }
      wp[nW] = p; wm[nW] = m; wg[nW] = sig[p]; nW++;
    }

    /* ── rives ── E : état (η, q̄, A, B) → T : niveau de chaque rive de
       chaque station : η ± Δy/2, Δy = C·v²·B·|κ|/g (C = 0,5 fluvial, 1
       torrentiel, USACE EM 1110-2-1601), demi-surélévation plafonnée à
       v²/2g, + sur la rive extérieure du virage, − sur l'intérieure ;
       station sèche (lame < H_SEC) → −∞ → S : levR (indice 2·s + côté,
       côté 0 = gauche, 1 = droite). */
    function rives() {
      for (var s = 0; s < M; s++) {
        var n = nR + s;
        if (eta[n] - bed[n] < H_SEC) { levR[2 * s] = -Infinity; levR[2 * s + 1] = -Infinity; continue; }
        var uu = A[n] > 0 ? qb[n] / A[n] : 0, u2 = uu * uu;
        var Fr = Math.abs(uu) / Math.sqrt(G * Math.max(A[n] / Bn[n], 1e-6));
        var dY = (Fr < 1 ? 0.5 : 1.0) * u2 * Bn[n] * Math.abs(geo.kappa[i0 + s]) / G;
        var demi = Math.min(0.5 * dY, u2 / (2 * G));
        var ext = geo.kappa[i0 + s] > 0 ? -1 : 1;      /* κ>0 : virage à gauche, rive extérieure à droite */
        levR[2 * s] = eta[n] + (ext === 1 ? demi : -demi);
        levR[2 * s + 1] = eta[n] + (ext === -1 ? demi : -demi);
      }
    }

    /* ── peindre ── E : instant t, levR → T : pour chaque rive d'une
       station mouillée (lame ≥ H_ARRIVEE) dont le niveau dépasse son
       maximum passé, avance le pointeur de la liste triée par seuil de
       connexion tant que seuil + H_ARRIVEE < niveau ; pixel jamais atteint
       → date t et ajout à la liste d'arrivée → S : arr, maxNiv, wp/wm/wg. */
    function peindre(t) {
      for (var s = 0; s < M; s++) {
        var n = nR + s; if (eta[n] - bed[n] < H_ARRIVEE) continue;
        for (var cc3 = 0; cc3 < 2; cc3++) {
          var m = 2 * s + cc3, lev = levR[m];
          if (lev <= maxNiv[m]) continue;
          maxNiv[m] = lev;
          var L = listeG[cc3], fin = debG[cc3][s + 1], jp = ptr[m];
          while (jp < fin && sig[L[jp]] + H_ARRIVEE < lev) {
            var q = L[jp];
            if (arr[q] < 0) { arr[q] = t; ajouter(q, m); tDernier = t; }
            jp++;
          }
          ptr[m] = jp;
        }
      }
    }

    /* clichés : lame de chaque rive au-dessus du lit de sa station, en cm
       (Uint16, 0 = sec, plafond 655,35 m) */
    var M2 = 2 * M, nSnap = 0, capS = 64, snaps = new Uint16Array(M2 * capS), prof = new Uint16Array(M2);
    /* ── profondeurs ── E : levR → T : (niveau − lit) × 100 arrondi, borné
       à [0, 65535] → S : tableau de 2M lames (cm). */
    function profondeurs(out) {
      for (var m = 0; m < M2; m++) {
        var l = levR[m];
        var d = l === -Infinity ? 0 : Math.round((l - lit[m >> 1]) * 100);
        out[m] = d < 0 ? 0 : d > 65535 ? 65535 : d;
      }
    }
    /* ── cliche ── E : levR → T : ajoute un cliché de lames, doublement
       du tampon à saturation → S : snaps, nSnap. */
    function cliche() {
      if (nSnap === capS) { capS *= 2; var s2 = new Uint16Array(M2 * capS); s2.set(snaps); snaps = s2; }
      profondeurs(prof); snaps.set(prof, nSnap * M2); nSnap++;
    }

    /* ── pasCFL ── E : état → T : Courant ≤ CFL sur les nœuds mouillés,
       célérité √(g·A/B) + |u| des faces voisines, plafonné à DT_MAX →
       S : pas de temps (s). */
    function pasCFL() {
      var dt = DT_MAX;
      for (var n = 0; n < nN; n++) {
        if (eta[n] - bed[n] < H_SEC) continue;
        var c = Math.sqrt(G * A[n] / Bn[n]);
        var ul = n > 0 ? Math.abs(u[n - 1]) : 0, ur = n < nN - 1 ? Math.abs(u[n]) : 0;
        var d = CFL * len[n] / (Math.max(ul, ur) + c);
        if (d < dt) dt = d;
      }
      return dt;
    }
    /* ── continuite ── E : pas dt → T : débits de face Q = u·Â, Â = plus
       petite des deux sections au niveau du nœud amont (sens de u) ;
       paroi fermée en amont, sortie libre (ou fermée) en aval ; bilan
       volumique des nœuds, débits moyens q̄ aux nœuds → S : débit sortant
       (m³/s). */
    function continuite(dt) {
      Q[0] = 0;
      for (var j = 0; j < nN - 1; j++) {
        var uj = u[j];
        if (uj === 0) { Q[j + 1] = 0; continue; }
        var up = uj > 0 ? j : j + 1;
        Q[j + 1] = uj * Math.min(A[up], aireA(up === j ? j + 1 : j, eta[up]));
      }
      Q[nN] = ouvert ? Math.max(0, u[nN - 2]) * A[nN - 1] : 0;
      for (var n = 0; n < nN; n++) {
        var v = Vn[n] - dt * (Q[n + 1] - Q[n]);
        Vn[n] = v > 0 ? v : 0;
        qb[n] = 0.5 * (Q[n] + Q[n + 1]);
      }
      return Q[nN];
    }
    /* ── mouvement ── E : pas dt, niveaux à jour → T : Stelling &
       Duinmeijer : face sèche si max(η) − max(lit) < H_SEC ; advection
       conservative [(q̄R·u*R − q̄L·u*L) − u·(q̄R − q̄L)] / (Ā·Δx), u* décentré
       selon le signe de q̄ ; pente de surface g·Δη/Δx ; Manning semi-
       implicite g·n²·|u| / R^(4/3) → S : aucune (u mis à jour). */
    function mouvement(dt) {
      for (var j = 0; j < nN - 1; j++) {
        var L = j, R = j + 1, uj = u[j];
        var hf = Math.max(eta[L], eta[R]) - Math.max(bed[L], bed[R]);
        if (hf < H_SEC) { uNouv[j] = 0; continue; }
        var upw = uj > 0 ? L : uj < 0 ? R : (eta[L] >= eta[R] ? L : R);
        var Aup = Math.min(A[upw], aireA(upw === L ? R : L, eta[upw]));
        if (Aup < 1e-6) Aup = 1e-6;
        var Rh = Aup / Math.max(Pn[upw], 1e-6);
        var qL = qb[L], qR = qb[R];
        var uL = qL > 0 ? (j > 0 ? u[j - 1] : 0) : uj;
        var uR = qR > 0 ? uj : (j < nN - 2 ? u[j + 1] : uj);
        var Ab = 0.5 * (A[L] + A[R]);
        var adv = Ab > 1e-6 ? ((qR * uR - qL * uL) - uj * (qR - qL)) / (Ab * dist[j]) : 0;
        var grad = G * (eta[R] - eta[L]) / dist[j];
        var nm = 0.5 * (nMan[L] + nMan[R]);
        var frot = dt * G * nm * nm * Math.abs(uj) / Math.pow(Rh > 1e-3 ? Rh : 1e-3, 4 / 3);
        uNouv[j] = (uj - dt * (adv + grad)) / (1 + frot);
      }
      var tmp = u; u = uNouv; uNouv = tmp;
    }

    /* intégration */
    var t = 0, front = -1, frontMin = [0], qMax = 0, Vsortie = 0, nEnv = 0;
    /* ── frontKm ── E : front (station) → T : abscisse curviligne depuis la
       brèche → S : km. */
    function frontKm() { return front < 0 ? 0 : (geo.cum[i0 + front] - geo.cum[i0]) / 1000; }
    /* ── instant ── E : t → T : volume restant dans la retenue, débit à la
       brèche, pixels atteints depuis le dernier envoi (indice, date, rive,
       seuil), lames de rive courantes ; message « instant », tampons
       transférés → S : aucune. */
    function instant(t) {
      var reste = 0; for (var i = 0; i < nR; i++) reste += Vn[i];
      var cour = new Uint16Array(M2); profondeurs(cour);
      var mp = wp.slice(nEnv, nW), ma = new Float32Array(nW - nEnv);
      for (i = 0; i < mp.length; i++) ma[i] = arr[mp[i]];
      var msg = { type: 'instant', t: t, frontKm: frontKm(), q: Math.abs(Q[nR]), reste: reste / V0,
                  p: mp, a: ma, m: wm.slice(nEnv, nW), g: wg.slice(nEnv, nW), prof: cour };
      nEnv = nW;
      envoyer(msg, [msg.p.buffer, msg.a.buffer, msg.m.buffer, msg.g.buffer, msg.prof.buffer]);
    }
    rives(); cliche();
    var mesure = Date.now();
    while (t < T_MAX) {
      var dt = pasCFL();
      Vsortie += dt * continuite(dt);
      etat();
      mouvement(dt);
      t += dt;
      if (t >= T_DEMARRAGE) { var qb0 = Math.abs(Q[nR]); if (qb0 > qMax) qMax = qb0; }
      for (s = M - 1; s > front; s--) if (eta[nR + s] - bed[nR + s] >= H_ARRIVEE) { front = s; break; }
      rives(); peindre(t);
      while (nSnap * DT_CLICHE <= t) cliche();
      while (frontMin.length * 60 <= t) frontMin.push(frontKm() * 1000);
      if (t > 600 && t - tDernier > T_CALME) break;
      if (Date.now() - mesure > DT_INSTANT_MS) { mesure = Date.now(); instant(t); }
    }
    instant(t);
    var tFin = t;

    /* isochrones : plus petit pas de PAS_ISO, jamais inférieur au pas
       précédent (le pas ne fait que s'allonger), donnant ≥ ECART_ISO_PX
       pixels d'avancée du front le long de la trajectoire */
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
    for (p = 0; p < N; p++) {
      var ap = arr[p]; if (ap < 0) continue;
      var r = Math.floor(p / W), cc4 = p - r * W, aq = -1;
      var vs = [r > 0 ? p - W : -1, r < H - 1 ? p + W : -1, cc4 > 0 ? p - 1 : -1, cc4 < W - 1 ? p + 1 : -1];
      for (var v4 = 0; v4 < 4; v4++) { var qq = vs[v4]; if (qq >= 0 && arr[qq] > ap && arr[qq] > aq) aq = arr[qq]; }
      if (aq < 0) continue;
      var lo2 = 0, hi2 = nI;
      while (lo2 < hi2) { var mi2 = (lo2 + hi2) >> 1; if (tI[mi2] < ap) lo2 = mi2 + 1; else hi2 = mi2; }
      for (var kI = lo2; kI < nI && tI[kI] < aq; kI++) seaux[kI].push(p);
    }
    var iso = [];
    for (i = 0; i < nI; i++) {
      var fm = frontMin[Math.round(tI[i] / 60)], sf = 0;
      while (sf < M - 1 && geo.cum[i0 + sf] - geo.cum[i0] < fm) sf++;
      iso.push({ t: tI[i], pas: choix[i].pas, trans: choix[i].trans, px: Int32Array.from(seaux[i]), lab: ch[i0 + sf] });
    }
    return {
      arr: arr, iso: iso,
      wp: wp.slice(0, nW), wm: wm.slice(0, nW), wg: wg.slice(0, nW),
      snaps: snaps.slice(0, nSnap * M2), nSnap: nSnap, dtSnap: DT_CLICHE, M: M,
      lit: Float32Array.from(lit), maxNiv: Float32Array.from(maxNiv),
      info: {
        zres: zres, zf: zf, Bd: Bd, Lres: Lres, qMax: qMax, tFin: tFin, V0: V0, Vsortie: Vsortie,
        frontKm: (frontMin[nMin] || 0) / 1000, Vreste: Vn.reduce(function (a, b) { return a + b; }, 0),
        frontMin: frontMin, fin: E.fin, nMouilles: nW,
        breche: ch[i0], atteintBout: front >= M - 1, parement: parement, mode: E.mode
      }
    };
  }

  return { calcul: calcul };
}

/* ── BARRAGEWORKER ── lanceur : un Worker dont la source est
   BARRAGE_FABRIQUE.toString() ; repli dans le fil principal si Worker
   indisponible. */
const BARRAGEWORKER = (function () {
  var _w = null;

  /* ── source ── E : aucune → T : fabrique + onmessage (calcul, messages
     « geom », « instant » puis « fin » avec tampons transférés, « erreur »)
     → S : texte du Worker. */
  function source() {
    return 'var BARRAGE=(' + BARRAGE_FABRIQUE.toString() + ')();\n' +
      'onmessage=function(e){try{var R=BARRAGE.calcul(e.data,function(m,tr){postMessage(m,tr||[]);});' +
      'var tr=[R.arr.buffer,R.wp.buffer,R.wm.buffer,R.wg.buffer,R.snaps.buffer,R.lit.buffer,R.maxNiv.buffer];' +
      'R.iso.forEach(function(i){tr.push(i.px.buffer);});' +
      'postMessage({type:"fin",res:R},tr);}catch(x){postMessage({type:"erreur",msg:String(x&&x.message||x)});}};';
  }

  /* ── lancer ── E : entrées de calcul, rappels message(m) (« geom »,
     « instant »), fin(res), erreur(msg) → T : arrête un calcul en cours,
     démarre le Worker (ou calcule sur place) → S : aucune. */
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
