/*
  Fichier  : dsm-worker-glacier.js
  Date     : 2026-07-15
  Version  : 1.6.0  (amplitude diurne × sc.bNeb — nébulosité mensuelle mesurée,
             fiche 73054001, transmise par le pas ; aDiurne = 13,8 plein ciel.)
  Version  : 1.5.0  (CYCLE DIURNE CENTRÉ : moyenne 24 h = C exactement — l'ancien
             sinus positif ajoutait (2b/π)·(L/24) ≈ +4,6 °C de moyenne estivale
             au soleil, double comptage de la convention « base = moyenne ».)
  Version  : 1.2.0  (suppression de φ : fonte pleine partout — les cellules
             partielles n'existent plus, cf. dsm-flux 3.4. Signature pas()
             sans paramètre phi.)
  Version  : 1.1.0  (fonte × φ des cellules de front partielles)
  Rôle     : Pool de workers (Blob inline, file:// OK — modèle dsm-worker-tiff)
             pour l'accumulation glacier PAR TRIANGLE : dépôt + fonte PDD
             analytique 24 h + tassement. Physique STRICTEMENT identique au
             mono-thread v3.45 — seule la partition des triangles change.
             L'écoulement (dsm-flux) reste sur le fil principal (transferts
             entre triangles voisins non partitionnables sans verrous).
  API      : GLACPOOL.init(nTri, tables)  — tables statiques par triangle
             GLACPOOL.majSoleil(wSun73)   — après recalcul insolation (1 ka)
             GLACPOOL.majFoehn(fC, fDT)   — après recalcul foehn (5 ka)
             GLACPOOL.pas(scal, neige, glace) → Promise (tableaux mis à jour en place)
  Dépend   : rien (constantes passées à l'init).
  Auteur   : Eric Perret / implémentation Claude
*/
"use strict";

const GLACPOOL = (() => {

  const WSRC = `
"use strict";
var S=null;            // statiques : {t0,t1,z,fDT,fC,cosT,actif,wSun,K}
onmessage=function(ev){
  var m=ev.data;
  if(m.cmd==='init'){ S=m; postMessage({ok:1}); return; }
  if(m.cmd==='soleil'){ S.wSun=m.wSun; postMessage({ok:1}); return; }
  if(m.cmd==='foehn'){ S.fC=m.fC; S.fDT=m.fDT; postMessage({ok:1}); return; }
  if(m.cmd==='pas'){
    var K=S.K, n=m.neige, g=m.glace, sc=m.scal;
    var nT=S.t1-S.t0, PI=Math.PI;
    var base=sc.tMer, lap=K.lapse/1000;
    var off=sc.slice*nT;                       // table wSun : tranche-major
    for(var t=0;t<nT;t++){
      if(!S.actif[t] && g[t]<=0 && n[t]<=0) continue;
      var z=S.z[t], fDT=S.fDT[t];
      var C=(z<=0.5?base:base-lap*z)+sc.tSaison+fDT;
      var b=K.aDiurne*(sc.bNeb||1)*(S.wSun[off+t]/255);   // nébulosité mensuelle (dsm-temp 2.6)
      // PDD analytique 24 h — diurne CENTRÉ (v1.5) : C est la MOYENNE journalière
      // (convention T0_MER/A_SAISON) ; jour au-dessus, nuit en dessous :
      // Cn = C − m, m = (2b/π)·(L/24) → moyenne 24 h = C exactement.
      var mC=(sc.L>0&&b>0)?(2*b/PI)*(sc.L/24):0;
      var Cn=C-mC;
      var degH=(Cn>0?Cn*(24-sc.L):0);
      if(sc.L>0&&b>0){
        if(Cn>=0) degH+=(Cn+2*b/PI)*sc.L;
        else if(Cn+b>0){
          var f1=Math.asin(-Cn/b)/PI;
          degH+=(Cn*(1-2*f1)+(2*b/PI)*Math.cos(PI*f1))*sc.L;
        }
      } else if(sc.L>0&&Cn>0) degH+=Cn*sc.L;
      // 1. dépôt
      var fSnow=C<=0?1:(C<2?(2-C)/2:0);
      n[t]+=sc.precJour*S.cosT[t]*S.fC[t]*fSnow;
      // 2. fonte
      var dh=degH*K.pasJ;
      if(dh>0){
        var fN=dh*K.ddfN;
        if(fN<=n[t]) n[t]-=fN;
        else { var r=(fN-n[t])/K.ddfN; n[t]=0; g[t]=Math.max(0,g[t]-r*K.ddfG); }
      }
      // 3. tassement
      if(n[t]>0){ var cv=n[t]*K.kTass; n[t]-=cv; g[t]+=cv; }
    }
    postMessage({neige:n.buffer, glace:g.buffer, t0:S.t0}, [n.buffer, g.buffer]);
  }
};`;

  var url = URL.createObjectURL(new Blob([WSRC], { type: 'text/javascript' }));
  var NW = Math.max(2, navigator.hardwareConcurrency || 4);
  var ws = [], ranges = [], nTriTot = 0;

  function _bcast(msgOf) {                       // envoie à tous, attend tous
    return Promise.all(ws.map(function (w, i) {
      return new Promise(function (res) {
        w.onmessage = function () { res(); };
        var m = msgOf(i);
        w.postMessage(m.msg, m.tr || []);
      });
    }));
  }

  // tables : {z,fDT,fC,cosT,actif,wSun73,K}  (arrays pleine taille ; découpés ici)
  function init(nTri, tb) {
    nTriTot = nTri;
    ws.forEach(function (w) { w.terminate(); });
    ws = []; ranges = [];
    var per = Math.ceil(nTri / NW);
    for (var i = 0; i < NW; i++) {
      var t0 = i * per, t1 = Math.min(nTri, t0 + per);
      if (t0 >= t1) break;
      ranges.push([t0, t1]);
      ws.push(new Worker(url));
    }
    return _bcast(function (i) {
      var r = ranges[i], t0 = r[0], t1 = r[1], n = t1 - t0;
      var wS = _sliceWsun(tb.wSun73, t0, t1);
      return { msg: { cmd: 'init', t0: t0, t1: t1, K: tb.K,
        z: tb.z.slice(t0, t1), fDT: tb.fDT.slice(t0, t1), fC: tb.fC.slice(t0, t1),
        cosT: tb.cosT.slice(t0, t1), actif: tb.actif.slice(t0, t1), wSun: wS } };
    });
  }

  function _sliceWsun(wSun73, t0, t1) {          // pleine table (73×nTri, tranche-major) → sous-table
    var nS = 73, n = t1 - t0, out = new Uint8Array(nS * n);
    for (var s = 0; s < nS; s++)
      out.set(wSun73.subarray(s * nTriTot + t0, s * nTriTot + t1), s * n);
    return out;
  }

  function majSoleil(wSun73) {
    return _bcast(function (i) {
      var r = ranges[i];
      return { msg: { cmd: 'soleil', wSun: _sliceWsun(wSun73, r[0], r[1]) } };
    });
  }

  function majFoehn(fC, fDT) {
    return _bcast(function (i) {
      var r = ranges[i];
      return { msg: { cmd: 'foehn', fC: fC.slice(r[0], r[1]), fDT: fDT.slice(r[0], r[1]) } };
    });
  }

  // scal : {tMer, tSaison, L, precJour, slice} — neige/glace mis à jour EN PLACE
  function pas(scal, neige, glace) {
    return Promise.all(ws.map(function (w, i) {
      return new Promise(function (res) {
        var r = ranges[i], t0 = r[0], t1 = r[1];
        var n = new Float32Array(neige.subarray(t0, t1));   // copies transférables
        var g = new Float32Array(glace.subarray(t0, t1));
        w.onmessage = function (ev) {
          neige.set(new Float32Array(ev.data.neige), ev.data.t0);
          glace.set(new Float32Array(ev.data.glace), ev.data.t0);
          res();
        };
        w.postMessage({ cmd: 'pas', scal: scal, neige: n, glace: g }, [n.buffer, g.buffer]);
      });
    }));
  }

  return { init, majSoleil, majFoehn, pas, NW };
})();
