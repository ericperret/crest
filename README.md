# DSM (Digital Surface Model) — CREST

Simulation glaciologique physiquement contrainte de la dynamique de la glace,
en JavaScript pur (navigateur + Web Workers), sans dépendance externe hormis
Leaflet (carto) et le tuilage MNT. Fonctionne sur **n'importe quel carré
Copernicus DSM de la planète** — pas seulement les Alpes, qui ne servent que
de cas de calibration (moraines datées, thèse Roattino 2022).

## Démarrer

Ouvrir **`map.html`** — c'est le point d'entrée. Charger un dossier local de
tuiles Copernicus DSM (bouton dossier, `webkitdirectory` — seuls les noms de
sous-dossiers sont lus au scan, pas leur contenu). La mappemonde affiche les
tuiles disponibles ; un clic sur une tuile verte lit son `.tif`, l'envoie par
`BroadcastChannel` à `dsm.html` (ouvert automatiquement, fenêtre réutilisée
d'un clic à l'autre) qui prend le relais pour la simulation. Aucune
installation, aucun build.

## Architecture

Maillage triangulaire adaptatif (**FILET**, `dsm-filet.js`/`dsm-mesh.js`) sur
la grille d'altitude 1024×1024 de la tuile choisie. Écoulement résolu par une
**Shallow Ice Approximation** (diffusion non linéaire, déformation de Glen +
glissement basal till linéaire) avec solveur **implicite** (Picard +
Gauss-Seidel, ensemble actif, segments adaptatifs) — `dsm-flux.js`, exécuté
en Web Worker (`dsm-worker-flux.js`).

Bilan de masse par degrés-jours positifs (PDD), température paramétrique
calibrée et **validée contre les normales climatologiques officielles
Météo-France 1991-2020** (`dsm-temp.js` + `dsm-temp_test.js`), forçage
paléoclimatique par les carottes GRIP/Vostok, précipitation orographique et
effet de foehn (`dsm-foehn.js`, validé sur le contraste Vosges/Alsace).

Convention temporelle du projet : `t_ka`, négatif = passé (LGM = −20).

## Modules

| Fichier | Rôle |
|---|---|
| `map.html` | **point d'entrée** — mappemonde, sélection de tuile Copernicus |
| `dsm.html` | fenêtre de simulation pilotée par map.html — interface, boucle |
| `dsm-flux.js` / `dsm-worker-flux.js` | écoulement SIA implicite |
| `dsm-worker-glacier.js` | bilan de masse (dépôt, PDD, tassement) |
| `dsm-temp.js` / `dsm-temp_test.js` | modèle et **validation** de température |
| `dsm-foehn.js` / `dsm-foehn_test.js` | précipitation orographique, foehn |
| `dsm-filet.js` / `dsm-mesh.js` | maillage triangulaire adaptatif |
| `dsm-fil3d.js` | visualisation 3D du maillage (fil de fer) |
| `dsm-astro.js` / `dsm-insol.js` / `dsm-ombre.js` | astronomie, insolation, ombrage |
| `dsm-init-glacier.js` / `dsm-partage.js` | initialisation, partage d'état |
| `dsm-worker-tiff.js` | chargement des tuiles MNT |

## Fondements scientifiques

Chaque brique physique du modèle est adossée à une source précise, avec son
statut clairement distingué : algorithme vérifié contre l'article, ou choix
de rhéologie assumé et documenté comme tel dans le cartouche du fichier.

**Astronomie et insolation — implémentation directe, zéro paramètre libre.**
Table orbitale **La2004** (Laskar et al. 2004, *A&A* 428:261, IMCCE/BDL,
`INSOLN.LA2004.BTL.ASC`) : excentricité, obliquité, longitude du périhélie
sur 250 ka. Conversions longitude-vraie/moyenne et position solaire :
routine `insolsub_f.f` (ASD/IMCCE, Laskar/Joutel/Gastineau), coefficients
numériques recopiés terme à terme. Réfraction atmosphérique : Bennett 1982.
Masquage topographique : horizon scanning (Franklin & Ray 1994).

**Écoulement glaciaire — SIA canonique (Hutter 1983).** Déformation : loi
de Glen, `A = 2,4×10⁻²⁴ Pa⁻³s⁻¹` glace tempérée (Cuffey & Paterson,
*The Physics of Glaciers*, 4ᵉ éd. 2010). Facteur d'accroissement `E = 3`
glace pléistocène : standard EISMINT/PISM (Paterson 1991). Glissement basal :
loi **linéaire** (Boulton & Hindmarsh 1987, till visqueux) plutôt que le
Weertman cubique classique — remplacée précisément parce que le cubique
faisait exploser le pas de temps en pente forte. Le coefficient n'est **pas**
tiré d'une table de la littérature : contrairement à A (propriété
intrinsèque de la glace, mesurable en labo), le glissement dépend de la
résistance du till et de la pression d'eau sous-glaciaire — invérifiables
a priori, variables de plusieurs ordres de grandeur d'un glacier à l'autre.
Aucune référence ne peut le donner : il se **calibre par inversion**, forme
allégée des méthodes de contrôle optimal (MacAyeal 1993) — c'est la pratique
standard du domaine, pas une faiblesse du projet. Solveur : implicite
(Picard + Gauss-Seidel), remplace un schéma explicite sous-cyclé au CFL
global qui saturait un cœur CPU.

**Précipitation orographique et foehn — implémentation vérifiée par test.**
Modèle linéaire de **Smith & Barstad 2004**, résolu par FFT2D radix-2 écrite
depuis zéro (aucune librairie). Validation : comparaison à la solution
analytique « triangle-ridge » de l'article, ordre de convergence > 1,9 —
exigence exacte de la suite de test de référence PISM (Aschwanden &
Khrulev). Thermodynamique : gradient adiabatique humide (Rogers & Yau),
pression de vapeur saturante (formule de Magnus, norme OMM). Points assumés,
documentés en l'état : le rapport Θm/γ reprend la valeur numérique de
l'implémentation PISM plutôt qu'une reconstruction vérifiée depuis
l'article ; le point de rosée de surface est un provisoire calibré sur le
contraste Vosges/Alsace.

**Bilan de masse — méthode standard, calibration mesurée.** Modèle
degré-jour positif (PDD), méthode empirique de référence (Hock 2003 pour la
plage canonique des facteurs degré-jour). La chaîne de température va plus
loin que la littérature générique : **validée directement contre les fiches
climatologiques officielles Météo-France 1991-2020** (stations Chambéry-Aix
et Bourg-Saint-Maurice — `dsm-temp_test.js`), avec correction de référence
préindustrielle (la calibration moderne ne réchauffe pas le paléo) et
nébulosité mensuelle mesurée sur l'amplitude diurne.

**Paléoclimat.** Anomalies calées sur les profils isotopiques des forages
**GRIP** (Groenland, 70°N) et **Vostok** (Antarctique, 78°S) — Bølling-Allerød
et rechute du Dryas récent identifiés dans la courbe. Reconstruction
inspirée des profils canoniques de ces forages, non tracée numériquement
depuis une publication unique — point à sourcer plus précisément si besoin
(Dansgaard et al. 1993 pour GRIP, Petit et al. 1999 pour Vostok).

## Méthode de calibration

Le cas d'étude alpin (LGM, thèse Roattino 2022) fournit des positions de
front **datées** : 24-21 ka (domaine morainique intermédiaire), 19 ka
(domaine est), Culoz ~16,5 ka, quatre positions de retrait du glacier de
l'Arc entre 16,7-14,6 et 12,5 ka. Ce sont des couples **(position, date)**,
pas des vitesses de glace mesurées — distinction qui compte :

> vitesse du front = vitesse de la glace − ablation locale / pente

Un front qui recule ne signifie pas que la glace ralentit : l'ablation peut
manger le flux plus vite qu'il n'arrive (phénomène documenté à l'extrême
dans les surges glaciaires, Meier & Post 1969, où vitesse de front et
vitesse de glace se découplent complètement). Extraire un coefficient de
glissement d'une vitesse de front confondrait donc deux grandeurs
physiquement distinctes — et il manque de toute façon l'épaisseur de glace
à ces points et dates pour calculer la contrainte de cisaillement
nécessaire à une inversion algébrique directe.

La méthode retenue est la comparaison directe, forme allégée de l'inversion
de contrôle optimal (MacAyeal 1993) : faire tourner la simulation, relever
où et quand le front simulé passe par ces mêmes points, ajuster le
coefficient de glissement (et le forçage climatique — les deux jouent)
jusqu'à ce que position ET date coïncident avec les cinq cibles. Le modèle
calcule lui-même son épaisseur et sa pente en interne à chaque instant ; le
couple (position, date) sert de fonction d'erreur, sans qu'aucune formule
fermée ne soit nécessaire.



Toute constante à contenu physique est sourcée ou mesurée — jamais posée
« à la vraisemblance ». Quand le modèle diverge de l'attendu, le réflexe est
de chercher la constante fausse ou la structure incohérente, pas d'ajouter un
paramètre de contournement. Voir les cartouches de chaque fichier pour
l'historique des corrections et leurs justifications.

## État au 2026-07-18

Écoulement SIA implicite validé (conservation, précision vs référence
explicite). Température validée contre stations Météo-France (Chambéry-Aix,
Bourg-Saint-Maurice, fiches 1991-2020) avec correction de référence
préindustrielle et nébulosité mensuelle mesurée. Calibration en cours contre
les fronts morainiques datés (thèse Roattino 2022) sur le cas d'étude alpin.

