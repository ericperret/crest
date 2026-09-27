/* ═══════════════════════════════════════════════════════════════════
   FICHIER : dsm-partage.js - v27/09/2026
   OBJET   : lignes de partage des eaux entre les quatre bords de la
             grille 1024² (bassins N, E, S, O) par inondation prioritaire
             (priority-flood) ; niveaux de remplissage et étiquettes
             de bassin.
   AUTEUR  : Eric P.
   RELECTURE : Opus 5.5
   DÉPEND  : aucun (grille d'altitude 1024² fournie par l'appelant)
   EXPOSE  : DSMPARTAGE { tracer, dessiner, drainage, bassins, invalider }
   CONVENTIONS
     - étiquettes de bord : 0 nord, 1 est, 2 sud, 3 ouest, 255 non atteint
     - calcul mémoïsé sur l'identité du tableau d'altitude
   ═══════════════════════════════════════════════════════════════════ */

"use strict";

/* ── DSMPARTAGE (module) ────────────────────────────────────────────
   ENTRÉE     : aucune (fermeture)
   TRAITEMENT : alloue les tampons 1024² partagés (étiquettes, niveaux,
                tas binaire) et définit les fonctions du module
   SORTIE     : objet { tracer, dessiner, drainage, bassins, invalider }
   ALGO       : « Module d'inondation prioritaire depuis les quatre bords
                d'une grille carrée 1024², résultats mémoïsés. »
   ─────────────────────────────────────────────────────────────────── */
const DSMPARTAGE = (() => {

  const DIM = 1024;
  const N   = DIM * DIM;

  const _label  = new Uint8Array(N);
  const _flood  = new Float32Array(N);
  const _hLvl   = new Float32Array(N);
  const _hIdx   = new Int32Array(N);

  const _bordMin = new Float32Array(4);

  /* Mémoïsation : `tracer`, `drainage` et `bassins` appelaient chacun
     _inonder, soit trois inondations de 1 048 576 cellules pour la même
     grille. On retient la dernière source traitée ; `invalider()` force
     le recalcul si le tableau est modifié en place.                   */
  let _srcElev = null;

  /* ── invalider ── E : aucune → T : oublie la grille mémorisée → S : aucune
     ALGO : « Force le recalcul au prochain appel (grille modifiée en place). » */
  function invalider() { _srcElev = null; }

  /* ── _inonder ───────────────────────────────────────────────────────
     ENTRÉE     : elev Float32Array 1024² (m)
     TRAITEMENT : si elev est la grille mémorisée, rien. Sinon, sème les
                  pixels des quatre bords (étiquette = bord, niveau =
                  altitude) dans un tas min ; dépile le plus bas, propage à
                  ses 4 voisins non visités avec niveau = max(altitude,
                  niveau courant) et la même étiquette ; note l'altitude
                  minimale de chaque bord (_bordMin)
     SORTIE     : _label (bord de rattachement), _flood (niveau de
                  remplissage), _bordMin — tampons internes
     ALGO       : « Priority-flood (Barnes 2014) 4-connexe depuis les bords :
                  chaque pixel reçoit le bord par lequel il se vide et son
                  niveau de remplissage de cuvette. »
     ─────────────────────────────────────────────────────────────────── */
  function _inonder(elev) {
    if (elev === _srcElev) return;
    _srcElev = elev;
    const label = _label, flood = _flood, lvl = _hLvl, idx = _hIdx;
    label.fill(255);
    flood.fill(0);
    let n = 0;

    /* up / push / pop : tas binaire min sur (lvl, idx) — E : niveau, cellule →
       T : remontée / descente classiques → S : cellule de plus bas niveau. */
    function up(i){ while(i>0){ const p=(i-1)>>1; if(lvl[p]<=lvl[i])break;
      const a=lvl[p];lvl[p]=lvl[i];lvl[i]=a; const b=idx[p];idx[p]=idx[i];idx[i]=b; i=p; } }
    function push(level, cell){ lvl[n]=level; idx[n]=cell; up(n); n++; }
    function pop(){ const ci=idx[0]; n--;
      if(n>0){ lvl[0]=lvl[n]; idx[0]=idx[n]; let i=0;
        for(;;){ const l=2*i+1,r=l+1; let s=i;
          if(l<n&&lvl[l]<lvl[s])s=l; if(r<n&&lvl[r]<lvl[s])s=r; if(s===i)break;
          const a=lvl[s];lvl[s]=lvl[i];lvl[i]=a; const b=idx[s];idx[s]=idx[i];idx[i]=b; i=s; } }
      return ci; }

    _bordMin.fill(Infinity);
    /* seed — E : pixel de bord, n° de bord → T : étiquette, niveau = altitude,
       empile, met à jour _bordMin → S : aucune. */
    function seed(i, edge){
      if(label[i]!==255) return;
      label[i]=edge; flood[i]=elev[i]; push(elev[i], i);
      if(elev[i] < _bordMin[edge]) _bordMin[edge] = elev[i];
    }
    for(let x=0;x<DIM;x++){ seed(x,0); seed((DIM-1)*DIM+x,2); }
    for(let y=0;y<DIM;y++){ seed(y*DIM,3); seed(y*DIM+DIM-1,1); }

    while(n>0){
      const cur = lvl[0];
      const c   = pop();
      const cy  = (c/DIM)|0, cx = c - cy*DIM;
      const lab = label[c];
      /* prop — E : voisin v → T : si non visité, hérite de l'étiquette, niveau =
         max(altitude de v, niveau dépilé), empile → S : aucune. */
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
  }

  /* ── drainage ── E : elev 1024² → T : _inonder → S : copie des niveaux de
     remplissage (m). ALGO : « Altitude après comblement des cuvettes. » */
  function drainage(elev) {
    _inonder(elev);
    return Float32Array.from(_flood);
  }

  /* ── bassins ── E : elev 1024² → T : _inonder → S : copie des étiquettes de
     bord (Uint8). ALGO : « Bord (N/E/S/O) vers lequel s'écoule chaque pixel. » */
  function bassins(elev) {
    _inonder(elev);
    return Uint8Array.from(_label);
  }

  /* ── tracer ─────────────────────────────────────────────────────────
     ENTRÉE     : elev Float32Array 1024²
     TRAITEMENT : _inonder ; marque les deux pixels de toute paire
                  horizontale ou verticale d'étiquettes différentes ; retire
                  ceux dont l'altitude est sous le plus bas des minima de
                  bord des deux bassins concernés
     SORTIE     : masque Float32Array 1024² (1 = ligne de partage)
     ALGO       : « Frontières entre bassins de bords différents, sans les
                  segments plus bas que l'exutoire le plus bas des deux. »
     ⚠ Le seuil « altitude < min(_bordMin) des deux bassins » est une
       heuristique non justifiée : _bordMin est l'altitude minimale du bord
       entier, pas celle de l'exutoire ; le critère supprime surtout la
       mer et les plaines basses. Masque binaire stocké en Float32 (4 octets
       par pixel au lieu d'1).
     ─────────────────────────────────────────────────────────────────── */
  function tracer(elev) {
    const label = _label, flood = _flood;
    _inonder(elev);

    const mask = new Float32Array(N);
    for(let y=0;y<DIM;y++) for(let x=0;x<DIM;x++){
      const i=y*DIM+x, l=label[i];
      if(x<DIM-1 && label[i+1]  !==l){ mask[i]=1; mask[i+1]=1; }
      if(y<DIM-1 && label[i+DIM]!==l){ mask[i]=1; mask[i+DIM]=1; }
    }

    for(let i=0;i<N;i++){
      if(!mask[i]) continue;
      const la = label[i];
      const y=(i/DIM)|0, x=i-y*DIM;
      let lb = 255;
      if(x<DIM-1 && label[i+1]  !==la) lb=label[i+1];
      else if(y<DIM-1 && label[i+DIM]!==la) lb=label[i+DIM];
      else if(x>0     && label[i-1]  !==la) lb=label[i-1];
      else if(y>0     && label[i-DIM]!==la) lb=label[i-DIM];
      if(lb===255) continue;
      const seuil = _bordMin[la] < _bordMin[lb] ? _bordMin[la] : _bordMin[lb];
      if(elev[i] < seuil) mask[i] = 0;
    }

    return mask;
  }

  /* ── dessiner ── E : ImageData 1024², masque → T : pixel noir opaque où
     masque ≠ 0 → S : la même ImageData. ALGO : « Trace le masque en noir. » */
  function dessiner(imageData, mask){
    const d = imageData.data;
    for(let i=0;i<N;i++){ if(mask[i]){ const p=i<<2; d[p]=0; d[p+1]=0; d[p+2]=0; d[p+3]=255; } }
    return imageData;
  }

  return { tracer, dessiner, drainage, bassins, invalider };

})();

if (typeof module !== "undefined" && module.exports) module.exports = { DSMPARTAGE };
