/* ═══════════════════════════════════════════════════════════════════
   FICHIER : dsm-barrage.js - v27/09/2026
   OBJET   : barrages connus de l'emprise (CFBR, GDW puis FAO) posés sur
             la carte ; menu du clic droit (rupture directe du barrage
             sous le curseur, robinet, lave, rupture d'un barrage proche
             ou saisi) ; chemin du robinet pour trouver le pied de
             l'ouvrage ; lancement du calcul d'onde bidimensionnel
             (dsm-worker-barrage.js) ; affichage
             vivant de l'onde pendant le calcul, rejeu (lecture, pause,
             curseur de temps), isochrones ; export Shapefile de
             l'emprise maximale datée (dsm-export-shp.js) ; cas d'essai :
             temps d'arrivée calculés aux points de mesure de la fiche,
             comparés aux temps observés (état, console, carte).
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
             pleine, cas le pire) ; temps en s, affichés « 45 min » sous
             une heure, « 1 h 10 » au-delà ; lames des clichés en cm.
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
const BAR_ESSAI_RAYON_M = 200;  /* m : tolérance de position d'un point d'essai */
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

/* ── secTxt ── E : durée (s) → T : à la seconde ; « 1 min 40 s », au-delà
   d'une heure « 1 h 02 min 05 s » → S : texte. */
function secTxt(s) {
  const t = Math.round(s), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), x = t % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? `${h} h ` : '') + `${mm} min ${String(x).padStart(2, '0')} s`;
}

/* ── dureeTxt ── E : durée (s) → T : minutes entières ; moins d'une
   heure : « 45 min », sinon « 1 h 10 » → S : texte. */
function dureeTxt(s) {
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

/* ═══ BARRAGES DE L'EMPRISE ═════════════════════════════════════════ */

/* ── barragesEmprise ── E : GEO et bibliothèques → T : ouvrages CFBR,
   puis GDW, puis FAO situés dans l'emprise ; un ouvrage à moins de
   BAR_DOUBLON_KM d'un ouvrage déjà retenu est écarté (priorité CFBR > GDW
   > FAO) et sa longueur de digue, si connue, est reportée sur l'ouvrage
   retenu ; position pixel arrondie → S : liste de {nom, lat, lon, h, V,
   hFond, L, src, detruit et essai (CFBR seulement), col, row}. */
function barragesEmprise() {
  const dedans = (la, lo) => la >= GEO.latMin && la <= GEO.latMax && lo >= GEO.lonMin && lo <= GEO.lonMax;
  const res = [];
  const cfbr = (typeof BARRAGES_CFBR !== 'undefined') ? BARRAGES_CFBR : [];
  const gdw  = (typeof BARRAGES_GDW  !== 'undefined') ? BARRAGES_GDW  : [];
  const fao  = (typeof BARRAGES_FAO  !== 'undefined') ? BARRAGES_FAO  : [];
  const jumeauDe = (la, lo) => res.find(c => distKm(c.lat, c.lon, la, lo) < BAR_DOUBLON_KM);
  cfbr.forEach(b => {
    if (dedans(b[0], b[1])) res.push({ nom: b[5], lat: b[0], lon: b[1], h: b[2], V: b[3], hFond: b[4], L: 0, src: 'CFBR', detruit: b[6] === 1, essai: b[7] || null });
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
   rupture au point de l'ouvrage ; ouvrage détruit (absent du MNT, aucun
   parement à chercher) : pied au point de la fiche (mode manuel) → S :
   ordre pour barrageLancer. */
function ordreBarrage(b) {
  return { col: b.col, row: b.row, mode: b.detruit ? 'manuel' : 'bib', V: b.V, h0: b.h, L: b.L, nom: b.nom,
           essai: b.essai };
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
  ondeLbl.textContent = `t = ${dureeTxt(O.tView)}` + (O.enCours ? ' — calcul…' : '');
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
   listes d'arrivée extensibles (pixel, date), index pixel → rang, lames
   courantes, calque RGBA persistant, boîte englobante des pixels
   atteints → S : objet onde. */
function ondeNouvelle() {
  const cap = 1 << 16;
  return {
    enCours: true, lecture: false, raf: 0, vitesse: 300,
    t: 0, tFin: 0, tView: 0, tNorm: 60,
    nW: 0, cap: cap, wp: new Int32Array(cap), wa: new Float32Array(cap),
    iWet: new Int32Array(imgW * imgH).fill(-1),
    prof: new Uint16Array(0), lame: new Float32Array(cap),
    wh: null, wv: null, snapT: null, snapOff: null, snapData: null,
    arr: null, iso: [], info: null,
    img: new ImageData(imgW, imgH), osc: new OffscreenCanvas(imgW, imgH),
    bb: [imgW, imgH, -1, -1]
  };
}

/* ── ondeAjouter ── E : pixel, date d'arrivée (s) → T : ajout aux listes
   (doublement à saturation), index, boîte englobante → S : aucune. */
function ondeAjouter(p, a) {
  const O = onde;
  if (O.nW === O.cap) {
    O.cap *= 2;
    const n1 = new Int32Array(O.cap); n1.set(O.wp); O.wp = n1;
    const n2 = new Float32Array(O.cap); n2.set(O.wa); O.wa = n2;
    O.lame = new Float32Array(O.cap);
  }
  O.wp[O.nW] = p; O.wa[O.nW] = a; O.iWet[p] = O.nW; O.nW++;
  const r = (p / imgW) | 0, c = p - r * imgW, b = O.bb;
  if (c < b[0]) b[0] = c; if (r < b[1]) b[1] = r; if (c > b[2]) b[2] = c; if (r > b[3]) b[3] = r;
}

/* ── ondeLames ── E : instant t → T : lame de chaque pixel atteint ; en
   calcul : dernières lames reçues (cm) ; rejeu : interpolation linéaire
   entre les deux clichés encadrant t (un pixel absent d'un cliché, pas
   encore atteint, y compte pour 0) → S : onde.lame (m). */
function ondeLames(t) {
  const O = onde, n = O.nW, L = O.lame;
  if (O.enCours) {
    const P = O.prof, m = Math.min(n, P.length);
    for (let i = 0; i < m; i++) L[i] = P[i] / 100;
    for (let i = m; i < n; i++) L[i] = 0;
    return;
  }
  const T = O.snapT, nS = T.length;
  let lo = 0, hi = nS - 1;
  while (lo < hi) { const mi = (lo + hi + 1) >> 1; if (T[mi] <= t) lo = mi; else hi = mi - 1; }
  const k0 = lo, k1 = Math.min(k0 + 1, nS - 1);
  const f = k1 > k0 ? Math.max(0, Math.min(1, (t - T[k0]) / (T[k1] - T[k0]))) : 0;
  const o0 = O.snapOff[k0], n0 = O.snapOff[k0 + 1] - o0, o1 = O.snapOff[k1], n1 = O.snapOff[k1 + 1] - o1, D = O.snapData;
  for (let i = 0; i < n; i++) {
    const d0 = i < n0 ? D[o0 + i] : 0, d1 = i < n1 ? D[o1 + i] : 0;
    L[i] = (d0 + (d1 - d0) * f) / 100;
  }
}

/* ── ondePeindre ── E : onde, instant affiché tView, échelle tNorm →
   T : pour chaque pixel atteint : transparent s'il ne l'est pas encore
   à tView ; couleur de son temps d'arrivée (arrivée / tNorm) ; opacité
   BAR_ALPHA_TRACE si la lame est sous BAR_H_ARRIVEE (eau retirée), sinon
   croissant avec la lame (log, 0,1 m → BAR_H_PLEIN) jusqu'à
   BAR_ALPHA_EAU ; recopie de la seule boîte englobante → S : onde.osc. */
function ondePeindre() {
  const O = onde; if (O.nW === 0) return;
  ondeLames(O.tView);
  const d = O.img.data, tv = O.tView, tn = O.tNorm, L = O.lame;
  const aT = Math.round(255 * BAR_ALPHA_TRACE), dA = 255 * (BAR_ALPHA_EAU - BAR_ALPHA_TRACE);
  const lPlein = Math.log(BAR_H_PLEIN / BAR_H_ARRIVEE);
  for (let i = 0; i < O.nW; i++) {
    const o = O.wp[i] * 4, a = O.wa[i];
    if (a > tv) { d[o + 3] = 0; continue; }
    const k = 3 * Math.min(255, Math.round(a / tn * 255));
    d[o] = BAR_LUT[k]; d[o + 1] = BAR_LUT[k + 1]; d[o + 2] = BAR_LUT[k + 2];
    const h = L[i];
    d[o + 3] = h < BAR_H_ARRIVEE ? aT :
      Math.round(255 * BAR_ALPHA_TRACE + dA * Math.min(1, Math.log(h / BAR_H_ARRIVEE) / lPlein));
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

/* ── ondeMessage ── E : message « instant » du Worker → T : pixels
   nouvellement atteints ajoutés, lames courantes, tView = tNorm = t
   simulé, barre d'état (temps, front, débit à la brèche, part restante
   de la retenue), rafraîchissement → S : aucune. */
function ondeMessage(m) {
  const O = onde; if (!O || m.type !== 'instant') return;
  for (let i = 0; i < m.p.length; i++) ondeAjouter(m.p[i], m.a[i]);
  O.prof = m.prof; O.t = m.t; O.tView = m.t; O.tNorm = Math.max(60, m.t);
  document.getElementById('vstatus').textContent =
    `${barrageTitre} — t = ${dureeTxt(m.t)} — front ${m.frontKm.toFixed(1)} km — ` +
    `Q brèche ${Math.round(m.q).toLocaleString()} m³/s — retenue ${(100 * m.reste).toFixed(0)} %`;
  ondeRafraichir();
}

/* ── ondeFin ── E : résultat du Worker → T : listes d'arrivée reprises du
   résultat (autorité), index reconstruit, lames et vitesses maximales,
   clichés, isochrones ; tNorm = dernier isochrone (sinon tFin) ;
   affichage à tFin → S : aucune. */
function ondeFin(R) {
  const O = onde; if (!O) return;
  O.iWet.fill(-1); O.nW = 0; O.bb = [imgW, imgH, -1, -1];
  O.cap = Math.max(1, R.wp.length);
  O.wp = new Int32Array(O.cap); O.wa = new Float32Array(O.cap); O.lame = new Float32Array(O.cap);
  for (let i = 0; i < R.wp.length; i++) ondeAjouter(R.wp[i], R.arr[R.wp[i]]);
  O.wh = R.wh; O.wv = R.wv;
  O.snapT = R.snapT; O.snapOff = R.snapOff; O.snapData = R.snapData;
  O.arr = R.arr; O.iso = R.iso; O.info = R.info;
  O.enCours = false; O.tFin = R.info.tFin; O.tView = O.tFin; O.t = O.tFin;
  O.tNorm = R.iso.length ? R.iso[R.iso.length - 1].t : Math.max(60, R.info.tFin);
  essaiMesurer();
  ondeRafraichir();
  document.getElementById('vstatus').textContent = barrageBilan() + essaiBilan();
}

/* ═══ LANCEMENT ═════════════════════════════════════════════════════ */

/* ═══ CAS D'ESSAI ═══════════════════════════════════════════════════ */

/* ── essaiPoints ── E : points de la fiche [[nom, lat, lon, tObs], …] ou
   rien → T : position pixel, points hors de la tuile écartés → S : liste
   de {nom, lat, lon, tObs, col, row, tCalc (NaN), d (m)} ou null. */
function essaiPoints(liste) {
  if (!liste || !liste.length) return null;
  const P = liste.map(e => {
    const g = geoVersPixel(e[1], e[2]);
    return { nom: e[0], lat: e[1], lon: e[2], tObs: e[3], col: Math.floor(g.col), row: Math.floor(g.row), tCalc: NaN, d: 0 };
  }).filter(e => e.col >= 0 && e.col < imgW && e.row >= 0 && e.row < imgH);
  return P.length ? P : null;
}

/* ── essaiMesurer ── E : onde terminée (arr en s, −1 sec), points
   d'essai → T : temps d'arrivée au pixel du point ; pixel sec : pixel
   atteint le plus proche à moins de BAR_ESSAI_RAYON_M (distance
   métrique, dx par ligne × cos lat) → S : tCalc (s, NaN si rien) et
   d (m) posés sur chaque point. */
function essaiMesurer() {
  const E = barrageMeta && barrageMeta.essai; if (!E || !onde || !onde.arr) return;
  const dLat = (GEO.latMax - GEO.latMin) / imgH, dLon = (GEO.lonMax - GEO.lonMin) / imgW, dy = 111320 * dLat;
  E.forEach(e => {
    const dx = 111320 * Math.cos(e.lat * Math.PI / 180) * dLon;
    const rc = Math.ceil(BAR_ESSAI_RAYON_M / dx), rr = Math.ceil(BAR_ESSAI_RAYON_M / dy);
    e.tCalc = NaN; e.d = 0;
    let dMin = Infinity;
    for (let r = Math.max(0, e.row - rr); r <= Math.min(imgH - 1, e.row + rr); r++) {
      for (let c = Math.max(0, e.col - rc); c <= Math.min(imgW - 1, e.col + rc); c++) {
        const a = onde.arr[r * imgW + c]; if (a < 0) continue;
        const d = Math.hypot((c - e.col) * dx, (r - e.row) * dy);
        if (d <= BAR_ESSAI_RAYON_M && d < dMin) { dMin = d; e.tCalc = a; e.d = d; }
      }
    }
  });
  console.table(E.map(e => ({ point: e.nom, lat: e.lat, lon: e.lon, obs_s: e.tObs,
    calc_s: isNaN(e.tCalc) ? null : Math.round(e.tCalc), ecart_pct: isNaN(e.tCalc) ? null : Math.round(100 * (e.tCalc - e.tObs) / e.tObs),
    decalage_m: Math.round(e.d) })));
}

/* ── essaiBilan ── E : points d'essai mesurés → T : par point, temps
   calculé, temps observé, écart relatif, décalage si pris à côté → S :
   texte à ajouter à l'état (vide sans essai). */
function essaiBilan() {
  const E = barrageMeta && barrageMeta.essai; if (!E) return '';
  return ' — essai : ' + E.map(e => isNaN(e.tCalc) ? `${e.nom} non atteint` :
    `${e.nom} ${secTxt(e.tCalc)} / obs ${secTxt(e.tObs)} (${e.tCalc >= e.tObs ? '+' : ''}${Math.round(100 * (e.tCalc - e.tObs) / e.tObs)} %` +
    (e.d > 0 ? `, à ${Math.round(e.d)} m` : '') + ')').join(' · ');
}

/* ── barrageLancer ── E : {col, row, mode, V (km³), h0 (m), L (m), nom}
   → T : efface le résultat précédent, chemin du robinet (sert à trouver
   le pied de l'ouvrage), pas des pixels depuis GEO (111 320 m/°, dx
   par ligne × cos lat), copie du DSM transférée au Worker, onde vivante
   → S : aucune. */
function barrageLancer(o) {
  barrageEffacer();
  const st = document.getElementById('vstatus');
  if (o.col < 0 || o.col >= imgW || o.row < 0 || o.row >= imgH) { st.textContent = 'Barrage hors de la tuile'; return; }
  barrageSite = o.row * imgW + o.col;
  barrageTitre = `${o.nom} — ${o.V} km³, ${o.h0} m`;
  barrageMeta = { nom: o.nom, V: o.V, h0: o.h0, essai: essaiPoints(o.essai) };
  st.textContent = `${barrageTitre} — pied de l'ouvrage…`;
  render();
  setTimeout(() => {
    const traj = eauTrajectoire(o.col, o.row);
    if (!traj || traj.chemin.length < 3) { st.textContent = `${barrageTitre} — pied de l'ouvrage introuvable`; return; }
    const dLat = (GEO.latMax - GEO.latMin) / imgH, dLon = (GEO.lonMax - GEO.lonMin) / imgW;
    const dxR = new Float64Array(imgH);
    for (let r = 0; r < imgH; r++) dxR[r] = 111320 * Math.cos((GEO.latMax - (r + 0.5) * dLat) * Math.PI / 180) * dLon;
    const E = { elev: elevGrid.slice(), W: imgW, H: imgH, dy: 111320 * dLat, dxR: dxR, chemin: traj.chemin,
                fin: traj.fin, mode: o.mode, V: o.V * 1e9, h0: o.h0, Ldigue: o.L || 0 };
    onde = ondeNouvelle();
    onde.vitesse = +document.getElementById('onde-v').value;
    ondePanneauMaj();
    st.textContent = `${barrageTitre} — rupture…`;
    BARRAGEWORKER.lancer(E, ondeMessage, ondeFin,
      msg => { barrageEffacer(); st.textContent = `${barrageTitre} — erreur : ${msg}`; });
  }, 30);
}

/* ── barrageBilan ── E : onde terminée → T : largeur de brèche, débit de
   pointe, portée du front, sortie en mer ou au bord de carte, part
   restante de la retenue, durée, nombre d'isochrones, avertissement si
   le parement de l'ouvrage n'a pas été repéré → S : texte d'état. */
function barrageBilan() {
  const I = onde.info;
  const fin = { mer: ' — atteint la mer', bord: ' — sort de la carte' }[I.fin] || '';
  return `${barrageTitre} — brèche ${I.Bd.toFixed(0)} m — Q pointe ${Math.round(I.qMax).toLocaleString()} m³/s — ` +
         `front ${I.frontKm.toFixed(1)} km${fin} — retenue ${(100 * I.Vreste / I.V0).toFixed(0)} % à ${dureeTxt(I.tFin)} — ` +
         `${onde.iso.length} isochrones` +
         (I.mode === 'bib' && !I.parement ? ' — parement non repéré : pied au point bas à moins de 6 h0' : '');
}

/* ═══ DESSIN ════════════════════════════════════════════════════════ */

/* ── barrageDessiner ── E : fenêtre source (sX, sY, sW, sH) du rendu →
   T : calque de l'onde ; isochrones antérieurs à tView (pixels du front
   à l'échelle d'affichage, au moins 1 px écran) et leurs étiquettes aux
   changements de pas et au dernier ; repère rouge du barrage rompu ;
   repères des barrages de l'emprise (carré cyan cerclé), noms écrits si
   au plus BAR_ETIQ_MAX repères visibles ; points d'essai (losange jaune,
   temps observé puis calculé) → S : dessin sur ctx. */
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
      const txt = dureeTxt(I.t) + (I.trans ? ` · pas ${dureeTxt(I.pas * 60)}` : '');
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
  if (barrageSite >= 0 && barrageMeta && barrageMeta.essai) {
    ctx.font = '11px monospace';
    barrageMeta.essai.forEach(e => {
      if (e.col < sX || e.col >= sX + sW || e.row < sY || e.row >= sY + sH) return;
      const x = (e.col + 0.5 - sX) * k, y = (e.row + 0.5 - sY) * k;
      ctx.fillStyle = 'rgba(13,17,23,.9)';
      ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x + 7, y); ctx.lineTo(x, y + 7); ctx.lineTo(x - 7, y); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#f9e2af';
      ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y); ctx.closePath(); ctx.fill();
      const txt = `${e.nom} obs ${secTxt(e.tObs)}` + (isNaN(e.tCalc) ? '' : ` · calc ${secTxt(e.tCalc)}`);
      ctx.strokeText(txt, x + 9, y + 4); ctx.fillStyle = '#f9e2af'; ctx.fillText(txt, x + 9, y + 4);
    });
  }
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
   l'instant affiché, puis lame et vitesse maximales (calcul terminé),
   ajoutées au texte des coordonnées écrit par dsm.html. */
canvas.addEventListener('mousemove', e => {
  if (!GEO || !elevGrid) return;
  let txt = '';
  const b = siteSous(e.clientX, e.clientY);
  if (b) txt += `  ▣ ${b.nom} — ${b.h} m — ${b.V} km³ [${b.src}]`;
  if (onde) {
    const r = canvas.getBoundingClientRect();
    const col = Math.round(srcX + (e.clientX - r.left) / r.width * DISP * srcPPx);
    const row = Math.round(srcY + (e.clientY - r.top) / r.height * DISP * srcPPx);
    if (col >= 0 && col < imgW && row >= 0 && row < imgH) {
      const i = onde.iWet[row * imgW + col];
      if (i >= 0 && onde.wa[i] <= onde.tView) txt += `  h ${onde.lame[i].toFixed(1)} m`;
      if (i >= 0 && onde.wh) txt += ` (max ${onde.wh[i].toFixed(1)} m, ${onde.wv[i].toFixed(1)} m/s)`;
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
      const X = ondeShapefile({ arr: O.arr, iso: O.iso, info: O.info, wp: O.wp.subarray(0, O.nW), wh: O.wh, wv: O.wv }, imgW, imgH, GEO, barrageMeta);
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
