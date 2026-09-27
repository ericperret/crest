/* ═══════════════════════════════════════════════════════════════════
   FICHIER : dsm-foehn.js - v27/09/2026
   OBJET   : précipitations orographiques (modèle linéaire de Smith &
             Barstad 2004, résolu par FFT, sur des tranches d'altitude) et
             réchauffement de foehn sous le vent. Fournit au glacier un
             facteur de précipitation fC et un ΔT moyen annuel par pixel.
   AUTEUR  : Eric P.
   RELECTURE : Opus 5.5
   DÉPEND  : aucun (UMD : DsmFoehn en navigateur, module.exports sous Node)
   EXPOSE  : DsmFoehn { foehnCalc, foehnComputeFC, sb2004Field, foehnDeltaT,
             foehnCreteAmont, foehnWindDirection, foehnWindVector,
             foehnWindRoseEpoque, moistLapseRate, satVaporPressure,
             lclHeight, fft1d, fft2d, … constantes FOEHN_* }
   CONVENTIONS : direction du vent « d'où il vient », degrés depuis le nord ;
             u vers l'est, v vers le SUD (repère image, lignes croissantes)
   ⚠ Calibration d'origine non documentée : rose des vents « Markstein »,
     FOEHN_MOISTURE_CAL = 0,142, fond 563 mm/an, référence 1500 mm/an,
     direction LGM 202,5°.
   ═══════════════════════════════════════════════════════════════════ */

/* Enveloppe UMD : expose la fabrique en module Node ou en global DsmFoehn. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.DsmFoehn = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

const G = 9.81;
const CP = 1005;
const RD = 287;
const LV = 2.5e6;
const EPS_MOL = 0.622;
const GAMMA_SEC = (G / CP) * 1000;

const FOEHN_DIR_ACTUEL_DEG = 270;
const FOEHN_DIR_LGM_DEG = 202.5;
const FOEHN_VITESSE_MS = 15.0;

const FOEHN_ROSE_MARKSTEIN_ACTUEL = [
  { dirDeg: 0,   weight: 0.1040, speedMs: 2.95, moistureFactor: 0.77 },
  { dirDeg: 45,  weight: 0.2227, speedMs: 5.17, moistureFactor: 0.20 },
  { dirDeg: 90,  weight: 0.0449, speedMs: 3.01, moistureFactor: 0.09 },
  { dirDeg: 135, weight: 0.0155, speedMs: 2.13, moistureFactor: 0.31 },
  { dirDeg: 180, weight: 0.1984, speedMs: 4.84, moistureFactor: 1.57 },
  { dirDeg: 225, weight: 0.2243, speedMs: 4.27, moistureFactor: 1.46 },
  { dirDeg: 270, weight: 0.1145, speedMs: 3.96, moistureFactor: 1.32 },
  { dirDeg: 315, weight: 0.0757, speedMs: 4.03, moistureFactor: 1.02 }
];

/* ── foehnWindRoseEpoque ── E : t_ka, rose de base (Markstein actuelle par
   défaut) → T : fait tourner chaque secteur de l'écart entre la direction
   dominante de l'époque et l'actuelle → S : rose décalée. ALGO : « Rose des
   vents paléo = rose actuelle tournée comme le vent dominant. »
   ⚠ Exportée mais jamais utilisée (foehnComputeFC reçoit une rose d'un seul
     secteur). */
function foehnWindRoseEpoque(tKa, baseRose) {
  const rose = baseRose || FOEHN_ROSE_MARKSTEIN_ACTUEL;
  const delta = foehnWindDirection(tKa) - FOEHN_DIR_ACTUEL_DEG;
  return rose.map(function (r) {
    return { dirDeg: (r.dirDeg + delta + 360) % 360, weight: r.weight, speedMs: r.speedMs, moistureFactor: r.moistureFactor };
  });
}

const SB_TAU_C = 1000.0;
const SB_TAU_F = 1000.0;
const SB_NM = 0.005;
const SB_HW = 2500.0;
const SB_RHO_SREF = 7.4e-3;
const EARTH_OMEGA = 7.2921e-5;

const FOEHN_DEWPOINT_DEPRESSION_C = 3.0;

const FOEHN_BAND_THICKNESS_M = 500;
const FOEHN_WIND_ALPHA = 1 / 7;
const FOEHN_WIND_ZREF = 1000;

const FOEHN_HOURS_PER_YEAR = 8760;
const FOEHN_BACKGROUND_MM_AN = 563;
const FOEHN_MOISTURE_CAL = 0.14200;
const FOEHN_REF_PRECIP_MM_AN = 1500;

const FOEHN_RECALC_KA = 5;

/* Fraction du temps en situation de foehn (~45 j/an). Le ΔT appliqué au
   bilan de masse est la moyenne annuelle : FREQ × ΔT instantané.        */
const FOEHN_FREQ = 0.12;

/* ── satVaporPressure ── E : Tc (°C) → T : 6,112·exp(17,62·T/(243,12 + T))
   → S : pression de vapeur saturante (hPa). ALGO : « Formule de Magnus. » */
function satVaporPressure(Tc) {
  return 6.112 * Math.exp((17.62 * Tc) / (243.12 + Tc));
}

/* ── moistLapseRate ── E : Tc (°C), P (hPa) → T : rapport de mélange
   saturant rs, Γm = g(1 + Lv·rs/(Rd·T)) / (cp + Lv²·rs·ε/(Rd·T²)) → S :
   gradient pseudo-adiabatique (°C/km). */
function moistLapseRate(Tc, Phpa) {
  const T = Tc + 273.15;
  const es = satVaporPressure(Tc);
  const rs = (0.622 * es) / (Phpa - es);
  const num = G * (1 + (LV * rs) / (RD * T));
  const den = CP + (LV * LV * rs * EPS_MOL) / (RD * T * T);
  return (num / den) * 1000;
}

/* ── lclHeight ── E : Tc (inutilisé), écart au point de rosée (°C) → T :
   125 m/°C → S : hauteur du niveau de condensation au-dessus du point (m).
   ALGO : « Formule d'Espy. » */
function lclHeight(Tc, dewpointDepressionC) {
  return 125 * dewpointDepressionC;
}

/* ── foehnDeltaT ───────────────────────────────────────────────────────
   ENTRÉE     : zBase (m), zCreteAmont (m), Tc (°C), P (hPa), écart au
                point de rosée (°C, 3 par défaut)
   TRAITEMENT : LCL = zBase + lclHeight ; dz = crête − LCL ; si dz > 0,
                ΔT = (Γsec − Γhumide)·dz
   SORTIE     : réchauffement de foehn instantané (°C)
   ALGO       : « Foehn thermodynamique : ascension humide au-dessus du
                niveau de condensation jusqu'à la crête, descente sèche. »
   ⚠ Le LCL est pris au-dessus du point sous le vent, pas de la base au
     vent de la crête ; Γhumide évalué à la température du point.
   ─────────────────────────────────────────────────────────────────── */
function foehnDeltaT(zBase, zCreteAmont, Tc, Phpa, dewpointDepressionC) {
  const dtd = dewpointDepressionC === undefined ? FOEHN_DEWPOINT_DEPRESSION_C : dewpointDepressionC;
  const zLCL = zBase + lclHeight(Tc, dtd);
  const dz = zCreteAmont - zLCL;
  if (dz <= 0) return 0;
  const gammaH = moistLapseRate(Tc, Phpa);
  return (GAMMA_SEC - gammaH) * (dz / 1000);
}

/* ── foehnWindDirection ── E : t_ka → T : interpolation linéaire de 270°
   (actuel) à 202,5° (≤ −20 ka) → S : direction d'où vient le vent (°).
   ⚠ Hypothèse de rotation linéaire, non sourcée. */
function foehnWindDirection(tKa) {
  const r = Math.min(1, Math.max(0, tKa / -20));
  return FOEHN_DIR_ACTUEL_DEG - (FOEHN_DIR_ACTUEL_DEG - FOEHN_DIR_LGM_DEG) * r;
}

/* ── foehnWindVector ── E : t_ka, vitesse (15 m/s) → T : u = −sin(dir)·V,
   v = cos(dir)·V → S : { u (vers l'est), v (vers le sud, repère image),
   direction, speed }. */
function foehnWindVector(tKa, speedMs) {
  const speed = speedMs === undefined ? FOEHN_VITESSE_MS : speedMs;
  const dirRad = (foehnWindDirection(tKa) * Math.PI) / 180;
  return {
    u: -Math.sin(dirRad) * speed,
    v: Math.cos(dirRad) * speed,
    direction: foehnWindDirection(tKa),
    speed: speed
  };
}

/* fftBitReverse — E : re, im, n → T : permutation en ordre binaire inversé,
   en place → S : aucune. */
function fftBitReverse(re, im, n) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tr = re[i]; re[i] = re[j]; re[j] = tr;
      let ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
}

/* ── fft1d ── E : re, im (longueur puissance de 2), invert → T : Cooley-
   Tukey radix-2 itératif en place, division par n à l'inverse → S : aucune.
   ALGO : « FFT complexe 1D radix-2 en place. » */
function fft1d(re, im, invert) {
  const n = re.length;
  fftBitReverse(re, im, n);
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (invert ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curWr = 1, curWi = 0;
      const half = len / 2;
      for (let j = 0; j < half; j++) {
        const ur = re[i + j], ui = im[i + j];
        const vr = re[i + j + half] * curWr - im[i + j + half] * curWi;
        const vi = re[i + j + half] * curWi + im[i + j + half] * curWr;
        re[i + j] = ur + vr; im[i + j] = ui + vi;
        re[i + j + half] = ur - vr; im[i + j + half] = ui - vi;
        const nextWr = curWr * wr - curWi * wi;
        const nextWi = curWr * wi + curWi * wr;
        curWr = nextWr; curWi = nextWi;
      }
    }
  }
  if (invert) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

/* ── fft2d ── E : re, im (nx × ny), invert → T : fft1d sur chaque ligne puis
   chaque colonne → S : aucune (en place). */
function fft2d(re, im, nx, ny, invert) {
  const rowRe = new Float64Array(nx), rowIm = new Float64Array(nx);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) { rowRe[x] = re[y * nx + x]; rowIm[x] = im[y * nx + x]; }
    fft1d(rowRe, rowIm, invert);
    for (let x = 0; x < nx; x++) { re[y * nx + x] = rowRe[x]; im[y * nx + x] = rowIm[x]; }
  }
  const colRe = new Float64Array(ny), colIm = new Float64Array(ny);
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) { colRe[y] = re[y * nx + x]; colIm[y] = im[y * nx + x]; }
    fft1d(colRe, colIm, invert);
    for (let y = 0; y < ny; y++) { re[y * nx + x] = colRe[y]; im[y * nx + x] = colIm[y]; }
  }
}

/* nextPow2 — E : k → T : doublement → S : plus petite puissance de 2 ≥ k. */
function nextPow2(k) { let p = 1; while (p < k) p *= 2; return p; }

/* ── angularFreqAxis ── E : n, pas d'échantillonnage (m) → T : fréquences
   0..n/2 puis négatives, × 2π/(n·pas) → S : nombres d'onde (rad/m). */
function angularFreqAxis(n, spacing) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const f = i <= (n - 1) / 2 ? i : i - n;
    out[i] = (2 * Math.PI * f) / (n * spacing);
  }
  return out;
}

/* ── sb2004Field ───────────────────────────────────────────────────────
   ENTRÉE     : relief h (nx × ny), pas dx, dy (m), opts { u, v, f, Nm, Hw,
                tauC, tauF, Cw, P0, Pscale, truncate }
   TRAITEMENT : ĥ = FFT(h) ; pour chaque (kx, ky) : σ = u·kx + v·ky,
                m² = (N² − σ²)·k²/(σ² − f²) (m réel du signe de σ, sinon
                imaginaire positif) ; P̂ = Cw·iσ·ĥ / [(1 − i·m·Hw)(1 + iσ·τc)(1 + iσ·τf)] ;
                FFT inverse ; ×3600 + P0, négatifs tronqués
   SORTIE     : champ de précipitation (mm/h × Pscale)
   ALGO       : « Modèle linéaire de précipitation orographique de Smith &
                Barstad (2004) dans l'espace de Fourier. »
   ─────────────────────────────────────────────────────────────────── */
function sb2004Field(h, nx, ny, dx, dy, opts) {
  const u = opts.u, v = opts.v, f = opts.f || 0;
  const Nm = opts.Nm !== undefined ? opts.Nm : SB_NM;
  const Hw = opts.Hw !== undefined ? opts.Hw : SB_HW;
  const tauC = opts.tauC !== undefined ? opts.tauC : SB_TAU_C;
  const tauF = opts.tauF !== undefined ? opts.tauF : SB_TAU_F;
  const Cw = opts.Cw;
  const P0 = opts.P0 || 0;
  const Pscale = opts.Pscale !== undefined ? opts.Pscale : 1;
  const truncate = opts.truncate !== false;

  const kxAxis = angularFreqAxis(nx, dx);
  const kyAxis = angularFreqAxis(ny, dy);

  const hRe = Float64Array.from(h);
  const hIm = new Float64Array(nx * ny);
  fft2d(hRe, hIm, nx, ny, false);

  const Pre = new Float64Array(nx * ny), Pim = new Float64Array(nx * ny);
  const eps = 1e-18;

  for (let iy = 0; iy < ny; iy++) {
    const ky = kyAxis[iy];
    for (let ix = 0; ix < nx; ix++) {
      const kx = kxAxis[ix];
      const sigma = u * kx + v * ky;
      let denomReg = sigma * sigma - f * f;
      if (Math.abs(denomReg) < eps) denomReg = denomReg >= 0 ? eps : -eps;
      const k2 = kx * kx + ky * ky;
      const mSq = ((Nm * Nm - sigma * sigma) * k2) / denomReg;

      let mRe, mIm;
      if (mSq >= 0) {
        mRe = Math.sqrt(mSq);
        mIm = 0;
        if (sigma !== 0) mRe *= Math.sign(sigma);
      } else {
        mRe = 0;
        mIm = Math.sqrt(-mSq);
      }

      const imI_re = -mIm, imI_im = mRe;
      const d1re = 1 - Hw * imI_re, d1im = -Hw * imI_im;
      const d2re = 1, d2im = sigma * tauC;
      const d3re = 1, d3im = sigma * tauF;
      const d12re = d1re * d2re - d1im * d2im;
      const d12im = d1re * d2im + d1im * d2re;
      const dre = d12re * d3re - d12im * d3im;
      const dim = d12re * d3im + d12im * d3re;
      const numRe = 0, numIm = Cw * sigma;
      const dmag2 = dre * dre + dim * dim;
      let coefRe = 0, coefIm = 0;
      if (dmag2 >= eps) {
        coefRe = (numRe * dre + numIm * dim) / dmag2;
        coefIm = (numIm * dre - numRe * dim) / dmag2;
      }
      const idx = iy * nx + ix;
      const hr = hRe[idx], hi = hIm[idx];
      Pre[idx] = hr * coefRe - hi * coefIm;
      Pim[idx] = hr * coefIm + hi * coefRe;
    }
  }

  fft2d(Pre, Pim, nx, ny, true);

  const out = new Float64Array(nx * ny);
  for (let i = 0; i < nx * ny; i++) {
    let val = Pre[i] * 3600 + P0;
    if (truncate && val < 0) val = 0;
    out[i] = val * Pscale;
  }
  return out;
}

/* ── foehnPrecipRasterOnce ── E : tranche de relief nBase², res (m), u, v, f,
   Cw → T : bordure nulle de nBase/2, taille puissance de 2, sb2004Field,
   recadrage → S : précipitation nBase² (mm/h). ALGO : « SB2004 sur une
   grille rembourrée pour limiter le repliement périodique de la FFT. » */
function foehnPrecipRasterOnce(hBand, nBase, res, u, v, f, Cw) {
  const dxM = typeof res === 'object' ? res.x : res;
  const dyM = typeof res === 'object' ? res.y : res;
  const pad = nBase >> 1;
  const nx = nextPow2(nBase + 2 * pad);
  const ny = nextPow2(nBase + 2 * pad);
  const offX = pad, offY = pad;

  const h = new Float64Array(nx * ny);
  for (let iy = 0; iy < nBase; iy++) {
    for (let ix = 0; ix < nBase; ix++) {
      h[(iy + offY) * nx + (ix + offX)] = hBand[iy * nBase + ix];
    }
  }

  const P_field = sb2004Field(h, nx, ny, dxM, dyM, {
    u, v, f, Nm: SB_NM, Hw: SB_HW, tauC: SB_TAU_C, tauF: SB_TAU_F, Cw, truncate: true
  });

  const out = new Float64Array(nBase * nBase);
  for (let iy = 0; iy < nBase; iy++) {
    for (let ix = 0; ix < nBase; ix++) {
      out[iy * nBase + ix] = P_field[(iy + offY) * nx + (ix + offX)];
    }
  }
  return out;
}

/* ── FOEHN_POOL ── E : aucune → T : pool paresseux de 2 Workers dont la
   source embarque FFT, SB2004 et ΔT de foehn → S : { available, run }. */
const FOEHN_POOL = (function () {
  let workers = null;

  /* available — E : aucune → T : Worker existe ? → S : booléen. */
  function available() {
    return typeof Worker !== 'undefined';
  }

  /* build — E : aucune → T : crée une fois les Workers depuis le toString()
     des fonctions de calcul ; messages 'dt' (ΔT par bande) ou précipitation
     → S : aucune. */
  function build() {
    if (workers) return;
    const NW = Math.min(2, Math.max(1, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2));
    const src = [
      '"use strict";',
      'var SB_NM=' + SB_NM + ', SB_HW=' + SB_HW + ', SB_TAU_C=' + SB_TAU_C + ', SB_TAU_F=' + SB_TAU_F + ';',
      fftBitReverse.toString(),
      fft1d.toString(),
      fft2d.toString(),
      nextPow2.toString(),
      angularFreqAxis.toString(),
      sb2004Field.toString(),
      foehnPrecipRasterOnce.toString(),
      'var G=' + G + ', CP=' + CP + ', RD=' + RD + ', LV=' + LV + ', EPS_MOL=' + EPS_MOL + ';',
      'var GAMMA_SEC=' + GAMMA_SEC + ', FOEHN_DEWPOINT_DEPRESSION_C=' + FOEHN_DEWPOINT_DEPRESSION_C + ';',
      satVaporPressure.toString(),
      moistLapseRate.toString(),
      lclHeight.toString(),
      foehnDeltaT.toString(),
      foehnCreteAmont.toString(),
      foehnDTBande.toString(),
      'onmessage = function (ev) {',
      '  var m = ev.data;',
      '  try {',
      '    if (m.type === "dt") { var D = foehnDTBande(m); postMessage({ P: D, id: m.id }, [D.buffer]); return; }',
      '    var P = foehnPrecipRasterOnce(m.hBand, m.nBase, m.res, m.u, m.v, m.f, m.Cw);',
      '    postMessage({ P: P, id: m.id }, [P.buffer]);',
      '  } catch (e) { postMessage({ err: String(e && e.message || e), id: m.id }); }',
      '};'
    ].join('\n');
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    workers = [];
    for (let i = 0; i < NW; i++) workers.push(new Worker(url));
    URL.revokeObjectURL(url);
  }

  /* fermer — E : aucune → T : termine les Workers ; le prochain run les
     recrée → S : aucune. */
  function fermer() {
    if (workers) workers.forEach(function (w) { w.terminate(); });
    workers = null;
  }

  /* run — E : liste de tâches → T : distribue les tâches aux Workers au fil
     des réponses ; erreur d'un Worker (exception interceptée, onerror ou
     message illisible) → pool fermé et promesse rejetée → S : Promise(
     résultats dans l'ordre des tâches). */
  function run(tasks) {
    build();
    return new Promise(function (resolve, reject) {
      if (tasks.length === 0) { resolve([]); return; }
      const results = new Array(tasks.length);
      let nextIdx = 0, done = 0, echec = false;
      function echouer(msg) {
        if (echec) return;
        echec = true;
        fermer();
        reject(new Error('Worker foehn : ' + msg));
      }
      function assign(w) {
        if (echec || nextIdx >= tasks.length) return;
        const idx = nextIdx++;
        const t = tasks[idx];
        w.onerror = function (err) {
          if (err && err.preventDefault) err.preventDefault();
          echouer((err && err.message) || 'erreur inconnue');
        };
        w.onmessageerror = function () { echouer('message illisible'); };
        w.onmessage = function (ev) {
          if (echec) return;
          if (ev.data.err) { echouer(ev.data.err); return; }
          results[ev.data.id] = ev.data.P;
          done++;
          if (done === tasks.length) resolve(results);
          else assign(w);
        };
        w.postMessage(Object.assign({ id: idx }, t));
      }
      workers.forEach(assign);
    });
  }

  return { available: available, run: run, fermer: fermer };
})();

/* ── foehnComputeFC ────────────────────────────────────────────────────
   ENTRÉE     : elev 1024² (m), res (m), t_ka, latitude, opts (épaisseur de
                tranche, loi du vent, rose, calibrations)
   TRAITEMENT : découpe le relief en tranches de 500 m (hauteur de relief
                contenue dans chaque tranche) ; pour chaque tranche et
                secteur de vent : vitesse en loi puissance (α = 1/7) à mi-
                tranche, Cw = ρv(z)·Γm/γ·facteur d'humidité, f de Coriolis,
                SB2004 (pool) ; somme pondérée des secteurs ; fC = (fond
                563 mm/an + P·cal·8760) / 1500 mm/an
   SORTIE     : Promise({ fC Float64Array (facteur de précipitation, 1 =
                1500 mm/an), wind, nBands, bandThicknessM, totalPRaw })
   ALGO       : « Précipitation orographique par superposition de SB2004
                appliqué à des tranches d'altitude, normalisée en facteur. »
   ⚠ La décomposition en tranches d'altitude n'est pas dans Smith &
     Barstad : c'est une extension propre au projet (le modèle est linéaire
     en h, la somme des tranches redonne le relief complet, seule la
     variation de U et Cw avec l'altitude change le résultat).
   ─────────────────────────────────────────────────────────────────── */
function foehnComputeFC(elev1024, res, tKa, latitudeDeg, opts) {
  const o = opts || {};
  const nBase = Math.round(Math.sqrt(elev1024.length));
  const lat = latitudeDeg === undefined ? 48 : latitudeDeg;
  const bandH = o.bandThicknessM !== undefined ? o.bandThicknessM : FOEHN_BAND_THICKNESS_M;
  const alpha = o.windAlpha !== undefined ? o.windAlpha : FOEHN_WIND_ALPHA;
  const zRef = o.zRefWind !== undefined ? o.zRefWind : FOEHN_WIND_ZREF;

  const rose = o.windRose && o.windRose.length
    ? o.windRose
    : [{ dirDeg: foehnWindDirection(tKa), speedMs: FOEHN_VITESSE_MS, weight: 1 }];
  const roseWeightTotal = rose.reduce((s, r) => s + r.weight, 0) || 1;

  const f = 2 * EARTH_OMEGA * Math.sin((lat * Math.PI) / 180);
  const SB_THETA_M_OVER_GAMMA = 6.5 / 5.8;

  let zMax = 0;
  for (let i = 0; i < elev1024.length; i++) if (elev1024[i] > zMax) zMax = elev1024[i];
  const nBands = Math.max(1, Math.ceil(zMax / bandH));

  const tasks = [];
  for (let b = 0; b < nBands; b++) {
    const z0 = b * bandH, z1 = z0 + bandH;
    const zMid = z0 + bandH / 2;

    const hBand = new Float64Array(nBase * nBase);
    for (let i = 0; i < elev1024.length; i++) {
      const z = elev1024[i];
      hBand[i] = z <= z0 ? 0 : (z >= z1 ? bandH : z - z0);
    }

    const rhoBand = SB_RHO_SREF * Math.exp(-zMid / SB_HW);
    const CwBand = rhoBand * SB_THETA_M_OVER_GAMMA;

    for (const r of rose) {
      if (r.weight <= 0) continue;
      const dirRad = (r.dirDeg * Math.PI) / 180;
      const Uband = r.speedMs * Math.pow(Math.max(zMid, 1) / zRef, alpha);
      const uBand = -Math.sin(dirRad) * Uband;
      const vBand = Math.cos(dirRad) * Uband;
      const moistureFactor = r.moistureFactor === undefined ? 1 : r.moistureFactor;
      const CwSector = CwBand * moistureFactor;

      tasks.push({ hBand: hBand, nBase: nBase, res: res, u: uBand, v: vBand, f: f, Cw: CwSector,
        weight: r.weight / roseWeightTotal });
    }
  }

  /* finish — E : champs par tâche → T : somme pondérée, conversion en mm/an
     (calibration), fond ajouté, division par la référence → S : résultat. */
  function finish(results) {
    const totalP = new Float64Array(nBase * nBase);
    for (let k = 0; k < tasks.length; k++) {
      const P = results[k], w = tasks[k].weight;
      for (let i = 0; i < totalP.length; i++) totalP[i] += P[i] * w;
    }

    const moistureCal = o.moistureCal !== undefined ? o.moistureCal : FOEHN_MOISTURE_CAL;
    const backgroundMmAn = o.backgroundMmAn !== undefined ? o.backgroundMmAn : FOEHN_BACKGROUND_MM_AN;
    const refPrecip = o.refPrecipMmAn !== undefined ? o.refPrecipMmAn : FOEHN_REF_PRECIP_MM_AN;

    const fC = new Float64Array(nBase * nBase);
    for (let i = 0; i < fC.length; i++) {
      const localMmAn = totalP[i] * moistureCal * FOEHN_HOURS_PER_YEAR;
      fC[i] = (backgroundMmAn + localMmAn) / refPrecip;
    }

    return { fC: fC, wind: foehnWindVector(tKa), nBands: nBands, bandThicknessM: bandH, totalPRaw: totalP };
  }

  if (FOEHN_POOL.available()) {
    return FOEHN_POOL.run(tasks).then(finish);
  }
  const results = tasks.map(function (t) {
    return foehnPrecipRasterOnce(t.hBand, t.nBase, t.res, t.u, t.v, t.f, t.Cw);
  });
  return Promise.resolve(finish(results));
}

/* ── foehnCreteAmont ── E : elev, nx, ny, pixel (ix0, iy0), direction du
   vent (°), res (m), distance max (50 km) → T : marche au vent par pas d'un
   pixel (en métrique anisotrope), altitude maximale rencontrée → S :
   altitude de la crête amont (m). ALGO : « Point le plus haut sur la ligne
   au vent. » */
function foehnCreteAmont(elev, nx, ny, ix0, iy0, dirDeg, res, maxDistM) {
  const dist = maxDistM === undefined ? 50000 : maxDistM;
  const rX = typeof res === 'object' ? res.x : res;
  const rY = typeof res === 'object' ? res.y : res;
  const dirRad = (dirDeg * Math.PI) / 180;
  const eX = Math.sin(dirRad) / rX, eY = -Math.cos(dirRad) / rY;
  const eN = Math.hypot(eX, eY) || 1;
  const stepX = eX / eN, stepY = eY / eN;
  const stepM = Math.hypot(stepX * rX, stepY * rY) || 1;
  const maxSteps = Math.round(dist / stepM);
  let maxZ = elev[iy0 * nx + ix0];
  let fx = ix0, fy = iy0;
  for (let s = 1; s <= maxSteps; s++) {
    fx += stepX; fy += stepY;
    const ix = Math.round(fx), iy = Math.round(fy);
    if (ix < 0 || ix >= nx || iy < 0 || iy >= ny) break;
    const z = elev[iy * nx + ix];
    if (z > maxZ) maxZ = z;
  }
  return maxZ;
}

/* ── foehnDTBande ── E : { elev, Tc, n, r0, r1, dirDeg, res, P, maxDistM,
   freq } → T : pour chaque pixel des lignes [r0, r1[, crête amont puis
   freq × foehnDeltaT → S : Float32Array des ΔT moyens annuels (°C).
   Exécuté en Worker. */
function foehnDTBande(m) {
  var n = m.n, out = new Float32Array((m.r1 - m.r0) * n);
  for (var iy = m.r0; iy < m.r1; iy++) {
    for (var ix = 0; ix < n; ix++) {
      var idx = iy * n + ix;
      var zCrete = foehnCreteAmont(m.elev, n, n, ix, iy, m.dirDeg, m.res, m.maxDistM);
      out[(iy - m.r0) * n + ix] = m.freq * foehnDeltaT(m.elev[idx], zCrete, m.Tc[idx], m.P);
    }
  }
  return out;
}

/* ── foehnCalc ─────────────────────────────────────────────────────────
   ENTRÉE     : t_ka, elev 1024², res, latitude, tempFn(idx) → °C, P (1000
                hPa), distance max, fcOpts { freq, … }
   TRAITEMENT : foehnComputeFC ; températures par pixel ; ΔT par 8 bandes
                de lignes dans le pool (ou sur place)
   SORTIE     : Promise({ foehnC Float32Array, foehnDT Float32Array (°C,
                moyenne annuelle = FOEHN_FREQ × ΔT instantané), nBands,
                bandThicknessM, wind, totalPRaw })
   ALGO       : « Facteur de précipitation orographique et réchauffement
                de foehn moyen annuel pour une époque. »
   ─────────────────────────────────────────────────────────────────── */
function foehnCalc(tKa, elev1024, res, latDeg, tempFn, Phpa, maxDistM, fcOpts) {
  const nBase = Math.round(Math.sqrt(elev1024.length));
  const P = Phpa === undefined ? 1000 : Phpa;
  const tFn = tempFn || function () { return 5; };
  const freq = fcOpts && fcOpts.freq !== undefined ? fcOpts.freq : FOEHN_FREQ;

  return foehnComputeFC(elev1024, res, tKa, latDeg, fcOpts).then(function (bandInfo) {
    const fC = bandInfo.fC;
    const dirDeg = foehnWindDirection(tKa);
    const Tc = new Float32Array(nBase * nBase);
    for (let i = 0; i < Tc.length; i++) Tc[i] = tFn(i);

    const NB = 8, bande = Math.ceil(nBase / NB), tasks = [];
    for (let k = 0; k < NB; k++) {
      const r0 = k * bande, r1 = Math.min(nBase, r0 + bande);
      if (r0 >= r1) break;
      tasks.push({ type: 'dt', elev: elev1024, Tc: Tc, n: nBase, r0: r0, r1: r1,
                   dirDeg: dirDeg, res: res, P: P, maxDistM: maxDistM, freq: freq });
    }
    const exec = FOEHN_POOL.available()
      ? FOEHN_POOL.run(tasks)
      : Promise.resolve(tasks.map(foehnDTBande));

    return exec.then(function (parts) {
      const foehnDT = new Float32Array(nBase * nBase);
      for (let k = 0; k < parts.length; k++) foehnDT.set(parts[k], tasks[k].r0 * nBase);
      const foehnC = Float32Array.from(fC);
      return { foehnC: foehnC, foehnDT: foehnDT, nBands: bandInfo.nBands, bandThicknessM: bandInfo.bandThicknessM, wind: bandInfo.wind, totalPRaw: bandInfo.totalPRaw };
    });
  });
}

return {
  FOEHN_RECALC_KA, FOEHN_FREQ, GAMMA_SEC, FOEHN_DEWPOINT_DEPRESSION_C,
  FOEHN_BAND_THICKNESS_M, FOEHN_WIND_ALPHA, FOEHN_WIND_ZREF,
  FOEHN_HOURS_PER_YEAR, FOEHN_BACKGROUND_MM_AN, FOEHN_MOISTURE_CAL, FOEHN_REF_PRECIP_MM_AN,
  satVaporPressure, moistLapseRate, lclHeight, foehnDeltaT,
  foehnWindDirection, foehnWindVector, foehnWindRoseEpoque, FOEHN_ROSE_MARKSTEIN_ACTUEL,
  fft1d, fft2d, angularFreqAxis, nextPow2,
  sb2004Field, foehnComputeFC,
  foehnCreteAmont, foehnCalc
};

});
