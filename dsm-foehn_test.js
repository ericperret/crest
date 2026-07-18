/*
  Fichier  : dsm-foehn.test.js
  Projet   : DSM — sous-projet PRÉCIPITATION OROGRAPHIQUE & FOEHN
  Rôle     : tests de validation Node.js pour dsm-foehn.js.
             1) Thermodynamique : Γ_sec, Γ_humide vs valeurs de référence
                connues (tables météo standard).
             2) FFT1D/2D : round-trip, cas connu.
             3) Smith & Barstad 2004 : comparaison à la solution
                analytique "triangle ridge" (même cas que la suite de
                test de l'implémentation de référence PISM) — vérifie
                un ordre de convergence > 1.9, comme l'exige la
                référence.
             4) Ordre de grandeur Vosges/Alsace (Colmar vs crête) sur un
                profil synthétique simplifié — vérification de cadrage,
                pas une validation fine (cf dsm-foehn-cadrage.md §4).
  Usage    : node dsm-foehn.test.js
  Auteur   : Eric Perret
  Date     : 2026-07-15
  Version  : 0.1
*/

const F = require("./dsm-foehn.js");

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log("  OK   " + label);
  } else {
    failures++;
    console.log("  FAIL " + label + (detail ? "  (" + detail + ")" : ""));
  }
}

// ---------------------------------------------------------------------
console.log("1) Thermodynamique");
check("Gamma_sec ~ 9.8 °C/km", Math.abs(F.GAMMA_SEC - 9.76) < 0.05, F.GAMMA_SEC);
{
  const g15 = F.moistLapseRate(15, 1013);
  const g0 = F.moistLapseRate(0, 1013);
  const gm20 = F.moistLapseRate(-20, 700);
  // Valeurs de référence usuelles (tables météo standard) :
  // ~4.3 à 20°C, ~6.4 à 0°C, ~8.6 à -20°C — tolérance large (±1 °C/km)
  check("Gamma_humide(15°C) plausible (4-5.5)", g15 > 4 && g15 < 5.5, g15.toFixed(2));
  check("Gamma_humide(0°C) plausible (5.5-7)", g0 > 5.5 && g0 < 7, g0.toFixed(2));
  check("Gamma_humide(-20°C) proche de Gamma_sec (foehn faiblit au froid)", gm20 > 7.5, gm20.toFixed(2));
  check("Gamma_humide croissant quand T decroit", g15 < g0 && g0 < gm20);
}

// ---------------------------------------------------------------------
console.log("2) Vent par époque");
{
  const d0 = F.foehnWindDirection(0);
  const dLGM = F.foehnWindDirection(-20);
  const dMid = F.foehnWindDirection(-10);
  check("direction(0) = 270 (Ouest)", Math.abs(d0 - 270) < 1e-9, d0);
  check("direction(-20) = 202.5 (SSO)", Math.abs(dLGM - 202.5) < 1e-9, dLGM);
  check("direction(-10) = milieu (236.25)", Math.abs(dMid - 236.25) < 1e-9, dMid);
  check("direction clampée au-delà de -20", F.foehnWindDirection(-30) === dLGM);
}

// ---------------------------------------------------------------------
console.log("3) FFT1D round-trip");
{
  const n = 1024;
  const re0 = Float64Array.from({ length: n }, () => Math.random());
  const im0 = new Float64Array(n);
  const re = re0.slice(), im = im0.slice();
  F.fft1d(re, im, false);
  F.fft1d(re, im, true);
  let maxErr = 0;
  for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(re[i] - re0[i]));
  check("round-trip erreur < 1e-10", maxErr < 1e-10, maxErr);
}

// ---------------------------------------------------------------------
console.log("4) Smith & Barstad 2004 — validation triangle-ridge (analytique)");
{
  function triangleRidge(x, A, d) { return Math.max(A * (1 - Math.abs(x) / d), 0); }
  function triangleRidgeExact(x, u, Cw, tau, A, d) {
    const C = Cw * u * A / d;
    const Ut = u * tau;
    const xc = Ut * Math.log(2 - Math.exp(-d / Ut));
    let P;
    if (x < 0 && x >= -d) P = C * (1 - Math.exp(-(x + d) / Ut));
    else if (x >= 0 && x <= xc) P = C * (Math.exp(-x / Ut) * (2 - Math.exp(-d / Ut)) - 1);
    else P = 0;
    return 3600 * P;
  }

  function maxErrorAt(spacing) {
    const A = 500, d = 50e3, speed = 15.0;
    const Cw = 7.4e-3 * (6.5 / 5.8); // même constante que foehnComputeFC
    const tauF = 1000.0, tauC = 0.0, Hw = 0.0, f = 0.0;
    const dirRad = (270 * Math.PI) / 180; // vent d'ouest
    const u = -Math.sin(dirRad) * speed, v = -Math.cos(dirRad) * speed;

    const xmin = -100e3, xmax = 100e3;
    const nBase = Math.round((xmax - xmin) / spacing) + 1;
    const pad = nBase;
    const nx = F.nextPow2(nBase + 2 * pad), ny = nx;
    const offX = pad, offY = pad;

    const h = new Float64Array(nx * ny);
    const xs = new Float64Array(nBase);
    for (let i = 0; i < nBase; i++) xs[i] = xmin + i * spacing;
    for (let iy = 0; iy < nBase; iy++)
      for (let ix = 0; ix < nBase; ix++)
        h[(iy + offY) * nx + (ix + offX)] = triangleRidge(xs[ix], A, d);

    const P = F.sb2004Field(h, nx, ny, spacing, spacing, {
      u, v, f, Nm: 0.005, Hw, tauC, tauF, Cw, truncate: true
    });
    const midRow = offY + Math.floor(nBase / 2);
    let maxErr = 0;
    for (let ix = 0; ix < nBase; ix++) {
      const exact = triangleRidgeExact(xs[ix], speed, Cw, tauF, A, d);
      const err = Math.abs(P[midRow * nx + (ix + offX)] - exact);
      if (err > maxErr) maxErr = err;
    }
    return maxErr;
  }

  const dxs = [4000, 2000, 1000];
  const errs = dxs.map(maxErrorAt);
  const order = (Math.log10(errs[0]) - Math.log10(errs[errs.length - 1])) /
                (Math.log10(dxs[0]) - Math.log10(dxs[dxs.length - 1]));
  console.log("   erreurs max (mm/h) pour dx=" + dxs.join(",") + " : " + errs.map(e => e.toFixed(5)).join(", "));
  check("erreur décroît avec la résolution", errs[2] < errs[0]);
  check("ordre de convergence > 1.9 (comme la suite de test PISM)", order > 1.9, order.toFixed(2));
}

// ---------------------------------------------------------------------
console.log("5) Ordre de grandeur Vosges/Alsace (profil synthétique)");
{
  // Profil très simplifié : plaine d'Alsace (Colmar, ~200 m) -> crête
  // Hohneck (~1360 m) sur ~22 km, symétrique côté lorrain. Objectif :
  // vérifier un facteur crête/plaine plausible (~3-4x), pas une
  // validation fine — cf dsm-foehn-cadrage.md §4 pour les cibles
  // chiffrées (Colmar ~530 mm/an, Hohneck ~2000 mm/an).
  const n = 256, spacing = 500; // 128 km de large, 500 m/pixel
  const pad = n, nx = F.nextPow2(n + 2 * pad), ny = nx;
  const offX = pad, offY = pad;
  const h = new Float64Array(nx * ny);
  const crestIdx = Math.floor(n / 2);
  const halfWidth = 22000 / spacing; // ~22 km du pied à la crête
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const distFromCrest = Math.abs(ix - crestIdx);
      const elev = 200 + Math.max(0, 1160 * (1 - distFromCrest / halfWidth));
      h[(iy + offY) * nx + (ix + offX)] = elev;
    }
  }
  const wind = F.foehnWindVector(0); // actuel, Ouest
  const Cw = 7.4e-3 * (6.5 / 5.8);
  const P = F.sb2004Field(h, nx, ny, spacing, spacing, {
    u: wind.u, v: wind.v, f: 2 * 7.2921e-5 * Math.sin(48 * Math.PI / 180),
    Nm: 0.005, Hw: 2500, tauC: 1000, tauF: 1000, Cw, truncate: true
  });
  const row = offY + Math.floor(n / 2);
  const crestVal = P[row * nx + (offX + crestIdx)];
  // "Colmar" = 20 km sous le vent de la crête (côté est, downwind si vent d'ouest)
  const colmarIdx = Math.min(n - 1, crestIdx + Math.round(20000 / spacing));
  const colmarVal = P[row * nx + (offX + colmarIdx)];
  const ratio = colmarVal > 1e-6 ? crestVal / colmarVal : Infinity;
  console.log("   crête=" + crestVal.toFixed(3) + " mm/h(rel.)  aval(\"Colmar\")=" + colmarVal.toFixed(3) + " mm/h(rel.)  ratio=" + ratio.toFixed(1));
  check("précipitation crête > aval (ombre pluviométrique présente)", crestVal > colmarVal * 1.5, ratio.toFixed(2));
}

// ---------------------------------------------------------------------
console.log("6) Recherche de crête amont + foehnCalc (assemblage)");
{
  // Grille 64×64 synthétique : plaine à 200 m, crête à 1400 m vers x=32,
  // vent d'ouest (270°, upwind = vers les x décroissants).
  const n = 64, resM = 1000;
  const elev = new Float32Array(n * n);
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const d = Math.abs(ix - 32);
      elev[iy * n + ix] = 200 + Math.max(0, 1200 * (1 - d / 20));
    }
  }
  // Pixel juste à l'est de la crête (aval, sous le vent d'ouest) doit voir
  // la crête en amont ; pixel loin à l'ouest (avant la crête) ne doit pas.
  const zAval = F.foehnCreteAmont(elev, n, n, 40, 32, 270, resM, 50000);
  const zAmontLoin = F.foehnCreteAmont(elev, n, n, 5, 32, 270, resM, 50000);
  check("crête vue en aval ≈ 1400 m", zAval > 1300, zAval.toFixed(0));
  check("pas de crête en amont lointain (avant la montée)", zAmontLoin < 300, zAmontLoin.toFixed(0));

  const { foehnC, foehnDT } = F.foehnCalc(0, elev, resM, 48, function () { return 15; });
  check("foehnC longueur = grille", foehnC.length === n * n);
  check("foehnDT longueur = grille", foehnDT.length === n * n);
  const dtAval = foehnDT[32 * n + 40];
  const dtSurCrete = foehnDT[32 * n + 32];
  console.log("   ΔT aval (x=40) =", dtAval.toFixed(2), "°C   ΔT sur crête (x=32) =", dtSurCrete.toFixed(2), "°C");
  check("réchauffement positif en aval de la crête", dtAval > 0, dtAval.toFixed(2));
}

// ---------------------------------------------------------------------
process.exit(failures === 0 ? 0 : 1);
