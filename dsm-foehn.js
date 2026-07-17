/*
  Fichier  : dsm-foehn.js
  Projet   : DSM — sous-projet PRÉCIPITATION OROGRAPHIQUE & FOEHN
  Rôle     : remplace les placeholders GLAC_FOEHN_VENT / GLAC_FOEHN_SOUS /
             GLAC_FOEHN_DT / GLAC_FOEHN_GRAZE par un calcul physique :
             thermodynamique adiabatique (ΔT) + modèle spectral de
             précipitation orographique de Smith & Barstad (2004) (fC).
  API      : foehnCalc(t_ka, elev1024, resY, latDeg, tempFn) — remplace
             glacierCalcFoehn(t_ka) de dsm.html à l'identique (même
             contrat de sortie : foehnC et foehnDT, Float32Array[GLAC_N],
             échantillonnés ensuite par triangle via F.centIdx — inchangé
             dans dsm.html, cf cadrage §6bis).
  Dépendances : aucune (JavaScript pur, navigateur + Web Workers).
  Auteur   : Eric Perret
  Date     : 2026-07-15
  Version  : 0.2 — aligné contre dsm.html réel (GLAC_PRECIP_CC, FILET,
             anomaliePaleo/tempInstant identifiés). Δz_saturé calculé par
             recherche directe de crête amont sur ombreElev1024 (pas de
             dépendance à ombreHorizonCopy, qui ne stocke qu'un angle,
             sans distance). Reste provisoire : dewpoint de surface
             (cadrage §6bis) et rayon de recherche amont (50 km, ordre de
             grandeur repris de l'ancien GLAC_FOEHN_GRAZE).
*/

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.DsmFoehn = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

// =====================================================================
// 1. CONSTANTES PHYSIQUES ET PARAMÈTRES DE DÉPART
//    (sources détaillées dans dsm-foehn-cadrage.md)
// =====================================================================

// Thermodynamique
const G = 9.81;            // m/s², gravité
const CP = 1005;           // J/(kg·K), chaleur spécifique air sec à pression cst
const RD = 287;            // J/(kg·K), constante spécifique air sec
const LV = 2.5e6;          // J/kg, chaleur latente de vaporisation
const EPS_MOL = 0.622;     // Rd/Rv
const GAMMA_SEC = (G / CP) * 1000; // °C/km ≈ 9,76

// Vent par époque (cf cadrage §3) — direction validée, vitesse tranchée §6
const FOEHN_DIR_ACTUEL_DEG = 270;   // Ouest (convention météo : d'où vient le vent)
const FOEHN_DIR_LGM_DEG = 202.5;    // Sud-Sud-Ouest
const FOEHN_VITESSE_MS = 15.0;      // m/s, source SB2004/PISM (cf cadrage §2)

// Smith & Barstad (2004) — valeurs de départ, source : implémentation de
// référence PISM (Aschwanden & Khrulev), à recaler sur Vosges/Alsace (§4)
const SB_TAU_C = 1000.0;    // s, temps de conversion nuage → pluie
const SB_TAU_F = 1000.0;    // s, temps de chute de l'hydrométéore
const SB_NM = 0.005;        // s⁻¹, fréquence de stabilité humide
const SB_HW = 2500.0;       // m, hauteur d'échelle de la vapeur d'eau
const SB_RHO_SREF = 7.4e-3; // kg/m³, densité de vapeur saturante de référence
const EARTH_OMEGA = 7.2921e-5; // rad/s, rotation terrestre (Coriolis)

// Humidité de surface provisoire pour le LCL (cf cadrage §6, point 2 —
// à remplacer par une valeur cohérente avec GLAC_PRECIP_CC dès que
// dsm.html sera disponible). Isolée ici pour être changée en un seul
// endroit.
const FOEHN_DEWPOINT_DEPRESSION_C = 3.0; // T - Td, air océanique stable

// Recalcul périodique (contrat DSM)
const FOEHN_RECALC_KA = 5;

// =====================================================================
// 2. THERMODYNAMIQUE
// =====================================================================

/** Pression de vapeur saturante (formule de Magnus, référence OMM).
 * @param {number} Tc température en °C
 * @returns {number} hPa
 */
function satVaporPressure(Tc) {
  return 6.112 * Math.exp((17.62 * Tc) / (243.12 + Tc));
}

/** Gradient adiabatique humide Γ_humide(T,P) (Rogers & Yau).
 * @param {number} Tc température en °C
 * @param {number} Phpa pression en hPa
 * @returns {number} °C/km
 */
function moistLapseRate(Tc, Phpa) {
  const T = Tc + 273.15;
  const es = satVaporPressure(Tc);
  const rs = (0.622 * es) / (Phpa - es);
  const num = G * (1 + (LV * rs) / (RD * T));
  const den = CP + (LV * LV * rs * EPS_MOL) / (RD * T * T);
  return (num / den) * 1000;
}

/** Altitude du niveau de condensation par ascendance (LCL), approximation
 * d'Espy — cf cadrage §6, provisoire tant que la source d'humidité n'est
 * pas raccordée à GLAC_PRECIP_CC.
 * @param {number} Tc température au sol, °C
 * @param {number} dewpointDepressionC T - Td, °C
 * @returns {number} hauteur du LCL au-dessus du sol, m
 */
function lclHeight(Tc, dewpointDepressionC) {
  return 125 * dewpointDepressionC;
}

/** Réchauffement de foehn pour un triangle donné.
 * @param {number} zBase altitude du pied du versant, m
 * @param {number} zCreteAmont altitude de la crête rencontrée en remontant
 *   le vent depuis ce triangle (fournie par l'adaptateur horizon, §6), m
 * @param {number} Tc température de l'air à zBase, °C
 * @param {number} Phpa pression à zBase, hPa
 * @param {number} [dewpointDepressionC] par défaut FOEHN_DEWPOINT_DEPRESSION_C
 * @returns {number} ΔT_foehn, °C (0 si le sommet ne dépasse pas le LCL)
 */
function foehnDeltaT(zBase, zCreteAmont, Tc, Phpa, dewpointDepressionC) {
  const dtd = dewpointDepressionC === undefined ? FOEHN_DEWPOINT_DEPRESSION_C : dewpointDepressionC;
  const zLCL = zBase + lclHeight(Tc, dtd);
  const dz = zCreteAmont - zLCL;
  if (dz <= 0) return 0;
  const gammaH = moistLapseRate(Tc, Phpa);
  return (GAMMA_SEC - gammaH) * (dz / 1000);
}

// =====================================================================
// 3. VENT PAR ÉPOQUE (cf cadrage §3)
// =====================================================================

/** Direction du vent dominant par époque, interpolation linéaire.
 * @param {number} tKa t_ka, négatif = passé, clampé à [-20, 0]
 * @returns {number} degrés, convention météo (0=Nord, 270=Ouest)
 */
function foehnWindDirection(tKa) {
  const r = Math.min(1, Math.max(0, tKa / -20));
  return FOEHN_DIR_ACTUEL_DEG - (FOEHN_DIR_ACTUEL_DEG - FOEHN_DIR_LGM_DEG) * r;
}

/** Vecteur vent (u,v) pour l'époque donnée. */
function foehnWindVector(tKa, speedMs) {
  const speed = speedMs === undefined ? FOEHN_VITESSE_MS : speedMs;
  const dirRad = (foehnWindDirection(tKa) * Math.PI) / 180;
  return {
    u: -Math.sin(dirRad) * speed,
    v: -Math.cos(dirRad) * speed,
    direction: foehnWindDirection(tKa),
    speed: speed
  };
}

// =====================================================================
// 4. FFT2 RADIX-2 (JS pur, sans librairie)
// =====================================================================

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

/** FFT 1D itérative, en place. invert=false : transformée directe
 * (convention exp(-i...), identique à la convention numpy utilisée dans
 * la littérature SB2004). invert=true : transformée inverse normalisée.
 * n doit être une puissance de 2.
 */
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

/** FFT 2D en place sur des tableaux (nx*ny), lignes puis colonnes.
 * nx et ny doivent être des puissances de 2.
 */
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

function nextPow2(k) { let p = 1; while (p < k) p *= 2; return p; }

/** Axe de nombre d'onde angulaire (rad/m), convention identique à
 * np.fft.fftfreq(n, d)*2π utilisée dans la littérature SB2004.
 */
function angularFreqAxis(n, spacing) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const f = i <= (n - 1) / 2 ? i : i - n;
    out[i] = (2 * Math.PI * f) / (n * spacing);
  }
  return out;
}

// =====================================================================
// 5. PRÉCIPITATION OROGRAPHIQUE — Smith & Barstad (2004)
// =====================================================================

/**
 * Calcule le champ de précipitation spectrale sur une grille déjà
 * paddée et de dimensions puissance de 2 (voir foehnComputeFC pour le
 * padding automatique depuis une grille DSM 1024×1024).
 *
 * @param {Float64Array|Float32Array} h élévation, longueur nx*ny
 * @param {number} nx,ny dimensions (puissances de 2)
 * @param {number} dx,dy résolution, m
 * @param {object} opts { u, v, f, Nm, Hw, tauC, tauF, Cw, P0, Pscale, truncate }
 * @returns {Float64Array} précipitation, mm/h, longueur nx*ny
 */
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

      // i*m
      const imI_re = -mIm, imI_im = mRe;
      // (1 - i*m*Hw)
      const d1re = 1 - Hw * imI_re, d1im = -Hw * imI_im;
      // (1 + i*sigma*tauC)
      const d2re = 1, d2im = sigma * tauC;
      // (1 + i*sigma*tauF)
      const d3re = 1, d3im = sigma * tauF;
      // produit des trois facteurs
      const d12re = d1re * d2re - d1im * d2im;
      const d12im = d1re * d2im + d1im * d2re;
      const dre = d12re * d3re - d12im * d3im;
      const dim = d12re * d3im + d12im * d3re;
      // numérateur Cw*i*sigma
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
    let val = Pre[i] * 3600 + P0; // mm/h
    if (truncate && val < 0) val = 0;
    out[i] = val * Pscale;
  }
  return out;
}

/**
 * Point d'entrée pour une grille DSM (ombreElev1024, 1024×1024).
 * Paddage automatique en puissance de 2, calcul SB2004, puis
 * normalisation en facteur multiplicatif fC (moyenne ≈ 1 sur la tuile
 * active) — la magnitude absolue de précipitation reste de la
 * responsabilité de GLAC_PRECIP_CC (pas de double comptage, cf cadrage).
 *
 * @param {Float32Array} elev1024 grille d'altitude, longueur 1024*1024
 * @param {number} resY m/pixel
 * @param {number} tKa époque
 * @param {number} [latitudeDeg=48] pour Coriolis
 * @param {number} [Tc=10] température de référence pour Θm=Γ_humide, °C
 * @param {number} [Phpa=1000] pression de référence, hPa
 * @returns {{fC: Float64Array, nx:number, ny:number, offX:number, offY:number, wind:object}}
 */
function foehnComputeFC(elev1024, resY, tKa, latitudeDeg, Tc, Phpa) {
  const nBase = Math.round(Math.sqrt(elev1024.length));
  const lat = latitudeDeg === undefined ? 48 : latitudeDeg;
  const T = Tc === undefined ? 10 : Tc;
  const P = Phpa === undefined ? 1000 : Phpa;

  const wind = foehnWindVector(tKa);
  const f = 2 * EARTH_OMEGA * Math.sin((lat * Math.PI) / 180);
  // Cw = ρ_Sref × Θm / γ (sensibilité au soulèvement, SB2004). Θm et γ
  // sont deux lapse rates distincts (moist adiabatique vs environnemental)
  // dont la définition précise dans SB2004 n'est pas encore vérifiée
  // ligne à ligne contre l'article original — on reprend donc la valeur
  // numérique complète de la référence PISM (déjà validée dans
  // dsm-foehn.test.js contre la solution analytique triangle-ridge)
  // plutôt que de reconstruire Θm/γ à partir de moistLapseRate(T,P),
  // ce qui donnerait un résultat non vérifié. Raffinement possible une
  // fois la définition exacte de Θm/γ sourcée depuis l'article.
  const SB_THETA_M_OVER_GAMMA = 6.5 / 5.8; // valeurs PISM: Θm=-6.5, γ=-5.8 K/km
  const Cw = SB_RHO_SREF * SB_THETA_M_OVER_GAMMA;
  void T; void P; // conservés dans la signature pour un futur Cw(T,P)

  const pad = nBase; // padding zéro, comme la référence SB2004/PISM
  const nx = nextPow2(nBase + 2 * pad);
  const ny = nextPow2(nBase + 2 * pad);
  const offX = pad, offY = pad;

  const h = new Float64Array(nx * ny);
  for (let iy = 0; iy < nBase; iy++) {
    for (let ix = 0; ix < nBase; ix++) {
      h[(iy + offY) * nx + (ix + offX)] = elev1024[iy * nBase + ix];
    }
  }

  const P_field = sb2004Field(h, nx, ny, resY, resY, {
    u: wind.u, v: wind.v, f: f, Nm: SB_NM, Hw: SB_HW,
    tauC: SB_TAU_C, tauF: SB_TAU_F, Cw: Cw, truncate: true
  });

  // Normalisation en facteur multiplicatif, moyenne ≈ 1 sur la tuile active
  let sum = 0;
  for (let iy = 0; iy < nBase; iy++) {
    for (let ix = 0; ix < nBase; ix++) {
      sum += P_field[(iy + offY) * nx + (ix + offX)];
    }
  }
  const mean = sum / (nBase * nBase) || 1e-9;

  const fC = new Float64Array(nBase * nBase);
  for (let iy = 0; iy < nBase; iy++) {
    for (let ix = 0; ix < nBase; ix++) {
      fC[iy * nBase + ix] = P_field[(iy + offY) * nx + (ix + offX)] / mean;
    }
  }

  return { fC, nx, ny, offX, offY, wind };
}

// =====================================================================
// 6. RÉCHAUFFEMENT PAR PIXEL — recherche de crête amont
//    Remplace le test binaire GLAC_FOEHN_GRAZE (angle rasant, sans
//    distance) par un Δz réel : on remonte le vent sur ombreElev1024 et
//    on retient l'altitude max rencontrée. ombreHorizonCopy (dsm-ombre)
//    ne stocke qu'un ANGLE par azimut, pas de distance associée — donc
//    pas réutilisable ici tel quel ; recherche refaite directement sur
//    la grille d'altitude, déjà disponible partout dans DSM.
// =====================================================================

/**
 * Altitude maximale rencontrée en remontant le vent depuis (ix0,iy0).
 * Convention grille DSM : ligne 0 = nord, ligne croissante = sud (cf
 * dsm.html, latC = latMax - ...). azimut meteo (0=N, 270=Ouest) → pas
 * (dx,dy) = (sin(az), -cos(az)).
 *
 * @param {Float32Array} elev grille d'altitude, longueur nx*ny
 * @param {number} nx,ny dimensions grille
 * @param {number} ix0,iy0 indices du pixel de départ
 * @param {number} dirDeg direction d'où vient le vent (degrés)
 * @param {number} resM résolution m/pixel
 * @param {number} maxDistM rayon de recherche, m (défaut 50 km — ordre
 *   de grandeur repris du commentaire GLAC_FOEHN_GRAZE d'origine)
 * @returns {number} altitude max rencontrée en amont (m), ou l'altitude
 *   locale si rien de plus haut n'est trouvé (pas de crête → pas de foehn)
 */
function foehnCreteAmont(elev, nx, ny, ix0, iy0, dirDeg, resM, maxDistM) {
  const dist = maxDistM === undefined ? 50000 : maxDistM;
  const dirRad = (dirDeg * Math.PI) / 180;
  const stepX = Math.sin(dirRad), stepY = -Math.cos(dirRad);
  const maxSteps = Math.round(dist / resM);
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

// =====================================================================
// 7. ASSEMBLAGE — remplace glacierCalcFoehn(t_ka) de dsm.html
// =====================================================================

/**
 * Calcule les deux rasters foehn (foehnC, foehnDT), longueur GLAC_N,
 * même contrat de sortie que l'actuel glacierCalcFoehn(t_ka) de
 * dsm.html : foehnC[i] = facteur multiplicatif précip (remplace
 * glacierFoehnC), foehnDT[i] = réchauffement additif °C (remplace
 * glacierFoehnDT). Intégration : le corps de glacierCalcFoehn est
 * remplacé par un appel à DsmFoehn.foehnCalc(...) ; le reste de
 * dsm.html (glacierPoolFoehn, échantillonnage par F.centIdx) ne change
 * pas.
 *
 * @param {number} tKa époque
 * @param {Float32Array} elev1024 ombreElev1024, longueur 1024²
 * @param {number} resY ombreResY, m/pixel
 * @param {number} latDeg latitude centre tuile (GEO.latMax+latMin)/2
 * @param {function(number):number} [tempFn] température °C au pixel i
 *   (brancher sur tempInstant(i, -1, jour, tKa, rise, set, false) côté
 *   dsm.html ; par défaut 5°C constant pour tests hors DSM)
 * @param {number} [Phpa=1000] pression de référence, hPa
 * @param {number} [maxDistM=50000] rayon de recherche de crête amont, m
 * @returns {{foehnC: Float32Array, foehnDT: Float32Array}}
 */
function foehnCalc(tKa, elev1024, resY, latDeg, tempFn, Phpa, maxDistM) {
  const nBase = Math.round(Math.sqrt(elev1024.length));
  const P = Phpa === undefined ? 1000 : Phpa;
  const tFn = tempFn || function () { return 5; };

  const { fC } = foehnComputeFC(elev1024, resY, tKa, latDeg);

  const dirDeg = foehnWindDirection(tKa);
  const foehnDT = new Float32Array(nBase * nBase);
  for (let iy = 0; iy < nBase; iy++) {
    for (let ix = 0; ix < nBase; ix++) {
      const idx = iy * nBase + ix;
      const zBase = elev1024[idx];
      const zCrete = foehnCreteAmont(elev1024, nBase, nBase, ix, iy, dirDeg, resY, maxDistM);
      const Tc = tFn(idx);
      foehnDT[idx] = foehnDeltaT(zBase, zCrete, Tc, P);
    }
  }

  const foehnC = Float32Array.from(fC);
  return { foehnC, foehnDT };
}

// =====================================================================
// EXPORTS
// =====================================================================
return {
  // constantes
  FOEHN_RECALC_KA, GAMMA_SEC, FOEHN_DEWPOINT_DEPRESSION_C,
  // thermodynamique
  satVaporPressure, moistLapseRate, lclHeight, foehnDeltaT,
  // vent
  foehnWindDirection, foehnWindVector,
  // FFT (exposée pour les tests)
  fft1d, fft2d, angularFreqAxis, nextPow2,
  // précipitation
  sb2004Field, foehnComputeFC,
  // réchauffement / assemblage — point d'intégration dsm.html
  foehnCreteAmont, foehnCalc
};

});
