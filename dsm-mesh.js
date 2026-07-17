/*
 * dsm-mesh.js
 * Projet  : DSM Copernicus — maillage triangulaire du terrain
 * Rôle    : À partir de elevGrid (Float32Array 1024×1024) et du masque
 *           partage (Float32Array 1024×1024), construit une matrice de triangles
 *           couvrant le terrain, puis fusionne les patches coplanaires.
 *
 *           Principe :
 *           — Chaque carré de 4 pixels donne 2 triangles. La diagonale est
 *             choisie pour minimiser l'angle dièdre (surface lisse), sauf près
 *             des crêtes où elle suit la ligne de partage.
 *           — Fusion union-find : triangles voisins dont cos_dièdre > COS_SEUIL
 *             sont regroupés en un même patch (même normale moyenne).
 *
 *           Sortie : objet MESH {
 *             verts    : Float32Array [x,y,z ...]   N sommets × 3
 *             tris     : Int32Array   [a,b,c ...]   T triangles × 3
 *             normals  : Float32Array [nx,ny,nz ...] T normales × 3
 *             neighbors: Int32Array   [t0,t1,t2 ...] T × 3 voisins (-1=bord)
 *             ridge    : Uint8Array   [0|1 ...]      T  (1=triangle sur crête)
 *             patch    : Int32Array   [pid ...]      T  (id patch fusionné)
 *             nV, nT, nP (nb sommets, triangles, patches)
 *           }
 *
 * Entrée  : elev     Float32Array 1024×1024
 *           partage  Float32Array 1024×1024  (1=crête, null=ignorer)
 *           scaleXY  mètres/pixel (défaut 10)
 *           scaleZ   facteur vertical (défaut 1)
 * Dépend  : rien. HTML/JS pur, aucune librairie.
 * Auteur  : Eric Perret
 * Date    : 2026-06-14
 * Version : 1.1.0
 */

"use strict";

const DSMMESH = (() => {

  const DIM      = 1024;
  const COS_SEUIL = 0.9998;  // ~2° seuil de coplanarité

  // ── Normale unitaire d'un triangle ──────────────────────────────
  function normale(verts, a, b, c, out, off) {
    var ax = verts[b*3]  -verts[a*3],   ay = verts[b*3+1]-verts[a*3+1], az = verts[b*3+2]-verts[a*3+2];
    var bx = verts[c*3]  -verts[a*3],   by = verts[c*3+1]-verts[a*3+1], bz = verts[c*3+2]-verts[a*3+2];
    var nx = ay*bz-az*by, ny = az*bx-ax*bz, nz = ax*by-ay*bx;
    var l  = Math.sqrt(nx*nx+ny*ny+nz*nz)||1;
    out[off]=nx/l; out[off+1]=ny/l; out[off+2]=nz/l;
  }

  // ── Union-Find path-compressed ──────────────────────────────────
  function ufFind(parent, i) {
    while (parent[i] !== i) { parent[i]=parent[parent[i]]; i=parent[i]; }
    return i;
  }
  function ufUnion(parent, rank, a, b) {
    a=ufFind(parent,a); b=ufFind(parent,b); if(a===b) return;
    if(rank[a]<rank[b]){ var t=a;a=b;b=t; }
    parent[b]=a; if(rank[a]===rank[b]) rank[a]++;
  }

  // ── Choisir diagonale au moindre dièdre ─────────────────────────
  function _choisirDiag(verts, tmp, A, B, C, D2) {
    normale(verts,A,B,C,  tmp,0); normale(verts,B,D2,C, tmp,3);
    var cos0=tmp[0]*tmp[3]+tmp[1]*tmp[4]+tmp[2]*tmp[5];
    normale(verts,A,B,D2, tmp,0); normale(verts,A,D2,C, tmp,3);
    var cos1=tmp[0]*tmp[3]+tmp[1]*tmp[4]+tmp[2]*tmp[5];
    return cos1>cos0 ? 1 : 0;
  }

  // ── construire ──────────────────────────────────────────────────
  function construire(elev, partage, scaleXY, scaleZ) {
    scaleXY = scaleXY||10; scaleZ = scaleZ||1;
    var D=DIM, nV=D*D;

    // 1. Sommets
    var verts = new Float32Array(nV*3);
    for(var y=0;y<D;y++) for(var x=0;x<D;x++){
      var i=y*D+x; verts[i*3]=x*scaleXY; verts[i*3+1]=y*scaleXY; verts[i*3+2]=elev[i]*scaleZ;
    }

    // 2. Triangles
    var nMax   = (D-1)*(D-1)*2;
    var tris    = new Int32Array(nMax*3);
    var normals = new Float32Array(nMax*3);
    var ridge   = new Uint8Array(nMax);
    var nT=0, tmp=new Float32Array(6);

    for(var cy=0;cy<D-1;cy++) for(var cx=0;cx<D-1;cx++){
      var A=cy*D+cx, B=cy*D+cx+1, C=(cy+1)*D+cx, D2=(cy+1)*D+cx+1;
      var surCrete = partage && (partage[A]||partage[B]||partage[C]||partage[D2]);
      var diag;
      if(surCrete){
        var bcC=partage[B]&&partage[C], adC=partage[A]&&partage[D2];
        if(bcC&&!adC) diag=0; else if(adC&&!bcC) diag=1;
        else diag=_choisirDiag(verts,tmp,A,B,C,D2);
      } else {
        diag=_choisirDiag(verts,tmp,A,B,C,D2);
      }
      var t0,t1,t2,t3,t4,t5;
      if(diag===0){ t0=A;t1=B;t2=C; t3=B;t4=D2;t5=C; }
      else        { t0=A;t1=B;t2=D2; t3=A;t4=D2;t5=C; }
      var oc=surCrete?1:0;
      tris[nT*3]=t0;tris[nT*3+1]=t1;tris[nT*3+2]=t2; normale(verts,t0,t1,t2,normals,nT*3); ridge[nT]=oc; nT++;
      tris[nT*3]=t3;tris[nT*3+1]=t4;tris[nT*3+2]=t5; normale(verts,t3,t4,t5,normals,nT*3); ridge[nT]=oc; nT++;
    }

    // 3. Voisins
    var neighbors = new Int32Array(nT*3).fill(-1);
    var edgeMap   = new Map();
    for(var t=0;t<nT;t++){
      var va=tris[t*3],vb=tris[t*3+1],vc=tris[t*3+2];
      var ed=[[Math.min(va,vb),Math.max(va,vb),0],[Math.min(vb,vc),Math.max(vb,vc),1],[Math.min(va,vc),Math.max(va,vc),2]];
      for(var e=0;e<3;e++){
        var key=ed[e][0]+'_'+ed[e][1], slot=ed[e][2];
        if(edgeMap.has(key)){
          var oth=edgeMap.get(key);
          neighbors[t*3+slot]=oth[0]; neighbors[oth[0]*3+oth[1]]=t; edgeMap.delete(key);
        } else edgeMap.set(key,[t,slot]);
      }
    }

    // 4. Fusion union-find : voisins coplanaires → même patch
    var parent=new Int32Array(nT), rank=new Uint8Array(nT);
    for(var i=0;i<nT;i++) parent[i]=i;
    for(var t=0;t<nT;t++){
      var o0=t*3;
      for(var s=0;s<3;s++){
        var nb=neighbors[o0+s]; if(nb<0) continue;
        var o1=nb*3;
        var cos=normals[o0]*normals[o1]+normals[o0+1]*normals[o1+1]+normals[o0+2]*normals[o1+2];
        if(cos>=COS_SEUIL) ufUnion(parent,rank,t,nb);
      }
    }

    // Normaliser les ids de patch (0..nP-1)
    var patch  = new Int32Array(nT);
    var remap  = new Int32Array(nT).fill(-1);
    var nP=0;
    for(var t=0;t<nT;t++){
      var root=ufFind(parent,t);
      if(remap[root]<0) remap[root]=nP++;
      patch[t]=remap[root];
    }

    return {
      verts   : verts.slice(0,nV*3),
      tris    : tris.slice(0,nT*3),
      normals : normals.slice(0,nT*3),
      neighbors,
      ridge   : ridge.slice(0,nT),
      patch,
      nV, nT, nP
    };
  }

  // ── Stats ────────────────────────────────────────────────────────
  function stats(mesh) {
    var nRidge=0;
    for(var i=0;i<mesh.nT;i++) if(mesh.ridge[i]) nRidge++;
    var taux = ((1 - mesh.nP/mesh.nT)*100).toFixed(1);
    return { sommets:mesh.nV, triangles:mesh.nT, patches:mesh.nP, surCrete:nRidge, fusion:taux+'%' };
  }

  return { construire, stats };

})();

if(typeof module!=="undefined"&&module.exports) module.exports={DSMMESH};
