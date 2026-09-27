/* ═══════════════════════════════════════════════════════════════════
   FICHIER : dsm-worker-flux.js - v27/09/2026
   OBJET   : exécute DSMFLUX.pas (dsm-flux.js) en parallèle, un Worker
             persistant par bassin versant. Les lignes de partage des
             eaux (dsm-partage.js) découpent la tuile en quatre bassins
             (écoulement vers les bords N, E, S, O) sans échange de glace
             entre eux : chaque bassin est un sous-problème complet, résolu
             par son propre Worker. La source des Workers est
             DSMFLUX_FABRIQUE.toString() : un seul code de calcul, ni
             importScripts ni dépendance réseau, ouverture file:// possible.
   AUTEUR  : Eric P.
   RELECTURE : Opus 5.5
   DÉPEND  : dsm-flux.js (DSMFLUX_FABRIQUE, DSMFLUX)
   EXPOSE  : FLUXWORKER { init, pas, fermer, pret, appel, progres, nBassins }
   CONVENTIONS : une facette appartient au bassin du pixel de son
             barycentre ; une arête entre deux bassins est coupée.
   ═══════════════════════════════════════════════════════════════════ */

"use strict";

const FLUXWORKER = (function () {

  var _filet = null, _prete = false, _appel = 0, _progres = null;
  var _parts = [];        /* { bassin, idx (global), filet, adj, w, mono } */

  /* ── source ── E : aucune → T : concatène DSMFLUX_FABRIQUE.toString() et un
     onmessage à deux messages (init : garde filet/adj/opts ; pas : pose
     c1Tab/glissTab, appelle DSMFLUX.pas, renvoie glace, vx, vy, vit et sonde
     en transférables) ; les signes de vie du solveur sont relayés avec le
     numéro d'appel et le bassin → S : texte du Worker. */
  function source() {
    return '"use strict";\n' + DSMFLUX_FABRIQUE.toString() + '\n' +
      'var DSMFLUX = DSMFLUX_FABRIQUE();\n' +
      'var F = null, ADJ = null, APPEL = 0, BASSIN = -1;\n' +
      'DSMFLUX.progres = function (p) { p.type = "progres"; p.appel = APPEL; p.bassin = BASSIN; postMessage(p); };\n' +
      'onmessage = function (ev) {\n' +
      '  var m = ev.data;\n' +
      '  try {\n' +
      '    if (m.type === "init") {\n' +
      '      F = m.filet; ADJ = m.adj; BASSIN = m.bassin;\n' +
      '      for (var k in m.opts) DSMFLUX.config[k] = m.opts[k];\n' +
      '      postMessage({ type: "prete" }); return;\n' +
      '    }\n' +
      '    if (m.type === "pas") {\n' +
      '      APPEL = m.appel;\n' +
      '      DSMFLUX.config.c1Tab = m.c1Tab; DSMFLUX.config.glissTab = m.glissTab;\n' +
      '      var t0 = performance.now();\n' +
      '      DSMFLUX.pas(F, ADJ, m.g, m.dtJours, m.wantVit, m.phase, m.recale);\n' +
      '      var s = DSMFLUX.sonde; s.tSolve = performance.now() - t0;\n' +
      '      var cam = new Uint8Array(s.camion); s.camion = cam;\n' +
      '      var vx = new Float32Array(F.vx), vy = new Float32Array(F.vy), vit = new Float32Array(F.vit);\n' +
      '      postMessage({ type: "done", g: m.g, vx: vx, vy: vy, vit: vit, sonde: s },\n' +
      '                  [m.g.buffer, vx.buffer, vy.buffer, vit.buffer, cam.buffer]);\n' +
      '    }\n' +
      '  } catch (e) { postMessage({ type: "error", message: e.message }); }\n' +
      '};\n';
  }

  /* ── _envoyer ── E : Worker, message, transférables → T : poste ; résout
     au premier message « prete » ou « done », rejette sur « error » ou
     erreur du Worker ; mémorise les « progres » avec l'heure de réception
     → S : Promise(réponse). Un seul échange en cours par Worker. */
  function _envoyer(w, msg, tr) {
    return new Promise(function (resolve, reject) {
      w.onmessage = function (ev) {
        var d = ev.data;
        if (d.type === 'progres') { d.recu = performance.now(); _progres = d; return; }
        if (d.type === 'error') reject(new Error('FLUXWORKER bassin ' + msg.bassinNom + ' : ' + d.message));
        else resolve(d);
      };
      w.onerror = function (err) {
        if (err && err.preventDefault) err.preventDefault();
        reject(new Error('FLUXWORKER bassin ' + msg.bassinNom + ' : ' + ((err && err.message) || 'erreur')));
      };
      w.postMessage(msg, tr || []);
    });
  }

  /* ── _decouper ───────────────────────────────────────────────────────
     ENTRÉE     : filet, adj (graphe complet), étiquette de bassin par
                  facette (Uint8Array)
     TRAITEMENT : pour chaque bassin non vide : liste des facettes (indices
                  globaux), numérotation locale, sous-filet (surf, centIdx,
                  centZ), arêtes internes au bassin renumérotées avec leurs
                  grandeurs (len, dist, cs, rail), bords et mer ; les arêtes
                  qui franchissent une ligne de partage sont écartées
     SORTIE     : liste de { bassin, idx, filet, adj }
     ALGO       : « Partitionne le graphe d'écoulement en sous-graphes
                  disjoints, un par bassin versant. »
     ─────────────────────────────────────────────────────────────────── */
  function _decouper(filet, adj, lab) {
    var n = filet.nTri, loc = new Int32Array(n), cnt = [0, 0, 0, 0];
    for (var t = 0; t < n; t++) cnt[lab[t]]++;
    var parts = [];
    for (var b = 0; b < 4; b++) {
      if (!cnt[b]) continue;
      var idx = new Int32Array(cnt[b]), k = 0;
      for (var t1 = 0; t1 < n; t1++) if (lab[t1] === b) { loc[t1] = k; idx[k++] = t1; }
      var nE = 0;
      for (var e = 0; e < adj.n; e++) if (lab[adj.a[e]] === b && lab[adj.b[e]] === b) nE++;
      var sa = new Int32Array(nE), sb = new Int32Array(nE), sl = new Float32Array(nE),
          sd = new Float32Array(nE), sc = new Float32Array(nE), sr = new Int8Array(nE), j = 0;
      for (var e2 = 0; e2 < adj.n; e2++) {
        var a = adj.a[e2], c = adj.b[e2];
        if (lab[a] !== b || lab[c] !== b) continue;
        sa[j] = loc[a]; sb[j] = loc[c]; sl[j] = adj.len[e2]; sd[j] = adj.dist[e2];
        sc[j] = adj.cs[e2]; sr[j] = adj.rail ? adj.rail[e2] : 0; j++;
      }
      var m = idx.length;
      var fS = new Float32Array(m), fC = new Int32Array(m), fZ = new Float32Array(m);
      var bL = new Float32Array(m), bS = new Float32Array(m), mer = new Uint8Array(m);
      for (var q = 0; q < m; q++) {
        var g = idx[q];
        fS[q] = filet.surf[g]; fC[q] = filet.centIdx[g]; fZ[q] = filet.centZ[g];
        if (adj.bordL) { bL[q] = adj.bordL[g]; bS[q] = adj.bordS[g]; }
        if (adj.mer) mer[q] = adj.mer[g];
      }
      parts.push({
        bassin: b, idx: idx,
        filet: { nTri: m, surf: fS, centIdx: fC, centZ: fZ },
        adj: { n: nE, a: sa, b: sb, len: sl, dist: sd, cs: sc, rail: sr, mode: adj.mode,
               bordL: bL, bordS: bS, mer: mer }
      });
    }
    return parts;
  }

  /* ── init ───────────────────────────────────────────────────────────
     ENTRÉE     : filet (nTri, surf, centIdx, centZ), adj (DSMFLUX.adjacence
                  sur le filet complet), opts { E, c1, gliss, … },
                  bassinsPix Uint8Array 1024² (DSMPARTAGE.bassins) ou null
     TRAITEMENT : ferme les Workers précédents ; étiquette chaque facette
                  par le bassin de son pixel central (sans étiquettes : un
                  seul bassin) ; découpe (_decouper) ; recopie opts dans
                  DSMFLUX.config ; un Worker par bassin, qui reçoit une fois
                  son sous-filet et son sous-graphe ; sans Worker, mode
                  mono (bassins traités l'un après l'autre sur place)
     SORTIE     : Promise(nombre de bassins)
     ALGO       : « Un Worker d'écoulement persistant par bassin versant. »
     ─────────────────────────────────────────────────────────────────── */
  function init(filet, adj, opts, bassinsPix) {
    fermer();
    if (!filet || !filet.nTri)
      return Promise.reject(new Error('FLUXWORKER.init : filet invalide.'));
    if (!adj || !adj.n)
      return Promise.reject(new Error(
        'FLUXWORKER.init : adjacence absente — appeler ' +
        'DSMFLUX.adjacence(filet, scaleXY, mode) d\'abord.'));
    _filet = filet;
    var o = {};
    if (opts) for (var k in opts)
      if (opts[k] !== undefined && k !== 'c1Tab' && k !== 'glissTab') o[k] = opts[k];
    for (var k2 in o) DSMFLUX.config[k2] = o[k2];

    var lab = new Uint8Array(filet.nTri);
    if (bassinsPix)
      for (var t = 0; t < filet.nTri; t++) {
        var v = bassinsPix[filet.centIdx[t]];
        lab[t] = v < 4 ? v : 0;
      }
    _parts = _decouper(filet, adj, lab);

    if (typeof Worker === 'undefined' || typeof Blob === 'undefined') {
      _parts.forEach(function (p) { p.mono = true; });
      _prete = true;
      return Promise.resolve(_parts.length);
    }
    var url = URL.createObjectURL(new Blob([source()], { type: 'application/javascript' }));
    var noms = ['N', 'E', 'S', 'O'];
    var taches = _parts.map(function (p) {
      p.w = new Worker(url);
      return _envoyer(p.w, { type: 'init', bassin: p.bassin, bassinNom: noms[p.bassin],
                             filet: p.filet, adj: p.adj, opts: o });
    });
    URL.revokeObjectURL(url);
    return Promise.all(taches).then(function () {
      _prete = true;
      console.log('[FLUXWORKER] ' + _parts.length + ' bassin(s) en parallèle : ' +
        _parts.map(function (p) { return noms[p.bassin] + ' ' + p.filet.nTri + ' fac.'; }).join(' | '));
      return _parts.length;
    });
  }

  /* ── _fusionnerSondes ── E : sondes par bassin, parties → T : sommes des
     compteurs et volumes, maxima (segments, écarts, temps), drapeaux « au
     moins un bassin », top 3 global remis en indices globaux, carte des
     fronts épais (camion) réassemblée → S : sonde unique au format
     DSMFLUX.sonde. */
  function _fusionnerSondes(sondes, parts, nTri) {
    var s = { top: [], neg: 0, seg: 0, picard: 0, picNonConv: 0, dPic: 0, gs: 0, cg: 0,
              nonConv: 0, nonConvMax: 0, recale: 0, recaleAuto: 0, phase: 0,
              camion: new Uint8Array(nTri), camionN: 0, postierN: 0, postierM3: 0,
              libM: 0, sortieM3: 0, velageM3: 0, tSolve: 0, bassins: sondes.length };
    for (var i = 0; i < sondes.length; i++) {
      var u = sondes[i], idx = parts[i].idx;
      s.neg += u.neg; s.picard += u.picard; s.picNonConv += u.picNonConv;
      s.gs += u.gs; s.cg += u.cg; s.nonConv += u.nonConv;
      s.camionN += u.camionN; s.postierN += u.postierN;
      s.postierM3 += u.postierM3; s.libM += u.libM;
      s.sortieM3 += u.sortieM3; s.velageM3 += u.velageM3;
      if (u.seg > s.seg) s.seg = u.seg;
      if (u.dPic > s.dPic) s.dPic = u.dPic;
      if (u.nonConvMax > s.nonConvMax) s.nonConvMax = u.nonConvMax;
      if ((u.tSolve || 0) > s.tSolve) s.tSolve = u.tSolve;
      if (u.recale) s.recale = 1;
      if (u.recaleAuto) s.recaleAuto = 1;
      s.phase = u.phase;
      for (var q = 0; q < u.camion.length; q++) if (u.camion[q]) s.camion[idx[q]] = 1;
      for (var k = 0; k < u.top.length; k++) {
        var r = u.top[k];
        s.top.push({ up: idx[r.up], dn: idx[r.dn], dV: r.dV, Hu: r.Hu, Hd: r.Hd });
      }
    }
    s.top.sort(function (x, y) { return y.dV - x.dV; });
    s.top.length = Math.min(3, s.top.length);
    s.postierM3 = +s.postierM3.toFixed(2); s.libM = +s.libM.toFixed(1);
    s.sortieM3 = +s.sortieM3.toFixed(2); s.velageM3 = +s.velageM3.toFixed(2);
    return s;
  }

  /* ── pas ────────────────────────────────────────────────────────────
     ENTRÉE     : filet, glaceWE Float32Array (m éq. eau, nTri), dtJours,
                  wantVit, phase (0..72), recale
     TRAITEMENT : pour chaque bassin, extrait sa glace, son c1Tab et son
                  glissTab (DSMFLUX.config) par ses indices globaux ; tous les
                  bassins partent en même temps ; au retour, glace, vx, vy,
                  vit réinjectés aux indices globaux ; sondes fusionnées
     SORTIE     : Promise(glaceWE mis à jour en place) ; filet.vx/vy/vit,
                  DSMFLUX.sonde
     ALGO       : « Un pas d'écoulement par bassin, tous les bassins en
                  parallèle, résultats rassemblés. »
     ─────────────────────────────────────────────────────────────────── */
  function pas(filet, glaceWE, dtJours, wantVit, phase, recale) {
    if (!_prete)
      return Promise.reject(new Error('FLUXWORKER.pas : init(filet, adj, opts) non appelé.'));
    var F = filet || _filet, n = F.nTri;
    if (!glaceWE || glaceWE.length !== n)
      return Promise.reject(new Error(
        'FLUXWORKER.pas : glaceWE de longueur ' + (glaceWE ? glaceWE.length : 'null') +
        ', attendu ' + n + '.'));
    var cfg = DSMFLUX.config, noms = ['N', 'E', 'S', 'O'];
    _appel++;
    if (!F.vx || F.vx.length !== n) { F.vx = new Float32Array(n); F.vy = new Float32Array(n); F.vit = new Float32Array(n); }

    function extraire(src, idx) {
      if (!src) return null;
      var out = new Float32Array(idx.length);
      for (var q = 0; q < idx.length; q++) out[q] = src[idx[q]];
      return out;
    }
    var c1G = cfg.c1Tab, glG = cfg.glissTab;
    var taches = _parts.map(function (p) {
      var g = extraire(glaceWE, p.idx), c1 = extraire(c1G, p.idx), gl = extraire(glG, p.idx);
      if (p.mono) {
        return Promise.resolve().then(function () {
          cfg.c1Tab = c1; cfg.glissTab = gl;
          var t0 = performance.now();
          DSMFLUX.pas(p.filet, p.adj, g, dtJours, wantVit, phase, recale);
          cfg.c1Tab = c1G; cfg.glissTab = glG;
          var s = DSMFLUX.sonde; s.tSolve = performance.now() - t0;
          return { g: g, vx: p.filet.vx, vy: p.filet.vy, vit: p.filet.vit, sonde: s };
        });
      }
      var tr = [g.buffer];
      if (c1) tr.push(c1.buffer);
      if (gl) tr.push(gl.buffer);
      return _envoyer(p.w, { type: 'pas', bassinNom: noms[p.bassin], appel: _appel, g: g,
                             c1Tab: c1, glissTab: gl, dtJours: dtJours,
                             wantVit: !!wantVit, phase: phase, recale: !!recale }, tr);
    });
    return Promise.all(taches).then(function (rep) {
      var sondes = [];
      for (var i = 0; i < rep.length; i++) {
        var idx = _parts[i].idx, d = rep[i];
        for (var q = 0; q < idx.length; q++) {
          var t = idx[q];
          glaceWE[t] = d.g[q];
          F.vx[t] = d.vx[q]; F.vy[t] = d.vy[q]; F.vit[t] = d.vit[q];
        }
        sondes.push(d.sonde);
      }
      DSMFLUX.sonde = _fusionnerSondes(sondes, _parts, n);
      return glaceWE;
    });
  }

  /* ── fermer ── E : aucune → T : termine les Workers, oublie le découpage
     → S : aucune. */
  function fermer() {
    _parts.forEach(function (p) { if (p.w) p.w.terminate(); });
    _parts = []; _filet = null; _prete = false;
  }

  return {
    init: init, pas: pas, fermer: fermer,
    get pret() { return _prete; },
    get appel() { return _appel; },
    get progres() { return _progres; },
    get nBassins() { return _parts.length; }
  };

})();

if (typeof module !== "undefined" && module.exports)
  module.exports.FLUXWORKER = FLUXWORKER;
