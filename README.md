<!-- ═══════════════════════════════════════════════════════════════════
     FICHIER : README.md - v27/09/2026
     OBJET   : présentation du projet pour GitHub
     AUTEUR  : Eric P.
     RELECTURE : Opus 5.5
     LICENCE : CC BY-NC 4.0 — source à citer : https://github.com/ericperret/crest/
               usage commercial interdit sauf accord écrit de l'auteur (voir LICENSE)
     ═══════════════════════════════════════════════════════════════════ -->

# crest — relief, ombres et paléoglaciers dans le navigateur

Dépôt : <https://github.com/ericperret/crest/>

Visualiseur de modèle numérique de terrain (Copernicus GLO-30) et simulateur
de glacier sur le dernier cycle climatique (−30 000 ans → aujourd'hui).

HTML, CSS et JavaScript uniquement : **aucune librairie, aucun serveur,
aucune installation**. On ouvre `map.html` dans un navigateur récent, c'est
tout. Les seuls accès réseau sont les fonds de carte (tuiles Esri et Carto).

---

## Ce que fait l'outil

**Carte des tuiles (`map.html`)**
- Grille mondiale des tuiles Copernicus 1°×1° ; les tuiles présentes dans
  le dossier local apparaissent en vert.
- Commande AWS S3 prête à copier pour télécharger les tuiles manquantes.
- Clic sur une tuile : ouverture dans le visualiseur.
- Sélection d'une zone rectangulaire à cheval sur plusieurs tuiles :
  mosaïque assemblée, rendue carrée, envoyée au visualiseur.

**Visualiseur (`dsm.html`)**

| Bouton | Fonction |
|---|---|
| ⇄ Courbes de niveau | Hypsométrie égalisée ou courbes de niveau |
| 🌑 Ombre | Horizons sur 64 azimuts, ombres portées heure par heure |
| ☀️ Insol | Insolation directe annuelle, horizon et orbite de l'époque compris |
| 🌡 Temp | Température moyenne annuelle (anomalie paléo + gradient) |
| ⛰ Partage | Lignes de partage des eaux entre les quatre bords |
| 🕸 Fil / 🗻 3D | Filet adaptatif de facettes, vue 3D en fil de fer |
| ❄️ Glacier | Simulation glaciaire complète (voir plus bas) |
| ➡ Flux | Flèches d'écoulement de la glace |
| 🗺 Carto | Étiquettes géographiques superposées |
| 🎬 Vidéo 365j | Film AVI des ombres au lever, un jour par image |
| ⏺ REC | Enregistrement WebM de l'écran |

Panneau de contrôle : **année** (−20 000 à 2100), **jour**, **heure
solaire**. Clavier : ↑↓ choisit le curseur, ←→ modifie la valeur.

Témoins d'état, courbe d'anomalie de température de l'époque, profileur
intégré et légende cartographique du glacier (glace, névé, fronts).

---

## Démarrage

1. Télécharger une ou plusieurs tuiles Copernicus GLO-30. La commande est
   donnée par `map.html` (bouton ☁️ ou clic sur une tuile absente), par
   exemple :
   ```
   aws s3 sync s3://copernicus-dem-30m/Copernicus_DSM_COG_10_N45_00_E006_00_DEM/ \
       ./Copernicus_DSM_COG_10_N45_00_E006_00_DEM/ \
       --no-sign-request --exclude "*" --include "*_DEM.tif"
   ```
   Aucun compte AWS n'est nécessaire (données publiques).
2. Ouvrir `map.html`, bouton **📂 Ouvrir copernicus/**, choisir le dossier.
3. Cliquer une tuile verte, ou **🔲 Sélection zone** puis **✔ Charger la
   zone**. Le visualiseur s'ouvre dans un nouvel onglet (autoriser les
   fenêtres surgissantes pour ce fichier).
4. Dans `dsm.html` : **🌑 Ombre** d'abord (calcule les horizons, requis par
   Insol, Temp et Glacier), puis les autres fonctions.

Navigateur : Chrome, Edge ou Firefox récents (Workers, OffscreenCanvas,
DecompressionStream, BroadcastChannel).

---

## La simulation glaciaire

Au démarrage : 10 ans figés à −30 ka, puis un pas de 5 jours jusqu'en 2026
(1 an simulé = 1/1000 ka de forçage).

| Étape | Module | Modèle |
|---|---|---|
| Orbite | `dsm-astro.js` | Laskar 2004, équation du centre de Berger 1978 |
| Température | `dsm-temp.js` | Anomalie de forage nord/sud pondérée en latitude, 6,5 °C/km, cycle saisonnier et diurne |
| Précipitation, foehn | `dsm-foehn.js` | Smith & Barstad 2004 par tranches d'altitude (FFT), foehn thermodynamique |
| Ensoleillement | `dsm-insol.js` | Rayonnement direct, horizons, 73 cartes par an |
| Maillage | `dsm-filet.js` | Quadtree adaptatif, facettes à cône de normales borné |
| Bilan de masse | `dsm-worker-glacier.js` | Degrés-heures en forme fermée, neige → glace par tassement |
| Glissement basal | `dsm-basal.js` | Température du lit, régimes gelé / tempéré / surge |
| Écoulement | `dsm-flux.js` | SIA implicite (Glen n = 3), Picard, gradient conjugué préconditionné |
| Parallélisme | `dsm-worker-flux.js` | Un Worker par bassin versant (4 bassins indépendants) |

Chien de garde : si une étape dépasse 15 s, la barre d'état et la console
indiquent l'étape, le pas et l'état du solveur.

---

## Clic droit : robinet, lave, rupture de barrage

Le clic droit ouvre un menu.

- **Robinet** : remplissage doux depuis le point cliqué (bassins
  successifs, seul le bassin le plus aval monte), jusqu'à la mer, au bord
  de la carte ou à une cuvette fermée. Sert aussi de trajectoire de
  référence à la rupture de barrage.
- **Lave** : à venir.
- **Rupture de barrage** : propose les barrages connus à moins de 30 km
  (CFBR en priorité, puis Global Dam Watch, puis FAO AQUASTAT), ou la saisie
  du volume (km³) et de la hauteur d'eau (m) au point cliqué. Cas le pire :
  retenue pleine, rupture instantanée et totale, sol nu, lit aval sec.

| Étape | Modèle |
|---|---|
| Trajectoire | Chemin du robinet depuis l'ouvrage |
| Ouvrage | Parement aval repéré dans le DSM (pente > 1/5, USBR 1987), pied = cote de fondation, retenue pleine = pied + hauteur |
| Retenue | Bief prismatique de volume V, hauteur h0, largeur = longueur de digue |
| Onde | Saint-Venant 1D, schéma de Stelling & Duinmeijer (2003), validé sur la solution de Ritter (1892) |
| Frottement | Manning, n de Cowan (1956) : terre nue 0,020 × sinuosité |
| Virages | Surélévation C·v²·B/(g·Rc) (USACE EM 1110-2-1601), plafonnée à v²/2g |
| Emprise | Sections en travers du DSM (Voronoï + seuils de connexion), date d'arrivée par pixel (lame ≥ 10 cm) |
| Isochrones | Pas de 1 min, allongé (2, 5, 10… 120 min) dès que deux fronts successifs sont à moins de 10 pixels ; le changement de pas est noté sur la courbe |

Survol : temps d'arrivée de l'onde en minutes. Espace : efface.

---

## Fichiers

```
map.html               carte des tuiles, assemblage de zones
dsm.html               visualiseur et boucle glaciaire
dsm-carte.js           carte tuilée Web Mercator native (remplace Leaflet)
dsm-worker-tiff.js     lecture GeoTIFF (Worker), hypsométrie, courbes
dsm-astro.js           orbite paléo, lever/coucher, position du Soleil
dsm-ombre.js           horizons, ombres, film des ombres
dsm-insol.js           insolation directe (pool de Workers)
dsm-temp.js            climat de surface
dsm-partage.js         lignes de partage des eaux (priority-flood)
dsm-mesh.js            maillage régulier et facettes (statistiques)
dsm-filet.js           filet adaptatif du glacier
dsm-fil3d.js           vue 3D du filet
dsm-foehn.js           précipitation orographique et foehn
dsm-worker-glacier.js  bilan de masse (pool de Workers)
dsm-basal.js           glissement basal
dsm-flux.js            écoulement de la glace
dsm-worker-flux.js     écoulement parallèle par bassin
dsm-barrage.js         menu du clic droit, choix du barrage, dessin
dsm-worker-barrage.js  onde de rupture (Worker), isochrones
dsm-barrages-cfbr.js   grands barrages français (CFBR)
dsm-barrages-gdw.js    barrages mondiaux (Global Dam Watch v1.0)
dsm-barrages-fao.js    barrages mondiaux complémentaires (FAO AQUASTAT)
```

Tous les fichiers sont à placer dans le même dossier. Chaque source porte
un cartouche et chaque fonction un commentaire entrée → traitement → sortie
avec une ligne « ALGO ».

---

## Limites connues

- Simulation « robinet » (clic droit) : écoulement mono-direction (D8), une
  seule sortie par seuil ; passage sous obstacle si la surface dépasse le sol
  à 2 px (ponts, embâcles… mais aussi arêtes minces).
- Rupture de barrage : onde 1D le long d'une seule trajectoire, projetée
  latéralement ; un plan d'eau du DSM est traité comme du sol (pas de
  bathymétrie) ; la retenue réelle est remplacée par un bief prismatique de
  même volume et même hauteur (vidange plus rapide, cas le pire) ; le front
  numérique sur lit sec retarde d'environ 10 % sur Ritter à la première
  minute.
- La glace ne franchit pas les lignes de partage (bassins indépendants).
- Rayonnement direct seul, sans diffus ni réfléchi.
- Pas de courbes de niveau sous 1000 m.
- Glissement basal et « postier » de l'écoulement : hypothèses propres au
  projet, non calibrées.
- Les passages douteux sont signalés « ⚠ » dans les commentaires du code.

---

## Fonds de carte et clé Carto

Les étiquettes utilisent Carto avec une clé `CARTO_KEY` déclarée dans
`dsm.html` et `map.html`. Clé vide : bascule automatique sur les étiquettes
Esri. Clé gratuite : <https://carto.com/basemaps/>.

## Données et attributions

- Copernicus DEM GLO-30 : © DLR e.V. 2010-2014 et © Airbus Defence and
  Space GmbH 2014-2018, fourni dans le cadre de COPERNICUS par l'Union
  européenne et l'ESA.
- Imagerie : © Esri, Maxar. Étiquettes : © CARTO, © OpenStreetMap.
- Barrages mondiaux : Global Dam Watch v1.0, © Union européenne 1995-2026,
  CC BY 4.0 — Lehner B. et al. (2024), Scientific Data 11:1069 ; extraction
  des seuls ouvrages de hauteur et de volume connus.
- Grands barrages français : Comité français des barrages et réservoirs
  (CFBR).
- Barrages complémentaires : FAO. 2021. AQUASTAT : Geo-referenced Database
  on Dams. Consulté le 27 septembre 2026.
  <https://www.fao.org/aquastat/en/databases/dams> licence CC-BY-4.0 ;
  fusion des fichiers régionaux, ouvrages de hauteur et de volume connus.

## Licence

[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/deed.fr) —
utilisation non commerciale libre à condition de citer la source :

> crest — Eric P. — <https://github.com/ericperret/crest/>

Utilisation commerciale interdite sauf accord écrit de l'auteur.
Détails dans [`LICENSE`](LICENSE).

## Auteur

Eric P. — relecture : Opus 5.5.
