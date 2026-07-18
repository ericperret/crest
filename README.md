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

## Principe directeur

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

