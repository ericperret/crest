/* ═══════════════════════════════════════════════════════════════════
   FICHIER : dsm-barrage.js - v27/09/2026
   OBJET   : barrages connus de l'emprise (CFBR, GDW puis FAO) posés sur
             la carte ; menu du clic droit (rupture directe du barrage
             sous le curseur, robinet, lave, rupture d'un barrage proche
             ou saisi) ; trajectoire de référence par le robinet ;
             lancement du calcul d'onde (dsm-worker-barrage.js) ; affichage
             vivant de l'onde pendant le calcul, rejeu (lecture, pause,
             curseur de temps), isochrones ; export Shapefile de
             l'emprise maximale datée (dsm-export-shp.js).
   AUTEUR  : Eric P.
   RELECTURE : Opus 5.5
   LICENCE : CC BY-NC 4.0 — source à citer : https://github.com/ericperret/crest/
             usage commercial interdit sauf accord écrit de l'auteur (voir LICENSE)
   DÉPEND  : dsm.html (GEO, imgW, imgH, elevGrid, canvas, ctx, DISP, srcX,
             srcY, srcPPx, render, coordEl, wrapEl), dsm-ombre.js
             (placeFaucet, eauTrajectoire), dsm-barrages-cfbr.js
             (BARRAGES_CFBR), dsm-barrages-gdw.js (BARRAGES_GDW),
             dsm-barrages-fao.js (BARRAGES_FAO), dsm-worker-barrage.js
             (BARRAGEWORKER), dsm-export-shp.js (ondeShapefile)
   EXPOSE  : barrageDessiner, barrageArrivee, barrageEffacer
   CONVENTIONS : volumes en km³ à l'écran, m³ au calcul ; hauteur d'eau
             initiale = hauteur du barrage sur terrain naturel (retenue
             pleine, cas le pire) ; temps en s, affichés en h min ; rive
             m = 2·station + côté ; lames des clichés en cm au-dessus du lit
             de la station.
   ═══════════════════════════════════════════════════════════════════ */
"use strict";

const BAR_RAYON_KM = 30;        /* rayon de recherche des barrages autour du clic */
const BAR_NB_PROPOSES = 10;
const BAR_DOUBLON_KM = 3;       /* deux ouvrages à moins de 3 km sont le même */
const BAR_ALPHA_TRACE = 0.35;   /* pixel atteint, eau retirée */
const BAR_ALPHA_EAU = 0.90;     /* pixel sous BAR_H_PLEIN d'eau ou plus */
const BAR_H_ARRIVEE = 0.10;     /* m : identique à H_ARRIVEE du Worker */
const BAR_H_PLEIN = 10;         /* m : lame d'opacité maximale (échelle log 0,1 → 10 m) */
const BAR_PICK_PX = 10;         /* px écran : tolérance du clic droit sur un repère */
const BAR_ETIQ_MAX = 40;        /* noms des repères écrits si ≤ 40 visibles */
const BAR_VITESSES = [[60, '1 min/s'], [300, '5 min/s'], [900, '15 min/s'], [3600, '1 h/s']];

let barrageSite = -1, barrageTitre = '', barrageMeta = null;
let onde = null;
let sitesGeo = null, sitesBarrages = [];

/* ── geoVersPixel ── E : lat, lon (°) → T : interpolation linéaire dans
   l'emprise GEO → S : {col, row} (réels). */
function geoVersPixel(lat, lon) {
  return { col: (lon - GEO.lonMin) / (GEO.lonMax - GEO.lonMin) * imgW,
           row: (GEO.latMax - lat) / (GEO.latMax - GEO.latMin) * imgH };
}

/* ── distKm ── E : deux couples lat, lon → T : haversine, R = 6371 km →
   S : distance (km). */
function distKm(la1, lo1, la2, lo2) {
  const r = Math.PI / 180, a = Math.sin((la2 - la1) * r / 2) ** 2 +
    Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin((lo2 - lo1) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

/* ── hMin ── E : durée (s) → T : heures et minutes entières → S : « h h mm ». */
function hMin(s) {
  const m = Math.floor(s / 60);
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

/* ═══ BARRAGES DE L'EMPRISE ═════════════════════════════════════════ */

/* ── barragesEmprise ── E : GEO et bibliothèques → T : ouvrages CFBR,
   puis GDW, puis FAO situés dans l'emprise ; un ouvrage à moins de
   BAR_DOUBLON_KM d'un ouvrage déjà retenu est écarté (priorité CFBR > GDW
   > FAO) et sa longueur de digue, si connue, est reportée sur l'ouvrage
   retenu ; position pixel arrondie → S : liste de {nom, lat, lon, h, V,
   hFond, L, src, col, row}. */
function barragesEmprise() {
  const dedans = (la, lo) => la >= GEO.latMin && la <= GEO.latMax && lo >= GEO.lonMin && lo <= GEO.lonMax;
  const res = [];
  const cfbr = (typeof BARRAGES_CFBR !== 'undefined') ? BARRAGES_CFBR : [];
  const gdw  = (typeof BARRAGES_GDW  !== 'undefined') ? BARRAGES_GDW  : [];
  const fao  = (typeof BARRAGES_FAO  !== 'undefined') ? BARRAGES_FAO  : [];
  const jumeauDe = (la, lo) => res.find(c => distKm(c.lat, c.lon, la, lo) < BAR_DOUBLON_KM);
  cfbr.forEach(b => {
    if (dedans(b[0], b[1])) res.push({ nom: b[5], lat: b[0], lon: b[1], h: b[2], V: b[3], hFond: b[4], L: 0, src: 'CFBR' });
  });
  gdw.forEach(b => {
    if (!dedans(b[0], b[1])) return;
    const jumeau = jumeauDe(b[0], b[1]);
    if (jumeau) { if (!jumeau.L && b[7] > 0) jumeau.L = b[7]; return; }
    res.push({ nom: b[5], lat: b[0], lon: b[1], h: b[2], V: b[3], hFond: 0, L: b[7], src: b[4] ? 'GDW est.' : 'GDW' });
  });
  fao.forEach(b => {
    if (!dedans(b[0], b[1]) || jumeauDe(b[0], b[1])) return;
    res.push({ nom: b[4], lat: b[0], lon: b[1], h: b[2], V: b[3], hFond: 0, L: 0, src: 'FAO' });
  });
  res.forEach(b => {
    const p = geoVersPixel(b.lat, b.lon);
    b.col = Math.min(imgW - 1, Math.max(0, Math.round(p.col)));
    b.row = Math.min(imgH - 1, Math.max(0, Math.round(p.row)));
  });
  return res;
}

/* ── sitesAJour ── E : GEO → T : recalcule la liste des barrages de
   l'emprise quand la tuile a changé → S : sitesBarrages. */
function sitesAJour() {
  if (sitesGeo === GEO) return;
  sitesGeo = GEO;
  sitesBarrages = GEO ? barragesEmprise() : [];
}

/* ── barragesProches ── E : lat, lon du clic → T : barrages de l'emprise
   à moins de BAR_RAYON_KM, triés par distance → S : BAR_NB_PROPOSES
   premiers, avec d (km). */
function barragesProches(lat, lon) {
  sitesAJour();
  return sitesBarrages.map(b => Object.assign({}, b, { d: distKm(lat, lon, b.lat, b.lon) }))
                      .filter(b => b.d <= BAR_RAYON_KM)
                      .sort((a, b) => a.d - b.d).slice(0, BAR_NB_PROPOSES);
}

/* ── siteEcran ── E : barrage, rectangle du canvas → T : centre du pixel
   de l'ouvrage ramené à la vue → S : {x, y} (px écran). */
function siteEcran(b, r) {
  const f = r.width / (DISP * srcPPx);
  return { x: r.left + (b.col + 0.5 - srcX) * f, y: r.top + (b.row + 0.5 - srcY) * f };
}

/* ── siteSous ── E : position écran → T : barrage le plus proche dont le
   repère est à moins de BAR_PICK_PX → S : barrage ou null. */
function siteSous(x, y) {
  sitesAJour();
  const r = canvas.getBoundingClientRect();
  let best = null, dMin = BAR_PICK_PX;
  sitesBarrages.forEach(b => {
    const e = siteEcran(b, r), d = Math.hypot(e.x - x, e.y - y);
    if (d <= dMin) { dMin = d; best = b; }
  });
  return best;
}

/* ── ordreBarrage ── E : barrage de bibliothèque → T : paramètres de
   rupture au point de l'ouvrage → S : ordre pour barrageLancer. */
function ordreBarrage(b) {
  return { col: b.col, row: b.row, mode: 'bib', V: b.V, h0: b.h, L: b.L, nom: b.nom };
}

/* ═══ MENU DU CLIC DROIT ════════════════════════════════════════════ */
const menuClic = document.createElement('div');
menuClic.id = 'menu-clic';
document.body.appendChild(menuClic);

/* ── menuFermer ── E : aucune → T : masque le menu → S : aucune. */
function menuFermer() { menuClic.style.display = 'none'; }

/* ── menuOuvrir ── E : position écran, colonne, ligne, barrage sous le
   curseur (ou null) → T : entrée de rupture directe du barrage visé,
   puis Robinet, Lave (inactive), Rupture de barrage (liste ou saisie) ;
   menu placé au curseur → S : aucune. */
function menuOuvrir(x, y, col, row, site) {
  menuClic.innerHTML = '';
  const item = (txt, actif, action) => {
    const b = document.createElement('button');
    b.className = 'btn'; b.textContent = txt; b.disabled = !actif;
    b.onclick = () => { menuFermer(); action(); };
    menuClic.appendChild(b);
  };
  if (site) item(`🌊 Rupture : ${site.nom} — ${site.h} m — ${site.V} km³ [${site.src}]`, true,
                 () => barrageLancer(ordreBarrage(site)));
  item('💧 Robinet', true, () => placeFaucet(col, row));
  item('🌋 Lave (à venir)', false, () => {});
  item(site ? '🌊 Autre barrage / saisie…' : '🌊 Rupture de barrage', true, () => barrageDialogue(col, row));
  menuClic.style.left = x + 'px'; menuClic.style.top = y + 'px';
  menuClic.style.display = 'flex';
}

canvas.addEventListener('contextmenu', e => {
  e.preventDefault(); if (!elevGrid) return;
  const r = canvas.getBoundingClientRect();
  const cx = (e.clientX - r.left) / r.width, cy = (e.clientY - r.top) / r.height;
  menuOuvrir(e.clientX, e.clientY,
             Math.round(srcX + cx * DISP * srcPPx), Math.round(srcY + cy * DISP * srcPPx),
             siteSous(e.clientX, e.clientY));
});
window.addEventListener('mousedown', e => { if (!menuClic.contains(e.target)) menuFermer(); });
window.addEventListener('keydown', e => {
  if (e.code === 'Escape') { menuFermer(); dlgFermer(); }
  if (e.code === 'Space' && !(e.target.closest && e.target.closest('#onde-panel, #dlg-barrage'))) barrageEffacer();
});

/* ═══ DIALOGUE BARRAGE ══════════════════════════════════════════════ */
const dlgBarrage = document.createElement('div');
dlgBarrage.id = 'dlg-barrage';
document.body.appendChild(dlgBarrage);

/* ── dlgFermer ── E : aucune → T : masque le dialogue → S : aucune. */
function dlgFermer() { dlgBarrage.style.display = 'none'; }

/* ── barrageDialogue ── E : colonne, ligne du clic → T : liste les
   barrages proches (un clic lance la simulation sur l'ouvrage) et
   propose la saisie du volume (km³) et de la hauteur d'eau (m) au point
   cliqué → S : aucune. */
function barrageDialogue(col, row) {
  if (!GEO) return;
  const lat = GEO.latMax - row / imgH * (GEO.latMax - GEO.latMin);
  const lon = GEO.lonMin + col / imgW * (GEO.lonMax - GEO.lonMin);
  const liste = barragesProches(lat, lon);
  dlgBarrage.innerHTML = '';
  const titre = document.createElement('div');
  titre.className = 'dlg-titre'; titre.textContent = 'Rupture instantanée de barrage';
  dlgBarrage.appendChild(titre);
  if (liste.length) {
    liste.forEach(b => {
      const bt = document.createElement('button');
      bt.className = 'btn dlg-ligne';
      bt.textContent = `${b.nom} — ${b.h} m — ${b.V} km³ — ${b.d.toFixed(1)} km [${b.src}]`;
      bt.onclick = () => { dlgFermer(); barrageLancer(ordreBarrage(b)); };
      dlgBarrage.appendChild(bt);
    });
  } else {
    const r = document.createElement('div'); r.className = 'dlg-note';
    r.textContent = `Aucun barrage connu à moins de ${BAR_RAYON_KM} km.`;
    dlgBarrage.appendChild(r);
  }
  const saisie = document.createElement('div'); saisie.className = 'dlg-saisie';
  saisie.innerHTML = 'Au point cliqué : V <input id="dlg-v" type="number" min="0.0001" step="0.01" value="0.1"> km³ ' +
                     'h <input id="dlg-h" type="number" min="1" step="1" value="50"> m ';
  const go = document.createElement('button'); go.className = 'btn'; go.textContent = 'Lancer';
  go.onclick = () => {
    const V = parseFloat(document.getElementById('dlg-v').value);
    const h = parseFloat(document.getElementById('dlg-h').value);
    if (!(V > 0) || !(h > 0)) return;
    dlgFermer();
    barrageLancer({ col: col, row: row, mode: 'manuel', V: V, h0: h, L: 0, nom: 'Barrage saisi' });
  };
  saisie.appendChild(go);
  dlgBarrage.appendChild(saisie);
  const ann = document.createElement('button'); ann.className = 'btn'; ann.textContent = 'Annuler';
  ann.onclick = dlgFermer;
  dlgBarrage.appendChild(ann);
  dlgBarrage.style.display = 'flex';
}

/* ═══ PANNEAU DE L'ONDE (calcul, rejeu, export) ═════════════════════ */
const ondePanneau = document.createElement('div');
ondePanneau.id = 'onde-panel';
ondePanneau.innerHTML =
  '<button class="btn" id="onde-play" title="Lecture / pause">▶</button>' +
  '<input type="range" id="onde-t" min="0" max="0" step="1" value="0">' +
  '<span id="onde-lbl">0 h 00</span>' +
  '<select id="onde-v" title="Vitesse de lecture">' +
  BAR_VITESSES.map(v => `<option value="${v[0]}"${v[0] === 300 ? ' selected' : ''}>${v[1]}</option>`).join('') +
  '</select>' +
  '<button class="btn" id="onde-shp" title="Emprise maximale datée, WGS84">⬇ Shapefile</button>' +
  '<button class="btn" id="onde-x" title="Effacer (Espace)">✕</button>';
wrapEl.appendChild(ondePanneau);
const ondeCurseur = document.getElementById('onde-t');
const ondeBtnPlay = document.getElementById('onde-play');
const ondeBtnShp = document.getElementById('onde-shp');
const ondeLbl = document.getElementById('onde-lbl');

ondeCurseur.addEventListener('input', () => {
  if (!onde || onde.enCours) return;
  ondeLecture(false);
  onde.tView = +ondeCurseur.value;
  ondeRafraichir();
});
ondeBtnPlay.addEventListener('click', () => { if (onde && !onde.enCours) ondeLecture(!onde.lecture); });
document.getElementById('onde-v').addEventListener('change', e => { if (onde) onde.vitesse = +e.target.value; });
ondeBtnShp.addEventListener('click', ondeExporter);
document.getElementById('onde-x').addEventListener('click', barrageEffacer);
ondePanneau.addEventListener('mousedown', e => e.stopPropagation());

/* ── ondePanneauMaj ── E : onde → T : en calcul : curseur suivant le
   temps simulé, lecture et export inactifs ; calcul fini : curseur sur
   [0, tFin], lecture et export actifs ; étiquette de temps → S : aucune. */
function ondePanneauMaj() {
  ondePanneau.style.display = onde ? 'flex' : 'none';
  if (!onde) return;
  const O = onde;
  ondeCurseur.max = Math.ceil(O.enCours ? O.t : O.tFin);
  ondeCurseur.value = Math.round(O.tView);
  ondeCurseur.disabled = O.enCours;
  ondeBtnPlay.disabled = O.enCours; ondeBtnShp.disabled = O.enCours;
  ondeBtnPlay.textContent = O.lecture ? '⏸' : '▶';
  ondeLbl.textContent = `t = ${hMin(O.tView)}` + (O.enCours ? ' — calcul…' : '');
}

/* ═══ ÉTAT, CALQUE ET REJEU DE L'ONDE ═══════════════════════════════ */

/* table des 256 couleurs de temps (rouge tôt → violet tard) */
const BAR_LUT = (function () {
  const t = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) { const c = couleurTemps(i / 255); t[3 * i] = c[0]; t[3 * i + 1] = c[1]; t[3 * i + 2] = c[2]; }
  return t;
})();

/* ── couleurTemps ── E : fraction 0..1 → T : teinte 0° (rouge, tôt) à
   270° (violet, tard), saturation 100 %, luminosité 55 % → S : [r,g,b]. */
function couleurTemps(f) {
  const h = 270 * Math.max(0, Math.min(1, f)), s = 1, l = 0.55;
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const c = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return [c(0), c(8), c(4)];
}

/* ── ondeNouvelle ── E : imgW, imgH → T : état vide d'une onde en calcul :
   listes d'arrivée extensibles (pixel, date, rive, seuil), index pixel →
   rang, calque RGBA persistant, boîte englobante des pixels mouillés →
   S : objet onde. */
function ondeNouvelle() {
  const cap = 1 << 16;
  return {
    enCours: true, lecture: false, raf: 0, vitesse: 300,
    t: 0, tFin: 0, tView: 0, tNorm: 60,
    nW: 0, cap: cap, wp: new Int32Array(cap), wa: new Float32Array(cap), wm: new Int32Array(cap), wg: new Float32Array(cap),
    iWet: new Int32Array(imgW * imgH).fill(-1),
    M: 0, lit: null, prof: null, niv: null, snaps: null, nSnap: 0, dtSnap: 60, maxNiv: null,
    arr: null, iso: [], info: null,
    img: new ImageData(imgW, imgH), osc: new OffscreenCanvas(imgW, imgH),
    bb: [imgW, imgH, -1, -1]
  };
}

/* ── ondeAjouter ── E : pixel, date (s), rive, seuil → T : ajout aux
   listes (doublement à saturation), index, boîte englobante → S : aucune. */
function ondeAjouter(p, a, m, g) {
  const O = onde;
  if (O.nW === O.cap) {
    O.cap *= 2;
    const n1 = new Int32Array(O.cap); n1.set(O.wp); O.wp = n1;
    const n2 = new Float32Array(O.cap); n2.set(O.wa); O.wa = n2;
    const n3 = new Int32Array(O.cap); n3.set(O.wm); O.wm = n3;
    const n4 = new Float32Array(O.cap); n4.set(O.wg); O.wg = n4;
  }
  O.wp[O.nW] = p; O.wa[O.nW] = a; O.wm[O.nW] = m; O.wg[O.nW] = g; O.iWet[p] = O.nW; O.nW++;
  const r = (p / imgW) | 0, c = p - r * imgW, b = O.bb;
  if (c < b[0]) b[0] = c; if (r < b[1]) b[1] = r; if (c > b[2]) b[2] = c; if (r > b[3]) b[3] = r;
}

/* ── ondeNiveaux ── E : instant t → T : niveau de chaque rive ; en
   calcul : dernières lames reçues ; rejeu : interpolation linéaire entre
   les deux clichés encadrant t ; lame < 1 cm → sèche (−∞) ; niveau = lit
   de la station + lame → S : onde.niv. */
function ondeNiveaux(t) {
  const O = onde, M2 = 2 * O.M, niv = O.niv, lit = O.lit;
  if (O.enCours) {
    for (let m = 0; m < M2; m++) { const d = O.prof[m]; niv[m] = d > 0 ? lit[m >> 1] + d / 100 : -Infinity; }
    return;
  }
  const x = Math.max(0, Math.min(t / O.dtSnap, O.nSnap - 1)), k0 = Math.floor(x);
  const k1 = Math.min(k0 + 1, O.nSnap - 1), f = x - k0, o0 = k0 * M2, o1 = k1 * M2, S = O.snaps;
  for (let m = 0; m < M2; m++) {
    const d = S[o0 + m] + (S[o1 + m] - S[o0 + m]) * f;
    niv[m] = d >= 1 ? lit[m >> 1] + d / 100 : -Infinity;
  }
}

/* ── ondePeindre ── E : onde, instant affiché tView, échelle tNorm →
   T : pour chaque pixel mouillé : transparent s'il n'est pas encore
   atteint ; couleur de son temps d'arrivée (arrivée / tNorm) ; opacité
   BAR_ALPHA_TRACE si l'eau s'est retirée, sinon croissant avec la lame
   courante (log, 0,1 m → BAR_H_PLEIN) jusqu'à BAR_ALPHA_EAU ; un pixel
   est sous l'eau si le niveau de sa rive dépasse son seuil de connexion
   de BAR_H_ARRIVEE (même règle que le Worker) ; recopie de la seule
   boîte englobante → S : onde.osc. */
function ondePeindre() {
  const O = onde; if (!O.niv || O.nW === 0) return;
  ondeNiveaux(O.tView);
  const d = O.img.data, tv = O.tView, tn = O.tNorm, z = elevGrid, niv = O.niv;
  const aT = Math.round(255 * BAR_ALPHA_TRACE), dA = 255 * (BAR_ALPHA_EAU - BAR_ALPHA_TRACE);
  const lPlein = Math.log(BAR_H_PLEIN / BAR_H_ARRIVEE);
  for (let i = 0; i < O.nW; i++) {
    const p = O.wp[i], o = p * 4, a = O.wa[i];
    if (a > tv) { d[o + 3] = 0; continue; }
    const k = 3 * Math.min(255, Math.round(a / tn * 255));
    d[o] = BAR_LUT[k]; d[o + 1] = BAR_LUT[k + 1]; d[o + 2] = BAR_LUT[k + 2];
    const lev = niv[O.wm[i]];
    let al = aT;
    if (lev - O.wg[i] >= BAR_H_ARRIVEE) {
      const h = lev - z[p];
      if (h > BAR_H_ARRIVEE) al = Math.round(255 * BAR_ALPHA_TRACE + dA * Math.min(1, Math.log(h / BAR_H_ARRIVEE) / lPlein));
    }
    d[o + 3] = al;
  }
  const b = O.bb;
  if (b[2] >= b[0]) O.osc.getContext('2d').putImageData(O.img, 0, 0, b[0], b[1], b[2] - b[0] + 1, b[3] - b[1] + 1);
}

/* ── ondeRafraichir ── E : onde → T : calque, panneau, rendu → S : aucune. */
function ondeRafraichir() {
  if (!onde) return;
  ondePeindre(); ondePanneauMaj(); render();
}

/* ── ondeLecture ── E : marche (booléen) → T : lecture : avance tView de
   (durée réelle écoulée × vitesse) à chaque image, repart de 0 si l'on
   était au bout, s'arrête à tFin ; pause : annule l'image en attente →
   S : aucune. */
function ondeLecture(marche) {
  const O = onde; if (!O) return;
  if (O.raf) { cancelAnimationFrame(O.raf); O.raf = 0; }
  O.lecture = marche;
  if (marche) {
    if (O.tView >= O.tFin) O.tView = 0;
    let dern = performance.now();
    const pas = now => {
      if (onde !== O || !O.lecture) return;
      O.tView = Math.min(O.tFin, O.tView + (now - dern) / 1000 * O.vitesse); dern = now;
      if (O.tView >= O.tFin) O.lecture = false;
      ondeRafraichir();
      if (O.lecture) O.raf = requestAnimationFrame(pas); else O.raf = 0;
    };
    O.raf = requestAnimationFrame(pas);
  }
  ondePanneauMaj();
}

/* ── ondeMessage ── E : message du Worker → T : « geom » : lits des
   stations, tableaux de niveaux ; « instant » : pixels nouvellement
   atteints ajoutés, lames courantes, tView = tNorm = t simulé, état de la
   barre (temps, front, débit à la brèche, part restante de la retenue),
   rafraîchissement → S : aucune. */
function ondeMessage(m) {
  const O = onde; if (!O) return;
  if (m.type === 'geom') {
    O.M = m.M; O.lit = m.lit; O.prof = new Uint16Array(2 * m.M); O.niv = new Float32Array(2 * m.M);
    return;
  }
  if (m.type !== 'instant') return;
  for (let i = 0; i < m.p.length; i++) ondeAjouter(m.p[i], m.a[i], m.m[i], m.g[i]);
  O.prof = m.prof; O.t = m.t; O.tView = m.t; O.tNorm = Math.max(60, m.t);
  document.getElementById('vstatus').textContent =
    `${barrageTitre} — t = ${hMin(m.t)} — front ${m.frontKm.toFixed(1)} km — ` +
    `Q brèche ${Math.round(m.q).toLocaleString()} m³/s — retenue ${(100 * m.reste).toFixed(0)} %`;
  ondeRafraichir();
}

/* ── ondeFin ── E : résultat du Worker → T : listes d'arrivée reprises du
   résultat (autorité), index reconstruit, clichés, enveloppe des niveaux,
   isochrones ; tNorm = dernier isochrone (sinon tFin) ; affichage à tFin
   → S : aucune. */
function ondeFin(R) {
  const O = onde; if (!O) return;
  O.iWet.fill(-1); O.nW = 0; O.bb = [imgW, imgH, -1, -1];
  O.cap = Math.max(1, R.wp.length);
  O.wp = new Int32Array(O.cap); O.wa = new Float32Array(O.cap); O.wm = new Int32Array(O.cap); O.wg = new Float32Array(O.cap);
  for (let i = 0; i < R.wp.length; i++) ondeAjouter(R.wp[i], R.arr[R.wp[i]], R.wm[i], R.wg[i]);
  O.M = R.M; O.lit = R.lit; O.niv = new Float32Array(2 * R.M);
  O.snaps = R.snaps; O.nSnap = R.nSnap; O.dtSnap = R.dtSnap; O.maxNiv = R.maxNiv;
  O.arr = R.arr; O.iso = R.iso; O.info = R.info;
  O.enCours = false; O.tFin = R.info.tFin; O.tView = O.tFin; O.t = O.tFin;
  O.tNorm = R.iso.length ? R.iso[R.iso.length - 1].t : Math.max(60, R.info.tFin);
  ondeRafraichir();
  document.getElementById('vstatus').textContent = barrageBilan();
}

/* ═══ LANCEMENT ═════════════════════════════════════════════════════ */

/* ── barrageLancer ── E : {col, row, mode, V (km³), h0 (m), L (m), nom}
   → T : efface le résultat précédent, trajectoire de référence par
   eauTrajectoire, taille des pixels depuis GEO (111 320 m/° × cos lat),
   copie du DSM transférée au Worker, onde vivante → S : aucune. */
function barrageLancer(o) {
  barrageEffacer();
  const st = document.getElementById('vstatus');
  if (o.col < 0 || o.col >= imgW || o.row < 0 || o.row >= imgH) { st.textContent = 'Barrage hors de la tuile'; return; }
  barrageSite = o.row * imgW + o.col;
  barrageTitre = `${o.nom} — ${o.V} km³, ${o.h0} m`;
  barrageMeta = { nom: o.nom, V: o.V, h0: o.h0 };
  st.textContent = `${barrageTitre} — trajectoire…`;
  render();
  setTimeout(() => {
    const traj = eauTrajectoire(o.col, o.row);
    if (!traj || traj.chemin.length < 3) { st.textContent = `${barrageTitre} — trajectoire impossible`; return; }
    const latM = (GEO.latMin + GEO.latMax) / 2;
    const dy = 111320 * (GEO.latMax - GEO.latMin) / imgH;
    const dx = 111320 * Math.cos(latM * Math.PI / 180) * (GEO.lonMax - GEO.lonMin) / imgW;
    const E = { elev: elevGrid.slice(), W: imgW, H: imgH, dx: dx, dy: dy, chemin: traj.chemin,
                fin: traj.fin, mode: o.mode, iDigue: barrageSite, V: o.V * 1e9, h0: o.h0, Ldigue: o.L || 0 };
    onde = ondeNouvelle();
    onde.vitesse = +document.getElementById('onde-v').value;
    ondePanneauMaj();
    st.textContent = `${barrageTitre} — sections et bief…`;
    BARRAGEWORKER.lancer(E, ondeMessage, ondeFin,
      msg => { barrageEffacer(); st.textContent = `${barrageTitre} — erreur : ${msg}`; });
  }, 30);
}

/* ── barrageBilan ── E : onde terminée → T : débit de pointe à la brèche,
   largeur de brèche, distance et durée d'arrivée au bout de la
   trajectoire, nombre d'isochrones, avertissement si le parement de
   l'ouvrage n'a pas été repéré → S : texte d'état. */
function barrageBilan() {
  const I = onde.info, fm = I.frontMin;
  let mBout = fm.length - 1;
  while (mBout > 0 && fm[mBout - 1] >= fm[fm.length - 1]) mBout--;
  const fin = { mer: 'mer', bord: 'bord de carte', 'fermé': 'cuvette fermée' }[I.fin] || I.fin;
  const arrive = I.atteintBout ? ` atteint (${fin}) en ${Math.floor(mBout / 60)} h ${String(mBout % 60).padStart(2, '0')}` : ' (arrêt avant le bout)';
  return `${barrageTitre} — brèche ${I.Bd.toFixed(0)} m — Q pointe ${Math.round(I.qMax).toLocaleString()} m³/s — ` +
         `front ${I.frontKm.toFixed(1)} km${arrive} — ${onde.iso.length} isochrones` +
         (I.mode === 'bib' && !I.parement ? ' — parement non repéré : pied au point bas à moins de 6 h0' : '');
}

/* ═══ DESSIN ════════════════════════════════════════════════════════ */

/* ── barrageDessiner ── E : fenêtre source (sX, sY, sW, sH) du rendu →
   T : calque de l'onde ; isochrones antérieurs à tView (pixels du front
   à l'échelle d'affichage, au moins 1 px écran) et leurs étiquettes aux
   changements de pas et au dernier ; repère rouge du barrage rompu ;
   repères des barrages de l'emprise (carré cyan cerclé), noms écrits si
   au plus BAR_ETIQ_MAX repères visibles → S : dessin sur ctx. */
function barrageDessiner(sX, sY, sW, sH) {
  if (!GEO) return;
  const k = DISP / sW, taille = Math.max(1, k);
  ctx.imageSmoothingEnabled = false;
  if (onde && onde.nW) ctx.drawImage(onde.osc, sX, sY, sW, sH, 0, 0, DISP, DISP);
  if (onde && !onde.enCours) {
    const iso = onde.iso, tMax = iso.length ? iso[iso.length - 1].t : 1;
    let dernier = -1;
    for (let i = 0; i < iso.length; i++) {
      if (iso[i].t > onde.tView) break;
      dernier = i;
      const rgb = couleurTemps(iso[i].t / tMax), px = iso[i].px;
      ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      for (let j = 0; j < px.length; j++) {
        const p = px[j], r = (p / imgW) | 0, c = p - r * imgW;
        if (c < sX || c >= sX + sW || r < sY || r >= sY + sH) continue;
        ctx.fillRect((c - sX) * k, (r - sY) * k, taille, taille);
      }
    }
    ctx.font = '11px monospace'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(13,17,23,.9)';
    for (let i = 0; i <= dernier; i++) {
      const I = iso[i]; if (!I.trans && i !== dernier) continue;
      const r = (I.lab / imgW) | 0, c = I.lab - r * imgW;
      if (c < sX || c >= sX + sW || r < sY || r >= sY + sH) continue;
      const txt = `${Math.round(I.t / 60)} min` + (I.trans ? ` · pas ${I.pas} min` : '');
      const x = (c - sX) * k + 4, y = (r - sY) * k - 4;
      ctx.strokeText(txt, x, y); ctx.fillStyle = '#f5f5f5'; ctx.fillText(txt, x, y);
    }
  }
  sitesAJour();
  const vis = sitesBarrages.filter(b => b.col >= sX && b.col < sX + sW && b.row >= sY && b.row < sY + sH);
  ctx.font = '10px sans-serif'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(13,17,23,.9)';
  vis.forEach(b => {
    const x = (b.col + 0.5 - sX) * k, y = (b.row + 0.5 - sY) * k;
    ctx.fillStyle = 'rgba(13,17,23,.9)'; ctx.fillRect(x - 5, y - 5, 10, 10);
    ctx.fillStyle = b.src === 'CFBR' ? '#89dceb' : '#74c7ec'; ctx.fillRect(x - 3.5, y - 3.5, 7, 7);
    if (vis.length <= BAR_ETIQ_MAX) {
      const txt = b.nom.replace(/\s*\(.*$/, '');
      ctx.strokeText(txt, x + 8, y + 3); ctx.fillStyle = '#cdd6f4'; ctx.fillText(txt, x + 8, y + 3);
    }
  });
  if (barrageSite >= 0) {
    const r = (barrageSite / imgW) | 0, c = barrageSite - r * imgW, x = (c + 0.5 - sX) * k, y = (r + 0.5 - sY) * k;
    ctx.fillStyle = 'rgb(220,40,40)';
    ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x - 6, y + 5); ctx.lineTo(x + 6, y + 5); ctx.closePath(); ctx.fill();
  }
}

/* ── barrageArrivee ── E : indice de pixel → T : rang dans les listes
   d'arrivée → S : minutes depuis la rupture, ou NaN si non atteint. */
function barrageArrivee(idx) {
  if (!onde) return NaN;
  const i = onde.iWet[idx];
  return i >= 0 ? onde.wa[i] / 60 : NaN;
}

/* Survol : nom du barrage sous le curseur ; sur un pixel atteint, lame à
   l'instant affiché et lame maximale (calcul terminé), ajoutées au texte
   des coordonnées écrit par dsm.html. */
canvas.addEventListener('mousemove', e => {
  if (!GEO || !elevGrid) return;
  let txt = '';
  const b = siteSous(e.clientX, e.clientY);
  if (b) txt += `  ▣ ${b.nom} — ${b.h} m — ${b.V} km³ [${b.src}]`;
  if (onde && onde.niv) {
    const r = canvas.getBoundingClientRect();
    const col = Math.round(srcX + (e.clientX - r.left) / r.width * DISP * srcPPx);
    const row = Math.round(srcY + (e.clientY - r.top) / r.height * DISP * srcPPx);
    if (col >= 0 && col < imgW && row >= 0 && row < imgH) {
      const p = row * imgW + col, i = onde.iWet[p];
      if (i >= 0 && onde.wa[i] <= onde.tView) {
        const lev = onde.niv[onde.wm[i]], h = lev - elevGrid[p];
        txt += lev - onde.wg[i] >= BAR_H_ARRIVEE && h > 0 ? `  h ${h.toFixed(1)} m` : '  h 0';
      }
      if (i >= 0 && onde.maxNiv) {
        const hm = onde.maxNiv[onde.wm[i]] - elevGrid[p];
        if (hm > 0) txt += ` (max ${hm.toFixed(1)} m)`;
      }
    }
  }
  if (txt) coordEl.textContent += txt;
});

/* ═══ EXPORT ════════════════════════════════════════════════════════ */

/* ── ondeExporter ── E : onde terminée → T : Shapefile WGS84 de
   l'emprise maximale par tranches d'arrivée (ondeShapefile), différé
   d'une image pour afficher l'état, téléchargement du ZIP → S : aucune. */
function ondeExporter() {
  if (!onde || onde.enCours || !onde.arr) return;
  const st = document.getElementById('vstatus'), O = onde;
  st.textContent = `${barrageTitre} — export Shapefile…`;
  setTimeout(() => {
    try {
      const X = ondeShapefile({ arr: O.arr, iso: O.iso, info: O.info }, imgW, imgH, GEO, barrageMeta);
      const a = document.createElement('a'), url = URL.createObjectURL(X.blob);
      a.href = url; a.download = X.nom; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      st.textContent = `${barrageTitre} — ${X.nom} : ${X.nb} tranches, ` +
                       `${Math.round(X.surfHa).toLocaleString()} ha (WGS84)`;
    } catch (x) { st.textContent = `${barrageTitre} — export impossible : ${x.message || x}`; }
  }, 30);
}

/* ── barrageEffacer ── E : aucune → T : arrête un calcul et une lecture
   en cours, oublie l'onde, masque le panneau, redessine → S : aucune. */
function barrageEffacer() {
  BARRAGEWORKER.arreter();
  if (onde && onde.raf) cancelAnimationFrame(onde.raf);
  const avait = onde || barrageSite >= 0;
  onde = null; barrageSite = -1;
  ondePanneauMaj();
  if (avait && typeof render === 'function') render();
}
