/* ═══════════════════════════════════════════════════════════════════
   FICHIER : dsm-worker-tiff.js - v27/09/2026
   OBJET   : lecture d'un GeoTIFF d'altitude (Copernicus : float32 tuilé,
             deflate, predictor 3) ou d'une grille assemblée par map.html,
             dans un Worker : altitudes, image hypsométrique égalisée,
             courbes de niveau ; puis installation dans le visualiseur.
   AUTEUR  : Eric P.
   RELECTURE : Opus 5.5
   LICENCE : CC BY-NC 4.0 — source à citer : https://github.com/ericperret/crest/
             usage commercial interdit sauf accord écrit de l'auteur (voir LICENSE)
   DÉPEND  : dsm.html (imgW, imgH, GEO, elevGrid, oscHypso, oscContour,
             oscWater, srcX, srcY, srcPPx, DISP, render, resizeWrap,
             makeHypsoLUT, dsmReset, resetSim), dsm-barrage.js
             (barrageEffacer), dsm-temp.js (tempInit)
   EXPOSE  : TIFF_WORKER_SRC, spawnTiffWorker, attachWorkerDoneHandler,
             prepViewerUI, loadInViewer, loadGridInViewer
   ═══════════════════════════════════════════════════════════════════ */
"use strict";

const TIFF_WORKER_SRC = `
/* ── readTiffTags ── E : ArrayBuffer TIFF → T : ordre des octets (II/MM),
   premier IFD, lecture des tags utiles (dimensions, bits, compression,
   predictor, tuiles, format d'échantillon, GeoTIFF pixelScale et
   tiepoint), valeurs en ligne ou par décalage selon la taille du type →
   S : objet t. ALGO : « Lecteur minimal du premier IFD d'un TIFF classique
   (non BigTIFF). » */
function readTiffTags(buf) {
  var v=new DataView(buf), le=(v.getUint16(0,true)===0x4949);
  var r16=function(o){return v.getUint16(o,le);};
  var r32=function(o){return v.getUint32(o,le);};
  var ifd=r32(4), t={}, ne=r16(ifd);
  for(var i=0;i<ne;i++){
    var base=ifd+2+i*12, tag=r16(base), type=r16(base+2),
        cnt=r32(base+4), vo=base+8;
    (function(tag,type,cnt,vo){
      /* vals — E : type, nombre, décalage du tag courant → T : lit les valeurs
         (SHORT, LONG, DOUBLE, LONG8) → S : tableau. */
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
        case 259:t.compression=vals()[0];break;
        case 322:t.tileW=vals()[0];break;    case 323:t.tileH=vals()[0];break;
        case 324:t.tileOffsets=vals();break; case 325:t.tileByteCounts=vals();break;
        case 339:t.sampleFormat=vals()[0];break;
        case 33550:t.pixelScale=vals();break; case 33922:t.tiepoint=vals();break;
      }
    })(tag,type,cnt,vo);
  }
  return t;
}

/* ── checkTiff ── E : tags t → T : exige tuilé, deflate (8 ou 32946),
   predictor 3, 32 bits, flottant → S : rien, ou exception listant les
   écarts. */
function checkTiff(t){
  var e=[];
  if(!t.tileW||!t.tileH||!t.tileOffsets) e.push('non tuilé');
  if(t.compression!==8&&t.compression!==32946) e.push('compression '+t.compression+' (deflate attendu)');
  if(t.predictor!==3) e.push('predictor '+(t.predictor||1)+' (3 attendu)');
  if(t.bps!==32) e.push(t.bps+' bits (32 attendus)');
  if(t.sampleFormat!==3) e.push('sampleFormat '+(t.sampleFormat||1)+' (flottant attendu)');
  if(e.length) throw new Error('GeoTIFF non supporté : '+e.join(', '));
}

/* ── inflateNative ── E : flux zlib (Uint8Array) → T : retire l'en-tête (2
   octets) et l'Adler-32 (4), DecompressionStream('deflate-raw'), concatène
   les morceaux → S : Promise(Uint8Array décompressé).
   ⚠ Suppose un flux sans dictionnaire prédéfini ; une erreur d'écriture
     n'est pas interceptée. */
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

/* ── decodeTile ── E : buffer, décalage, taille, tileW, tileH → T : inflate ;
   par ligne, cumul des octets (predictor 3 : différence horizontale octet
   par octet), puis réassemblage des 4 plans d'octets (poids fort en
   premier) en float32 petit-boutiste → S : Promise(Float32Array tileW ×
   tileH). ALGO : « Décodage d'une tuile flottante TIFF predictor 3. » */
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

/* ── makeHypsoLUT ── E : aucune → T : 8 paliers vert → brun → gris → blanc,
   interpolés sur 256 niveaux → S : table RGB.
   ⚠ Copie de makeHypsoLUT de dsm.html (légende) : deux définitions à
     garder identiques. */
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

/* ── buildElevAndHypso ── E : buffer, tags t, table de couleurs → T :
   décode chaque tuile dans la grille W×H, min/max terrestres (0,5 <
   z < 9000) ; égalisation d'histogramme sur 10 000 classes → indice de
   couleur ; mer et hors domaine en bleu → S : Promise({ elevGrid, vmin,
   vmax, hypsoPixels RGBA }). ALGO : « Grille d'altitude et image
   hypsométrique à contraste égalisé. »
   ⚠ Garde toutes les tuiles décodées en plus de la grille : mémoire
     doublée pendant le traitement. */
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

/* ── buildHypsoFromGrid ── E : grille Float32 W×H, table de couleurs →
   T : même égalisation que buildElevAndHypso → S : { vmin, vmax,
   hypsoPixels }. */
function buildHypsoFromGrid(elevGrid,W,H,lut){
  var N=W*H, vmin=Infinity, vmax=-Infinity;
  for(var i=0;i<N;i++){var v=elevGrid[i]; if(v>0.5&&v<9000){if(v<vmin)vmin=v; if(v>vmax)vmax=v;}}
  if(vmin===Infinity){vmin=0; vmax=1;}
  var NBINS=10000, hist=new Uint32Array(NBINS), vrange=vmax-vmin||1;
  for(var i=0;i<N;i++){
    var v=elevGrid[i];
    if(v>0.5&&v<9000) hist[Math.min(NBINS-1,Math.floor((v-vmin)/vrange*NBINS))]++;
  }
  var tot=0; for(var b=0;b<NBINS;b++) tot+=hist[b];
  var binToLut=new Uint8Array(NBINS), cumul=0;
  for(var b=0;b<NBINS;b++){cumul+=hist[b]; binToLut[b]=tot?Math.min(255,Math.floor(cumul/tot*256)):0;}

  var hypsoPixels=new Uint8ClampedArray(N*4);
  for(var i=0;i<N;i++){
    var v=elevGrid[i], o=i*4;
    if(v<=0.5||v>=9000){hypsoPixels[o]=20;hypsoPixels[o+1]=60;hypsoPixels[o+2]=130;hypsoPixels[o+3]=255;}
    else{var li=binToLut[Math.min(NBINS-1,Math.floor((v-vmin)/vrange*NBINS))]*3;
      hypsoPixels[o]=lut[li];hypsoPixels[o+1]=lut[li+1];hypsoPixels[o+2]=lut[li+2];hypsoPixels[o+3]=255;}
  }
  return {vmin:vmin, vmax:vmax, hypsoPixels:hypsoPixels};
}

/* ── buildContourBitmap ─────────────────────────────────────────────────
   ENTRÉE     : grille W×H, vmin, vmax
   TRAITEMENT : fond blanc (terre) / bleu (mer) ; marching squares sur
                chaque cellule terrestre, niveaux multiples du pas compris
                dans [min, max] de la cellule, intersection interpolée ;
                deux passes : mineures tous les 500 m (hors multiples de
                1000), majeures tous les 1000 m
   SORTIE     : { bitmap ImageBitmap, interval, major }
   ALGO       : « Courbes de niveau par marching squares, deux passes de
                trait (mineures, majeures). »
   ⚠ Aucune courbe sous 1000 m (BASE) et pas fixe de 500 m : sur un relief
     de plaine ou de moyenne montagne (Guyane : tout est sous 1000 m), la
     vue « courbes de niveau » reste vide.
   ─────────────────────────────────────────────────────────────────── */
function buildContourBitmap(elevGrid,W,H,vmin,vmax){
  var BASE=1000, interval=500, major=1000;

  // Table Marching Squares — 16 cas, chacun 0, 1 ou 2 segments
  var LINES=[
    [],[[0,3]],[[0,1]],[[1,3]],
    [[1,2]],[[0,3],[1,2]],[[0,2]],[[2,3]],
    [[2,3]],[[0,2]],[[0,1],[2,3]],[[1,2]],
    [[1,3]],[[0,1]],[[0,3]],[]
  ];

  /* ep — E : arête (0 haut, 1 droite, 2 bas, 3 gauche), cellule, 4 coins,
     niveau → T : interpolation linéaire du passage → S : [x, y] pixel. */
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

  /* drawPass — E : pas des niveaux, modulo à sauter, couleur, épaisseur →
     T : un seul chemin pour toutes les cellules et niveaux → S : trait. */
  function drawPass(stepLv, skipMod, color, lw){
    ctx.strokeStyle=color; ctx.lineWidth=lw;
    ctx.beginPath();
    for(var r=0;r<H-1;r++) for(var c=0;c<W-1;c++){
      var TL=elevGrid[r*W+c], TR=elevGrid[r*W+c+1];
      var BR=elevGrid[(r+1)*W+c+1], BL=elevGrid[(r+1)*W+c];
      if(TL<=0.5||TR<=0.5||BR<=0.5||BL<=0.5||TL>=9000||TR>=9000||BR>=9000||BL>=9000) continue;
      var cMin=TL,cMax=TL;
      if(TR<cMin)cMin=TR; if(TR>cMax)cMax=TR;
      if(BR<cMin)cMin=BR; if(BR>cMax)cMax=BR;
      if(BL<cMin)cMin=BL; if(BL>cMax)cMax=BL;
      // Premier niveau >= cMin, aligné sur stepLv, jamais sous BASE (1000 m)
      var first=Math.max(BASE,Math.ceil(cMin/stepLv)*stepLv);
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

/* ── Worker (onmessage) ── E : 'load' { buffer TIFF } ou 'grid' { grid, w,
   h, geo } → T : tags + contrôle + géoréférence (tiepoint = coin nord-ouest,
   étendue = taille × pas), altitudes, hypsométrie, courbes → S : 'done'
   (grille, pixels, bitmap, geo) ou 'error'.
   ⚠ Le tiepoint est pris comme coin de pixel : pour un raster « point »
     (Copernicus : AREA_OR_POINT=Point) l'emprise est décalée d'un
     demi-pixel et allongée d'un pixel. */
self.onmessage=async function(e){
  if(e.data.type==='load'){
    try{
      var buf=e.data.buffer;
      self.postMessage({type:'progress',msg:'Lecture tags TIFF\u2026'});
      var t=readTiffTags(buf);
      checkTiff(t);
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
  } else if(e.data.type==='grid'){
    try{
      var W=e.data.w, H=e.data.h, elevGrid=e.data.grid, geo=e.data.geo||null;
      var lut=makeHypsoLUT();
      self.postMessage({type:'progress',msg:'Hypsométrie (zone assemblée)\u2026'});
      var res=buildHypsoFromGrid(elevGrid,W,H,lut);
      self.postMessage({type:'progress',msg:'Marching Squares\u2026'});
      var cRes=buildContourBitmap(elevGrid,W,H,res.vmin,res.vmax);
      self.postMessage({
        type:'done',
        width:W, height:H,
        vmin:res.vmin, vmax:res.vmax, geo:geo,
        interval:cRes.interval, major:cRes.major,
        elevGrid:elevGrid, hypsoPixels:res.hypsoPixels,
        contourBitmap:cRes.bitmap
      },[elevGrid.buffer, res.hypsoPixels.buffer, cRes.bitmap]);
    }catch(err){
      self.postMessage({type:'error', msg:err.message});
    }
  }
};
`;

let tiffWorker = null;
/* ── spawnTiffWorker ── E : aucune → T : termine l'éventuel Worker en cours,
   en crée un depuis TIFF_WORKER_SRC → S : Worker. */
function spawnTiffWorker(){
  if(tiffWorker){ tiffWorker.terminate(); tiffWorker=null; }
  const blob = new Blob([TIFF_WORKER_SRC], {type:'application/javascript'});
  const url  = URL.createObjectURL(blob);
  const w    = new Worker(url);
  URL.revokeObjectURL(url);
  return w;
}

/* ── attachWorkerDoneHandler ── E : tiffWorker → T : 'progress' → barre
   d'état ; 'done' → installe grille, GEO, T0 de température, images
   hypsométrique et courbes, vue initiale, boutons, redimensionnement ;
   'error' → message → S : aucune. */
function attachWorkerDoneHandler(){
  tiffWorker.onmessage=(e)=>{
    const d=e.data;
    if(d.type==='progress'){
      document.getElementById('vstatus').textContent=d.msg;

    } else if(d.type==='done'){
      const {width:W,height:H,vmin,vmax,geo,interval,major,
             elevGrid:eg,hypsoPixels,contourBitmap}=d;

      imgW=W; imgH=H; GEO=geo; elevGrid=eg;
      if(GEO && typeof tempInit==='function') tempInit();
      vminGlobal=vmin; vmaxGlobal=vmax;
      makeHypsoLUT();

      oscHypso=new OffscreenCanvas(W,H);
      oscHypso.getContext('2d').putImageData(new ImageData(hypsoPixels,W,H),0,0);
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
      render(); tiffWorker=null;

    } else if(d.type==='error'){
      document.getElementById('vstatus').textContent='Erreur Worker : '+d.msg;
      tiffWorker=null;
    }
  };
}

/* ── prepViewerUI ── E : aucune → T : dsmReset(), masque le texte d'accueil,
   désactive les boutons dépendant de la tuile, vide les images, remet la
   simulation d'eau à zéro → S : aucune. */
function prepViewerUI(){
  if(typeof dsmReset==='function') dsmReset();
  document.getElementById('placeholder').style.display='none';
  swapBtn.disabled=true;
  document.getElementById('btn-carto').disabled=true;
  document.getElementById('btn-rec').disabled=true;
  oscHypso=null; oscContour=null; resetSim();
  if(typeof barrageEffacer==='function') barrageEffacer();
}

/* ── loadInViewer ── E : File GeoTIFF → T : prépare l'interface, titre,
   lit le fichier, lance le Worker et lui transfère le buffer → S : Promise. */
async function loadInViewer(file){
  prepViewerUI();

  document.title=`DSM — ${file.name.replace(/\.[^.]+$/,'')}`;
  document.getElementById('titre').textContent=file.name.replace(/\.[^.]+$/,'');
  document.getElementById('vstatus').textContent='Lecture fichier…';

  const buf=await file.arrayBuffer();
  document.getElementById('vstatus').textContent='Worker démarré — fil principal libre';

  tiffWorker=spawnTiffWorker();
  attachWorkerDoneHandler();

  tiffWorker.postMessage({type:'load', buffer:buf}, [buf]);
}

/* ── loadGridInViewer ── E : { grid, w, h, geo } reçu de map.html → T :
   prépare l'interface, lance le Worker en mode 'grid' → S : Promise. */
async function loadGridInViewer(d){
  prepViewerUI();

  document.title='DSM — zone sélectionnée';
  document.getElementById('titre').textContent=`Zone ${d.w}×${d.h}`;
  document.getElementById('vstatus').textContent='Grille reçue — Worker démarré';

  tiffWorker=spawnTiffWorker();
  attachWorkerDoneHandler();

  const grid=(d.grid instanceof Float32Array)?d.grid:new Float32Array(d.grid);
  tiffWorker.postMessage({type:'grid', grid:grid, w:d.w, h:d.h, geo:d.geo}, [grid.buffer]);
}
