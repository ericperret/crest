/* ═══════════════════════════════════════════════════════════════════
   FICHIER : dsm-laves.js - v27/09/2026
   OBJET   : éruptions effusives connues proposées au clic droit « Lave »
             (débit, volume, température, composition du bain fondu,
             explication pour guider le choix) ; viscosité du bain fondu
             par le modèle GRD ; paramètres transmis au calcul de coulée
             (dsm-worker-barrage.js, calculLave) ; lecture d'une saisie
             WGS84 « 37.750° N, 15.005° E ».
   AUTEUR  : Eric P.
   RELECTURE : Opus 5.5
   LICENCE : CC BY-NC 4.0 — source à citer : https://github.com/ericperret/crest/
             usage commercial interdit sauf accord écrit de l'auteur (voir LICENSE)
   DÉPEND  : aucune
   EXPOSE  : LAVES_CAS, laveGRD, laveParametres, laveLireWGS84
   CONVENTIONS : cas pire (même convention que la rupture de barrage) :
             débit de pointe publié tenu jusqu'à épuisement du volume
             publié (durée = V / Q) ; à défaut de pointe, débit moyen ;
             compositions en % massique d'oxydes, fer total en FeO, bain
             dégazé (H2O 0,02 %, valeur de MAGFLOW pour l'Etna) ;
             températures en °C dans les fiches, K au calcul ; cristaux à
             l'évent φ0 = 0,15 et gagnés jusqu'au figeage Δφ = 0,45, croûte
             fc = 1, α = −0,00756 (valeurs par défaut de FLOWGO, Harris &
             Rowland 2001) sauf mention ; figeage 900 °C (MAGFLOW, Del Negro
             et al. 2013).
   ═══════════════════════════════════════════════════════════════════ */
"use strict";

const LAVES_CAS = [
  { nom: 'Nyiragongo 2002 (RD Congo)', type: 'foïdite ultra-fluide',
    Q: 460, V: 20e6, Te: 1150,
    comp: { SiO2: 39.4, TiO2: 2.8, Al2O3: 14.9, FeO: 12.9, MnO: 0.28, MgO: 3.9, CaO: 11.7, Na2O: 5.9, K2O: 5.4, P2O5: 1.3 },
    note: 'Lave très pauvre en silice, vidange brutale du lac de lave : 20 Mm³ en moins de 12 h, ' +
          'plusieurs km/h jusque dans Goma. Scénario le plus rapide.',
    src: 'GVP BGVN 27:03 et 27:04 (volume 20·10⁶ m³) ; Tedesco et al. 2007, JGR 112 (durée ≤ 12 h)' },
  { nom: 'Villarrica 1971 (Chili)', type: 'basalte-andésite',
    Q: 800, V: 23e6, Te: 1140,
    comp: { SiO2: 52.0, TiO2: 1.2, Al2O3: 16.5, FeO: 9.8, MnO: 0.16, MgO: 5.7, CaO: 9.8, Na2O: 3.2, K2O: 0.7, P2O5: 0.2 },
    note: 'Éruption brève et massive (pointe 800 m³/s) : coulée de 16,5 km en deux jours. ' +
          'Pour une éruption courte et violente sur un strato-volcan.',
    src: 'Castruccio & Contreras 2016, JVGR 327:469' },
  { nom: 'Piton de la Fournaise 2007 (La Réunion)', type: 'basalte de point chaud',
    Q: 200, V: 140e6, Te: 1150,
    comp: { SiO2: 49.0, TiO2: 2.7, Al2O3: 14.0, FeO: 11.3, MnO: 0.17, MgO: 7.4, CaO: 11.3, Na2O: 2.6, K2O: 0.7, P2O5: 0.3 },
    note: 'Basalte fluide, pointe > 200 m³/s après l\u2019effondrement du Dolomieu : la mer atteinte à 3 km en 11 h 30. ' +
          'Pour une éruption de volcan-bouclier à bas débit puis violente.',
    src: 'Staudacher et al. 2009, JVGR 184:126 (≥ 140·10⁶ m³, pointe > 200 m³/s)' },
  { nom: 'La Palma 2021 (Canaries)', type: 'basanite',
    Q: 42.7, V: 212e6, Te: 1170,
    comp: { SiO2: 43.8, TiO2: 3.8, Al2O3: 14.2, FeO: 12.2, MnO: 0.2, MgO: 7.3, CaO: 11.0, Na2O: 4.2, K2O: 1.6, P2O5: 0.9 },
    note: 'Fissure de flanc, 85 jours : coulées lentes mais très étendues (12 km², 3 000 bâtiments). ' +
          'Pour une longue éruption fissurale en zone habitée.',
    src: 'Plank et al. 2023, Sci. Rep. 13:2044 (212·10⁶ m³, pointe 42,7 m³/s)' },
  { nom: 'Etna 2004-2005 (Sicile)', type: 'basalte de l\u2019Etna',
    Q: 4, V: 46e6, Te: 1070,
    comp: { SiO2: 47.8, TiO2: 1.7, Al2O3: 17.1, FeO: 10.4, MnO: 0.18, MgO: 5.8, CaO: 10.6, Na2O: 3.6, K2O: 2.0, P2O5: 0.5 },
    vent: { lat: 37.740, lon: 15.015, note: 'fissure de 2 900 à 2 600 m, évent le plus bas (cas pire)' },
    note: 'Débit faible (4 m³/s) pendant six mois dans le Valle del Bove : coulée lente, épaisse, confinée. ' +
          'Cas d\u2019essai (visuel : front vers 1 980 m d\u2019altitude).',
    src: 'paramètres fournis (42 à 50·10⁶ m³, 1 060 à 1 080 °C, 1 000 à 10 000 Pa·s, 2 600 kg/m³) ; ' +
         'Burton et al. 2005, GRL 32 (évent de 2 620 m)' },
  { nom: 'Lonquimay 1988-1990 (Chili)', type: 'andésite',
    Q: 80, V: 230e6, Te: 1050,
    comp: { SiO2: 58.0, TiO2: 1.3, Al2O3: 16.3, FeO: 8.2, MnO: 0.16, MgO: 3.1, CaO: 6.3, Na2O: 4.6, K2O: 1.4, P2O5: 0.3 },
    note: 'Lave riche en silice, 13 mois : coulée épaisse (10 à 50 m) et lente, 10,2 km. ' +
          'Pour une lave visqueuse de strato-volcan andésitique.',
    src: 'Naranjo et al. 1992, Geol. Mag. 129:657 ; Castruccio & Contreras 2016 (pointe 80 m³/s)' }
];

/* masses molaires (g/mol) des oxydes du modèle GRD */
const GRD_MM = { SiO2: 60.0843, TiO2: 79.8658, Al2O3: 101.9613, FeO: 71.8444, MnO: 70.9374, MgO: 40.3044,
                 CaO: 56.0774, Na2O: 61.9789, K2O: 94.196, P2O5: 141.9445, H2O: 18.0153 };

/* ── laveGRD ── E : composition en % massique d'oxydes (H2O comprise) →
   T : passage en % molaire normalisé à 100 ; B et C du modèle de
   Giordano, Russell & Dingwell (2008, EPSL 271:123, table 1), A = −4,55 ;
   vérifié sur leur table 2 (B 7730, C 335, log η(1273 K) 3,69 contre
   7720, 334, 3,67 publiés) → S : {A, B, C} de log10 η = A + B/(T − C). */
function laveGRD(w) {
  const m = {}; let s = 0;
  for (const k in GRD_MM) { m[k] = (w[k] || 0) / GRD_MM[k]; s += m[k]; }
  for (const k in m) m[k] *= 100 / s;
  const V = m.H2O, TA = m.TiO2 + m.Al2O3, FM = m.FeO + m.MnO + m.MgO, NK = m.Na2O + m.K2O;
  const B = 159.6 * (m.SiO2 + m.TiO2) - 173.3 * m.Al2O3 + 72.1 * (m.FeO + m.MnO + m.P2O5) + 75.7 * m.MgO
          - 39.0 * m.CaO - 84.1 * (m.Na2O + V) + 141.5 * (V + Math.log(1 + m.H2O))
          - 2.43 * (m.SiO2 + m.TiO2) * FM - 0.91 * (m.SiO2 + TA + m.P2O5) * (NK + m.H2O) + 17.6 * m.Al2O3 * NK;
  const C = 2.75 * m.SiO2 + 15.7 * TA + 8.3 * FM + 10.2 * m.CaO - 12.3 * NK - 99.5 * Math.log(1 + V)
          + 0.30 * (m.Al2O3 + FM + m.CaO - m.P2O5) * (NK + V);
  return { A: -4.55, B: B, C: C };
}

/* ── laveParametres ── E : cas de LAVES_CAS → T : VFT du bain fondu dégazé,
   températures en K, durée = V/Q, valeurs FLOWGO et MAGFLOW par défaut
   → S : objet « lave » attendu par calculLave. */
function laveParametres(c) {
  const g = laveGRD(Object.assign({ H2O: 0.02 }, c.comp));
  return { nom: c.nom, A: g.A, B: g.B, C: g.C, Te: c.Te + 273.15, Ts: (c.Ts || 900) + 273.15,
           phi0: c.phi0 !== undefined ? c.phi0 : 0.15, dphi: c.dphi !== undefined ? c.dphi : 0.45,
           fc: c.fc !== undefined ? c.fc : 1.0, alpha: c.alpha !== undefined ? c.alpha : -0.00756,
           Q: c.Q, duree: c.V / c.Q };
}

/* ── laveLireWGS84 ── E : texte « 37.750° N, 15.005° E » (degrés décimaux,
   virgule ou point décimal, hémisphères N/S et E/O/W, ou nombres signés
   « 37.75, 15.005 ») → T : deux nombres dans l'ordre latitude,
   longitude ; S et O/W négatifs → S : {lat, lon} ou null. */
function laveLireWGS84(txt) {
  const t = String(txt || '').replace(/°/g, ' ').replace(/(\d),(\d)/g, '$1.$2').toUpperCase();
  const re = /(-?\d+(?:\.\d+)?)\s*([NSEOW])?/g, v = [];
  let r;
  while ((r = re.exec(t)) && v.length < 2) {
    let x = parseFloat(r[1]);
    if (r[2] === 'S' || r[2] === 'O' || r[2] === 'W') x = -Math.abs(x);
    v.push(x);
  }
  if (v.length < 2 || Math.abs(v[0]) > 90 || Math.abs(v[1]) > 180) return null;
  return { lat: v[0], lon: v[1] };
}
