/* ═══════════════════════════════════════════════════════════════════
   FICHIER : dsm-basal.js - v27/09/2026
   OBJET   : glissement basal : température du lit, régimes gelé /
             tempéré / surge avec stockage et vidange d'eau, patinage du
             front sur sol gelé. Produit c1Tab et glissTab pour DSMFLUX.
   AUTEUR  : Eric P.
   RELECTURE : Opus 5.5
   LICENCE : CC BY-NC 4.0 — source à citer : https://github.com/ericperret/crest/
             usage commercial interdit sauf accord écrit de l'auteur (voir LICENSE)
   DÉPEND  : aucun (calcul pur : Worker, fil principal ou Node)
   EXPOSE  : BASAL { K, R_GELE, R_TEMPERE, R_SURGE, tPmp, tBasEquilibre,
             tauThermique, fonteFriction, c1DepuisVitesse,
             pentesDepuisMaillage, etatNeuf, basalPas, fusionSondes }
   ⚠ Modèle conceptuel non calibré : le réservoir d'eau sous lit gelé se
     remplit vers W_MAX sans bilan d'eau (aucune production amont n'est
     calculée), et le patinage du front sur pergélisol (jusqu'à GLISS_GEL)
     est une hypothèse propre au projet, sans équivalent dans la
     littérature glaciologique courante.
   ═══════════════════════════════════════════════════════════════════ */

/* Glissement basal : commutation thermique et stockage / vidange.

   Deux mécanismes, couplés et volontairement simplifiés :

   1. THERMIQUE — la température du lit relaxe vers son équilibre
      géothermique avec une constante de temps qui croît comme H².
      Une glace épaisse isole : le lit se réchauffe même sous un climat
      très froid. Le seuil de décollement n'est pas 0 °C mais le point
      de fusion sous pression, qui descend de 0,78 °C par kilomètre de
      glace — un lit à −0,6 °C sous 1000 m de glace est déjà tempéré.

   2. HYDROLOGIQUE — tant que le lit est gelé, il fait bouchon : l'eau
      produite en amont ne peut ni s'écouler ni lubrifier, elle
      s'accumule. Plus la phase froide dure, plus le réservoir est
      chargé. Au dégel le bouchon lâche, la pression effective
      s'effondre et le glissement passe de quelques dizaines à quelques
      milliers de mètres par an, jusqu'à vidange du stock.

   3. PROGLACIAIRE — un sol gelé ne soude pas. Le front qui arrive sur
      un terrain en pergélisol ne peut ni regeler dans les aspérités ni
      s'y ancrer : l'interface reste micro-adhérente et le front patine
      au lieu de se fixer, exactement comme une avalanche sur croûte
      froide qui court alors qu'elle s'arrêterait sur neige humide. Sur
      sol dégelé au contraire le front fond, s'ancre et se stabilise.
      Le facteur de patinage croît avec la durée d'installation du
      pergélisol et s'annule dès le dégel.

   La vidange donne la vitesse, le sol gelé donne la distance : c'est
   leur conjonction qui porte le front bien au-delà de ce que la SIA
   seule autorise.

   Sorties, toutes deux consommées par DSMFLUX :
     c1[]    coefficient de glissement linéaire u_b = c1 · tau_b, indexé
             par le triangle amont          → cfg.c1Tab
     gliss[] facteur de patinage du front, indexé par le triangle VIDE
             vers lequel le front avance    → cfg.glissTab

   Calcul pur : tourne dans un Worker, sur le fil principal ou sous
   Node.                                                              */

"use strict";

/* ── BASAL (module) ── E : aucune → T : constantes K (surchargeables) et
   fonctions → S : objet BASAL. */
const BASAL = (function () {

  const AN = 31556952;

  /* ─── Constantes, toutes surchargeables par opts ──────────────────── */

  const K = {
    /* Physique de la glace */
    RHO_GLACE:    917,        /* kg/m³                                  */
    G_PESANT:     9.81,       /* m/s²                                   */
    K_THERM:      2.1,        /* conductivité, W/m/K                    */
    KAPPA:        1.09e-6,    /* diffusivité thermique, m²/s            */
    L_FUSION:     334000,     /* chaleur latente, J/kg                  */

    /* Flux géothermique, W/m². 0,05 = croûte continentale banale ;
       0,08 en domaine alpin fracturé.                                  */
    FLUX_GEO:     0.055,

    /* Point de fusion sous pression : Tpmp = -BETA_PMP · rho · g · H   */
    BETA_PMP:     8.7e-8,     /* K/Pa                                   */

    /* Inertie thermique du lit : tau = H² / (4·KAPPA), bornée.
       500 m de glace ≈ 1800 ans, 1500 m ≈ 16000 ans.                   */
    TAU_TH_MIN:   10,         /* années                                 */
    TAU_TH_MAX:   20000,      /* années                                 */

    /* Hystérésis sur le seuil de fusion, évite le battement            */
    DT_HYST:      0.05,       /* °C                                     */

    /* ── Réservoir d'eau basale, en m équivalent eau ────────────────  */

    /* Charge du réservoir pendant la phase froide : eau descendue de
       l'amont tempéré et piégée par le bouchon gelé. Charge saturante,
       W → W_MAX avec la constante TAU_CHARGE. C'est ce terme qui
       convertit la durée du gel en distance d'avance : la vidange dure
       TAU_VIDANGE · ln(W / W_ARRET).                                   */
    W_MAX:        3.0,        /* m eq. eau — capacité du till           */
    TAU_CHARGE:   500,        /* années                                 */

    /* Drainage du réservoir en régime tempéré normal                   */
    TAU_DRAIN:    100,        /* années                                 */

    /* Déclenchement de la vidange                                      */
    W_SEUIL:      1.2,        /* m — au-delà, la surge part             */
    W_ARRET:      0.15,       /* m — en deçà, elle s'éteint             */
    TAU_VIDANGE:  100,        /* années — durée caractéristique         */

    /* Épaisseur minimale sous laquelle rien ne se passe                */
    H_MIN_GLISS:  20,         /* m                                      */

    /* ── Sol proglaciaire : patinage du front sur terrain gelé ──────  */
    T_GEL_SOL:    -1.0,       /* °C — au-dessous, le sol prend en gel   */
    TAU_PERGEL:   300,        /* années — installation du pergélisol    */
    GLISS_DEGEL:  1,          /* sol dégelé : le front s'ancre          */
    GLISS_GEL:    60,         /* pergélisol établi : le front patine    */
    TAU_DEGEL:    50,         /* années — perte du gel au redoux        */

    /* ── Coefficients de glissement, u_b = c1 · tau_b, en m/(Pa·s) ──
       Repères sous tau_b = 100 kPa :
         C1_GELE     →      0 m/an
         C1_TEMPERE  →     20 m/an
         C1_SURGE    →   5000 m/an
       La loi linéaire diverge sous forte contrainte : les deux plafonds
       ci-dessous la ramènent dans le domaine observé.                   */
    C1_GELE:      0,
    C1_TEMPERE:   6.3e-12,
    C1_SURGE:     1.6e-9,
    U_TEMP_MAX:   200,        /* m/an                                   */
    U_SURGE_MAX:  8000,       /* m/an — ordre du Kutiah, 1953           */

    /* Montée en charge du glissement tempéré avec le stock d'eau :
       c1 = C1_TEMPERE · (1 + SENS_W · W / W_SEUIL)                     */
    SENS_W:       2.0
  };

  /* Codes de régime, écrits dans etat.regime                           */
  const R_GELE = 0, R_TEMPERE = 1, R_SURGE = 2;

  /* ── tPmp ── E : H (m), constantes k → T : −β·ρ·g·H → S : point de fusion
     sous pression (°C). ALGO : « Température de fusion de la glace au lit
     sous H mètres (≈ −0,78 °C/km). » */
  function tPmp(H, k) {
    return -k.BETA_PMP * k.RHO_GLACE * k.G_PESANT * H;
  }

  /* ── tBasEquilibre ── E : tSurf (°C), H (m), k → T : Ts + Φgéo·H / K_therm
     → S : température d'équilibre du lit (°C). ALGO : « Profil conductif
     permanent chauffé par le flux géothermique, sans friction. » */
  function tBasEquilibre(tSurf, H, k) {
    return tSurf + k.FLUX_GEO * H / k.K_THERM;
  }

  /* ── tauThermique ── E : H (m), k → T : H² / (4κ), en années, borné à
     [TAU_TH_MIN, TAU_TH_MAX] → S : constante de temps (ans). ALGO : « Temps
     de diffusion thermique à travers la colonne de glace. » */
  function tauThermique(H, k) {
    var tau = (H * H / (4 * k.KAPPA)) / AN;
    if (tau < k.TAU_TH_MIN) return k.TAU_TH_MIN;
    if (tau > k.TAU_TH_MAX) return k.TAU_TH_MAX;
    return tau;
  }

  /* ── fonteFriction ── E : tauB (Pa), uB (m/an), k → T : τ·u / (ρ·L) → S :
     fonte basale (m/an). ALGO : « Fonte par chaleur de frottement au lit. »
     ⚠ Jamais appelée : basalPas n'ajoute pas cette fonte, contrairement à
       son commentaire (« la friction entretient la fonte »). */
  function fonteFriction(tauB, uB, k) {
    if (tauB <= 0 || uB <= 0) return 0;
    return tauB * uB / (k.RHO_GLACE * k.L_FUSION) * AN;
  }

  /* ── c1DepuisVitesse ── E : uAn (m/an), tauB (Pa) → T : u / (AN · τ) →
     S : c1 (m/(Pa·s)), 0 si τ ≤ 0. ALGO : « Coefficient de glissement
     linéaire donnant la vitesse u sous la contrainte τ. » */
  function c1DepuisVitesse(uAn, tauB) {
    if (tauB <= 0) return 0;
    return (uAn / AN) / tauB;
  }

  /* ── basalPas ───────────────────────────────────────────────────────
     ENTRÉE     : tables { H (m), tSurf (°C, moyenne annuelle), pente (|∇s|
                  ou null → 0,05) }, etat { tBas, stock (m éq. eau), regime,
                  tFroid (ans) }, c1 et gliss (sorties), dtAns, tranche
                  [t0, t1[, opts (surcharge de K)
     TRAITEMENT : par triangle —
                  · hors glace (H < H_MIN_GLISS) : lit = air, stock vidé,
                    régime gelé ; tFroid cumule sous T_GEL_SOL, décroît sinon ;
                    gliss = GLISS_DEGEL + (GLISS_GEL − GLISS_DEGEL)·(1 − e^(−tFroid/TAU_PERGEL))
                  · sous glace : tBas relaxe vers tBasEquilibre avec la
                    constante tauThermique, écrêté au point de fusion ;
                    τb = ρ·g·H·pente ; tempéré si tBas ≥ tPmp − DT_HYST
                  · gelé : stock → W_MAX (TAU_CHARGE), c1 = C1_GELE
                  · surge (déjà en surge ou stock > W_SEUIL) : c1 = C1_SURGE
                    plafonné à U_SURGE_MAX, stock vidangé (TAU_VIDANGE), retour
                    tempéré sous W_ARRET
                  · tempéré : stock + fonte géothermique, drainé (TAU_DRAIN),
                    c1 = C1_TEMPERE·(1 + SENS_W·W/W_SEUIL) plafonné à U_TEMP_MAX
     SORTIE     : c1[t], gliss[t], etat mis à jour ; sonde (comptes par
                  régime, stock, tBas moyen, c1 max, vitesse de surge max,
                  bascules, patinage moyen/max)
     ALGO       : « Automate à trois régimes (gelé, tempéré, surge) piloté
                  par la température du lit relaxée vers l'équilibre
                  géothermique et par un stock d'eau qui se charge sous lit
                  gelé et se vidange en surge. »
     ⚠ Voir le cartouche : stock sans bilan d'eau, patinage sur pergélisol
       hypothétique ; frottement non réinjecté dans la fonte.
     ─────────────────────────────────────────────────────────────────── */
  function basalPas(tables, etat, c1, gliss, dtAns, t0, t1, opts) {
    var k = _opts(opts);
    var H = tables.H, tS = tables.tSurf, pente = tables.pente;
    var tB = etat.tBas, W = etat.stock, reg = etat.regime, tF = etat.tFroid;

    var rg = k.RHO_GLACE * k.G_PESANT;
    var facDegel  = 1 - Math.exp(-dtAns / k.TAU_DEGEL);
    var facDrain  = 1 - Math.exp(-dtAns / k.TAU_DRAIN);
    var facVid    = 1 - Math.exp(-dtAns / k.TAU_VIDANGE);
    var facCharge = 1 - Math.exp(-dtAns / k.TAU_CHARGE);
    var mbGeo    = k.FLUX_GEO / (k.RHO_GLACE * k.L_FUSION) * AN;   /* m/an */

    var s = {
      nTri: 0, nGele: 0, nTempere: 0, nSurge: 0, nPergel: 0,
      stockTot: 0, stockMax: 0, tBasMoy: 0, tFroidMax: 0,
      c1Max: 0, uSurgeMax: 0, nBascule: 0, glissMoy: 0, glissMax: 0
    };

    for (var t = t0; t < t1; t++) {

      var h = H[t];

      /* ── Hors glace : le sol suit l'air, le réservoir se vide, et on
            évalue son état de gel — c'est ce terrain-là que le front
            rencontrera. Gelé, il ne soude pas et laisse patiner ; dégelé,
            il ancre le front. ─────────────────────────────────────── */
      if (h < k.H_MIN_GLISS) {
        tB[t] = tS[t];
        W[t] = 0;
        reg[t] = R_GELE;
        c1[t] = 0;

        if (tS[t] < k.T_GEL_SOL) {
          tF[t] += dtAns;
        } else {
          tF[t] -= tF[t] * facDegel;         /* le redoux efface le gel  */
          if (tF[t] < 0) tF[t] = 0;
        }
        if (gliss) {
          var pg = 1 - Math.exp(-tF[t] / k.TAU_PERGEL);
          var gv = k.GLISS_DEGEL + (k.GLISS_GEL - k.GLISS_DEGEL) * pg;
          gliss[t] = gv;
          s.glissMoy += gv;
          if (gv > s.glissMax) s.glissMax = gv;
          if (pg > 0.5) s.nPergel++;
        }
        s.nTri++; s.nGele++;
        if (tF[t] > s.tFroidMax) s.tFroidMax = tF[t];
        continue;
      }

      /* Sous la glace, le facteur de front ne sert pas : le triangle
         n'est pas vide. On le laisse au neutre. */
      if (gliss) { gliss[t] = k.GLISS_DEGEL; s.glissMoy += k.GLISS_DEGEL; }

      /* ── 1. Relaxation thermique du lit ──────────────────────────── */
      var tEq  = tBasEquilibre(tS[t], h, k);
      var tau  = tauThermique(h, k);
      var relax = 1 - Math.exp(-dtAns / tau);
      var tb = tB[t] + (tEq - tB[t]) * relax;

      var tm = tPmp(h, k);
      if (tb > tm) tb = tm;          /* la fusion écrête, l'excès part en eau */
      tB[t] = tb;

      /* ── 2. Contrainte basale et régime en cours ─────────────────── */
      var tauB = rg * h * (pente ? pente[t] : 0.05);
      var regAvant = reg[t];
      var tempere = tb >= tm - k.DT_HYST;

      /* ── 3. Réservoir ────────────────────────────────────────────── */
      var w = W[t];
      var c = 0;

      if (!tempere) {

        /* Lit gelé : bouchon. Aucun glissement, mais l'eau descendue de
           l'amont s'accumule sans pouvoir s'évacuer. La durée du gel se
           convertit ici en réserve, donc en distance d'avance future. */
        reg[t] = R_GELE;
        tF[t] += dtAns;
        w += (k.W_MAX - w) * facCharge;
        c = k.C1_GELE;

      } else if (regAvant === R_SURGE || w > k.W_SEUIL) {

        /* Vidange explosive : pression effective effondrée, le lit
           découple. La friction entretient la fonte tant que ça glisse. */
        reg[t] = R_SURGE;
        tF[t] = 0;
        c = _plafond(k.C1_SURGE, k.U_SURGE_MAX, tauB);
        w -= w * facVid;      /* drainage efficace : le réseau s'ouvre  */
        if (w < k.W_ARRET) reg[t] = R_TEMPERE;
        var uB = c * tauB * AN;                       /* m/an           */
        if (uB > s.uSurgeMax) s.uSurgeMax = uB;

      } else {

        /* Tempéré courant : glissement modéré, drainage efficace. */
        reg[t] = R_TEMPERE;
        tF[t] = 0;
        w += mbGeo * dtAns;
        w -= w * facDrain;
        var f = 1 + k.SENS_W * (w / k.W_SEUIL);
        c = _plafond(k.C1_TEMPERE * f, k.U_TEMP_MAX, tauB);
      }

      if (w < 0) w = 0;
      if (w > k.W_MAX) w = k.W_MAX;
      W[t] = w;
      c1[t] = c;

      /* ── Diagnostic ──────────────────────────────────────────────── */
      s.nTri++;
      if (reg[t] === R_GELE) s.nGele++;
      else if (reg[t] === R_SURGE) s.nSurge++;
      else s.nTempere++;
      if (regAvant !== reg[t]) s.nBascule++;
      s.stockTot += w;
      if (w > s.stockMax) s.stockMax = w;
      s.tBasMoy += tb;
      if (tF[t] > s.tFroidMax) s.tFroidMax = tF[t];
      if (c > s.c1Max) s.c1Max = c;
    }

    if (s.nTri > 0) { s.tBasMoy /= s.nTri; s.glissMoy /= s.nTri; }
    return s;
  }

  /* ── etatNeuf ── E : nTri, tSurf (ou null) → T : alloue tBas, stock, regime,
     tFroid ; tBas = tSurf → S : etat. ALGO : « État basal initial : lit à la
     température de l'air, réservoir vide. » */
  function etatNeuf(nTri, tSurf) {
    var e = {
      tBas:   new Float32Array(nTri),
      stock:  new Float32Array(nTri),
      regime: new Uint8Array(nTri),
      tFroid: new Float32Array(nTri)
    };
    if (tSurf) e.tBas.set(tSurf);
    return e;
  }

  /* ── fusionSondes ── E : liste de sondes de tranches → T : sommes, maxima,
     moyennes pondérées par le nombre de triangles → S : sonde unique. */
  function fusionSondes(liste) {
    var s = {
      nTri: 0, nGele: 0, nTempere: 0, nSurge: 0, nPergel: 0,
      stockTot: 0, stockMax: 0, tBasMoy: 0, tFroidMax: 0,
      c1Max: 0, uSurgeMax: 0, nBascule: 0, glissMoy: 0, glissMax: 0
    };
    var wT = 0, wG = 0;
    for (var i = 0; i < liste.length; i++) {
      var u = liste[i];
      s.nTri += u.nTri; s.nGele += u.nGele;
      s.nTempere += u.nTempere; s.nSurge += u.nSurge;
      s.nPergel += u.nPergel;
      s.nBascule += u.nBascule; s.stockTot += u.stockTot;
      if (u.glissMax > s.glissMax) s.glissMax = u.glissMax;
      wG += u.glissMoy * u.nTri;
      if (u.stockMax  > s.stockMax)  s.stockMax  = u.stockMax;
      if (u.tFroidMax > s.tFroidMax) s.tFroidMax = u.tFroidMax;
      if (u.c1Max     > s.c1Max)     s.c1Max     = u.c1Max;
      if (u.uSurgeMax > s.uSurgeMax) s.uSurgeMax = u.uSurgeMax;
      wT += u.tBasMoy * u.nTri;
    }
    if (s.nTri > 0) { s.tBasMoy = wT / s.nTri; s.glissMoy = wG / s.nTri; }
    return s;
  }

  /* ── pentesDepuisMaillage ── E : filet F (nx, ny, nz) → T : |∇z| =
     √((nx/nz)² + (ny/nz)²) par triangle ; sans normales, 0,05 partout →
     S : Float32Array des pentes du lit. ALGO : « Pente du lit de chaque
     triangle depuis sa normale ; dsm.html la remplace sous la glace par la
     pente de surface. » */
  function pentesDepuisMaillage(F) {
    var n = F.nTri, p = new Float32Array(n);
    if (!F.nx) { p.fill(0.05); return p; }
    for (var t = 0; t < n; t++) {
      var nz = F.nz[t] || 1;
      var gx = -F.nx[t] / nz, gy = -F.ny[t] / nz;
      p[t] = Math.sqrt(gx * gx + gy * gy);
    }
    return p;
  }

  /* ── _plafond ── E : c1, uMax (m/an), tauB (Pa) → T : min(c1, uMax/(AN·τ))
     → S : c1 plafonné. ALGO : « Borne le glissement à une vitesse maximale. » */
  function _plafond(c, uMax, tauB) {
    if (tauB <= 0) return c;
    var cMax = (uMax / AN) / tauB;
    return c < cMax ? c : cMax;
  }

  /* ── _opts ── E : opts ou null → T : copie de K où chaque clé présente dans
     opts remplace la valeur par défaut → S : constantes effectives. */
  function _opts(opts) {
    if (!opts) return K;
    var o = {};
    for (var c in K) o[c] = opts[c] !== undefined ? opts[c] : K[c];
    return o;
  }

  return {
    K: K,
    R_GELE: R_GELE, R_TEMPERE: R_TEMPERE, R_SURGE: R_SURGE,
    tPmp: tPmp, tBasEquilibre: tBasEquilibre, tauThermique: tauThermique,
    fonteFriction: fonteFriction, c1DepuisVitesse: c1DepuisVitesse,
    pentesDepuisMaillage: pentesDepuisMaillage,
    etatNeuf: etatNeuf, basalPas: basalPas, fusionSondes: fusionSondes
  };

})();

if (typeof module !== "undefined" && module.exports)
  module.exports = { BASAL: BASAL };
