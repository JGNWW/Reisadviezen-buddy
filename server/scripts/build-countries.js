/**
 * Bouwt server/data/countries.json: een mapping van ISO 3166-1 alpha-3 code
 * naar de Nederlandse/Engelse naam en de identifiers die elke buitenlandse
 * bron gebruikt om een land aan te duiden (slug, ISO2 of numeriek id).
 *
 * Ondersteunde bronnen: VK (FCDO), VS (State Dept), Canada (Global Affairs),
 * Ierland (DFA). Australië/Frankrijk/Spanje/Japan volgen later.
 *
 * Deze data wordt in de repo "gebakken". Draai opnieuw met:
 *   npm run build:countries
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const NL_LIST =
  'https://opendata.nederlandwereldwijd.nl/v2/sources/nederlandwereldwijd/infotypes/traveladvice?output=json&rows=500';
const ISO_JSON =
  'https://raw.githubusercontent.com/lukes/ISO-3166-Countries-with-Regional-Codes/master/all/all.json';
const UK_INDEX = 'https://www.gov.uk/api/content/foreign-travel-advice';
const US_RSS = 'https://travel.state.gov/_res/rss/TAsTWs.xml';
const IE_AZ = 'https://www.dfa.ie/travel/travel-advice/a-z-list-of-countries/';
const CA_INDEX = 'https://data.international.gc.ca/travel-voyage/index-alpha-eng.json';

// Handmatige koppelingen waar de genormaliseerde Engelse naam niet matcht.
const UK_SLUG_OVERRIDES = {
  USA: 'usa', GBR: 'uk', KOR: 'south-korea', PRK: 'north-korea', RUS: 'russia',
  SYR: 'syria', IRN: 'iran', VEN: 'venezuela', BOL: 'bolivia', TZA: 'tanzania',
  MDA: 'moldova', LAO: 'laos', BRN: 'brunei', CPV: 'cape-verde', CIV: 'ivory-coast',
  COD: 'democratic-republic-of-the-congo', COG: 'congo', SWZ: 'swaziland',
  MKD: 'north-macedonia', PSE: 'the-occupied-palestinian-territories', VAT: 'vatican-city',
  TLS: 'east-timor', FSM: 'micronesia', VNM: 'vietnam', SVK: 'slovakia',
  CZE: 'czech-republic', MMR: 'myanmar-burma', TUR: 'turkey', GMB: 'the-gambia',
  LCA: 'st-lucia', VCT: 'st-vincent-and-the-grenadines', KNA: 'st-kitts-and-nevis', TWN: 'taiwan',
};

const US_SLUG_OVERRIDES = {
  KOR: 'south-korea', PRK: 'north-korea', MMR: 'burma', CPV: 'cabo-verde',
  AZE: 'azerbajian', BIH: 'bosinia-and-herzegovina', COD: 'democratic-republic-of-the-congo',
  COG: 'republic-of-the-congo', CIV: 'cote-d-ivoire', SYR: 'syria', RUS: 'russia',
  MDA: 'moldova', TLS: 'timor-leste', SWZ: 'eswatini', MKD: 'north-macedonia',
  PSE: 'israel-the-west-bank-and-gaza', VGB: 'british-virgin-islands',
  VIR: 'us-virgin-islands', TUR: 'turkey', GBR: 'united-kingdom', USA: null,
};

const IE_SLUG_OVERRIDES = {
  KOR: 'south-korea', PRK: 'north-korea', MMR: 'myanmar', CPV: 'cape-verde',
  BRN: 'brunei-darussalam', COD: 'democratic-republic-of-the-congo', COG: 'congo',
  CIV: 'cote-divoire', SYR: 'syria', RUS: 'russian-federation', TLS: 'timor-leste',
  SWZ: 'eswatini', MKD: 'north-macedonia', VAT: 'holy-see-vatican-city-state',
  MDA: 'moldova', TUR: 'turkey', USA: 'united-states-of-america', GBR: 'united-kingdom',
  VNM: 'vietnam', LAO: 'laos',
};

// Frankrijk (France Diplomatie): slug = Franse landnaam, genormaliseerd. We
// leiden die af door de Engelse naam te vertalen; overrides voor bekende namen.
const FR_SLUG_OVERRIDES = {
  USA: 'etats-unis', GBR: 'royaume-uni', DEU: 'allemagne', NLD: 'pays-bas',
  BEL: 'belgique', ESP: 'espagne', ITA: 'italie', CHE: 'suisse', KOR: 'coree-du-sud',
  PRK: 'coree-du-nord', RUS: 'russie', CHN: 'chine', JPN: 'japon', MAR: 'maroc',
  EGY: 'egypte', GRC: 'grece', TUR: 'turquie', BRA: 'bresil', MEX: 'mexique',
  ZAF: 'afrique-du-sud', SAU: 'arabie-saoudite', ARE: 'emirats-arabes-unis',
  IND: 'inde', IDN: 'indonesie', THA: 'thailande', VNM: 'vietnam', PHL: 'philippines',
};

// Handmatige ISO3 -> ISO2 aanvullingen voor NL-bijzonderheden (Caribisch NL).
const ISO2_OVERRIDES = { 'BQ-BO': 'BQ', 'BQ-SA': 'BQ', 'BQ-SE': 'BQ' };

/** Vertaalt een tekst via het gratis Google-endpoint (voor slug-afleiding). */
async function translateName(text, to) {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const d = await res.json();
    return Array.isArray(d?.[0]) ? d[0].map((s) => (s && s[0]) || '').join('') : null;
  } catch { return null; }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

const normalise = (s) =>
  (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ReisadviezenBuddy/1.0)' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}
async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

function matchSlug(iso, enName, slugSet, overrides) {
  if (iso in overrides) return overrides[iso]; // kan expliciet null zijn
  const cand = normalise(enName);
  return slugSet.has(cand) ? cand : null;
}

async function main() {
  console.log('Ophalen bron-indexen (NL, ISO, VK, VS, Canada, Ierland)...');
  const [nlList, isoData, ukIndex, usXml, ieHtml, caIndex] = await Promise.all([
    getJson(NL_LIST),
    getJson(ISO_JSON),
    getJson(UK_INDEX),
    getText(US_RSS).catch((e) => (console.warn('VS-index faalde:', e.message), '')),
    getText(IE_AZ).catch((e) => (console.warn('Ierland-index faalde:', e.message), '')),
    getJson(CA_INDEX).catch((e) => (console.warn('Canada-index faalde:', e.message), { data: {} })),
  ]);

  const iso3ToEn = {};
  const iso3ToIso2 = {};
  for (const c of isoData) {
    iso3ToEn[c['alpha-3']] = c.name;
    iso3ToIso2[c['alpha-3']] = c['alpha-2'];
  }

  const ukSlugs = new Set();
  for (const l of ukIndex?.links?.children ?? []) {
    const slug = (l.base_path || '').replace('/foreign-travel-advice/', '');
    if (slug) ukSlugs.add(slug);
  }
  const usSlugs = new Set(
    [...usXml.matchAll(/traveladvisories\/([a-z0-9-]+)-travel-advisory\.html/g)].map((m) => m[1])
  );
  const ieSlugs = new Set(
    [...ieHtml.matchAll(/\/a-z-list-of-countries\/([a-z0-9-]+)\//g)].map((m) => m[1])
  );
  // Canada: ISO2 -> { id, eng }
  const caByIso2 = {};
  for (const [iso2, v] of Object.entries(caIndex.data || {})) {
    caByIso2[iso2] = { id: v['country-id'], eng: v['country-eng'] };
  }

  const counts = { uk: 0, us: 0, ca: 0, ie: 0, fr: 0 };
  const countries = {};
  for (const doc of nlList) {
    const iso = (doc.isocode || '').toUpperCase();
    if (!iso) continue;
    const enName = iso3ToEn[iso] || doc.location;
    const iso2 = ISO2_OVERRIDES[iso] || iso3ToIso2[iso] || null;

    const uk = matchSlug(iso, enName, ukSlugs, UK_SLUG_OVERRIDES);
    const us = matchSlug(iso, enName, usSlugs, US_SLUG_OVERRIDES);
    const ie = matchSlug(iso, enName, ieSlugs, IE_SLUG_OVERRIDES);

    let ca = null;
    const caEntry = iso2 && caByIso2[iso2];
    if (caEntry) ca = { iso2, id: caEntry.id, slug: normalise(caEntry.eng) };

    if (uk) counts.uk++;
    if (us) counts.us++;
    if (ca) counts.ca++;
    if (ie) counts.ie++;

    countries[iso] = {
      iso3: iso,
      iso2,
      nl: doc.location,
      en: enName,
      key: doc.locationkey,
      sources: { uk, us, ca, ie, fr: null },
    };
  }

  // Frankrijk: slug afleiden via vertaling van de Engelse naam (met overrides).
  console.log('Franse slugs afleiden via vertaling…');
  const isos = Object.keys(countries);
  await mapLimit(isos, 6, async (iso) => {
    let fr = FR_SLUG_OVERRIDES[iso];
    if (!fr) {
      const frName = await translateName(countries[iso].en, 'fr');
      fr = frName ? normalise(frName) : null;
    }
    countries[iso].sources.fr = fr;
    if (fr) counts.fr = (counts.fr || 0) + 1;
  });

  const payload = JSON.stringify(countries, null, 2) + '\n';
  const outPath = join(__dirname, '..', 'data', 'countries.json');
  await writeFile(outPath, payload, 'utf8');
  // Ook een kopie voor de Worker (self-contained deploy).
  const workerPath = join(__dirname, '..', '..', 'worker', 'src', 'data', 'countries.json');
  await writeFile(workerPath, payload, 'utf8').catch(() => {});
  const total = Object.keys(countries).length;
  console.log(`Geschreven ${total} landen naar ${outPath} en worker/src/data.`);
  console.log(
    `Koppelingen: VK ${counts.uk}, VS ${counts.us}, Canada ${counts.ca}, Ierland ${counts.ie}, Frankrijk ${counts.fr}.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
