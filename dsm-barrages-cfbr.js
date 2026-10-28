/* ═══════════════════════════════════════════════════════════════════
   FICHIER : dsm-barrages-cfbr.js - v27/09/2026
   OBJET   : grands barrages français (retenue ≥ 0,1 km³) pour la
             simulation de rupture ; prioritaires sur BARRAGES_GDW ;
             plus Malpasset (0,055 km³, détruit en 1959) comme cas
             d'essai de référence.
   AUTEUR  : Eric P.
   RELECTURE : Opus 5.5
   LICENCE : CC BY-NC 4.0 — source à citer : https://github.com/ericperret/crest/
             usage commercial interdit sauf accord écrit de l'auteur (voir LICENSE)
             Données : Comité français des barrages et réservoirs (CFBR).
   EXPOSE  : BARRAGES_CFBR
   CONVENTIONS : une ligne = [lat °, lon °, hauteur sur terrain naturel m,
             volume km³, hauteur sur fondation m (0 = non renseignée),
             « nom (territoire, rivière) », 1 si ouvrage détruit (absent du
             MNT : pied de rupture au point de la fiche, sans recherche de
             parement ; champ facultatif), points d'essai [[nom, lat °,
             lon °, temps d'arrivée observé s], …] (champ facultatif)]
   ═══════════════════════════════════════════════════════════════════ */
"use strict";
const BARRAGES_CFBR = [
[5.06194,-53.04860,37,3.500,51,"Petit-Saut (Guyane, Sinnamary)"],
[44.47167,6.27053,123.5,1.272,129.5,"Serre-Ponçon (Hautes-Alpes / Alpes-de-Haute-Provence, Durance)"],
[43.73680,6.13419,85,0.767,0,"Sainte-Croix (Alpes-de-Haute-Provence / Var, Verdon)"],
[46.39729,5.66573,103,0.5924,0,"Vouglans (Jura, Ain)"],
[45.41310,2.49739,119,0.477,0,"Bort-les-Orgues (Cantal / Corrèze, Dordogne)"],
[48.55780,4.74778,20,0.350,21,"Marne-Giffaumont (Marne / Haute-Marne, Marne)"],
[45.22556,6.95333,95,0.320,0,"Mont-Cenis (Savoie, Cenise)"],
[-22.15164,166.88078,54,0.315,0,"Yaté (Nouvelle-Calédonie, Yaté)"],
[44.96117,5.68882,135,0.309,0,"Monteynard (Isère, Drac)"],
[44.82944,2.74047,105,0.296,0,"Sarrans (Aveyron, Truyère)"],
[44.92206,3.07510,79,0.2706,0,"Grandval (Cantal, Truyère)"],
[45.49487,6.93231,160,0.230,180,"Tignes (Savoie, Isère)"],
[45.24361,2.22472,84,0.220,0,"L'Aigle (Cantal / Corrèze, Dordogne)"],
[48.24944,4.30806,25,0.2078,0,"Seine-Morge (Aube, Morge)"],
[44.74785,3.82521,50,0.190,0,"Naussac (Lozère, Donozau / Allier)"],
[45.15190,2.01000,79,0.187,0,"Chastang (Corrèze, Dordogne)"],
[45.68421,6.61982,150,0.185,0,"Roselend (Savoie, Doron de Roselend)"],
/* cas d'essai : ouvrage détruit le 2/12/1959 ; retenue à la cote 100 m à la
   rupture ; volume du benchmark CADAM ; validation par les coupures des
   transformateurs EDF A, B, C (100, 1240, 1420 s ; BASEMENT v3, table 5,
   repère local ramené en WGS84 : origine au milieu de la ligne de barrage
   (4678 ; 4268), rotation 5° calée sur le lit du Reyran, ±200 m ; horloge EDF : A 21 h 13, entrée de
   Fréjus 21 h 34, parc HT nord de Fréjus ≈ 21 h 35) */
[43.51208,6.75650,60,0.055,66.5,"Malpasset (Var, Reyran) — détruit 1959, cas d'essai",1,
 [["A",43.50416,6.75719,100],["B",43.44814,6.73615,1240],["C",43.43871,6.72817,1420]]]
];
