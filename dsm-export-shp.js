/* ═══════════════════════════════════════════════════════════════════
   FICHIER : dsm-export-shp.js - v27/09/2026
   OBJET   : export de l'emprise maximale d'une onde de rupture en
             Shapefile polygone (ZIP : .shp .shx .dbf .prj .cpg), WGS84
             géographique (EPSG:4326), une entité par tranche d'arrivée
             du front (isochrones), table attributaire datée.
   AUTEUR  : Eric P.
   RELECTURE : Opus 5.5
   LICENCE : CC BY-NC 4.0 — source à citer : https://github.com/ericperret/crest/
             usage commercial interdit sauf accord écrit de l'auteur (voir LICENSE)
   DÉPEND  : aucune (données passées en argument)
   EXPOSE  : ondeShapefile
   RÉFÉRENCES :
     · ESRI Shapefile Technical Description, juillet 1998 (polygone, type 5 :
       anneau extérieur horaire, trous antihoraires) ;
     · dBASE III (en-tête 32 o, descripteurs 32 o, 0x0D, enregistrements,
       0x1A) ; encodage déclaré par le fichier .cpg (UTF-8) ;
     · PKWARE APPNOTE 6.3 (ZIP, méthode 0 « stocké », CRC-32 polynôme
       0xEDB88320) ;
     · aire des pixels sur la sphère authalique du WGS84 : R = 6 371 007,2 m
       (Moritz 1980, Geodetic Reference System 1980), aire d'une maille
       = R²·Δλ·(sin φnord − sin φsud).
   CONVENTIONS : pixel d'indice (col, lig) centré sur lonMin + col·pas,
             latMax − lig·pas (même convention que l'affichage et le survol ;
             Copernicus AREA_OR_POINT=Point) ; ses coins sont à ±½ pas.
             Temps en minutes depuis la rupture.
   ═══════════════════════════════════════════════════════════════════ */
"use strict";

const SHP_R_AUTHALIQUE = 6371007.2;
const SHP_PRJ_WGS84 = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],' +
                      'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

/* ── shpBandes ── E : arr (s, −1 sec), iso [{t, pas}], N → T :
   bornes des tranches : ]0, T1], ]T1, T2]… aux isochrones, puis, pour les
   pixels atteints après le dernier isochrone (remplissage latéral une
   fois le front arrêté), tranches successives au pas du dernier isochrone
   (1 min sans isochrone) jusqu'à la dernière arrivée ; étiquette de chaque
   pixel mouillé par recherche dichotomique de la première borne ≥ date →
   S : {lab Int16 (−1 sec), t0[], t1[], pas[]} (minutes). */
function shpBandes(arr, iso, N) {
  const t1 = iso.map(i => i.t), pas = iso.map(i => i.pas);
  let aMax = 0;
  for (let p = 0; p < N; p++) if (arr[p] > aMax) aMax = arr[p];
  const pasDer = pas.length ? pas[pas.length - 1] : 1;
  let tDer = t1.length ? t1[t1.length - 1] : 0;
  while (aMax > tDer) { tDer += pasDer * 60; t1.push(tDer); pas.push(pasDer); }
  const nB = t1.length, lab = new Int16Array(N).fill(-1);
  for (let p = 0; p < N; p++) {
    const a = arr[p]; if (a < 0) continue;
    let lo = 0, hi = nB - 1;
    while (lo < hi) { const mi = (lo + hi) >> 1; if (t1[mi] < a) lo = mi + 1; else hi = mi; }
    lab[p] = lo;
  }
  const t0 = t1.map((t, k) => k ? t1[k - 1] : 0);
  return { lab: lab, t0: t0.map(t => t / 60), t1: t1.map(t => t / 60), pas: pas };
}

/* ── shpContours ── E : étiquettes lab, W, H, nombre de tranches → T :
   pour chaque tranche, arêtes de pixel séparant la tranche du reste,
   orientées tranche à droite (sens horaire à l'écran, nord en haut) et
   rangées par sommet de départ (masque 4 bits par coin) ; chaînage des
   anneaux en tournant à droite aux sommets doubles (connexité 4 : deux
   pixels en diagonale donnent deux anneaux qui se touchent en un point) ;
   sommets conservés aux seuls changements de direction (aucune perte :
   les côtés de pixel sont alignés) ; départ hors sommets doubles d'abord
   → S : {anneaux [tranche][anneau] Float64 (col, lig des coins, fermés),
   nPix [tranche]}. Anneaux extérieurs horaires, trous antihoraires. */
function shpContours(lab, W, H, nB) {
  const N = W * H, W1 = W + 1;
  const deb = new Int32Array(nB + 1);
  for (let p = 0; p < N; p++) if (lab[p] >= 0) deb[lab[p] + 1]++;
  for (let b = 0; b < nB; b++) deb[b + 1] += deb[b];
  const ordre = new Int32Array(deb[nB]), rempl = deb.slice(0, nB);
  for (let p = 0; p < N; p++) if (lab[p] >= 0) ordre[rempl[lab[p]]++] = p;
  const sortie = new Uint8Array(W1 * (H + 1));
  const pas = [1, W1, -1, -W1];
  const nbBits = m => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);

  /* E : sommet et direction de départ → T : suit les arêtes libres en
     préférant le virage à droite, efface chaque arête suivie → S : anneau
     fermé (col, lig). */
  function tracer(v0, d0) {
    const pts = [];
    let v = v0, d = d0, dPrec = -1;
    for (;;) {
      sortie[v] &= ~(1 << d);
      if (d !== dPrec) { const r = (v / W1) | 0; pts.push(v - r * W1, r); dPrec = d; }
      v += pas[d];
      if (v === v0) break;
      const bits = sortie[v], dr = (d + 1) & 3, dg = (d + 3) & 3;
      if (bits & (1 << dr)) d = dr;
      else if (bits & (1 << d)) { /* tout droit */ }
      else if (bits & (1 << dg)) d = dg;
      else break;
    }
    pts.push(pts[0], pts[1]);
    return Float64Array.from(pts);
  }

  const anneaux = [], nPix = [];
  for (let b = 0; b < nB; b++) {
    const n = deb[b + 1] - deb[b], ar = new Int32Array(4 * n);
    let na = 0;
    for (let j = deb[b]; j < deb[b + 1]; j++) {
      const p = ordre[j], r = (p / W) | 0, c = p - r * W;
      let v;
      if (r === 0 || lab[p - W] !== b)     { v = r * W1 + c;           sortie[v] |= 1; ar[na++] = v * 4; }
      if (c === W - 1 || lab[p + 1] !== b) { v = r * W1 + c + 1;       sortie[v] |= 2; ar[na++] = v * 4 + 1; }
      if (r === H - 1 || lab[p + W] !== b) { v = (r + 1) * W1 + c + 1; sortie[v] |= 4; ar[na++] = v * 4 + 2; }
      if (c === 0 || lab[p - 1] !== b)     { v = (r + 1) * W1 + c;     sortie[v] |= 8; ar[na++] = v * 4 + 3; }
    }
    const liste = [];
    for (let passe = 0; passe < 2; passe++) {
      for (let k = 0; k < na; k++) {
        const v = ar[k] >> 2, d = ar[k] & 3;
        if (!(sortie[v] & (1 << d))) continue;
        if (passe === 0 && nbBits(sortie[v]) > 1) continue;
        liste.push(tracer(v, d));
      }
    }
    anneaux.push(liste); nPix.push(n);
  }
  return { anneaux: anneaux, nPix: nPix };
}

/* ── shpSurfacesHa ── E : lab, W, H, nB, GEO → T : somme par tranche des
   aires de maille sur la sphère authalique (aire constante par ligne) →
   S : tableau des surfaces (ha). */
function shpSurfacesHa(lab, W, H, nB, geo) {
  const sx = (geo.lonMax - geo.lonMin) / W, sy = (geo.latMax - geo.latMin) / H, rad = Math.PI / 180;
  const surf = new Float64Array(nB);
  for (let r = 0; r < H; r++) {
    const phN = (geo.latMax - (r - 0.5) * sy) * rad, phS = (geo.latMax - (r + 0.5) * sy) * rad;
    const a = SHP_R_AUTHALIQUE * SHP_R_AUTHALIQUE * sx * rad * (Math.sin(phN) - Math.sin(phS));
    for (let c = 0, p = r * W; c < W; c++, p++) if (lab[p] >= 0) surf[lab[p]] += a;
  }
  return Array.from(surf, s => s / 1e4);
}

/* ── shpPolygones ── E : entités [{anneaux Float64 (col, lig)}], W, H,
   GEO → T : coins convertis en lon, lat (coin = centre ∓ ½ pas) ;
   enregistrements polygone (type 5) : boîte, parties, points ; en-têtes
   100 o (grands-boutiens : code 9994, longueur en mots de 16 bits ;
   petits-boutiens : version 1000, type, boîte) ; index .shx → S :
   {shp Uint8Array, shx Uint8Array}. */
function shpPolygones(entites, W, H, geo) {
  const sx = (geo.lonMax - geo.lonMin) / W, sy = (geo.latMax - geo.latMin) / H;
  const lon = c => geo.lonMin + (c - 0.5) * sx, lat = r => geo.latMax - (r - 0.5) * sy;
  let taille = 100;
  const rec = entites.map(e => {
    let np = 0; e.anneaux.forEach(a => { np += a.length / 2; });
    const cont = 44 + 4 * e.anneaux.length + 16 * np;
    taille += 8 + cont;
    return { cont: cont, np: np };
  });
  const shp = new ArrayBuffer(taille), shx = new ArrayBuffer(100 + 8 * entites.length);
  const D = new DataView(shp), X = new DataView(shx);
  const bb = [Infinity, Infinity, -Infinity, -Infinity];
  let o = 100;
  entites.forEach((e, i) => {
    X.setInt32(100 + 8 * i, o / 2, false); X.setInt32(104 + 8 * i, rec[i].cont / 2, false);
    D.setInt32(o, i + 1, false); D.setInt32(o + 4, rec[i].cont / 2, false);
    const c0 = o + 8;
    D.setInt32(c0, 5, true);
    D.setInt32(c0 + 36, e.anneaux.length, true); D.setInt32(c0 + 40, rec[i].np, true);
    let q = c0 + 44, k = 0;
    e.anneaux.forEach(a => { D.setInt32(q, k, true); q += 4; k += a.length / 2; });
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    e.anneaux.forEach(a => {
      for (let j = 0; j < a.length; j += 2) {
        const x = lon(a[j]), y = lat(a[j + 1]);
        D.setFloat64(q, x, true); D.setFloat64(q + 8, y, true); q += 16;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    });
    D.setFloat64(c0 + 4, x0, true); D.setFloat64(c0 + 12, y0, true);
    D.setFloat64(c0 + 20, x1, true); D.setFloat64(c0 + 28, y1, true);
    if (x0 < bb[0]) bb[0] = x0; if (y0 < bb[1]) bb[1] = y0; if (x1 > bb[2]) bb[2] = x1; if (y1 > bb[3]) bb[3] = y1;
    o += 8 + rec[i].cont;
  });
  [[D, taille], [X, 100 + 8 * entites.length]].forEach(([V, t]) => {
    V.setInt32(0, 9994, false); V.setInt32(24, t / 2, false);
    V.setInt32(28, 1000, true); V.setInt32(32, 5, true);
    for (let j = 0; j < 4; j++) V.setFloat64(36 + 8 * j, bb[j], true);
  });
  return { shp: new Uint8Array(shp), shx: new Uint8Array(shx) };
}

/* ── shpDbf ── E : champs [{n, t ('N'|'C'), l, d}], lignes (tableaux de
   valeurs) → T : en-tête dBASE III (0x03, date, nombre, longueurs),
   descripteurs, 0x0D ; numériques cadrés à droite à d décimales,
   caractères UTF-8 tronqués sur une frontière de caractère et complétés
   d'espaces ; 0x1A final → S : Uint8Array. */
function shpDbf(champs, lignes) {
  const enc = new TextEncoder();
  const lRec = 1 + champs.reduce((s, c) => s + c.l, 0), lEnt = 32 + 32 * champs.length + 1;
  const buf = new Uint8Array(lEnt + lRec * lignes.length + 1).fill(0x20);
  const D = new DataView(buf.buffer), now = new Date();
  buf.fill(0, 0, lEnt);
  buf[0] = 0x03; buf[1] = now.getFullYear() - 1900; buf[2] = now.getMonth() + 1; buf[3] = now.getDate();
  D.setUint32(4, lignes.length, true); D.setUint16(8, lEnt, true); D.setUint16(10, lRec, true);
  champs.forEach((c, i) => {
    const o = 32 + 32 * i;
    for (let j = 0; j < c.n.length; j++) buf[o + j] = c.n.charCodeAt(j);
    buf[o + 11] = c.t.charCodeAt(0); buf[o + 16] = c.l; buf[o + 17] = c.d || 0;
  });
  buf[lEnt - 1] = 0x0D;
  lignes.forEach((ligne, k) => {
    let o = lEnt + k * lRec + 1;
    champs.forEach((c, i) => {
      let octets;
      if (c.t === 'N') {
        let s = Number(ligne[i]).toFixed(c.d || 0);
        if (s.length > c.l) s = '*'.repeat(c.l);
        octets = enc.encode(s.padStart(c.l, ' '));
      } else {
        octets = enc.encode(String(ligne[i]));
        if (octets.length > c.l) {
          let n = c.l; while (n > 0 && (octets[n] & 0xC0) === 0x80) n--;
          octets = octets.subarray(0, n);
        }
      }
      buf.set(octets, o); o += c.l;
    });
  });
  buf[buf.length - 1] = 0x1A;
  return buf;
}

/* ── zipStocker ── E : fichiers [{nom, donnees Uint8Array}] → T : CRC-32
   (table 256, polynôme réfléchi 0xEDB88320), en-têtes locaux 0x04034b50,
   répertoire central 0x02014b50, fin 0x06054b50, méthode 0, noms UTF-8
   (bit 11), date et heure DOS courantes → S : Blob application/zip. */
function zipStocker(fichiers) {
  const T = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
  const crc = u => { let c = 0xFFFFFFFF; for (let i = 0; i < u.length; i++) c = T[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const enc = new TextEncoder(), d = new Date();
  const hDos = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const jDos = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const morceaux = [], central = [];
  let off = 0;
  fichiers.forEach(f => {
    const nom = enc.encode(f.nom), c = crc(f.donnees), n = f.donnees.length;
    const L = new DataView(new ArrayBuffer(30));
    L.setUint32(0, 0x04034b50, true); L.setUint16(4, 20, true); L.setUint16(6, 0x0800, true);
    L.setUint16(8, 0, true); L.setUint16(10, hDos, true); L.setUint16(12, jDos, true);
    L.setUint32(14, c, true); L.setUint32(18, n, true); L.setUint32(22, n, true);
    L.setUint16(26, nom.length, true); L.setUint16(28, 0, true);
    morceaux.push(new Uint8Array(L.buffer), nom, f.donnees);
    const C = new DataView(new ArrayBuffer(46));
    C.setUint32(0, 0x02014b50, true); C.setUint16(4, 20, true); C.setUint16(6, 20, true);
    C.setUint16(8, 0x0800, true); C.setUint16(10, 0, true); C.setUint16(12, hDos, true); C.setUint16(14, jDos, true);
    C.setUint32(16, c, true); C.setUint32(20, n, true); C.setUint32(24, n, true);
    C.setUint16(28, nom.length, true); C.setUint32(42, off, true);
    central.push(new Uint8Array(C.buffer), nom);
    off += 30 + nom.length + n;
  });
  let tc = 0; central.forEach(u => { tc += u.length; });
  const F = new DataView(new ArrayBuffer(22));
  F.setUint32(0, 0x06054b50, true); F.setUint16(8, fichiers.length, true); F.setUint16(10, fichiers.length, true);
  F.setUint32(12, tc, true); F.setUint32(16, off, true);
  return new Blob(morceaux.concat(central, [new Uint8Array(F.buffer)]), { type: 'application/zip' });
}

/* ── shpNom ── E : texte → T : décomposition NFD, diacritiques retirés,
   tout caractère hors [A-Za-z0-9_-] → « _ », 40 caractères au plus →
   S : nom de fichier. */
function shpNom(t) {
  return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_')
          .replace(/^_+|_+$/g, '').slice(0, 40) || 'barrage';
}

/* ── ondeShapefile ── E : {arr Float32 (s), iso, info (qMax)}, W, H,
   GEO, méta {nom, V km³, h0 m} → T : tranches d'arrivée, contours,
   surfaces, entités non vides, table (ID, T_DEB_MIN, T_FIN_MIN,
   T_FIN_HM, PAS_MIN, SURF_HA, NB_PIX, BARRAGE, V_KM3, H0_M, Q_MAX_M3S),
   .prj WGS84, .cpg UTF-8, ZIP → S : {blob, nom (.zip), nb (entités),
   surfHa (total)}. */
function ondeShapefile(R, W, H, geo, meta) {
  const N = W * H;
  const B = shpBandes(R.arr, R.iso, N), nB = B.t1.length;
  const C = shpContours(B.lab, W, H, nB), S = shpSurfacesHa(B.lab, W, H, nB, geo);
  const hm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
  const entites = [], lignes = [];
  let total = 0;
  for (let b = 0; b < nB; b++) {
    if (!C.nPix[b]) continue;
    entites.push({ anneaux: C.anneaux[b] });
    lignes.push([entites.length, B.t0[b], B.t1[b], hm(B.t1[b]), B.pas[b], S[b], C.nPix[b],
                 meta.nom, meta.V, meta.h0, Math.round(R.info.qMax)]);
    total += S[b];
  }
  const champs = [
    { n: 'ID', t: 'N', l: 6, d: 0 }, { n: 'T_DEB_MIN', t: 'N', l: 7, d: 0 },
    { n: 'T_FIN_MIN', t: 'N', l: 7, d: 0 }, { n: 'T_FIN_HM', t: 'C', l: 6 },
    { n: 'PAS_MIN', t: 'N', l: 5, d: 0 }, { n: 'SURF_HA', t: 'N', l: 14, d: 2 },
    { n: 'NB_PIX', t: 'N', l: 10, d: 0 }, { n: 'BARRAGE', t: 'C', l: 80 },
    { n: 'V_KM3', t: 'N', l: 12, d: 4 }, { n: 'H0_M', t: 'N', l: 8, d: 1 },
    { n: 'Q_MAX_M3S', t: 'N', l: 10, d: 0 }];
  const P = shpPolygones(entites, W, H, geo), base = 'onde_' + shpNom(meta.nom), enc = new TextEncoder();
  const blob = zipStocker([
    { nom: base + '.shp', donnees: P.shp }, { nom: base + '.shx', donnees: P.shx },
    { nom: base + '.dbf', donnees: shpDbf(champs, lignes) },
    { nom: base + '.prj', donnees: enc.encode(SHP_PRJ_WGS84) },
    { nom: base + '.cpg', donnees: enc.encode('UTF-8') }]);
  return { blob: blob, nom: base + '.zip', nb: entites.length, surfHa: total };
}
