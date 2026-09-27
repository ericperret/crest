/* ═══════════════════════════════════════════════════════════════════
   FICHIER : dsm-carte.js - v27/09/2026
   OBJET   : carte tuilée Web Mercator (XYZ) native, sans librairie :
             couches de tuiles avec opacité, zoom fractionnaire, glisser /
             molette, calques de dessin, évènements géographiques.
             Remplace Leaflet dans map.html et pour les étiquettes de
             dsm.html.
   AUTEUR  : Eric P.
   RELECTURE : Opus 5.5
   DÉPEND  : aucun (services de tuiles externes fournis par l'appelant)
   EXPOSE  : DsmCarte (constructeur)
   ═══════════════════════════════════════════════════════════════════ */

/* Utilisation :

   var c = new DsmCarte(elementConteneur, { lat, lon, zoom, interactif });
   c.ajouterCouche(urlXYZ, { opacite, attribution, zMax, sous })
   c.ajouterDessin(function (ctx, carte) { … })   — redessiné à chaque vue
   c.on('mousemove' | 'click' | 'mousedown' | 'mouseup' | 'mouseout', fn)
       fn({ lat, lon, x, y, ev })
   c.vue(lat, lon, zoom) · c.cadrer(sud, ouest, nord, est, zoomMax)
   c.versEcran(lat, lon) → {x, y} · c.versGeo(x, y) → {lat, lon}
   c.glisser = false  désactive le déplacement à la souris
   c.redessiner() · c.redimensionner() · c.conteneur                     */

"use strict";

/* ── DsmCarte ───────────────────────────────────────────────────────────
   ENTRÉE     : conteneur (élément DOM), opts { lat, lon, zoom, zoomMin,
                zoomMax, interactif }
   TRAITEMENT : insère un canvas plein cadre et une zone d'attribution ;
                état de vue (centre, zoom fractionnaire) ; cache de tuiles
                (800 max) ; écouteurs souris et ResizeObserver
   SORTIE     : objet carte (méthodes ci-dessous)
   ALGO       : « Mini-client de tuiles XYZ en Web Mercator : projection,
                cache d'images, rendu canvas, glisser et molette. »
   ─────────────────────────────────────────────────────────────────── */
function DsmCarte(conteneur, opts) {
  opts = opts || {};
  var self = this, TS = 256, LAT_MAX = 85.05112878;

  if (getComputedStyle(conteneur).position === 'static') conteneur.style.position = 'relative';
  var cv = document.createElement('canvas');
  cv.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block';
  conteneur.appendChild(cv);
  var attr = document.createElement('div');
  attr.style.cssText = 'position:absolute;right:2px;bottom:1px;font:9px sans-serif;' +
    'color:#bbb;background:rgba(0,0,0,.35);padding:0 4px;pointer-events:none;z-index:1';
  conteneur.appendChild(attr);

  var ctx = cv.getContext('2d');
  var couches = [], cache = new Map(), dessins = [], ecouteurs = {};
  var W = 0, H = 0, dpr = 1, raf = 0;
  var z = opts.zoom !== undefined ? opts.zoom : 2;
  var cLat = opts.lat || 0, cLon = opts.lon || 0;
  var zMin = opts.zoomMin !== undefined ? opts.zoomMin : 1;
  var zMax = opts.zoomMax !== undefined ? opts.zoomMax : 19;

  self.conteneur = conteneur;
  self.canvas = cv;
  self.glisser = opts.interactif !== false;

  /* monde — E : zoom → T : 256·2^z → S : largeur du monde en pixels. */
  function monde(zz) { return TS * Math.pow(2, zz); }
  /* pX / pY — E : lon ou lat (°), zoom → T : projection Web Mercator (lat
     bornée à ±85,05°) → S : coordonnée pixel monde. */
  function pX(lon, zz) { return (lon + 180) / 360 * monde(zz); }
  function pY(lat, zz) {
    var s = Math.sin(Math.max(-LAT_MAX, Math.min(LAT_MAX, lat)) * Math.PI / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * monde(zz);
  }
  /* iX / iY — E : pixel monde, zoom → T : inverse Web Mercator → S : lon / lat (°). */
  function iX(x, zz) { return x / monde(zz) * 360 - 180; }
  function iY(y, zz) {
    var n = Math.PI - 2 * Math.PI * y / monde(zz);
    return 180 / Math.PI * Math.atan(Math.sinh(n));
  }

  /* versEcran — E : lat, lon → T : décalage au centre de la vue → S : {x, y} écran. */
  self.versEcran = function (lat, lon) {
    return { x: W / 2 + pX(lon, z) - pX(cLon, z), y: H / 2 + pY(lat, z) - pY(cLat, z) };
  };
  /* versGeo — E : x, y écran → T : inverse de versEcran → S : {lat, lon}. */
  self.versGeo = function (x, y) {
    return { lat: iY(pY(cLat, z) + y - H / 2, z), lon: iX(pX(cLon, z) + x - W / 2, z) };
  };
  /* zoom — E : aucune → S : zoom courant (fractionnaire). */
  self.zoom = function () { return z; };

  /* ajouterCouche — E : gabarit d'URL XYZ ({s} {z} {x} {y} {r}), opts {
     opacite, sous (sous-domaines), zMax (zoom natif max), attribution } →
     T : ajoute la couche, complète l'attribution, redessine → S : aucune. */
  self.ajouterCouche = function (url, o) {
    o = o || {};
    couches.push({ url: url, opacite: o.opacite === undefined ? 1 : o.opacite,
                   sous: o.sous || ['a', 'b', 'c'], zMax: o.zMax || 19 });
    if (o.attribution) attr.textContent = (attr.textContent ? attr.textContent + ' | ' : '') + o.attribution;
    self.redessiner();
  };
  /* ajouterDessin — E : fn(ctx, carte) → T : l'ajoute aux calques appelés
     après les tuiles → S : aucune. */
  self.ajouterDessin = function (fn) { dessins.push(fn); self.redessiner(); };
  /* on — E : nom d'évènement, fn → T : abonne fn → S : aucune. */
  self.on = function (nom, fn) { (ecouteurs[nom] = ecouteurs[nom] || []).push(fn); };

  /* emettre — E : nom, évènement souris → T : coordonnées écran puis
     géographiques → S : appelle chaque abonné avec { lat, lon, x, y, ev }. */
  function emettre(nom, e) {
    var l = ecouteurs[nom];
    if (!l) return;
    var r = cv.getBoundingClientRect();
    var sx = r.width ? W / r.width : 1, sy = r.height ? H / r.height : 1;
    var x = (e.clientX - r.left) * sx, y = (e.clientY - r.top) * sy;
    var g = self.versGeo(x, y);
    var o = { lat: g.lat, lon: g.lon, x: x, y: y, ev: e };
    for (var i = 0; i < l.length; i++) l[i](o);
  }

  /* borner — E : état → T : zoom dans [zMin, zMax], latitude bornée,
     longitude ramenée dans [−180, 180[ → S : aucune. */
  function borner() {
    z = Math.max(zMin, Math.min(zMax, z));
    cLat = Math.max(-LAT_MAX, Math.min(LAT_MAX, cLat));
    cLon = ((cLon + 180) % 360 + 360) % 360 - 180;
  }
  /* vue — E : lat, lon, zoom (optionnel) → T : fixe le centre, borne,
     redessine → S : aucune. */
  self.vue = function (lat, lon, zoom) {
    cLat = lat; cLon = lon;
    if (zoom !== undefined) z = zoom;
    borner(); self.redessiner();
  };
  /* cadrer — E : sud, ouest, nord, est, zoomMax → T : zoom qui fait tenir
     l'emprise à 90 % de la vue (plafonné), centre Mercator de l'emprise →
     S : aucune. */
  self.cadrer = function (sud, ouest, nord, est, zoomMaxi) {
    if (!W || !H) self.redimensionner();
    var dx = pX(est, 0) - pX(ouest, 0), dy = pY(sud, 0) - pY(nord, 0);
    var zz = Math.log2(Math.min((W || 256) / dx, (H || 256) / dy) * 0.9);
    z = Math.min(zoomMaxi !== undefined ? zoomMaxi : zMax, zz);
    cLon = (ouest + est) / 2;
    cLat = iY((pY(sud, 0) + pY(nord, 0)) / 2, 0);
    borner(); self.redessiner();
  };
  /* redimensionner — E : taille du conteneur → T : canvas à la taille × dpr
     → S : aucune (redessin demandé). */
  self.redimensionner = function () {
    W = conteneur.clientWidth; H = conteneur.clientHeight;
    dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(W * dpr));
    cv.height = Math.max(1, Math.round(H * dpr));
    self.redessiner();
  };
  /* redessiner — E : aucune → T : programme un seul peindre() par image →
     S : aucune. */
  self.redessiner = function () { if (!raf) raf = requestAnimationFrame(peindre); };

  /* cleTuile — E : couche, z, x, y → S : clé texte du cache. */
  function cleTuile(ic, zt, tx, ty) { return ic + '/' + zt + '/' + tx + '/' + ty; }

  /* tuile — E : couche, z, x, y → T : image du cache ou nouvelle requête
     (sous-domaine tournant, @2x si écran dense), éviction FIFO au-delà de
     800 → S : { img, ok }. */
  function tuile(ic, zt, tx, ty) {
    var k = cleTuile(ic, zt, tx, ty), t = cache.get(k);
    if (t) return t;
    var c = couches[ic], img = new Image();
    t = { img: img, ok: false };
    img.onload = function () { t.ok = true; self.redessiner(); };
    img.onerror = function () { t.err = true; };
    img.src = c.url.replace('{s}', c.sous[(tx + ty) % c.sous.length])
      .replace('{z}', zt).replace('{x}', tx).replace('{y}', ty)
      .replace('{r}', dpr > 1 ? '@2x' : '');
    cache.set(k, t);
    if (cache.size > 800) cache.delete(cache.keys().next().value);
    return t;
  }

  /* parente — E : couche, z, x, y → T : cherche une tuile parente déjà
     chargée jusqu'à 4 niveaux au-dessus → S : { t, d } ou null. */
  function parente(ic, zt, tx, ty) {
    for (var d = 1; d <= 4 && zt - d >= 0; d++) {
      var t = cache.get(cleTuile(ic, zt - d, tx >> d, ty >> d));
      if (t && t.ok) return { t: t, d: d };
    }
    return null;
  }

  /* ── peindre ── E : état de vue → T : pour chaque couche, zoom de tuile =
     arrondi borné au zoom natif, facteur d'échelle 2^(z − zt), tuiles visibles
     (longitude bouclée), tuile parente recadrée en attendant ; puis calques de
     dessin → S : dessin sur le canvas. ALGO : « Rendu de tuiles XYZ à zoom
     fractionnaire avec repli sur les tuiles parentes. » */
  function peindre() {
    raf = 0;
    if (!W || !H) { W = conteneur.clientWidth; H = conteneur.clientHeight; if (!W || !H) return; self.redimensionner(); return; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    for (var ic = 0; ic < couches.length; ic++) {
      var c = couches[ic];
      var zt = Math.max(0, Math.min(c.zMax, Math.round(z)));
      var n = 1 << zt, ts = TS * Math.pow(2, z - zt);
      var ox = W / 2 - pX(cLon, z), oy = H / 2 - pY(cLat, z);
      var x0 = Math.floor(-ox / ts), x1 = Math.floor((W - ox) / ts);
      var y0 = Math.max(0, Math.floor(-oy / ts)), y1 = Math.min(n - 1, Math.floor((H - oy) / ts));
      ctx.globalAlpha = c.opacite;
      for (var ty = y0; ty <= y1; ty++)
        for (var tx = x0; tx <= x1; tx++) {
          var txm = ((tx % n) + n) % n;
          var px = ox + tx * ts, py = oy + ty * ts;
          var t = tuile(ic, zt, txm, ty);
          if (t.ok) { ctx.drawImage(t.img, px, py, ts + 0.5, ts + 0.5); continue; }
          var p = parente(ic, zt, txm, ty);
          if (p) {
            var f = 1 << p.d, sw = p.t.img.naturalWidth / f, sh = p.t.img.naturalHeight / f;
            ctx.drawImage(p.t.img, (txm % f) * sw, (ty % f) * sh, sw, sh, px, py, ts + 0.5, ts + 0.5);
          }
        }
    }
    ctx.globalAlpha = 1;
    for (var i = 0; i < dessins.length; i++) dessins[i](ctx, self);
  }

  /* ── Interactions ───────────────────────────────────────────────── */
  var drag = null, bouge = false;
  cv.addEventListener('mousedown', function (e) {
    emettre('mousedown', e);
    if (!self.glisser || e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, cx: pX(cLon, z), cy: pY(cLat, z) };
    bouge = false;
  });
  window.addEventListener('mousemove', function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) bouge = true;
    cLon = iX(drag.cx - dx, z); cLat = iY(drag.cy - dy, z);
    borner(); self.redessiner();
  });
  window.addEventListener('mouseup', function (e) {
    if (drag) { drag = null; }
    if (e.target === cv) emettre('mouseup', e);
  });
  cv.addEventListener('mousemove', function (e) { emettre('mousemove', e); });
  cv.addEventListener('mouseleave', function (e) { emettre('mouseout', e); });
  cv.addEventListener('click', function (e) {
    if (bouge) { bouge = false; return; }
    emettre('click', e);
  });
  cv.addEventListener('wheel', function (e) {
    if (opts.interactif === false) return;
    e.preventDefault();
    var r = cv.getBoundingClientRect();
    var x = e.clientX - r.left, y = e.clientY - r.top;
    var g = self.versGeo(x, y);
    z += e.deltaY < 0 ? 0.5 : -0.5;
    borner();
    cLon = iX(pX(g.lon, z) - (x - W / 2), z);
    cLat = iY(pY(g.lat, z) - (y - H / 2), z);
    borner(); self.redessiner();
  }, { passive: false });

  if (typeof ResizeObserver !== 'undefined')
    new ResizeObserver(function () { self.redimensionner(); }).observe(conteneur);
  self.redimensionner();
}

if (typeof module !== "undefined" && module.exports) module.exports = { DsmCarte: DsmCarte };
