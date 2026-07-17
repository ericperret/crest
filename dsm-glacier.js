/*
 * dsm-glacier.js
 * Projet  : DSM Viewer — module simulation glacier
 * Rôle    : Orchestre la simulation glacier :
 *             - Construit state + cfg depuis ombreElev1024 + GEO
 *             - Calcule state.smb (PDD) depuis tempCarte (dsm-temp.js)
 *             - Délègue IGMICEFLOW.update + IGMTHK.update à un Blob Worker
 *             - Dessine overlay épaisseur + flèches vitesse (ubar,vbar réels IGM)
 * Dépend  : dsm.html : GEO, ombreElev1024, OMBRE_DIM, ctrlTka, render, glacierOsc
 *           dsm-temp.js : tempCarte
 *           igm-*.js : chargés dans le Worker via importScripts
 * Auteur  : DSM Glacier
 * Date    : 2026-06-13
 * Version : 2.6.0  (2026-06-13 : slope_type godunov ; cf. fix signature igm-thk)
 *
 * Physique :
 *   SMB   = accum(T,P) − fonte_PDD(T)            [m glace/an]
 *   THK   = IGMTHK → h += dt·(smb − divflux)     conservation masse
 *   U,V   = IGMICEFLOW (method=solved)            Blatter-Pattyn/Glen
 *   ubar  = intégration verticale depuis U        vitesse moyenne
 */

"use strict";

const GLACIER = (() => {

  // ── PDD (Positive Degree Day) ────────────────────────────────
  const RHO_EAU   = 1000;
  const RHO_GLACE = 917;   // unifiée (audit constantes) — valeur standard
  const EAU_GLACE = RHO_EAU / RHO_GLACE;

  let _ddfNeige = 1.1;   // m glace / °C·an  (Hock 2003)
  let _ddfGlace = 2.9;   // m glace / °C·an
  const THR_SNOW = 0.0;
  const THR_RAIN = 2.0;

  const DIM = 1024;
  const N   = DIM * DIM;

  // ── État ─────────────────────────────────────────────────────
  let _running    = false;
  let _timer      = null;
  let _worker     = null;
  let _workerBusy = false;
  let _workerReady= false;
  let _readyTimer = null;

  let _state      = null;
  let _cfg        = null;
  let _oscGlace   = null;
  let _showArrows = true;

  let _precip = 100;
  let _dtAns  = 20;          // pas fixe en ans (slider « Pas » retiré du GUI)
  const GLAC_YEAR0    = -20000;  // démarrage : Dernier Maximum Glaciaire
  const GLAC_YEAR_END = 2024;    // arrêt : présent
  let _cbStep = null;

  // ── cfg IGM — valeurs physiques depuis iceflow.yaml IGM source ──
  function _buildCfg(Ny, Nx, dx) {
    return {
      processes: {
        iceflow: {
          method: "solved",
          force_max_velbar: 0,
          physics: {
            energy_components: ["viscosity", "gravity", "sliding"],
            sliding: {
              law: "weertman",
              use_mask_gr: false,
              weertman: { regu: 1e-10, exponent: 3.0, u_ref: 1.0 },
            },
            gravity_cst: 9.81, ice_density: 917.0, water_density: 1000.0,
            init_slidingco: 0.0464, init_arrhenius: 78.0,
            enhancement_factor: 1.0, exp_glen: 3.0,
            regu_glen: 1e-5, thr_ice_thk: 0.1,
            min_sr: 1e-20, max_sr: 1e20,
            force_negative_gravitational_energy: false, cf_eswn: [],
          },
          numerics: {
            precision: "single", Nz: 10, vert_spacing: 4.0,
            basis_horizontal: "central", basis_vertical: "lagrange",
          },
          solver: {
            nbitmax: 8, optimizer: "adam", print_cost: false,
            fieldin: ["thk", "usurf", "arrhenius", "slidingco", "dX"],
          },
          unified: {
            inputs: ["thk", "usurf", "arrhenius", "slidingco", "dX"],
            bcs: [], nbit: 8, adam: { lr: 1e-3 },
          },
        },
        thk: { calving_front: false, ratio_density: 1.13, slope_type: "godunov" },
        time: { cfl: 0.3, dt_max: _dtAns, dt_min: 0.1 },
      },
      grid: { Ny, Nx, dx, dy: dx },
    };
  }

  // ── state IGM initial ────────────────────────────────────────
  function _buildState(Ny, Nx, dx) {
    const x = new Float32Array(Nx); for (let i=0;i<Nx;i++) x[i]=i*dx;
    const y = new Float32Array(Ny); for (let j=0;j<Ny;j++) y[j]=j*dx;
    const topg  = new Float32Array(ombreElev1024);
    const thk   = new Float32Array(N);
    const usurf = new Float32Array(topg);
    const lsurf = new Float32Array(topg);
    return {
      x, y, dx, dy: dx, thk_Ny: Ny, thk_Nx: Nx,
      topg, thk, lsurf, usurf, smb: new Float32Array(N),
      t: 0, it: 0, dt: _dtAns,
      iceflow_initialized: false, iceflow: null, logger: null,
    };
  }

  // ── SMB (Main Thread) ────────────────────────────────────────
  function _computeSmb(state) {
    const Tmoy  = tempCarte(ctrlTka());
    const precM = (_precip / 100) * EAU_GLACE;
    for (let i = 0; i < N; i++) {
      const T = Tmoy[i];
      if (state.topg[i] <= 0.5) { state.smb[i] = 0; continue; }
      let fSnow = 0;
      if      (T <= THR_SNOW) fSnow = 1;
      else if (T <  THR_RAIN) fSnow = (THR_RAIN - T) / (THR_RAIN - THR_SNOW);
      const accum      = precM * fSnow;
      const Tpos       = T > 0 ? T : 0;
      const fonteNeige = _ddfNeige * Tpos;
      const fonteGlace = fonteNeige > accum ? _ddfGlace * Tpos : 0;
      state.smb[i] = accum - fonteNeige - fonteGlace;
    }
  }

  // ── Blob Worker ──────────────────────────────────────────────
  const IGM_SCRIPTS = [
    "igm-math.js", "igm-stag.js", "igm-grad.js",
    "igm-vertical.js", "igm-horizontal.js",
    "igm-iceflowutils_final.js", "igm-energy.js", "igm-gradient.js",
    "igm-unified_final.js", "igm-solve.js",
    "igm-iceflow.js", "igm-thk.js", "igm-complete-data.js",
  ];

  function _workerCode() { return `
"use strict";
let _cfg = null, _state = null, _ready = false;

// Capture globale — toute erreur non gérée remonte au Main
self.onerror = function(msg, src, line, col, err) {
  self.postMessage({ type:"error", msg:"WORKER onerror: "+msg+" @"+line+":"+col });
  return true;
};

self.postMessage({ type:"log", msg:"worker script chargé, attente init" });

self.addEventListener("message", function _boot(e) {
  if (e.data.type !== "init") return;
  self.removeEventListener("message", _boot);
  const base = e.data.base;
  self.postMessage({ type:"log", msg:"init reçu, base="+base });

  const scripts = ${JSON.stringify(IGM_SCRIPTS)}.map(s => base + s);
  // Importer un par un pour identifier lequel échoue
  for (let i = 0; i < scripts.length; i++) {
    try {
      importScripts(scripts[i]);
      self.postMessage({ type:"log", msg:"[" + (i+1) + "/" + scripts.length + "] OK " + scripts[i].split("/").pop() });
    } catch(err) {
      self.postMessage({ type:"error", msg:"importScripts ÉCHEC sur " + scripts[i] + " : " + err.message });
      return;
    }
  }

  // Réexposer les namespaces (const lexicaux → globalThis pour _dep)
  try { globalThis.IGMMATH         = IGMMATH;         } catch(_){}
  try { globalThis.IGMSTAG         = IGMSTAG;         } catch(_){}
  try { globalThis.IGMGRAD         = IGMGRAD;         } catch(_){}
  try { globalThis.IGMVERTICAL     = IGMVERTICAL;     } catch(_){}
  try { globalThis.IGMHORIZONTAL   = IGMHORIZONTAL;   } catch(_){}
  try { globalThis.IGMICEFLOWUTILS = IGMICEFLOWUTILS; } catch(_){}
  try { globalThis.IGMENERGY       = IGMENERGY;       } catch(_){}
  try { globalThis.IGMUNIFIED      = IGMUNIFIED;      } catch(_){}
  try { globalThis.IGMSOLVE        = IGMSOLVE;        } catch(_){}
  try { globalThis.IGMICEFLOW      = IGMICEFLOW;      } catch(_){}
  try { globalThis.IGMTHK          = IGMTHK;          } catch(_){}
  try { globalThis.IGMCOMPLETEDATA = IGMCOMPLETEDATA; } catch(_){}

  // Vérifier que les namespaces critiques sont là
  const manquants = [];
  ["IGMMATH","IGMGRAD","IGMVERTICAL","IGMHORIZONTAL","IGMICEFLOWUTILS",
   "IGMENERGY","IGMUNIFIED","IGMSOLVE","IGMICEFLOW","IGMTHK","IGMCOMPLETEDATA"]
    .forEach(n => { if (typeof globalThis[n] === "undefined") manquants.push(n); });
  if (manquants.length) {
    self.postMessage({ type:"error", msg:"namespaces manquants après import: " + manquants.join(", ") });
    return;
  }

  _ready = true;
  self.postMessage({ type:"ready" });
  self.postMessage({ type:"log", msg:"READY — tous modules chargés" });

  self.addEventListener("message", function onMsg(e) {
    const msg = e.data;
    if (msg.type === "stop") { self.close(); return; }
    if (msg.type !== "step") return;

    // Reconstituer les TypedArrays depuis les buffers transférés
    const s = msg.state;
    const state = {
      x     : new Float32Array(s.x),
      y     : new Float32Array(s.y),
      dx    : s.dx, dy: s.dy,
      thk_Ny: s.thk_Ny, thk_Nx: s.thk_Nx,
      topg  : new Float32Array(s.topg),
      thk   : new Float32Array(s.thk),
      lsurf : new Float32Array(s.lsurf),
      usurf : new Float32Array(s.usurf),
      smb   : new Float32Array(s.smb),
      U     : s.U    ? new Float32Array(s.U)    : undefined,
      V     : s.V    ? new Float32Array(s.V)    : undefined,
      ubar  : s.ubar ? new Float32Array(s.ubar) : undefined,
      vbar  : s.vbar ? new Float32Array(s.vbar) : undefined,
      arrhenius : s.arrhenius ? new Float32Array(s.arrhenius) : undefined,
      slidingco : s.slidingco ? new Float32Array(s.slidingco) : undefined,
      t: s.t, it: s.it, dt: s.dt,
      iceflow_initialized: false,
      iceflow: null,
      logger: null,
    };
    const cfg = msg.cfg;

    const t0 = (self.performance && performance.now) ? performance.now() : Date.now();
    try {
      self.postMessage({ type:"log", msg:"step START it="+state.it });
      IGMCOMPLETEDATA.completeData(state, { include: true, value: 0 });
      self.postMessage({ type:"log", msg:"  completeData OK (dX len="+(state.dX?state.dX.length:0)+")" });
      state.iceflow_initialized = false;
      IGMICEFLOW.initialize(cfg, state);
      self.postMessage({ type:"log", msg:"  initialize OK (Nz="+(state.iceflow&&state.iceflow.discr_v?state.iceflow.discr_v.V_b.length:"?")+")" });
      // Étape 4 — l'écoulement ne se calcule QUE s'il y a de la glace à faire glisser.
      // Tant que la glace est négligeable : neige tombe / s'épaissit = pure accumulation, zéro solveur.
      let _hmax = 0; const _thk = state.thk;
      for (let i = 0; i < _thk.length; i++) if (_thk[i] > _hmax) _hmax = _thk[i];
      if (_hmax >= 3.0) {
        IGMICEFLOW.update(cfg, state);
        self.postMessage({ type:"log", msg:"  iceflow.update OK (hmax="+_hmax.toFixed(1)+" m, ubar len="+(state.ubar?state.ubar.length:0)+")" });
      } else {
        const _N = _thk.length;
        state.ubar = new Float32Array(_N);
        state.vbar = new Float32Array(_N);
        self.postMessage({ type:"log", msg:"  écoulement ignoré — glace < 3 m (hmax="+_hmax.toFixed(3)+" m), pure accumulation" });
      }
      IGMTHK.update(cfg, state);
      self.postMessage({ type:"log", msg:"  thk.update OK" });
      state.t  += state.dt;
      state.it += 1;
      const dtms = ((self.performance&&performance.now)?performance.now():Date.now()) - t0;
      self.postMessage({ type:"log", msg:"step END it="+state.it+" en "+dtms.toFixed(0)+" ms" });

      const transferList = [
        state.thk.buffer, state.usurf.buffer,
        ...(state.ubar ? [state.ubar.buffer]  : []),
        ...(state.vbar ? [state.vbar.buffer]  : []),
        ...(state.U    ? [state.U.buffer]     : []),
        ...(state.V    ? [state.V.buffer]     : []),
        ...(state.arrhenius ? [state.arrhenius.buffer] : []),
        ...(state.slidingco ? [state.slidingco.buffer] : []),
      ];

      self.postMessage({
        type : "result",
        thk  : state.thk.buffer,
        usurf: state.usurf.buffer,
        ubar : state.ubar ? state.ubar.buffer : null,
        vbar : state.vbar ? state.vbar.buffer : null,
        U    : state.U    ? state.U.buffer    : null,
        V    : state.V    ? state.V.buffer    : null,
        arrhenius: state.arrhenius ? state.arrhenius.buffer : null,
        slidingco: state.slidingco ? state.slidingco.buffer : null,
        t    : state.t,  it: state.it,  dt: state.dt,
      }, transferList);

    } catch(err) {
      self.postMessage({ type:"error", msg: err.message+"\\n"+(err.stack||"") });
    }
  });
});
`; }

  function _createWorker() {
    console.log("[GLACIER] création worker…");
    let blob, url, w;
    try {
      blob = new Blob([_workerCode()], { type: "application/javascript" });
      url  = URL.createObjectURL(blob);
      w    = new Worker(url);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("[GLACIER] échec création Worker:", err.message);
      return null;
    }

    const base = location.href.replace(/[^/]*$/, "");
    console.log("[GLACIER] base URL =", base);

    w.onmessage = _onMsg;
    w.onerror = (e) => {
      console.error("[GLACIER] Worker.onerror:", e.message || e,
                    "@", e.filename, e.lineno + ":" + e.colno);
      e.preventDefault && e.preventDefault();
      _workerBusy = false;
    };
    w.onmessageerror = (e) => {
      console.error("[GLACIER] Worker.onmessageerror (clonage échoué):", e);
    };

    // Watchdog : si pas de "ready" sous 5 s, alerter (importScripts file:// bloqué ?)
    _readyTimer = setTimeout(() => {
      if (!_workerReady) {
        console.error("[GLACIER] ⏱ TIMEOUT — pas de 'ready' après 5 s. " +
          "Cause probable : importScripts() bloqué (file:// + blob worker). " +
          "Servir via http (python3 -m http.server) au lieu de file://.");
      }
    }, 5000);

    console.log("[GLACIER] envoi init au worker");
    w.postMessage({ type: "init", base });
    return w;
  }

  function _onMsg(e) {
    const msg = e.data;
    if (msg.type === "log") { console.log("[GLACIER:worker]", msg.msg); return; }
    if (msg.type === "ready") {
      console.log("[GLACIER] ✓ worker READY");
      _workerReady = true;
      if (_readyTimer) { clearTimeout(_readyTimer); _readyTimer = null; }
      _workerBusy = false;
      if (_running) _sendStep();
      return;
    }
    if (msg.type === "error") {
      console.error("[GLACIER] ✗", msg.msg);
      _workerBusy = false; _running = false;
      return;
    }
    if (msg.type === "result") {
      _state.thk   = new Float32Array(msg.thk);
      _state.usurf = new Float32Array(msg.usurf);
      _state.ubar  = msg.ubar ? new Float32Array(msg.ubar) : null;
      _state.vbar  = msg.vbar ? new Float32Array(msg.vbar) : null;
      _state.U     = msg.U    ? new Float32Array(msg.U)    : null;
      _state.V     = msg.V    ? new Float32Array(msg.V)    : null;
      _state.arrhenius = msg.arrhenius ? new Float32Array(msg.arrhenius) : null;
      _state.slidingco = msg.slidingco ? new Float32Array(msg.slidingco) : null;
      _state.t     = msg.t;
      _state.it    = msg.it;
      _state.dt    = msg.dt;
      _dessiner();
      if (_cbStep) _cbStep(_state.t, _state.thk, _state.ubar, _state.vbar);
      _workerBusy = false;
      if (GLAC_YEAR0 + _state.t >= GLAC_YEAR_END) { stop(); return; }   // présent atteint
      if (_running) _timer = setTimeout(_sendStep, 10);
    }
  }

  function _sendStep() {
    if (_workerBusy || !_worker || !_state) {
      console.log("[GLACIER] _sendStep ignoré (busy=" + _workerBusy +
                  " worker=" + !!_worker + " state=" + !!_state + ")");
      return;
    }
    _workerBusy = true;
    // Année glacier = -20000 + t ; pilote le climat (ctrlAnnee → ctrlTka → _computeSmb)
    let _annee = GLAC_YEAR0 + _state.t;
    if (_annee > GLAC_YEAR_END) _annee = GLAC_YEAR_END;
    if (typeof ctrlAnnee !== "undefined") {
      ctrlAnnee = Math.round(_annee);
      const _e = (typeof document !== "undefined") && document.getElementById("ctrl-val-0");
      if (_e) _e.textContent = ctrlAnnee.toLocaleString("fr-FR").replace(/\u202f/g, "\u00a0");
    }
    _computeSmb(_state);
    console.log("[GLACIER] → envoi step it=" + _state.it);
    _worker.postMessage({
      type: "step", cfg: _cfg,
      state: {
        x: _state.x, y: _state.y, dx: _state.dx, dy: _state.dy,
        thk_Ny: _state.thk_Ny, thk_Nx: _state.thk_Nx,
        topg  : _state.topg,   thk  : _state.thk,
        lsurf : _state.lsurf,  usurf: _state.usurf,
        smb   : _state.smb,
        U     : _state.U    || null,
        V     : _state.V    || null,
        ubar  : _state.ubar || null,
        vbar  : _state.vbar || null,
        arrhenius: _state.arrhenius || null,
        slidingco: _state.slidingco || null,
        t: _state.t, it: _state.it, dt: _state.dt,
      },
    });
  }

  // ── Rendu overlay ────────────────────────────────────────────
  function _dessiner() {
    if (!_oscGlace || !_state) return;
    const ctx2 = _oscGlace.getContext("2d");
    const imgd = ctx2.createImageData(DIM, DIM);
    const d    = imgd.data;

    let hMax = 0.1;
    for (let i = 0; i < N; i++) if (_state.thk[i] > hMax) hMax = _state.thk[i];

    for (let i = 0; i < N; i++) {
      const h = _state.thk[i];
      if (h < 0.05) continue;
      const t   = Math.min(1, h / hMax);
      const p   = i << 2;
      d[p]   = 0;                                // pas de rouge → jamais blanc
      d[p+1] = Math.round(220 - t * 200);        // G : cyan (220) → bleu (20)
      d[p+2] = 255;                              // B constant
      d[p+3] = Math.min(235, 110 + t * 130) | 0; // opacité : visible dès la glace fine
    }
    ctx2.putImageData(imgd, 0, 0);

    if (_showArrows && _state.ubar && _state.vbar) _dessinerFleches(ctx2);

    if (typeof glacierOsc !== "undefined" && glacierOsc) {
      const c2 = glacierOsc.getContext("2d");
      c2.clearRect(0, 0, DIM, DIM);
      c2.drawImage(_oscGlace, 0, 0);
    }
    if (typeof render === "function") render();
  }

  function _dessinerFleches(ctx2) {
    const PAS = 16, LONG = 7;
    const ubar = _state.ubar, vbar = _state.vbar;
    let vmax = 0.01;
    for (let i = 0; i < N; i++) {
      if (_state.thk[i] < 0.05) continue;
      const v = Math.sqrt(ubar[i]*ubar[i] + vbar[i]*vbar[i]);
      if (v > vmax) vmax = v;
    }
    ctx2.save(); ctx2.lineWidth = 1.2;
    for (let py = PAS>>1; py < DIM; py += PAS) {
      for (let px = PAS>>1; px < DIM; px += PAS) {
        const i  = py * DIM + px;
        if (_state.thk[i] < 0.05) continue;
        const vx = ubar[i], vy = vbar[i];
        const v  = Math.sqrt(vx*vx + vy*vy);
        if (v < 0.01) continue;
        const t  = Math.log(1 + v / vmax * 9) / Math.LN10;
        const r  = t < 0.5 ? 0 : Math.round((t-0.5)*2*255);
        const g  = t < 0.5 ? Math.round(t*2*200) : Math.round((1-(t-0.5)*2)*200);
        const b  = t < 0.5 ? Math.round(255*(1-t)) : 0;
        const col = `rgba(${r},${g},${b},0.88)`;
        ctx2.strokeStyle = col; ctx2.fillStyle = col;
        const nx = vx/v, ny = vy/v;
        const L  = 2 + t*(LONG-2);
        ctx2.beginPath();
        ctx2.moveTo(px - nx*L*0.5, py - ny*L*0.5);
        ctx2.lineTo(px + nx*L*0.5, py + ny*L*0.5);
        ctx2.stroke();
        const ex = px+nx*L*0.5, ey = py+ny*L*0.5;
        const px2=-ny, py2=nx;
        ctx2.beginPath();
        ctx2.moveTo(ex, ey);
        ctx2.lineTo(ex-nx*3.5+px2*1.8, ey-ny*3.5+py2*1.8);
        ctx2.lineTo(ex-nx*3.5-px2*1.8, ey-ny*3.5-py2*1.8);
        ctx2.closePath(); ctx2.fill();
      }
    }
    ctx2.restore();
  }

  // ── Statistiques ─────────────────────────────────────────────
  function stats() {
    if (!_state) return { annee:"0", volGlace:"0.000", surface:"0", vmax:"0" };
    const dlon = GEO.lonMax - GEO.lonMin;
    const dlat = GEO.latMax - GEO.latMin;
    const lat0 = (GEO.latMax + GEO.latMin) / 2 * Math.PI / 180;
    const dx   = dlon * 111320 * Math.cos(lat0) / DIM;
    const dy   = dlat * 111320 / DIM;
    const aire = dx * dy;
    let vol=0, surf=0, vmax=0;
    for (let i=0; i<N; i++) {
      if (_state.thk[i] > 0.05) { vol += _state.thk[i]*aire; surf += aire; }
      if (_state.ubar) {
        const v = Math.sqrt(_state.ubar[i]**2 + (_state.vbar?_state.vbar[i]**2:0));
        if (v > vmax) vmax = v;
      }
    }
    return {
      annee   : Math.round(GLAC_YEAR0 + _state.t).toLocaleString("fr-FR"),
      volGlace: (vol/1e9).toFixed(3),
      surface : (surf/1e6).toFixed(1),
      vmax    : vmax.toFixed(1),
    };
  }

  // ── API publique ─────────────────────────────────────────────
  function init() {
    console.log("[GLACIER] init() appelé");
    if (!ombreElev1024 || !GEO) {
      console.error("[GLACIER] init échoué : ombreElev1024=" + !!ombreElev1024 +
                    " GEO=" + !!GEO + " (charger un DSM d'abord)");
      return false;
    }
    const Ny=DIM, Nx=DIM;
    const dlon = GEO.lonMax - GEO.lonMin;
    const lat0 = (GEO.latMax+GEO.latMin)/2 * Math.PI/180;
    const dx   = dlon * 111320 * Math.cos(lat0) / Nx;
    console.log("[GLACIER] grille " + Ny + "×" + Nx + " dx=" + dx.toFixed(1) + " m");
    _cfg        = _buildCfg(Ny, Nx, dx);
    _state      = _buildState(Ny, Nx, dx);
    _oscGlace   = new OffscreenCanvas(DIM, DIM);
    _workerReady = false;
    _worker     = _createWorker();
    if (!_worker) { console.error("[GLACIER] worker null"); return false; }
    _workerBusy = true;   // jusqu'au "ready"
    return true;
  }

  function reset() {
    console.log("[GLACIER] reset()");
    stop();
    if (_worker) { _worker.postMessage({ type:"stop" }); _worker = null; }
    if (_readyTimer) { clearTimeout(_readyTimer); _readyTimer = null; }
    _state = null; _cfg = null; _workerBusy = false; _workerReady = false;
    if (_oscGlace) _oscGlace.getContext("2d").clearRect(0,0,DIM,DIM);
    if (typeof glacierOsc!=="undefined"&&glacierOsc)
      glacierOsc.getContext("2d").clearRect(0,0,DIM,DIM);
    if (typeof render==="function") render();
  }

  function start() {
    console.log("[GLACIER] start() — running=" + _running +
                " ready=" + _workerReady + " busy=" + _workerBusy);
    if (_running) return;
    if (!_state && !init()) return;
    _running = true;
    // Si worker déjà prêt (relance après stop), envoyer tout de suite ;
    // sinon le handler "ready" déclenchera le premier step.
    if (_workerReady && !_workerBusy) _sendStep();
  }

  function stop() {
    console.log("[GLACIER] stop()");
    _running = false;
    if (_timer) { clearTimeout(_timer); _timer = null; }
  }

  return {
    init, reset, start, stop, stats,
    isRunning   : ()  => _running,
    setOnStep   : (cb)=> { _cbStep     = cb; },
    setPrecip   : (v) => { _precip     = v;  },
    setDt       : (v) => { _dtAns      = v;  if (_cfg) _cfg.processes.time.dt_max = v; },
    setDdfNeige : (v) => { _ddfNeige   = v;  },
    setDdfGlace : (v) => { _ddfGlace   = v;  },
    setSlidingco: (v) => { if (_cfg) _cfg.processes.iceflow.physics.init_slidingco = v;
                           if (_state) _state.slidingco = undefined; },
    setShowArrows:(v) => { _showArrows  = v;  if (_state) _dessiner(); },
    getThk      : ()  => _state ? _state.thk  : null,
    getUbar     : ()  => _state ? _state.ubar : null,
    getVbar     : ()  => _state ? _state.vbar : null,
  };

})();
