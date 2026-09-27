/* ═══════════════════════════════════════════════════════════════════
   FICHIER : dsm-worker-glacier.js - v27/09/2026
   OBJET   : bilan de masse local neige / glace par triangle du filet
             (accumulation, fonte en degrés-heures, tassement), réparti
             sur un pool de Workers qui gardent chacun une tranche de
             triangles.
   AUTEUR  : Eric P.
   RELECTURE : Opus 5.5
   LICENCE : CC BY-NC 4.0 — source à citer : https://github.com/ericperret/crest/
             usage commercial interdit sauf accord écrit de l'auteur (voir LICENSE)
   DÉPEND  : aucun (noyau pur ; les tables viennent de dsm.html)
   EXPOSE  : GLACIER { KDEF, degresHeures, pasTranche, fusionSondes,
             volumes, _interpELA }, GLACPOOL { init, majFoehn, majSoleil,
             pas, fermer, … }
   CONVENTIONS : épaisseurs en m d'équivalent eau ; pas de 5 jours ;
             ensoleillement 0..255 par tranche de 5 jours (73 cartes)
   ⚠ Modèle degrés-jours pur : pas de regel, pas de pluie sur neige, pas
     de terme radiatif hors de la bosse diurne.
   ═══════════════════════════════════════════════════════════════════ */

/* Bilan de masse de la neige et de la glace, triangle par triangle.

   Bilan de masse local par triangle, parallélisé (référence unique :
   l'ancienne fonction glacierAccumPas de dsm.html a été retirée).
   Le bilan est purement local — aucun échange entre triangles,
   l'écoulement relève de dsm-flux.js — ce qui rend le découpage en
   tranches contiguës immédiat.

   Le pas est infra-annuel (5 jours par défaut). La fonte est calculée
   en degrés-heures positifs à partir du cycle diurne : température de
   base issue du gradient adiabatique, modulation saisonnière, et une
   demi-sinusoïde diurne d'amplitude `aDiurne · nébulosité · ensoleillement`
   étalée sur la durée du jour. L'intégrale de la partie positive de ce
   cycle est calculée en forme fermée, y compris le cas où le jour passe
   au-dessus de zéro alors que la moyenne journalière reste négative.

   Découpage des états :
     — statique, envoyé une fois à l'init : z, cosT, actif, K
     — semi-statique, rafraîchi par époque : fC, fDT (foehn),
       wSun73 (cartes d'ensoleillement, une par tranche de l'année)
     — dynamique, échangé à chaque pas : hNeige, hGlace, et le scalaire
       climatique du pas

   Le noyau `pasTranche` est du calcul pur : il tourne aussi bien dans un
   Worker que sur le fil principal ou sous Node.                          */

"use strict";

/* ── GLACIER (module) ── E : aucune → T : constantes KDEF et noyau de
   calcul → S : objet GLACIER. */
const GLACIER = (function () {

  /* ─── Constantes par défaut, toutes surchargeables par K ──────────── */

  const KDEF = {
    lapse:    6.5,       /* gradient adiabatique, °C/km                  */
    aDiurne:  13.8,      /* amplitude diurne de plein soleil, °C         */
    pasJ:     5,         /* durée du pas, jours                          */
    ddfN:     0.00017,   /* facteur degrés-heures, neige, m/(°C·h)       */
    ddfG:     0.00033,   /* facteur degrés-heures, glace, m/(°C·h)       */
    kTass:    0          /* fraction de neige convertie en glace par pas */
  };

  /* ── degresHeures ───────────────────────────────────────────────────────
     ENTRÉE     : C température moyenne journalière (°C), b amplitude de la
                  bosse diurne (°C), L durée du jour (h)
     TRAITEMENT : nuit à Cn = C − (2b/π)(L/24) (moyenne sur 24 h conservée) ;
                  jour Cn + b·sin(π·phase) ; intégrale fermée de la partie
                  positive : tout le jour si Cn ≥ 0, sinon fenêtre centrale
                  bornée par asin(−Cn/b)
     SORTIE     : degrés-heures positifs de la journée (°C·h)
     ALGO       : « Degrés-heures positifs d'une journée à nuit constante et
                  jour en demi-sinus, moyenne journalière imposée, en forme
                  fermée. »
     ─────────────────────────────────────────────────────────────────── */
  function degresHeures(C, b, L) {
    var mC = (L > 0 && b > 0) ? (2 * b / Math.PI) * (L / 24) : 0;
    var Cn = C - mC;
    var degH = (Cn > 0 ? Cn * (24 - L) : 0);
    if (L > 0 && b > 0) {
      if (Cn >= 0) {
        degH += (Cn + 2 * b / Math.PI) * L;
      } else if (Cn + b > 0) {
        var f1 = Math.asin(-Cn / b) / Math.PI;
        degH += (Cn * (1 - 2 * f1) + (2 * b / Math.PI) * Math.cos(Math.PI * f1)) * L;
      }
    } else if (L > 0 && Cn > 0) {
      degH += Cn * L;
    }
    return degH;
  }

  /* ── pasTranche ─────────────────────────────────────────────────────────
     ENTRÉE     : T { z, cosT, actif, fC, fDT, wSun, nLoc }, etat { hNeige,
                  hGlace } (m éq. eau, modifiés en place), scal { tMer,
                  tSaison, bNeb, L, precJour, slice }, tranche [t0, t1[, K
     TRAITEMENT : par triangle actif ou encore englacé —
                  C = T_mer − 6,5 °C/km·z + saison + ΔT foehn ;
                  b = aDiurne·nébulosité·ensoleillement/255 ; degresHeures ;
                  accumulation = précip·cosT·fC·fraction neigeuse (1 sous
                  0 °C, 0 au-dessus de 2 °C, linéaire entre) ;
                  fonte = degH·pasJ·ddfN sur la neige, reste converti en
                  fonte de glace (ddfG) ;
                  tassement = kTass × neige restante → glace ;
                  bilan potentiel (fonte de glace illimitée) pour encadrer
                  la ligne d'équilibre (plus haut z négatif, plus bas z positif)
     SORTIE     : sonde { comptes, accumulation, fonte, tassement, maxima,
                  degH et bilan moyens, zELA interpolée }
     ALGO       : « Bilan de masse degrés-jours d'un pas de 5 jours par
                  triangle, avec ligne d'équilibre sur le bilan potentiel. »
     ─────────────────────────────────────────────────────────────────── */
  function pasTranche(T, etat, scal, t0, t1, K) {
    var k = _opts(K);
    var z = T.z, cosT = T.cosT, actif = T.actif;
    var fC = T.fC, fDT = T.fDT, wSun = T.wSun, nLoc = T.nLoc;
    var hN = etat.hNeige, hG = etat.hGlace;

    var lapse = k.lapse / 1000;
    var tMer = scal.tMer, tSaison = scal.tSaison, L = scal.L;
    var precJour = scal.precJour;
    var ampl = k.aDiurne * scal.bNeb;
    var offSun = (scal.slice | 0) * nLoc;
    var ddfN = k.ddfN, ddfG = k.ddfG, kTass = k.kTass, pasJ = k.pasJ;

    var s = {
      nTri: 0, nEnglaces: 0, nAccum: 0, nAblation: 0,
      accumTot: 0, fonteTot: 0, tasseTot: 0,
      hNMax: 0, hGMax: 0, degHMoy: 0, bilanMoy: 0,
      zNeg: NaN, bNeg: 0, zPos: NaN, bPos: 0
    };

    for (var t = t0; t < t1; t++) {

      var neige = hN[t], glace = hG[t];
      if (!actif[t] && glace <= 0 && neige <= 0) continue;

      var zt = z[t];

      /* ── Température moyenne du pas ──────────────────────────────── */
      var C = (zt <= 0.5 ? tMer : tMer - lapse * zt) + tSaison + fDT[t];

      /* ── Bosse diurne, pondérée par l'ensoleillement du triangle ─── */
      var b = ampl * (wSun ? wSun[offSun + t] / 255 : 0);

      var degH = degresHeures(C, b, L);

      /* ── 1. Accumulation ─────────────────────────────────────────── */
      /* La neige tombe verticalement : une facette inclinée en reçoit
         moins par unité de sa propre surface.                                         */
      var precEff = precJour * cosT[t] * fC[t];
      var fSnow = C <= 0 ? 1 : (C < 2 ? (2 - C) / 2 : 0);
      var accum = precEff * fSnow;
      hN[t] = neige + accum;
      s.accumTot += accum;

      /* ── 2. Fonte : la neige d'abord, la glace ensuite ───────────── */
      var fonte = 0;
      var dh = degH * pasJ;
      if (dh > 0) {
        var fN = dh * ddfN;
        if (fN <= hN[t]) {
          hN[t] -= fN;
          fonte = fN;
        } else {
          var dhReste = (fN - hN[t]) / ddfN;
          fonte = hN[t];
          hN[t] = 0;
          var avant = hG[t];
          hG[t] = Math.max(0, hG[t] - dhReste * ddfG);
          fonte += avant - hG[t];
        }
      }
      s.fonteTot += fonte;

      /* ── 3. Tassement : la neige survivante devient glace ────────── */
      if (hN[t] > 0) {
        var conv = hN[t] * kTass;
        hN[t] -= conv;
        hG[t] += conv;
        s.tasseTot += conv;
      }

      neige = hN[t];
      glace = hG[t];

      /* ── Diagnostic ──────────────────────────────────────────────── */
      var bilan = accum - fonte;
      s.nTri++;
      s.bilanMoy += bilan;
      s.degHMoy += degH;
      if (neige > 0 || glace > 0) s.nEnglaces++;
      if (bilan > 0) s.nAccum++; else if (bilan < 0) s.nAblation++;
      if (neige > s.hNMax) s.hNMax = neige;
      if (glace > s.hGMax) s.hGMax = glace;

      /* Ligne d'équilibre : elle se lit sur le bilan *potentiel* — celui
         qu'aurait le triangle s'il disposait d'une réserve illimitée. Le
         bilan réel est borné par la masse présente, donc nul partout où
         la glace a déjà disparu : il ne dit plus rien de la position de
         la ligne. On garde l'encadrement le plus serré autour du
         changement de signe. */
      var bPot = accum - dh * ddfG;
      if (zt > 0) {
        if (bPot < 0 && (isNaN(s.zNeg) || zt >= s.zNeg)) { s.zNeg = zt; s.bNeg = bPot; }
        if (bPot > 0 && (isNaN(s.zPos) || zt <= s.zPos)) { s.zPos = zt; s.bPos = bPot; }
      }
    }

    if (s.nTri > 0) { s.bilanMoy /= s.nTri; s.degHMoy /= s.nTri; }
    s.zELA = _interpELA(s);
    return s;
  }

  /* ── _interpELA ── E : sonde (zNeg, bNeg, zPos, bPos) → T : interpolation
     linéaire du zéro de bilan → S : altitude ELA (m) ou NaN. */
  function _interpELA(s) {
    if (isNaN(s.zNeg) || isNaN(s.zPos)) return NaN;
    var db = s.bPos - s.bNeg;
    if (Math.abs(db) < 1e-12) return (s.zNeg + s.zPos) / 2;
    return s.zNeg + (s.zPos - s.zNeg) * (-s.bNeg) / db;
  }

  /* ── fusionSondes ── E : sondes de tranches → T : sommes, maxima, moyennes
     pondérées, encadrement ELA le plus serré → S : sonde unique. */
  function fusionSondes(liste) {
    var s = {
      nTri: 0, nEnglaces: 0, nAccum: 0, nAblation: 0,
      accumTot: 0, fonteTot: 0, tasseTot: 0,
      hNMax: 0, hGMax: 0, degHMoy: 0, bilanMoy: 0,
      zNeg: NaN, bNeg: 0, zPos: NaN, bPos: 0, zELA: NaN
    };
    var wB = 0, wD = 0;
    for (var i = 0; i < liste.length; i++) {
      var u = liste[i];
      if (!u) continue;
      s.nTri += u.nTri; s.nEnglaces += u.nEnglaces;
      s.nAccum += u.nAccum; s.nAblation += u.nAblation;
      s.accumTot += u.accumTot; s.fonteTot += u.fonteTot;
      s.tasseTot += u.tasseTot;
      if (u.hNMax > s.hNMax) s.hNMax = u.hNMax;
      if (u.hGMax > s.hGMax) s.hGMax = u.hGMax;
      wB += u.bilanMoy * u.nTri; wD += u.degHMoy * u.nTri;
      if (!isNaN(u.zNeg) && (isNaN(s.zNeg) || u.zNeg > s.zNeg)) { s.zNeg = u.zNeg; s.bNeg = u.bNeg; }
      if (!isNaN(u.zPos) && (isNaN(s.zPos) || u.zPos < s.zPos)) { s.zPos = u.zPos; s.bPos = u.bPos; }
    }
    if (s.nTri > 0) { s.bilanMoy = wB / s.nTri; s.degHMoy = wD / s.nTri; }
    s.zELA = _interpELA(s);
    return s;
  }

  /* ── volumes ── E : etat, surfaces (m²), sonde (optionnelle) → T : Σ h·surf
     → S : { volNeige, volGlace } (m³ éq. eau), recopiés dans la sonde. */
  function volumes(etat, surf, sondeOut) {
    var vN = 0, vG = 0;
    for (var t = 0; t < surf.length; t++) {
      vN += etat.hNeige[t] * surf[t];
      vG += etat.hGlace[t] * surf[t];
    }
    if (sondeOut) { sondeOut.volNeige = vN; sondeOut.volGlace = vG; }
    return { volNeige: vN, volGlace: vG };
  }

  /* ── _opts ── E : K ou null → T : KDEF surchargé clé par clé → S : constantes. */
  function _opts(K) {
    if (!K) return KDEF;
    var o = {};
    for (var c in KDEF) o[c] = K[c] !== undefined ? K[c] : KDEF[c];
    return o;
  }

  return {
    KDEF: KDEF,
    degresHeures: degresHeures, pasTranche: pasTranche,
    fusionSondes: fusionSondes, volumes: volumes, _interpELA: _interpELA
  };

})();

/* ══ Pool de Workers ══════════════════════════════════════════════════
   Le bilan étant local, chaque Worker garde en propre une tranche
   contiguë de triangles et ses tables statiques. À chaque pas seuls le
   scalaire climatique et les deux tableaux d'épaisseur circulent.

   Cycle de vie :
     init(nTri, tables)    une fois, après construction du filet
     majFoehn(fC, fDT)     à chaque recalcul de foehn
     majSoleil(wSun73)     à chaque recalcul d'insolation
     pas(scal, hN, hG)     à chaque pas de temps
     fermer()

   Sans Worker disponible (Node, file:// restreint), tout bascule sur le
   fil principal sans changer l'API.                                     */

/* ── GLACPOOL (module) ── E : aucune → T : pool de 4 Workers au plus,
   chacun propriétaire d'une tranche contiguë de triangles → S : API
   init / majFoehn / majSoleil / pas / fermer. */
const GLACPOOL = (function () {

  var SRC = null, pool = [], parts = [], nMax = 4;
  var n = 0, nJours = 0, K = null, mono = null, prets = false;
  var derniereSonde = null;

  /* disponible — E : aucune → S : Worker et Blob existent ? */
  function disponible() {
    return typeof Worker !== 'undefined' && typeof Blob !== 'undefined';
  }

  /* source — E : aucune → T : sérialise KDEF, degresHeures, _interpELA,
     _opts, pasTranche et un onmessage (init, foehn, soleil, pas) ; mémorisé
     → S : texte du Worker. */
  function source() {
    if (SRC) return SRC;
    SRC =
      'var KDEF = ' + JSON.stringify(GLACIER.KDEF) + ';\n' +
      'var degresHeures = ' + GLACIER.degresHeures.toString() + ';\n' +
      'var _interpELA = ' + GLACIER._interpELA.toString() + ';\n' +
      'function _opts(K) {\n' +
      '  if (!K) return KDEF;\n' +
      '  var o = {};\n' +
      '  for (var c in KDEF) o[c] = K[c] !== undefined ? K[c] : KDEF[c];\n' +
      '  return o;\n' +
      '}\n' +
      'var pasTranche = ' + GLACIER.pasTranche.toString() + ';\n' +
      'var T = null, K = null, nLoc = 0;\n' +
      'onmessage = function (ev) {\n' +
      '  var m = ev.data;\n' +
      '  if (m.type === "init") {\n' +
      '    nLoc = m.nLoc; K = m.K;\n' +
      '    T = { z: m.z, cosT: m.cosT, actif: m.actif,\n' +
      '          fC: m.fC, fDT: m.fDT, wSun: m.wSun, nLoc: nLoc };\n' +
      '    postMessage({ type: "prete" }); return;\n' +
      '  }\n' +
      '  if (m.type === "foehn") { T.fC = m.fC; T.fDT = m.fDT;\n' +
      '    postMessage({ type: "prete" }); return; }\n' +
      '  if (m.type === "soleil") { T.wSun = m.wSun;\n' +
      '    postMessage({ type: "prete" }); return; }\n' +
      '  if (m.type === "pas") {\n' +
      '    var etat = { hNeige: m.hNeige, hGlace: m.hGlace };\n' +
      '    var s = pasTranche(T, etat, m.scal, 0, nLoc, K);\n' +
      '    postMessage({ type: "done", r0: m.r0, hNeige: m.hNeige,\n' +
      '                  hGlace: m.hGlace, sonde: s },\n' +
      '                [m.hNeige.buffer, m.hGlace.buffer]);\n' +
      '  }\n' +
      '};';
    return SRC;
  }

  /* creer — E : aucune → T : Worker depuis un Blob de source() → S : Worker. */
  function creer() {
    var blob = new Blob([source()], { type: 'application/javascript' });
    var url = URL.createObjectURL(blob);
    var w = new Worker(url);
    URL.revokeObjectURL(url);
    return w;
  }

  /* fermer — E : aucune → T : termine les Workers, remet l'état à vide → S : aucune. */
  function fermer() {
    for (var i = 0; i < pool.length; i++) pool[i].terminate();
    pool = []; parts = []; prets = false; mono = null;
  }

  /* _envoyer — E : Worker, message, transférables → T : poste, résout à la
     réponse, rejette sur erreur → S : Promise(réponse). */
  function _envoyer(wk, msg, transf) {
    return new Promise(function (resolve, reject) {
      wk.onmessage = function (ev) { resolve(ev.data); };
      wk.onerror = function (err) { reject(err); };
      wk.postMessage(msg, transf || []);
    });
  }

  /* _plein / _plein8 — E : longueur, valeur → S : Float32Array / Uint8Array rempli. */
  function _plein(len, v) { var a = new Float32Array(len); a.fill(v); return a; }
  function _plein8(len, v) { var a = new Uint8Array(len); a.fill(v); return a; }

  /* _trancherSun — E : cartes wSun (nJours × n), [r0, r1[ → T : extrait la
     sous-tranche de chaque carte → S : Uint8Array (nJours × nLoc) ou null. */
  function _trancherSun(wSun, r0, r1) {
    if (!wSun || nJours === 0) return null;
    var nLoc = r1 - r0;
    var out = new Uint8Array(nJours * nLoc);
    for (var sl = 0; sl < nJours; sl++)
      out.set(wSun.subarray(sl * n + r0, sl * n + r1), sl * nLoc);
    return out;
  }

  /* ── init ── E : nTri, tables { z, cosT, actif, fC, fDT, wSun73, K } → T :
     ferme l'ancien pool ; sans Worker, mode mono ; sinon découpe en tranches
     contiguës (≤ 4) et envoie à chaque Worker ses tables statiques →
     S : Promise(nombre de Workers, 0 en mono). */
  function init(nTri, tables) {
    fermer();
    tables = tables || {};
    n = nTri | 0;
    if (!(n > 0)) return Promise.reject(new Error('GLACPOOL.init : nTri invalide.'));
    if (!tables.z || tables.z.length !== n)
      return Promise.reject(new Error(
        'GLACPOOL.init : z de longueur ' + (tables.z ? tables.z.length : 'null') +
        ', attendu ' + n + '.'));

    K = tables.K || null;
    var wSun = tables.wSun73 || null;
    nJours = wSun ? Math.floor(wSun.length / n) : 0;

    var T = {
      z:     tables.z,
      cosT:  tables.cosT  || _plein(n, 1),
      actif: tables.actif || _plein8(n, 1),
      fC:    tables.fC    || _plein(n, 1),
      fDT:   tables.fDT   || new Float32Array(n),
      wSun:  wSun,
      nLoc:  n
    };

    if (!disponible()) {
      mono = T;
      parts = [{ r0: 0, r1: n }];
      prets = true;
      return Promise.resolve(0);
    }

    var nW = Math.min(nMax, (typeof navigator !== 'undefined' &&
                             navigator.hardwareConcurrency) || 4);
    var bande = Math.ceil(n / nW);
    parts = [];
    for (var w = 0; w < nW; w++) {
      var r0 = w * bande, r1 = Math.min(n, r0 + bande);
      if (r0 >= r1) break;
      parts.push({ r0: r0, r1: r1 });
    }

    var taches = parts.map(function (p) {
      var wk = creer();
      pool.push(wk);
      var msg = {
        type: 'init', nLoc: p.r1 - p.r0, K: K,
        z:     new Float32Array(T.z.subarray(p.r0, p.r1)),
        cosT:  new Float32Array(T.cosT.subarray(p.r0, p.r1)),
        actif: new Uint8Array(T.actif.subarray(p.r0, p.r1)),
        fC:    new Float32Array(T.fC.subarray(p.r0, p.r1)),
        fDT:   new Float32Array(T.fDT.subarray(p.r0, p.r1)),
        wSun:  _trancherSun(wSun, p.r0, p.r1)
      };
      var tr = [msg.z.buffer, msg.cosT.buffer, msg.actif.buffer,
                msg.fC.buffer, msg.fDT.buffer];
      if (msg.wSun) tr.push(msg.wSun.buffer);
      return _envoyer(wk, msg, tr);
    });

    return Promise.all(taches).then(function () {
      prets = true;
      return pool.length;
    });
  }

  /* ── majFoehn ── E : fC, fDT (nTri) → T : envoie à chaque Worker sa tranche
     → S : Promise(true). */
  function majFoehn(fC, fDT) {
    if (!prets) return Promise.reject(new Error('GLACPOOL.majFoehn : init() non appelé.'));
    if (mono) { mono.fC = fC; mono.fDT = fDT; return Promise.resolve(true); }
    return Promise.all(parts.map(function (p, i) {
      var a = new Float32Array(fC.subarray(p.r0, p.r1));
      var b = new Float32Array(fDT.subarray(p.r0, p.r1));
      return _envoyer(pool[i], { type: 'foehn', fC: a, fDT: b },
                      [a.buffer, b.buffer]);
    })).then(function () { return true; });
  }

  /* ── majSoleil ── E : wSun73 (73 × nTri) → T : envoie à chaque Worker ses
     tranches de cartes → S : Promise(true). */
  function majSoleil(wSun73) {
    if (!prets) return Promise.reject(new Error('GLACPOOL.majSoleil : init() non appelé.'));
    nJours = wSun73 ? Math.floor(wSun73.length / n) : 0;
    if (mono) { mono.wSun = wSun73; return Promise.resolve(true); }
    return Promise.all(parts.map(function (p, i) {
      var w = _trancherSun(wSun73, p.r0, p.r1);
      return _envoyer(pool[i], { type: 'soleil', wSun: w },
                      w ? [w.buffer] : []);
    })).then(function () { return true; });
  }

  /* ── pas ── E : scal, hNeige, hGlace (nTri, m éq. eau) → T : chaque Worker
     reçoit sa tranche, exécute pasTranche, renvoie ses épaisseurs recopiées
     en place ; sondes fusionnées → S : Promise(sonde du pas). */
  function pas(scal, hNeige, hGlace) {
    if (!prets)
      return Promise.reject(new Error(
        'GLACPOOL.pas : init(nTri, { z, cosT, actif, fC, fDT, wSun73, K }) ' +
        'non appelé.'));
    if (!scal || scal.tMer === undefined)
      return Promise.reject(new Error(
        'GLACPOOL.pas : scal doit porter { tMer, tSaison, bNeb, L, precJour, slice }.'));
    if (!hNeige || !hGlace || hNeige.length !== n || hGlace.length !== n)
      return Promise.reject(new Error(
        'GLACPOOL.pas : épaisseurs de longueur ' +
        (hNeige ? hNeige.length : 'null') + ' / ' +
        (hGlace ? hGlace.length : 'null') + ', attendu ' + n + '.'));

    if (mono) {
      derniereSonde = GLACIER.pasTranche(
        mono, { hNeige: hNeige, hGlace: hGlace }, scal, 0, n, K);
      return Promise.resolve(derniereSonde);
    }

    var sondes = new Array(parts.length);
    return Promise.all(parts.map(function (p, i) {
      var a = new Float32Array(hNeige.subarray(p.r0, p.r1));
      var b = new Float32Array(hGlace.subarray(p.r0, p.r1));
      return _envoyer(pool[i], { type: 'pas', r0: p.r0, scal: scal,
                                 hNeige: a, hGlace: b },
                      [a.buffer, b.buffer])
        .then(function (d) {
          hNeige.set(d.hNeige, d.r0);
          hGlace.set(d.hGlace, d.r0);
          sondes[i] = d.sonde;
        });
    })).then(function () {
      derniereSonde = GLACIER.fusionSondes(sondes);
      return derniereSonde;
    });
  }

  return {
    disponible: disponible, init: init, pas: pas,
    majFoehn: majFoehn, majSoleil: majSoleil, fermer: fermer,
    get sonde()  { return derniereSonde; },
    get pret()   { return prets; },
    get taille() { return pool.length; },
    get nJours() { return nJours; },
    get nMax()   { return nMax; }, set nMax(v) { nMax = Math.max(1, v | 0); }
  };

})();

if (typeof module !== "undefined" && module.exports)
  module.exports = { GLACIER: GLACIER, GLACPOOL: GLACPOOL };
