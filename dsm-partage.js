/*
 * dsm-partage.js
 * Projet  : DSM Copernicus — lignes de partage des eaux
 * Rôle    : À partir d'un masque d'élévation 1024×1024 (Float32Array),
 *           renvoie un masque 1024×1024 (Float32Array) où 1 = crête, 0 = autre.
 *           Méthode : priority-flood depuis les 4 bords (algo original),
 *           + passe de filtrage : un pixel de frontière est supprimé si son
 *           altitude est inférieure au minimum des deux bords qu'il sépare
 *           (= il est dans une vallée, pas sur une crête).
 * Entrée  : elev  Float32Array de 1024*1024
 * Sortie  : mask  Float32Array de 1024*1024  (1.0 = crête, 0.0 = autre)
 * Dépend  : rien. HTML/JS pur, aucune librairie. 1024 en dur.
 * Auteur  : Eric Perret
 * Date    : 2026-06-14
 * Version : 5.0.0
 */

"use strict";

const DSMPARTAGE = (() => {

  const DIM = 1024;
  const N   = DIM * DIM;

  // tableaux de travail réutilisés
  const _label  = new Uint8Array(N);     // étiquette bord : 0=N 1=E 2=S 3=O, 255=non visité
  const _flood  = new Float32Array(N);   // niveau d'inondation stocké par pixel
  const _hLvl   = new Float32Array(N);   // heap : priorité
  const _hIdx   = new Int32Array(N);     // heap : indice cellule

  // altitude minimale de chaque bord (calculée à la seed)
  const _bordMin = new Float32Array(4);  // index 0=N 1=E 2=S 3=O

  function tracer(elev) {
    const label = _label, flood = _flood, lvl = _hLvl, idx = _hIdx;
    label.fill(255);
    flood.fill(0);
    let n = 0;

    // ── heap min ──
    function up(i){ while(i>0){ const p=(i-1)>>1; if(lvl[p]<=lvl[i])break;
      const a=lvl[p];lvl[p]=lvl[i];lvl[i]=a; const b=idx[p];idx[p]=idx[i];idx[i]=b; i=p; } }
    function push(level, cell){ lvl[n]=level; idx[n]=cell; up(n); n++; }
    function pop(){ const ci=idx[0]; n--;
      if(n>0){ lvl[0]=lvl[n]; idx[0]=idx[n]; let i=0;
        for(;;){ const l=2*i+1,r=l+1; let s=i;
          if(l<n&&lvl[l]<lvl[s])s=l; if(r<n&&lvl[r]<lvl[s])s=r; if(s===i)break;
          const a=lvl[s];lvl[s]=lvl[i];lvl[i]=a; const b=idx[s];idx[s]=idx[i];idx[i]=b; i=s; } }
      return ci; }

    // ── graines + calcul du min de chaque bord ──
    _bordMin.fill(Infinity);
    function seed(i, edge){
      if(label[i]!==255) return;
      label[i]=edge; flood[i]=elev[i]; push(elev[i], i);
      if(elev[i] < _bordMin[edge]) _bordMin[edge] = elev[i];
    }
    for(let x=0;x<DIM;x++){ seed(x,0); seed((DIM-1)*DIM+x,2); }   // N, S
    for(let y=0;y<DIM;y++){ seed(y*DIM,3); seed(y*DIM+DIM-1,1); } // O, E

    // ── inondation (identique à l'original) ──
    // flood[v] = niveau d'inondation = max(elev[v], niveau du parent)
    while(n>0){
      const cur = lvl[0];
      const c   = pop();
      const cy  = (c/DIM)|0, cx = c - cy*DIM;
      const lab = label[c];
      function prop(v){
        if(label[v]!==255) return;
        label[v] = lab;
        const fl = elev[v]>cur ? elev[v] : cur;
        flood[v] = fl;
        push(fl, v);
      }
      if(cy>0)      prop(c-DIM);
      if(cy<DIM-1)  prop(c+DIM);
      if(cx>0)      prop(c-1);
      if(cx<DIM-1)  prop(c+1);
    }

    // ── passe 1 : frontières brutes entre étiquettes ──
    const mask = new Float32Array(N);
    for(let y=0;y<DIM;y++) for(let x=0;x<DIM;x++){
      const i=y*DIM+x, l=label[i];
      if(x<DIM-1 && label[i+1]  !==l){ mask[i]=1; mask[i+1]=1; }
      if(y<DIM-1 && label[i+DIM]!==l){ mask[i]=1; mask[i+DIM]=1; }
    }

    // ── passe 2 : filtrage des fausses crêtes ──
    // Un pixel de frontière entre bords A et B est valide seulement si
    // son altitude réelle est >= min(bordMin[A], bordMin[B]).
    // Si elev[i] < ce seuil, le pixel est dans une vallée → on l'efface.
    for(let i=0;i<N;i++){
      if(!mask[i]) continue;
      const la = label[i];
      // chercher l'étiquette voisine différente
      const y=(i/DIM)|0, x=i-y*DIM;
      let lb = 255;
      if(x<DIM-1 && label[i+1]  !==la) lb=label[i+1];
      else if(y<DIM-1 && label[i+DIM]!==la) lb=label[i+DIM];
      else if(x>0     && label[i-1]  !==la) lb=label[i-1];
      else if(y>0     && label[i-DIM]!==la) lb=label[i-DIM];
      if(lb===255) continue;
      // seuil = minimum des altitudes de bord entre les deux versants
      const seuil = _bordMin[la] < _bordMin[lb] ? _bordMin[la] : _bordMin[lb];
      if(elev[i] < seuil) mask[i] = 0;
    }

    return mask;
  }

  // Pose le masque en noir sur un ImageData 1024×1024
  function dessiner(imageData, mask){
    const d = imageData.data;
    for(let i=0;i<N;i++){ if(mask[i]){ const p=i<<2; d[p]=0; d[p+1]=0; d[p+2]=0; d[p+3]=255; } }
    return imageData;
  }

  return { tracer, dessiner };

})();

if (typeof module !== "undefined" && module.exports) module.exports = { DSMPARTAGE };
