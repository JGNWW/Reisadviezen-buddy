/**
 * Canonieke thema-taxonomie.
 *
 * De thema's zijn afgeleid van de koppenstructuur van NederlandWereldwijd
 * (de <category> namen en de <paragraphtitle> subkoppen in de reisadviezen).
 * Zowel Nederlandse subkoppen als de koppen van buitenlandse reisadviezen
 * worden op deze canonieke thema's geclassificeerd, zodat we per thema naast
 * elkaar kunnen vergelijken en kunnen zien welke thema's ontbreken.
 *
 * De trefwoorden zijn meertalig (nl/en/de/fr/es/da): de bronnen hebben elk een
 * vaste kopstructuur, dus de vaste koppen van Auswärtiges Amt, um.dk, France
 * Diplomatie en Exteriores staan er letterlijk in. Diakrieten hoeven niet
 * (de matcher normaliseert: Kriminalität ~ kriminalitat). De dekking per bron
 * wordt bewaakt door worker/test/coverage.test.mjs.
 *
 * De kop "In het kort" (introduction) wordt bewust NIET als thema meegenomen;
 * die wordt apart als samenvatting/kleurcode getoond.
 */

export const THEMES = [
  {
    id: 'veiligheid-algemeen',
    label: 'Actuele veiligheidssituatie',
    group: 'Veiligheid & risico’s',
    keywords: [
      'actuele situatie', 'veiligheidssituatie', 'veiligheidsrisico', 'algemene veiligheid',
      'warnings and insurance', 'safety and security', 'current situation', 'overview',
      'travel advisory', 'exercise increased caution', 'exercise normal', 'reconsider travel',
      'do not travel',
      // de/da/fr/es
      'sicherheit', 'sicherheitshinweis', 'aktuelles',
      'sikkerhed', 'generel anbefaling', 'sikkerhedsrisici', 'ekstra forsigtig',
      'trekking', 'hiking', 'wanderungen',
      'securite', 'derniere minute',
      'seguridad', 'notas importantes',
    ],
  },
  {
    id: 'criminaliteit',
    label: 'Criminaliteit',
    group: 'Veiligheid & risico’s',
    keywords: [
      'criminaliteit', 'zakkenroller', 'beroving', 'diefstal', 'oplichting', 'fraude',
      'crime', 'theft', 'scam', 'robbery', 'pickpocket', 'mugging',
      'kriminalitat', 'kriminalitet', 'criminalite', 'delincuencia', 'robo',
    ],
  },
  {
    id: 'terrorisme',
    label: 'Terrorisme',
    group: 'Veiligheid & risico’s',
    keywords: [
      'terrorisme', 'terroristische', 'aanslag', 'terrorism', 'terrorist attack',
      'terrorismus', 'terror', 'terrorismo',
    ],
  },
  {
    id: 'ontvoering',
    label: 'Ontvoering',
    group: 'Veiligheid & risico’s',
    keywords: [
      'ontvoering', 'gijzeling', 'kidnap', 'hostage', 'abduction',
      'entfuhrung', 'enlevement', 'secuestro', 'bortforelse',
    ],
  },
  {
    id: 'demonstraties-politiek',
    label: 'Demonstraties & politieke situatie',
    group: 'Veiligheid & risico’s',
    keywords: [
      'demonstratie', 'betoging', 'protest', 'politieke situatie', 'onrust', 'rellen', 'staking',
      'verkiezing', 'politieke spanning', 'political situation', 'demonstration', 'civil unrest',
      'election', 'protests', 'strikes', 'political tension',
      'innenpolitische', 'manifestation', 'manifestacion', 'politisk',
    ],
  },
  {
    id: 'conflict-grens',
    label: 'Conflict, grens- en regionale risico’s',
    group: 'Veiligheid & risico’s',
    keywords: [
      'grensgebied', 'regionale risico', 'gewapend conflict', 'oorlog', 'gewapende', 'militair',
      'landmijn', 'regional risks', 'border', 'conflict', 'war', 'armed', 'landmine', 'frontline',
      'grenzgebiet', 'frontiere', 'frontera',
    ],
  },
  {
    id: 'natuurgeweld',
    label: 'Natuurgeweld & klimaat',
    group: 'Veiligheid & risico’s',
    keywords: [
      'natuurgeweld', 'aardbeving', 'overstroming', 'orkaan', 'cycloon', 'vulkaan', 'tsunami',
      'bosbrand', 'extreme weer', 'klimaat', 'natural disaster', 'earthquake', 'flood',
      'hurricane', 'cyclone', 'volcano', 'wildfire', 'extreme weather', 'weather', 'monsoon',
      'erdbeben', 'klima', 'naturkatastrophen', 'uberschwemmung', 'wirbelsturm',
      'naturkatastrofer', 'jordskælv', 'jordskaelv',
      'intemperies', 'seisme', 'catastrophes naturelles', 'inondation',
      'terremoto', 'huracan', 'inundacion', 'desastres naturales',
    ],
  },
  {
    id: 'verkeer-vervoer',
    label: 'Verkeer & vervoer',
    group: 'Veiligheid & risico’s',
    keywords: [
      'verkeer', 'vervoer', 'wegen', 'openbaar vervoer', 'rijden', 'taxi', 'luchtvaart', 'vliegen',
      'zeevaart', 'piraterij', 'road', 'transport', 'driving', 'air travel', 'sea travel',
      'piracy', 'public transport', 'aviation', 'vehicle',
      'fuhrerschein', 'verkehr', 'trafik', 'circulation', 'conduccion', 'liaisons aeriennes',
    ],
  },
  {
    id: 'wetten-gebruiken',
    label: 'Wetten, gebruiken & lokale regels',
    group: 'Praktisch & juridisch',
    keywords: [
      'wetten en gebruiken', 'wetten', 'lokale wetgeving', 'drugs', 'alcohol', 'lhbtiq', 'lgbt',
      'religie', 'ramadan', 'kleding', 'fotograferen', 'zeden', 'laws and cultural differences',
      'local laws', 'customs', 'personal id', 'dress', 'illegal drugs', 'criminal penalties',
      'gay and lesbian',
      'rechtliche', 'lokale regler', 'skikke', 'legislation', 'leyes', 'costumbres',
    ],
  },
  {
    id: 'gezondheid',
    label: 'Gezondheid & medische zorg',
    group: 'Praktisch & juridisch',
    keywords: [
      'gezondheid', 'medische', 'ziekenhuis', 'zorg', 'malaria', 'dengue', 'ziekte', 'water',
      'voedsel', 'apotheek', 'medicijn', 'health', 'medical', 'hospital', 'disease', 'vaccination',
      'vaccinaties', 'inenting', 'inentingen', 'vaccine', 'altitude', 'hoogteziekte',
      'air quality', 'hiv', 'ambulance',
      'impfschutz', 'gesundheit', 'medizinische', 'erkrankungen', 'tollwut', 'durchfall',
      'luftverschmutzung', 'reisemedizinische', 'cholera', 'enzephalitis', 'tuberkulos', 'influenza',
      'sundhed', 'sygdom',
      'sante', 'rougeole', 'paludisme', 'epidemie', 'evacuation sanitaire',
      'sanitarias', 'salud', 'vacuna',
    ],
  },
  {
    id: 'inreis-documenten',
    label: 'Inreis, visum & documenten',
    group: 'Praktisch & juridisch',
    keywords: [
      'inreis', 'visum', 'paspoort', 'documenten', 'grenscontrole', 'douane', 'inreisregels',
      'entry requirements', 'entry', 'visa', 'passport', 'border control', 'customs rules',
      'einreise', 'reisedokumente', 'aufenthalt', 'einfuhrbestimmungen', 'zoll',
      'indrejse', 'ophold',
      'entree', 'sejour', 'formalites',
      'documentacion', 'visado', 'aduanas',
    ],
  },
  {
    id: 'geld',
    label: 'Geld & betalen',
    group: 'Praktisch & juridisch',
    keywords: [
      'geld', 'betalen', 'pinnen', 'creditcard', 'valuta', 'contant', 'money', 'currency',
      'cash', 'atm', 'credit card', 'payment',
      'wahrung', 'devises', 'monnaie', 'divisas', 'moneda',
    ],
  },
  {
    id: 'verzekering',
    label: 'Verzekeringen',
    group: 'Praktisch & juridisch',
    keywords: [
      'verzekering', 'reisverzekering', 'insurance', 'travel insurance',
      'versicherung', 'assurance', 'seguro de viaje', 'forsikring',
    ],
  },
  {
    id: 'nood-hulp',
    label: 'Noodsituatie & hulp',
    group: 'Praktisch & juridisch',
    keywords: [
      'noodsituatie', 'in geval van nood', 'hulp', 'alarmnummer', 'ambassade', 'consulaat',
      'crisis', 'emergency', 'getting help', 'consular', 'embassy', 'assistance',
      'krisenvorsorge', 'danskerlisten', 'urgence', 'ambassade', 'embajada', 'telefonos',
    ],
  },
];

const THEME_BY_ID = new Map(THEMES.map((t) => [t.id, t]));
export function themeById(id) {
  return THEME_BY_ID.get(id) || null;
}

const norm = (s) =>
  (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/**
 * Classificeert een kop (en optioneel wat tekst) naar een canoniek thema.
 * Retourneert het thema-id, of null als er geen duidelijke match is.
 *
 * De kop weegt zwaar; de tekst wordt alleen gebruikt als tiebreak.
 */
export function classifyTheme(heading, text = '') {
  const h = norm(heading);
  const t = norm(text).slice(0, 600);
  let best = null;
  let bestScore = 0;

  for (const theme of THEMES) {
    let score = 0;
    for (const kw of theme.keywords) {
      const k = norm(kw);
      if (h.includes(k)) score += 10 + k.length / 10; // kop-match weegt zwaar
      else if (t.includes(k)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = theme.id;
    }
  }
  // Vereis minimaal een kop-match of meerdere tekst-hits.
  return bestScore >= 2 ? best : null;
}

/**
 * Ordent thema-ids in de vaste taxonomie-volgorde.
 */
export function orderThemes(ids) {
  const order = new Map(THEMES.map((t, i) => [t.id, i]));
  return [...new Set(ids)].sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
}
