/*
 * dsm-fil3d.js
 * Projet  : DSM — FIL DE FER 3D : le filet (et uniquement le filet) en trois
 *           dimensions, rotations X/Y/Z, zoom, exagération du relief.
 * Modèle  : arêtes = cordes des segments de contact inter-triangles extraites
 *           de triOfPix (même chapelet de traversées que l'adjacence du flux,
 *           mais extrémités VRAIES : premier point du balayage lexicographique
 *           = extrémité exacte d'un segment rectiligne, second = point le plus
 *           éloigné du premier — les diagonales ↗ ne sont pas confondues avec
 *           les ↘ comme le ferait une boîte englobante). Altitude des
 *           extrémités : interpolation bilinéaire du socle (grille 1024²).
 *           Projection ORTHOGRAPHIQUE maison, rotations appliquées dans
 *           l'ordre Rz (azimut, axe vertical) → Rx (bascule) → Ry (roulis),
 *           profondeur utilisée pour une atténuation légère (lecture du 3D).
 * API     : construire(F, elev, scaleXY) → { seg (Float32Array 6/segment,
 *             mètres, z=altitude), n, cx, cy, cz, rayon }
 *           ouvrir(F, elev, scaleXY)     → superposition plein écran :
 *             glisser = azimut/bascule, molette = zoom, curseurs Rot X/Y/Z
 *             + Relief ×, Échap ou ✕ = fermer. Reconstruit si le filet change.
 * Unités  : mètres partout (px × scaleXY) ; angles en degrés dans l'interface.
 * Dépend  : rien. JS pur, canvas 2D natif.
 * Auteur  : Eric Perret / implémentation Claude
 * Date    : 2026-07-15
 * Version : 1.0.0
 */
"use strict";
const DSMFIL3D = (() => {
  const D = 1024;

  // ── Extraction des arêtes 3D du filet ────────────────────────────
  function construire(F, elev, scaleXY) {
    var top = F.triOfPix;
    // Par paire de triangles : premier point rencontré (extrémité exacte,
    // balayage lexicographique) + point le plus éloigné de lui.
    var map = new Map();   // clé → {x0,y0,x1,y1,d2}
    function acc(a, b, px, py) {
      var k = a < b ? a * 1e6 + b : b * 1e6 + a;
      var r = map.get(k);
      if (!r) { map.set(k, { x0: px, y0: py, x1: px, y1: py, d2: 0 }); return; }
      var dx = px - r.x0, dy = py - r.y0, d2 = dx * dx + dy * dy;
      if (d2 > r.d2) { r.d2 = d2; r.x1 = px; r.y1 = py; }
    }
    for (var y = 0; y < D - 1; y++)
      for (var x = 0; x < D - 1; x++) {
        var i = y * D + x, a = top[i];
        if (a < 0) continue;
        var b1 = top[i + 1], b2 = top[i + D];
        if (b1 >= 0 && b1 !== a) acc(a, b1, x + 1, y + 0.5);   // traversée horizontale
        if (b2 >= 0 && b2 !== a) acc(a, b2, x + 0.5, y + 1);   // traversée verticale
      }
    // Altitude bilinéaire aux extrémités (px flottants → grille 1024²)
    function zAt(px, py) {
      var ix = px < 0 ? 0 : px > D - 2 ? D - 2 : px | 0;
      var iy = py < 0 ? 0 : py > D - 2 ? D - 2 : py | 0;
      var tx = px - ix, ty = py - iy, o = iy * D + ix;
      return elev[o] * (1 - tx) * (1 - ty) + elev[o + 1] * tx * (1 - ty) +
             elev[o + D] * (1 - tx) * ty + elev[o + D + 1] * tx * ty;
    }
    var n = map.size, seg = new Float32Array(n * 6), j = 0;
    var mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9, mnz = 1e9, mxz = -1e9;
    map.forEach(function (r) {
      var x0 = r.x0 * scaleXY, y0 = r.y0 * scaleXY, z0 = zAt(r.x0, r.y0);
      var x1 = r.x1 * scaleXY, y1 = r.y1 * scaleXY, z1 = zAt(r.x1, r.y1);
      seg[j] = x0; seg[j + 1] = y0; seg[j + 2] = z0;
      seg[j + 3] = x1; seg[j + 4] = y1; seg[j + 5] = z1;
      j += 6;
      if (x0 < mnx) mnx = x0; if (x0 > mxx) mxx = x0;
      if (x1 < mnx) mnx = x1; if (x1 > mxx) mxx = x1;
      if (y0 < mny) mny = y0; if (y0 > mxy) mxy = y0;
      if (y1 < mny) mny = y1; if (y1 > mxy) mxy = y1;
      if (z0 < mnz) mnz = z0; if (z0 > mxz) mxz = z0;
      if (z1 < mnz) mnz = z1; if (z1 > mxz) mxz = z1;
    });
    return { seg: seg, n: n,
             cx: (mnx + mxx) / 2, cy: (mny + mxy) / 2, cz: (mnz + mxz) / 2,
             rayon: Math.max(mxx - mnx, mxy - mny, mxz - mnz) / 2 || 1 };
  }

  // ── Visionneuse plein écran ───────────────────────────────────────
  var _ov = null, _mesh = null, _srcF = null;
  var rotX = 60, rotY = 0, rotZ = 0, zoom = 0.9, exag = 1;

  function ouvrir(F, elev, scaleXY) {
    if (!_mesh || _srcF !== F) { _mesh = construire(F, elev, scaleXY); _srcF = F; }
    if (_ov) { _ov.style.display = 'block'; dessiner(); return; }
    _ov = document.createElement('div');
    _ov.style.cssText = 'position:fixed;inset:0;background:#11111b;z-index:9999;';
    _ov.innerHTML =
      '<canvas id="f3d-cv" style="position:absolute;inset:0;cursor:grab"></canvas>' +
      '<div style="position:absolute;top:8px;left:8px;color:#cdd6f4;' +
        'font:12px monospace;background:#1e1e2ecc;padding:8px 10px;border-radius:6px;' +
        'user-select:none">' +
        '<div style="margin-bottom:6px;color:#fab387">FIL DE FER 3D — ' +
          _mesh.n + ' arêtes</div>' +
        _slider('f3d-rx', 'Rot X (bascule)', 0, 90, rotX) +
        _slider('f3d-ry', 'Rot Y (roulis)', -180, 180, rotY) +
        _slider('f3d-rz', 'Rot Z (azimut)', -180, 180, rotZ) +
        _slider('f3d-ex', 'Relief ×', 0.5, 5, exag, 0.1) +
        '<div style="margin-top:6px;color:#6c7086">glisser : Z/X — molette : zoom' +
          ' — Échap : fermer</div>' +
      '</div>' +
      '<button id="f3d-x" style="position:absolute;top:8px;right:8px;' +
        'background:#313244;color:#cdd6f4;border:0;border-radius:6px;' +
        'padding:6px 12px;cursor:pointer;font:14px monospace">✕</button>';
    document.body.appendChild(_ov);
    var cv = _ov.querySelector('#f3d-cv');
    function taille() { cv.width = innerWidth; cv.height = innerHeight; dessiner(); }
    addEventListener('resize', taille); taille();
    // Interactions : glisser = azimut (Z) / bascule (X), molette = zoom
    var drag = null;
    cv.addEventListener('pointerdown', function (e) {
      drag = { x: e.clientX, y: e.clientY }; cv.setPointerCapture(e.pointerId);
      cv.style.cursor = 'grabbing';
    });
    cv.addEventListener('pointermove', function (e) {
      if (!drag) return;
      rotZ = _mod180(rotZ + (e.clientX - drag.x) * 0.4);
      rotX = Math.max(0, Math.min(90, rotX + (e.clientY - drag.y) * 0.4));
      drag = { x: e.clientX, y: e.clientY };
      _maj('f3d-rx', rotX); _maj('f3d-rz', rotZ); dessiner();
    });
    cv.addEventListener('pointerup', function () { drag = null; cv.style.cursor = 'grab'; });
    cv.addEventListener('wheel', function (e) {
      e.preventDefault();
      zoom *= e.deltaY < 0 ? 1.1 : 1 / 1.1;
      zoom = Math.max(0.1, Math.min(40, zoom));
      dessiner();
    }, { passive: false });
    _lie('f3d-rx', function (v) { rotX = v; }); _lie('f3d-ry', function (v) { rotY = v; });
    _lie('f3d-rz', function (v) { rotZ = v; }); _lie('f3d-ex', function (v) { exag = v; });
    _ov.querySelector('#f3d-x').addEventListener('click', fermer);
    addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && _ov && _ov.style.display !== 'none') fermer();
    });
    dessiner();
  }
  function fermer() { if (_ov) _ov.style.display = 'none'; }
  function _mod180(a) { while (a > 180) a -= 360; while (a < -180) a += 360; return a; }
  function _slider(id, nom, mn, mx, v, pas) {
    return '<label style="display:block;margin:3px 0">' + nom +
      ' <span id="' + id + '-v">' + v + '</span><br>' +
      '<input id="' + id + '" type="range" min="' + mn + '" max="' + mx +
      '" step="' + (pas || 1) + '" value="' + v + '" style="width:180px"></label>';
  }
  function _lie(id, set) {
    var el = _ov.querySelector('#' + id);
    el.addEventListener('input', function () {
      set(+el.value); _maj(id, +el.value); dessiner();
    });
  }
  function _maj(id, v) {
    _ov.querySelector('#' + id).value = v;
    _ov.querySelector('#' + id + '-v').textContent = (+v).toFixed(v % 1 ? 1 : 0);
  }

  // ── Rendu : Rz (azimut) → Rx (bascule) → Ry (roulis), orthographique ──
  // Axes modèle : x = est, y = nord, z = altitude × exagération.
  function dessiner() {
    if (!_ov || !_mesh) return;
    var cv = _ov.querySelector('#f3d-cv'), c = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    c.clearRect(0, 0, W, H);
    var ra = Math.PI / 180;
    var cz = Math.cos(rotZ * ra), sz = Math.sin(rotZ * ra);
    var cx = Math.cos(rotX * ra), sx = Math.sin(rotX * ra);
    var cyr = Math.cos(rotY * ra), syr = Math.sin(rotY * ra);
    var k = zoom * Math.min(W, H) / (2.2 * _mesh.rayon);
    var s = _mesh.seg, n = _mesh.n;
    var mx = _mesh.cx, my = _mesh.cy, mz = _mesh.cz, R = _mesh.rayon;
    // 4 lots d'opacité selon la profondeur moyenne (lecture du relief)
    var lots = [[], [], [], []];
    for (var i = 0; i < n * 6; i += 6) {
      // point 0 — modèle : x est, y NORD (py écran inversé), z altitude exagérée
      var x0 = s[i] - mx, y0 = my - s[i + 1], z0 = (s[i + 2] - mz) * exag;
      var x1 = s[i + 3] - mx, y1 = my - s[i + 4], z1 = (s[i + 5] - mz) * exag;
      // Rz (azimut, autour de l'axe vertical modèle)
      var ax0 = x0 * cz - y0 * sz, ay0 = x0 * sz + y0 * cz;
      var ax1 = x1 * cz - y1 * sz, ay1 = x1 * sz + y1 * cz;
      // Rx (bascule) : le nord part en profondeur/écran
      var by0 = ay0 * cx - z0 * sx, bz0 = ay0 * sx + z0 * cx;
      var by1 = ay1 * cx - z1 * sx, bz1 = ay1 * sx + z1 * cx;
      // Ry (roulis) autour de l'axe de visée
      var u0 = ax0 * cyr - bz0 * syr, v0 = ax0 * syr + bz0 * cyr;
      var u1 = ax1 * cyr - bz1 * syr, v1 = ax1 * syr + bz1 * cyr;
      var lot = ((by0 + by1) / (4 * R) + 0.5) * 4 | 0;      // profondeur → 0..3
      lots[lot < 0 ? 0 : lot > 3 ? 3 : lot].push(
        W / 2 + u0 * k, H / 2 - v0 * k, W / 2 + u1 * k, H / 2 - v1 * k);
    }
    c.lineWidth = 1;
    var alpha = [0.9, 0.65, 0.45, 0.3];                     // proche → lointain
    for (var l = 0; l < 4; l++) {
      var L = lots[l]; if (!L.length) continue;
      c.strokeStyle = 'rgba(250,179,135,' + alpha[l] + ')'; // orange du fil 2D
      c.beginPath();
      for (var p = 0; p < L.length; p += 4) {
        c.moveTo(L[p], L[p + 1]); c.lineTo(L[p + 2], L[p + 3]);
      }
      c.stroke();
    }
  }

  return { construire, ouvrir, fermer };
})();
if (typeof module !== "undefined" && module.exports) module.exports = { DSMFIL3D };
