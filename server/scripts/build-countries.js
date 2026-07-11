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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Handmatige koppelingen staan in een databestand (geen code) zodat de
// wekelijkse mapping-bewaking ze via een auto-fix-PR kan bijwerken:
// server/data/slug-overrides.json. Waarde null = bron heeft geen advies.
const OVERRIDES = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'slug-overrides.json'), 'utf8'));

const NL_LIST =
  'https://opendata.nederlandwereldwijd.nl/v2/sources/nederlandwereldwijd/infotypes/traveladvice?output=json';
const ISO_JSON =
  'https://raw.githubusercontent.com/lukes/ISO-3166-Countries-with-Regional-Codes/master/all/all.json';
const UK_INDEX = 'https://www.gov.uk/api/content/foreign-travel-advice';
const US_RSS = 'https://travel.state.gov/_res/rss/TAsTWs.xml';
const IE_AZ = 'https://www.dfa.ie/travel/travel-advice/a-z-list-of-countries/';
const CA_INDEX = 'https://data.international.gc.ca/travel-voyage/index-alpha-eng.json';
const DE_INDEX = 'https://www.auswaertiges-amt.de/opendata/travelwarning';

// Handmatige koppelingen waar de genormaliseerde Engelse naam niet matcht —
// zie server/data/slug-overrides.json (bewust data, geen code).
const UK_SLUG_OVERRIDES = OVERRIDES.uk || {};
const US_SLUG_OVERRIDES = OVERRIDES.us || {};
const IE_SLUG_OVERRIDES = OVERRIDES.ie || {};
// Frankrijk (France Diplomatie): slug = Franse landnaam, genormaliseerd;
// afgeleid via vertaling, met overrides voor bekende namen.
const FR_SLUG_OVERRIDES = OVERRIDES.fr || {};
// Australië (Smartraveller): URL = /destinations/{continent}/{slug}.
const AU_SLUG_OVERRIDES = OVERRIDES.au || {};
// Smartraveller-continent op basis van ISO-regio/subregio.
function auContinent(region, subregion) {
  if (region === 'Africa') return 'africa';
  if (region === 'Americas') return 'americas';
  if (region === 'Europe') return 'europe';
  if (region === 'Oceania') return 'pacific';
  if (region === 'Asia') return subregion === 'Western Asia' ? 'middle-east' : 'asia';
  return null;
}

// Spanje (Exteriores): landpagina via de Spaanse landnaam (?trc=Naam);
// afgeleid via vertaling (en->es), met overrides voor bekende namen.
const ES_NAME_OVERRIDES = OVERRIDES.es || {};

// Nieuw-Zeeland (SafeTravel): /destinations/{slug}, slug = Engelse landnaam.
const NZ_SLUG_OVERRIDES = OVERRIDES.nz || {};

// Denemarken (Udenrigsministeriet): /rejsevejledninger/{slug}, slug = Deense
// landnaam; afgeleid via vertaling (en->da), met overrides voor bekende namen.
const DK_NAME_OVERRIDES = OVERRIDES.dk || {};

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

/**
 * De NW-API geeft maximaal 200 rijen per pagina, ook als je meer vraagt —
 * pagineer met offset, anders ontbreken er stilletjes ±26 landen (waaronder
 * de VS en Frankrijk).
 */
async function getNlList() {
  const ROWS = 200;
  const all = [];
  for (let offset = 0; ; offset += ROWS) {
    const page = await getJson(`${NL_LIST}&rows=${ROWS}&offset=${offset}`);
    if (!Array.isArray(page) || !page.length) break;
    all.push(...page);
    if (page.length < ROWS) break;
  }
  return all;
}

function matchSlug(iso, enName, slugSet, overrides) {
  if (iso in overrides) return overrides[iso]; // kan expliciet null zijn
  const cand = normalise(enName);
  return slugSet.has(cand) ? cand : null;
}

async function main() {
  console.log('Ophalen bron-indexen (NL, ISO, VK, VS, Canada, Ierland)...');
  const [nlList, isoData, ukIndex, usXml, ieHtml, caIndex, deIndex] = await Promise.all([
    getNlList(),
    getJson(ISO_JSON),
    getJson(UK_INDEX),
    getText(US_RSS).catch((e) => (console.warn('VS-index faalde:', e.message), '')),
    getText(IE_AZ).catch((e) => (console.warn('Ierland-index faalde:', e.message), '')),
    getJson(CA_INDEX).catch((e) => (console.warn('Canada-index faalde:', e.message), { data: {} })),
    getJson(DE_INDEX).catch((e) => (console.warn('Duitsland-index faalde:', e.message), { response: {} })),
  ]);

  // Duitsland (Auswärtiges Amt): de adapter neemt ISO3 en zoekt zelf de
  // content-id op. We hoeven hier alleen te weten wélke ISO3-codes de API kent.
  const deIso3 = new Set();
  for (const v of Object.values(deIndex?.response || {})) {
    if (v && typeof v === 'object' && v.iso3CountryCode) deIso3.add(v.iso3CountryCode.toUpperCase());
  }

  const iso3ToEn = {};
  const iso3ToIso2 = {};
  const iso3ToRegion = {};
  const iso3ToSub = {};
  for (const c of isoData) {
    iso3ToEn[c['alpha-3']] = c.name;
    iso3ToIso2[c['alpha-3']] = c['alpha-2'];
    iso3ToRegion[c['alpha-3']] = c.region;
    iso3ToSub[c['alpha-3']] = c['sub-region'];
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
    const ie = matchSlug(iso, enName, ieSlugs, IE_SLUG_OVERRIDES);
    // VS: de State Dept-RSS is een roulerende subset; leid de slug direct af
    // (misses geven netjes 404 in de adapter).
    const us = iso in US_SLUG_OVERRIDES ? US_SLUG_OVERRIDES[iso] : normalise(enName);

    let ca = null;
    const caEntry = iso2 && caByIso2[iso2];
    if (caEntry) ca = { iso2, id: caEntry.id, slug: normalise(caEntry.eng) };

    // Australië: continent uit ISO-regio, slug uit Engelse naam (met overrides).
    let au = null;
    const continent = auContinent(iso3ToRegion[iso], iso3ToSub[iso]);
    if (continent) au = { continent, slug: AU_SLUG_OVERRIDES[iso] || normalise(enName) };

    if (uk) counts.uk++;
    if (us) counts.us++;
    if (ca) counts.ca++;
    if (ie) counts.ie++;
    if (au) counts.au = (counts.au || 0) + 1;

    countries[iso] = {
      iso3: iso,
      iso2,
      nl: doc.location,
      en: enName,
      key: doc.locationkey,
      sources: {
        uk, us, ca, ie, fr: null, au, es: null,
        de: deIso3.has(iso) ? iso : null,
        nz: NZ_SLUG_OVERRIDES[iso] || normalise(enName),
        dk: null,
      },
    };
    if (countries[iso].sources.de) counts.de = (counts.de || 0) + 1;
    if (countries[iso].sources.nz) counts.nz = (counts.nz || 0) + 1;
  }

  // Frankrijk (slug), Spanje (Spaanse naam) en Denemarken (Deense slug)
  // afleiden via vertaling.
  console.log('Franse/Spaanse/Deense namen afleiden via vertaling…');
  const isos = Object.keys(countries);
  await mapLimit(isos, 6, async (iso) => {
    let fr = FR_SLUG_OVERRIDES[iso];
    if (!fr) { const frName = await translateName(countries[iso].en, 'fr'); fr = frName ? normalise(frName) : null; }
    countries[iso].sources.fr = fr;
    if (fr) counts.fr = (counts.fr || 0) + 1;

    let es = ES_NAME_OVERRIDES[iso];
    if (!es) { const esName = await translateName(countries[iso].en, 'es'); es = esName ? esName.trim() : null; }
    countries[iso].sources.es = es;
    if (es) counts.es = (counts.es || 0) + 1;

    let dk = DK_NAME_OVERRIDES[iso];
    if (!dk) { const daName = await translateName(countries[iso].en, 'da'); dk = daName ? normalise(daName) : null; }
    countries[iso].sources.dk = dk;
    if (dk) counts.dk = (counts.dk || 0) + 1;
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
    `Koppelingen: VK ${counts.uk}, VS ${counts.us}, Canada ${counts.ca}, Ierland ${counts.ie}, ` +
      `Frankrijk ${counts.fr}, Australië ${counts.au || 0}, Spanje ${counts.es}, ` +
      `Duitsland ${counts.de || 0}, Nieuw-Zeeland ${counts.nz || 0}, Denemarken ${counts.dk || 0}.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
