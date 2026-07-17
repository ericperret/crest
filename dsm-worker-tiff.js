/*
  Fichier  : dsm-worker-tiff.js
  Date     : 2026-06-11
  Version  : 3.10
  Rôle     : Décodage GeoTIFF (worker Blob inline) + chargement viewer.
             readTiffTags + DecompressionStream + Float32 + hypsométrie +
             contours Marching Squares → elevGrid + pixels RGBA (transferables).
  Expose   : WORKER_SRC, spawnWorker(), loadInViewer(file).
  Dépend   : globales de dsm.html (render, resizeWrap, makeHypsoLUT, GEO,
             elevGrid, imgW/imgH, srcX/srcY/srcPPx, viewMode, osc*, vmin/vmax,
             swapBtn, DISP) et resetSim (dsm-ombre.js) — résolues à l'exécution.
  Ordre    : charger APRÈS le script glue inline de dsm.html et dsm-astro.js.
  Note 3.10: redécoupage VERBATIM depuis dsm_original.html v3.7 (référence
             utilisateur) — zéro modification fonctionnelle.
*/
"use strict";

// ════════════════════════════════════════════════════════════════
// WORKER INLINE — Blob URL (fonctionne sur file:// et http://)
// Tout le décodage TIFF tourne hors fil principal.
// Retourne (zero-copy) : elevGrid F32 + hypsoPixels RGBA + contourPixels RGBA
// ════════════════════════════════════════════════════════════════
const WORKER_SRC = `
// ── Tags TIFF ──────────────────────────────────────────────────
function readTiffTags(buf) {
  var v=new DataView(buf), le=(v.getUint16(0,true)===0x4949);
  var r16=function(o){return v.getUint16(o,le);};
  var r32=function(o){return v.getUint32(o,le);};
  var ifd=r32(4), t={}, ne=r16(ifd);
  for(var i=0;i<ne;i++){
    var base=ifd+2+i*12, tag=r16(base), type=r16(base+2),
        cnt=r32(base+4), vo=base+8;
    (function(tag,type,cnt,vo){
      function vals(){
        var sz=[0,1,1,2,4,8,1,1,2,4,8,4,8][type]||1;
        var start=sz*cnt>4?r32(vo):vo, arr=[];
        for(var j=0;j<cnt;j++){
          var p=start+j*sz;
          if(type===3)arr.push(v.getUint16(p,le));
          else if(type===4)arr.push(v.getUint32(p,le));
          else if(type===12)arr.push(v.getFloat64(p,le));
          else if(type===16)arr.push(Number(v.getBigUint64(p,le)));
          else arr.push(v.getUint32(p,le));
        }
        return arr;
      }
      switch(tag){
        case 256:t.width=vals()[0];break;    case 257:t.height=vals()[0];break;
        case 258:t.bps=vals()[0];break;      case 317:t.predictor=vals()[0];break;
        case 322:t.tileW=vals()[0];break;    case 323:t.tileH=vals()[0];break;
        case 324:t.tileOffsets=vals();break; case 325:t.tileByteCounts=vals();break;
        case 339:t.sampleFormat=vals()[0];break;
        case 33550:t.pixelScale=vals();break; case 33922:t.tiepoint=vals();break;
      }
    })(tag,type,cnt,vo);
  }
  return t;
}

// ── Inflate natif (DecompressionStream — disponible dans Workers) ──
async function inflateNative(uint8){
  var raw=uint8.slice(2,uint8.length-4);
  var ds=new DecompressionStream('deflate-raw');
  var writer=ds.writable.getWriter(), reader=ds.readable.getReader();
  writer.write(raw).then(function(){writer.close();});
  var chunks=[], totalLen=0;
  while(true){var r=await reader.read(); if(r.done)break; chunks.push(r.value); totalLen+=r.value.length;}
  var out=new Uint8Array(totalLen), off=0;
  for(var i=0;i<chunks.length;i++){out.set(chunks[i],off);off+=chunks[i].length;}
  return out;
}

// ── Décodage tuile Float32 (Predictor=3, fpAcc) ────────────────
async function decodeTile(buf,offset,byteCount,tileW,tileH){
  var raw=await inflateNative(new Uint8Array(buf,offset,byteCount));
  var rowBytes=tileW*4, out=new Float32Array(tileW*tileH), tmp=new Uint8Array(out.buffer);
  for(var row=0;row<tileH;row++){
    var rs=row*rowBytes;
    for(var i=rs+1;i<rs+rowBytes;i++) raw[i]=(raw[i]+raw[i-1])&0xFF;
    var base=row*tileW;
    for(var i=0;i<tileW;i++){
      tmp[(base+i)*4+0]=raw[rs+3*tileW+i]; tmp[(base+i)*4+1]=raw[rs+2*tileW+i];
      tmp[(base+i)*4+2]=raw[rs+1*tileW+i]; tmp[(base+i)*4+3]=raw[rs+0*tileW+i];
    }
  }
  return out;
}

// ── LUT hypsométrique ──────────────────────────────────────────
function makeHypsoLUT(){
  var stops=[[0.00,20,90,20],[0.12,80,160,50],[0.25,180,170,80],
    [0.40,180,130,50],[0.58,140,85,30],[0.74,130,100,80],
    [0.88,200,190,180],[1.00,255,255,255]];
  var lut=new Uint8Array(256*3);
  for(var i=0;i<256;i++){
    var t=i/255, s0=stops[0], s1=stops[1];
    for(var k=0;k<stops.length-1;k++)
      if(t>=stops[k][0]&&t<=stops[k+1][0]){s0=stops[k];s1=stops[k+1];break;}
    var f=s1[0]===s0[0]?0:(t-s0[0])/(s1[0]-s0[0]);
    lut[i*3]=Math.round(s0[1]+f*(s1[1]-s0[1]));
    lut[i*3+1]=Math.round(s0[2]+f*(s1[2]-s0[2]));
    lut[i*3+2]=Math.round(s0[3]+f*(s1[3]-s0[3]));
  }
  return lut;
}

// ── Grille élévation + pixels RGBA hypsométriques ─────────────
// Égalisation d'histogramme (10 000 bins) pour maximiser le contraste.
// Pixels placés dans un tableau W×H global (pas tuile par tuile).
async function buildElevAndHypso(buf,t,lut){
  var W=t.width, H=t.height, tileW=t.tileW, tileH=t.tileH;
  var tileOffsets=t.tileOffsets, tileByteCounts=t.tileByteCounts;
  var tilesX=Math.ceil(W/tileW), tilesY=Math.ceil(H/tileH);
  var totalTiles=tilesX*tilesY;
  var elevGrid=new Float32Array(W*H);
  var tiles=[], vmin=Infinity, vmax=-Infinity;

  for(var ty=0;ty<tilesY;ty++) for(var tx=0;tx<tilesX;tx++){
    var idx=ty*tilesX+tx;
    var tw=Math.min(tileW,W-tx*tileW), th=Math.min(tileH,H-ty*tileH);
    var data=await decodeTile(buf,tileOffsets[idx],tileByteCounts[idx],tileW,tileH);
    tiles.push({data:data,tw:tw,th:th,tx:tx,ty:ty});
    for(var r=0;r<th;r++) for(var c=0;c<tw;c++){
      var v=data[r*tileW+c];
      elevGrid[(ty*tileH+r)*W+(tx*tileW+c)]=v;
      if(v>0.5&&v<9000){if(v<vmin)vmin=v; if(v>vmax)vmax=v;}
    }
    self.postMessage({type:'progress',msg:'Décodage tuile '+(idx+1)+'/'+totalTiles+'…'});
  }

  var NBINS=10000, hist=new Uint32Array(NBINS), vrange=vmax-vmin||1;
  for(var i=0;i<tiles.length;i++){
    var tile=tiles[i];
    for(var r=0;r<tile.th;r++) for(var c=0;c<tile.tw;c++){
      var v=tile.data[r*tileW+c];
      if(v>0.5&&v<9000) hist[Math.min(NBINS-1,Math.floor((v-vmin)/vrange*NBINS))]++;
    }
  }
  var tot=0; for(var b=0;b<NBINS;b++) tot+=hist[b];
  var binToLut=new Uint8Array(NBINS), cumul=0;
  for(var b=0;b<NBINS;b++){cumul+=hist[b]; binToLut[b]=Math.min(255,Math.floor(cumul/tot*256));}

  var hypsoPixels=new Uint8ClampedArray(W*H*4);
  for(var i=0;i<tiles.length;i++){
    var tile=tiles[i];
    for(var r=0;r<tile.th;r++) for(var c=0;c<tile.tw;c++){
      var v=tile.data[r*tileW+c];
      var o=((tile.ty*tileH+r)*W+(tile.tx*tileW+c))*4;
      if(v<=0.5||v>=9000){hypsoPixels[o]=20;hypsoPixels[o+1]=60;hypsoPixels[o+2]=130;hypsoPixels[o+3]=255;}
      else{var li=binToLut[Math.min(NBINS-1,Math.floor((v-vmin)/vrange*NBINS))]*3;
        hypsoPixels[o]=lut[li];hypsoPixels[o+1]=lut[li+1];hypsoPixels[o+2]=lut[li+2];hypsoPixels[o+3]=255;}
    }
  }
  return {elevGrid:elevGrid, vmin:vmin, vmax:vmax, hypsoPixels:hypsoPixels};
}

// ── Marching Squares — bitmap contours (OffscreenCanvas dans le Worker) ──
//
// Table LINES[idx] = paires d'arêtes à connecter (0=haut 1=droite 2=bas 3=gauche).
// idx construit bit par bit : bit0=TL bit1=TR bit2=BR bit3=BL (1 si > seuil).
// edgePt : interpolation linéaire sub-pixel sur l'arête.
//
// Stratégie performance :
//   Une seule passe cellulaire par style (minor / major).
//   Pour chaque cellule, on cherche les niveaux dans [cellMin,cellMax] par pas
//   → on ne teste jamais les niveaux qui ne coupent pas la cellule.
//   Résultat : deux ctx.stroke() au total, quelque soit le nombre de niveaux.
function buildContourBitmap(elevGrid,W,H,vmin,vmax){
  var interval=vmax>800?100:vmax>300?50:20, major=interval*5;

  // Table Marching Squares — 16 cas, chacun 0, 1 ou 2 segments
  var LINES=[
    [],[[0,3]],[[0,1]],[[1,3]],
    [[1,2]],[[0,3],[1,2]],[[0,2]],[[2,3]],
    [[2,3]],[[0,2]],[[0,1],[2,3]],[[1,2]],
    [[1,3]],[[0,1]],[[0,3]],[]
  ];

  // Coordonnée du point de croisement sur l'arête e (espace pixel = espace grille)
  function ep(e,c,r,TL,TR,BR,BL,t){
    var d,f;
    if(e===0){d=TR-TL; f=d?(t-TL)/d:.5; return[c+f,r];}
    if(e===1){d=BR-TR; f=d?(t-TR)/d:.5; return[c+1,r+f];}
    if(e===2){d=BR-BL; f=d?(t-BL)/d:.5; return[c+f,r+1];}
    d=BL-TL; f=d?(t-TL)/d:.5; return[c,r+f];
  }

  var osc=new OffscreenCanvas(W,H), ctx=osc.getContext('2d');

  // 1. Fond : blanc (terre) / bleu (mer)
  var bg=new Uint8ClampedArray(W*H*4);
  for(var i=0;i<W*H;i++){
    var v=elevGrid[i], o=i*4;
    if(v<=0.5||v>=9000){bg[o]=20;bg[o+1]=60;bg[o+2]=130;}
    else{bg[o]=255;bg[o+1]=255;bg[o+2]=255;}
    bg[o+3]=255;
  }
  ctx.putImageData(new ImageData(bg,W,H),0,0);
  bg=null;

  // 2. Isolignes Marching Squares — une passe par style
  function drawPass(stepLv, skipMod, color, lw){
    ctx.strokeStyle=color; ctx.lineWidth=lw;
    ctx.beginPath();
    for(var r=0;r<H-1;r++) for(var c=0;c<W-1;c++){
      var TL=elevGrid[r*W+c], TR=elevGrid[r*W+c+1];
      var BR=elevGrid[(r+1)*W+c+1], BL=elevGrid[(r+1)*W+c];
      if(TL<=0.5||TR<=0.5||BR<=0.5||BL<=0.5) continue;
      var cMin=TL,cMax=TL;
      if(TR<cMin)cMin=TR; if(TR>cMax)cMax=TR;
      if(BR<cMin)cMin=BR; if(BR>cMax)cMax=BR;
      if(BL<cMin)cMin=BL; if(BL>cMax)cMax=BL;
      // Premier niveau >= cMin aligné sur stepLv
      var first=Math.ceil(cMin/stepLv)*stepLv;
      for(var lv=first;lv<=cMax;lv+=stepLv){
        if(skipMod&&(lv%skipMod===0)) continue;
        var idx=(TL>lv?1:0)|(TR>lv?2:0)|(BR>lv?4:0)|(BL>lv?8:0);
        var segs=LINES[idx];
        for(var s=0;s<segs.length;s++){
          var p0=ep(segs[s][0],c,r,TL,TR,BR,BL,lv);
          var p1=ep(segs[s][1],c,r,TL,TR,BR,BL,lv);
          ctx.moveTo(p0[0],p0[1]); ctx.lineTo(p1[0],p1[1]);
        }
      }
    }
    ctx.stroke();
  }

  drawPass(interval, major,  'rgba(110,78,28,.55)', 0.7);  // mineures
  drawPass(major,    0,      'rgba(62,36,8,.90)',   1.6);   // majeures

  return {bitmap:osc.transferToImageBitmap(), interval:interval, major:major};
}

// ── Point d'entrée Worker ──────────────────────────────────────
self.onmessage=async function(e){
  if(e.data.type!=='load') return;
  try{
    var buf=e.data.buffer;
    self.postMessage({type:'progress',msg:'Lecture tags TIFF\u2026'});
    var t=readTiffTags(buf);
    var geo=(t.tiepoint&&t.pixelScale)?{
      lonMin:t.tiepoint[3], latMax:t.tiepoint[4],
      lonMax:t.tiepoint[3]+t.width*t.pixelScale[0],
      latMin:t.tiepoint[4]-t.height*t.pixelScale[1]
    }:null;
    var lut=makeHypsoLUT();
    var res=await buildElevAndHypso(buf,t,lut);
    self.postMessage({type:'progress',msg:'Marching Squares\u2026'});
    var cRes=buildContourBitmap(res.elevGrid,t.width,t.height,res.vmin,res.vmax);
    self.postMessage({
      type:'done',
      width:t.width, height:t.height,
      vmin:res.vmin, vmax:res.vmax, geo:geo,
      interval:cRes.interval, major:cRes.major,
      elevGrid:res.elevGrid, hypsoPixels:res.hypsoPixels,
      contourBitmap:cRes.bitmap
    },[res.elevGrid.buffer, res.hypsoPixels.buffer, cRes.bitmap]);
  }catch(err){
    self.postMessage({type:'error', msg:err.message});
  }
};
`;

let activeWorker = null;
function spawnWorker(){
  if(activeWorker){ activeWorker.terminate(); activeWorker=null; }
  const blob = new Blob([WORKER_SRC], {type:'application/javascript'});
  const url  = URL.createObjectURL(blob);
  const w    = new Worker(url);
  URL.revokeObjectURL(url);
  return w;
}

// ════════════════════════════════════════════════════════════════
// CHARGEMENT — via Worker (zéro blocage fil principal)
// Le Worker reçoit l'ArrayBuffer (transfert), renvoie :
//   elevGrid F32 + hypsoPixels RGBA + contourPixels RGBA (transferables)
// Le fil principal construit les OffscreenCanvas depuis les pixels reçus.
// ════════════════════════════════════════════════════════════════
async function loadInViewer(file){
  document.getElementById('placeholder').style.display='none';
  swapBtn.disabled=true;
  document.getElementById('btn-carto').disabled=true;
  document.getElementById('btn-rec').disabled=true;
  oscHypso=null; oscContour=null; resetSim();

  document.title=`DSM — ${file.name.replace(/\.[^.]+$/,'')}`;
  document.getElementById('titre').textContent=file.name.replace(/\.[^.]+$/,'');
  document.getElementById('vstatus').textContent='Lecture fichier…';

  const buf=await file.arrayBuffer();      // lit sur disque
  document.getElementById('vstatus').textContent='Worker démarré — fil principal libre';

  activeWorker=spawnWorker();
  activeWorker.onmessage=(e)=>{
    const d=e.data;
    if(d.type==='progress'){
      document.getElementById('vstatus').textContent=d.msg;

    } else if(d.type==='done'){
      const {width:W,height:H,vmin,vmax,geo,interval,major,
             elevGrid:eg,hypsoPixels,contourBitmap}=d;

      imgW=W; imgH=H; GEO=geo; elevGrid=eg;
      vminGlobal=vmin; vmaxGlobal=vmax;
      makeHypsoLUT();

      oscHypso=new OffscreenCanvas(W,H);
      oscHypso.getContext('2d').putImageData(new ImageData(hypsoPixels,W,H),0,0);
      // Bitmap Marching Squares dessiné dans le Worker — transfert zero-copy
      oscContour=new OffscreenCanvas(W,H);
      oscContour.getContext('2d').drawImage(contourBitmap,0,0);
      contourBitmap.close();
      oscWater=new OffscreenCanvas(W,H);

      srcX=0; srcY=0; srcPPx=Math.max(W,H)/DISP;
      viewMode='hypso'; swapBtn.textContent='⇄ Courbes de niveau';
      swapBtn.disabled=false;
      document.getElementById('btn-carto').disabled=false;
      document.getElementById('btn-rec').disabled=false;
      document.getElementById('btn-ombre').disabled=false;

      resizeWrap();
      document.getElementById('vstatus').textContent=
        `${W}×${H} px — ${vmin.toFixed(0)}–${vmax.toFixed(0)} m`
        +` — courbes /${interval} m (majeure /${major} m)`;
      render(); activeWorker=null;

    } else if(d.type==='error'){
      document.getElementById('vstatus').textContent='Erreur Worker : '+d.msg;
      activeWorker=null;
    }
  };

  // Transfert zero-copy : buf est envoyé au Worker, inutilisable ici après
  activeWorker.postMessage({type:'load', buffer:buf}, [buf]);
}
