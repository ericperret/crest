/* ═══════════════════════════════════════════════════════════════════
   FICHIER : dsm-barrage.js - v27/09/2026
   OBJET   : menu du clic droit (robinet, lave, rupture de barrage) ;
             choix du barrage (bibliothèques CFBR, GDW puis FAO, ou saisie du
             volume et de la hauteur d'eau) ; trajectoire de référence par
             le robinet ; lancement du calcul d'onde (dsm-worker-barrage.js) ;
             dessin de l'emprise datée et des isochrones du front.
   AUTEUR  : Eric P.
   RELECTURE : Opus 5.5
   LICENCE : CC BY-NC 4.0 — source à citer : https://github.com/ericperret/crest/
             usage commercial interdit sauf accord écrit de l'auteur (voir LICENSE)
   DÉPEND  : dsm.html (GEO, imgW, imgH, elevGrid, canvas, ctx, DISP, srcX,
             srcY, srcPPx, render), dsm-ombre.js (placeFaucet,
             eauTrajectoire), dsm-barrages-cfbr.js (BARRAGES_CFBR),
             dsm-barrages-gdw.js (BARRAGES_GDW), dsm-barrages-fao.js
             (BARRAGES_FAO), dsm-worker-barrage.js
             (BARRAGEWORKER)
   EXPOSE  : barrageDessiner, barrageArrivee, barrageEffacer
   CONVENTIONS : volumes en km³ à l'écran, m³ au calcul ; hauteur d'eau
             initiale = hauteur du barrage sur terrain naturel (retenue
             pleine, cas le pire) ; temps d'arrivée en s, affichés en min.
   ═══════════════════════════════════════════════════════════════════ */
"use strict";

const BAR_RAYON_KM = 30;        /* rayon de recherche des barrages autour du clic */
const BAR_NB_PROPOSES = 10;
const BAR_DOUBLON_KM = 3;       /* deux ouvrages à moins de 3 km sont le même */
const BAR_ALPHA_EMPRISE = 0.35;

let barrageRes = null, barrageOsc = null, barrageSite = -1, barrageTitre = '';

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

/* ── barragesProches ── E : lat, lon du clic → T : ouvrages CFBR, puis
   GDW, puis FAO situés dans la tuile et à moins de BAR_RAYON_KM ; un
   ouvrage à moins de BAR_DOUBLON_KM d'un ouvrage déjà retenu est écarté
   (priorité CFBR > GDW > FAO) et sa longueur de digue, si connue, est
   reportée sur l'ouvrage retenu ; tri par distance → S : liste de {nom,
   lat, lon, h, V, hFond, L, src, d}. */
function barragesProches(lat, lon) {
  const dedans = (la, lo) => la >= GEO.latMin && la <= GEO.latMax && lo >= GEO.lonMin && lo <= GEO.lonMax;
  const res = [];
  const cfbr = (typeof BARRAGES_CFBR !== 'undefined') ? BARRAGES_CFBR : [];
  const gdw  = (typeof BARRAGES_GDW  !== 'undefined') ? BARRAGES_GDW  : [];
  const fao  = (typeof BARRAGES_FAO  !== 'undefined') ? BARRAGES_FAO  : [];
  const jumeauDe = (la, lo) => res.find(c => distKm(c.lat, c.lon, la, lo) < BAR_DOUBLON_KM);
  cfbr.forEach(b => {
    if (!dedans(b[0], b[1])) return;
    const d = distKm(lat, lon, b[0], b[1]); if (d > BAR_RAYON_KM) return;
    res.push({ nom: b[5], lat: b[0], lon: b[1], h: b[2], V: b[3], hFond: b[4], L: 0, src: 'CFBR', d: d });
  });
  gdw.forEach(b => {
    if (!dedans(b[0], b[1])) return;
    const d = distKm(lat, lon, b[0], b[1]); if (d > BAR_RAYON_KM) return;
    const jumeau = jumeauDe(b[0], b[1]);
    if (jumeau) { if (!jumeau.L && b[7] > 0) jumeau.L = b[7]; return; }
    res.push({ nom: b[5], lat: b[0], lon: b[1], h: b[2], V: b[3], hFond: 0, L: b[7], src: b[4] ? 'GDW est.' : 'GDW', d: d });
  });
  fao.forEach(b => {
    if (!dedans(b[0], b[1])) return;
    const d = distKm(lat, lon, b[0], b[1]); if (d > BAR_RAYON_KM) return;
    if (jumeauDe(b[0], b[1])) return;
    res.push({ nom: b[4], lat: b[0], lon: b[1], h: b[2], V: b[3], hFond: 0, L: 0, src: 'FAO', d: d });
  });
  res.sort((a, b) => a.d - b.d);
  return res.slice(0, BAR_NB_PROPOSES);
}

/* ── menu du clic droit ── */
const menuClic = document.createElement('div');
menuClic.id = 'menu-clic';
document.body.appendChild(menuClic);

/* ── menuFermer ── E : aucune → T : masque le menu → S : aucune. */
function menuFermer() { menuClic.style.display = 'none'; }

/* ── menuOuvrir ── E : position écran, colonne, ligne → T : construit
   les entrées Robinet, Lave (inactive), Rupture de barrage, place le
   menu au curseur → S : aucune. */
function menuOuvrir(x, y, col, row) {
  menuClic.innerHTML = '';
  const item = (txt, actif, action) => {
    const b = document.createElement('button');
    b.className = 'btn'; b.textContent = txt; b.disabled = !actif;
    b.onclick = () => { menuFermer(); action(); };
    menuClic.appendChild(b);
  };
  item('💧 Robinet', true, () => placeFaucet(col, row));
  item('🌋 Lave (à venir)', false, () => {});
  item('🌊 Rupture de barrage', true, () => barrageDialogue(col, row));
  menuClic.style.left = x + 'px'; menuClic.style.top = y + 'px';
  menuClic.style.display = 'flex';
}

canvas.addEventListener('contextmenu', e => {
  e.preventDefault(); if (!elevGrid) return;
  const r = canvas.getBoundingClientRect();
  const cx = (e.clientX - r.left) / r.width, cy = (e.clientY - r.top) / r.height;
  menuOuvrir(e.clientX, e.clientY,
             Math.round(srcX + cx * DISP * srcPPx), Math.round(srcY + cy * DISP * srcPPx));
});
window.addEventListener('mousedown', e => { if (!menuClic.contains(e.target)) menuFermer(); });
window.addEventListener('keydown', e => {
  if (e.code === 'Escape') { menuFermer(); dlgFermer(); }
  if (e.code === 'Space') barrageEffacer();
});

/* ── dialogue barrage ── */
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
      bt.onclick = () => {
        dlgFermer();
        const p = geoVersPixel(b.lat, b.lon);
        barrageLancer({ col: Math.round(p.col), row: Math.round(p.row), mode: 'bib',
                        V: b.V, h0: b.h, L: b.L, nom: b.nom });
      };
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

/* ── barrageLancer ── E : {col, row, mode, V (km³), h0 (m), L (m), nom}
   → T : efface le résultat précédent, trajectoire de référence par
   eauTrajectoire, taille des pixels depuis GEO (111 320 m/° × cos lat),
   copie du DSM transférée au Worker, suivi de progression → S : aucune. */
function barrageLancer(o) {
  barrageEffacer();
  const st = document.getElementById('vstatus');
  if (o.col < 0 || o.col >= imgW || o.row < 0 || o.row >= imgH) { st.textContent = 'Barrage hors de la tuile'; return; }
  barrageSite = o.row * imgW + o.col;
  barrageTitre = `${o.nom} — ${o.V} km³, ${o.h0} m`;
  st.textContent = `${barrageTitre} — trajectoire…`;
  setTimeout(() => {
    const traj = eauTrajectoire(o.col, o.row);
    if (!traj || traj.chemin.length < 3) { st.textContent = `${barrageTitre} — trajectoire impossible`; return; }
    const latM = (GEO.latMin + GEO.latMax) / 2;
    const dy = 111320 * (GEO.latMax - GEO.latMin) / imgH;
    const dx = 111320 * Math.cos(latM * Math.PI / 180) * (GEO.lonMax - GEO.lonMin) / imgW;
    const E = { elev: elevGrid.slice(), W: imgW, H: imgH, dx: dx, dy: dy, chemin: traj.chemin,
                fin: traj.fin, mode: o.mode, iDigue: barrageSite, V: o.V * 1e9, h0: o.h0, Ldigue: o.L || 0 };
    BARRAGEWORKER.lancer(E,
      (t, fKm) => { st.textContent = `${barrageTitre} — t = ${(t / 60).toFixed(0)} min — front ${fKm.toFixed(1)} km`; },
      res => { barrageRes = res; barragePeindre(); render(); st.textContent = barrageBilan(); },
      msg => { st.textContent = `${barrageTitre} — erreur : ${msg}`; });
  }, 30);
}

/* ── couleurTemps ── E : fraction 0..1 → T : teinte 0° (rouge, tôt) à
   270° (violet, tard), saturation 100 %, luminosité 55 % → S : [r,g,b]. */
function couleurTemps(f) {
  const h = 270 * Math.max(0, Math.min(1, f)), s = 1, l = 0.55;
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const c = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return [c(0), c(8), c(4)];
}

/* ── barragePeindre ── E : barrageRes → T : calque W×H de l'emprise, chaque
   pixel mouillé coloré par son temps d'arrivée rapporté au dernier
   isochrone → S : barrageOsc. */
function barragePeindre() {
  const R = barrageRes, N = imgW * imgH;
  const tMax = R.iso.length ? R.iso[R.iso.length - 1].t : Math.max(60, R.info.tFin);
  barrageOsc = new OffscreenCanvas(imgW, imgH);
  const c = barrageOsc.getContext('2d'), img = c.createImageData(imgW, imgH), d = img.data;
  const A = Math.round(255 * BAR_ALPHA_EMPRISE);
  for (let p = 0; p < N; p++) {
    const a = R.arr[p]; if (a < 0) continue;
    const rgb = couleurTemps(a / tMax), o = p * 4;
    d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = A;
  }
  c.putImageData(img, 0, 0);
}

/* ── barrageBilan ── E : barrageRes → T : débit de pointe à la brèche,
   largeur de brèche, distance et durée d'arrivée au bout de la
   trajectoire, nombre d'isochrones, avertissement si le parement de
   l'ouvrage n'a pas été repéré → S : texte d'état. */
function barrageBilan() {
  const I = barrageRes.info, fm = I.frontMin;
  let mBout = fm.length - 1;
  while (mBout > 0 && fm[mBout - 1] >= fm[fm.length - 1]) mBout--;
  const fin = { mer: 'mer', bord: 'bord de carte', 'fermé': 'cuvette fermée' }[I.fin] || I.fin;
  const arrive = I.atteintBout ? ` atteint (${fin}) en ${Math.floor(mBout / 60)} h ${String(mBout % 60).padStart(2, '0')}` : ' (arrêt avant le bout)';
  return `${barrageTitre} — brèche ${I.Bd.toFixed(0)} m — Q pointe ${Math.round(I.qMax).toLocaleString()} m³/s — ` +
         `front ${I.frontKm.toFixed(1)} km${arrive} — ${barrageRes.iso.length} isochrones` +
         (I.mode === 'bib' && !I.parement ? ' — parement non repéré : pied au point bas à moins de 6 h0' : '');
}

/* ── barrageDessiner ── E : fenêtre source (sX, sY, sW, sH) du rendu →
   T : emprise datée, isochrones (pixels du front dessinés à l'échelle
   d'affichage, au moins 1 px écran), étiquettes aux changements de pas et
   au dernier isochrone, repère du barrage → S : dessin sur ctx. */
function barrageDessiner(sX, sY, sW, sH) {
  if (!barrageRes) return;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(barrageOsc, sX, sY, sW, sH, 0, 0, DISP, DISP);
  const k = DISP / sW, taille = Math.max(1, k), iso = barrageRes.iso;
  const tMax = iso.length ? iso[iso.length - 1].t : 1;
  for (let i = 0; i < iso.length; i++) {
    const rgb = couleurTemps(iso[i].t / tMax), px = iso[i].px;
    ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    for (let j = 0; j < px.length; j++) {
      const p = px[j], r = (p / imgW) | 0, c = p - r * imgW;
      if (c < sX || c >= sX + sW || r < sY || r >= sY + sH) continue;
      ctx.fillRect((c - sX) * k, (r - sY) * k, taille, taille);
    }
  }
  ctx.font = '11px monospace'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(13,17,23,.9)';
  for (let i = 0; i < iso.length; i++) {
    const I = iso[i]; if (!I.trans && i !== iso.length - 1) continue;
    const r = (I.lab / imgW) | 0, c = I.lab - r * imgW;
    if (c < sX || c >= sX + sW || r < sY || r >= sY + sH) continue;
    const txt = `${Math.round(I.t / 60)} min` + (I.trans ? ` · pas ${I.pas} min` : '');
    const x = (c - sX) * k + 4, y = (r - sY) * k - 4;
    ctx.strokeText(txt, x, y); ctx.fillStyle = '#f5f5f5'; ctx.fillText(txt, x, y);
  }
  if (barrageSite >= 0) {
    const r = (barrageSite / imgW) | 0, c = barrageSite - r * imgW, x = (c - sX) * k, y = (r - sY) * k;
    ctx.fillStyle = 'rgb(220,40,40)';
    ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x - 6, y + 5); ctx.lineTo(x + 6, y + 5); ctx.closePath(); ctx.fill();
  }
}

/* ── barrageArrivee ── E : indice de pixel → T : lecture de l'emprise
   datée → S : minutes depuis la rupture, ou NaN si non atteint. */
function barrageArrivee(idx) {
  if (!barrageRes) return NaN;
  const a = barrageRes.arr[idx];
  return a >= 0 ? a / 60 : NaN;
}

/* ── barrageEffacer ── E : aucune → T : arrête un calcul en cours, oublie
   le résultat, redessine → S : aucune. */
function barrageEffacer() {
  BARRAGEWORKER.arreter();
  const avait = barrageRes || barrageSite >= 0;
  barrageRes = null; barrageOsc = null; barrageSite = -1;
  if (avait && typeof render === 'function') render();
}
