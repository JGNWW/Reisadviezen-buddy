/**
 * Bouwt server/data/countries.json: een mapping van ISO 3166-1 alpha-3 code
 * naar de Nederlandse naam, Engelse naam en de slug die de bronnen van andere
 * landen gebruiken (op dit moment het Verenigd Koninkrijk / FCDO).
 *
 * Deze data wordt in de repo "gebakken" zodat de tool tijdens runtime niet
 * afhankelijk is van externe naslagbronnen. Draai opnieuw met:
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

// Handmatige koppelingen waar de Engelse naam van NederlandWereldwijd/ISO niet
// automatisch matcht met de FCDO-slug.
const UK_SLUG_OVERRIDES = {
  USA: 'usa',
  GBR: 'uk', // niet gebruikt voor vergelijking, maar volledig houden
  KOR: 'south-korea',
  PRK: 'north-korea',
  RUS: 'russia',
  SYR: 'syria',
  IRN: 'iran',
  VEN: 'venezuela',
  BOL: 'bolivia',
  TZA: 'tanzania',
  MDA: 'moldova',
  LAO: 'laos',
  BRN: 'brunei',
  CPV: 'cape-verde',
  CIV: 'ivory-coast',
  COD: 'democratic-republic-of-the-congo',
  COG: 'congo',
  SWZ: 'swaziland',
  MKD: 'north-macedonia',
  PSE: 'the-occupied-palestinian-territories',
  VAT: 'vatican-city',
  TLS: 'east-timor',
  FSM: 'micronesia',
  VNM: 'vietnam',
  SVK: 'slovakia',
  CZE: 'czech-republic',
  MMR: 'myanmar-burma',
  TUR: 'turkey',
  GMB: 'the-gambia',
  LCA: 'st-lucia',
  VCT: 'st-vincent-and-the-grenadines',
  KNA: 'st-kitts-and-nevis',
  TWN: 'taiwan',
};

const normalise = (s) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function main() {
  console.log('Ophalen NL-lijst, ISO-data en FCDO-index...');
  const [nlList, isoData, ukIndex] = await Promise.all([
    getJson(NL_LIST),
    getJson(ISO_JSON),
    getJson(UK_INDEX),
  ]);

  // ISO3 -> Engelse naam
  const iso3ToEn = {};
  for (const c of isoData) iso3ToEn[c['alpha-3']] = c.name;

  // FCDO slugs (set voor snelle lookup)
  const ukSlugs = new Set();
  for (const l of ukIndex?.links?.children ?? []) {
    const bp = l.base_path || '';
    const slug = bp.replace('/foreign-travel-advice/', '');
    if (slug) ukSlugs.add(slug);
  }

  const countries = {};
  let ukMatched = 0;
  for (const doc of nlList) {
    const iso = (doc.isocode || '').toUpperCase();
    if (!iso) continue;
    const enName = iso3ToEn[iso] || doc.location;

    // Bepaal FCDO-slug
    let ukSlug = UK_SLUG_OVERRIDES[iso] ?? null;
    if (!ukSlug) {
      const candidate = normalise(enName);
      if (ukSlugs.has(candidate)) ukSlug = candidate;
    }
    if (ukSlug && ukSlugs.has(ukSlug)) ukMatched++;
    else if (ukSlug && !ukSlugs.has(ukSlug)) {
      // override die (nog) niet in de index staat: toch bewaren
      ukMatched++;
    } else {
      ukSlug = null;
    }

    countries[iso] = {
      iso3: iso,
      nl: doc.location,
      en: enName,
      key: doc.locationkey,
      sources: {
        uk: ukSlug,
      },
    };
  }

  const outPath = join(__dirname, '..', 'data', 'countries.json');
  await writeFile(outPath, JSON.stringify(countries, null, 2) + '\n', 'utf8');
  console.log(
    `Geschreven ${Object.keys(countries).length} landen naar ${outPath} ` +
      `(${ukMatched} met FCDO-koppeling).`
  );

  // Rapporteer landen zonder UK-koppeling zodat overrides aangevuld kunnen worden.
  const missing = Object.values(countries)
    .filter((c) => !c.sources.uk)
    .map((c) => `${c.iso3} (${c.en})`);
  if (missing.length) {
    console.log(`\nGeen FCDO-slug gevonden voor ${missing.length} landen:`);
    console.log(missing.join(', '));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
