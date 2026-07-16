/**
 * Bouwt de regjeringen.no-mapping voor de Noorwegen-bron.
 *
 * Noorse landpagina's hebben een vaste, stabiele URL-vorm:
 *   /no/tema/utenrikssaker/reiseinformasjon/velg-land/reiseinfo_{slug}/id{nummer}/
 * Het id-nummer is niet afleidbaar; regjeringen.no blokkeert datacenter-IP's,
 * dus de lijst wordt uit de Wayback Machine CDX-index gehaald (alle ooit
 * gearchiveerde reiseinfo-URL's — de id's zijn permanent). Schrijft:
 *
 *   src/data/no-map.json       iso3 → { slug, id }
 *   src/data/countries.json    voegt sources.no toe per land
 *
 * Draaien: node scripts/build-no-map.mjs
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CDX = 'https://web.archive.org/cdx/search/cdx?url=regjeringen.no/no/tema/utenrikssaker/reiseinformasjon/velg-land/&matchType=prefix&fl=original&collapse=urlkey&limit=5000';

// Noorse slug → ISO3.
const NO_TO_ISO3 = {
  afghanistan: 'AFG', albania: 'ALB', algerie: 'DZA', angola: 'AGO', antigua_barbuda: 'ATG',
  argentina: 'ARG', armenia: 'ARM', aserbajdsjan: 'AZE', australia: 'AUS', bahamas: 'BHS',
  bangladesh: 'BGD', belgia: 'BEL', bhutan: 'BTN', bolivia: 'BOL', bosnia: 'BIH',
  botswana: 'BWA', brasil: 'BRA', brunei: 'BRN', bulgaria: 'BGR', burkinafaso: 'BFA',
  burundi: 'BDI', canada: 'CAN', chile: 'CHL', colombia: 'COL', cookoyene: 'COK',
  costarica: 'CRI', cuba: 'CUB', danmark: 'DNK', djibouti: 'DJI', dominikanske: 'DOM',
  drkongo: 'COD', ecuador: 'ECU', egypt: 'EGY', ekvatorialguinea: 'GNQ',
  elfernbenskysten: 'CIV', elsalvador: 'SLV', emiratene: 'ARE', eritrea: 'ERI',
  estland: 'EST', etiopia: 'ETH', ewatini: 'SWZ', fiji: 'FJI', filippinene: 'PHL',
  finland: 'FIN', frankrike: 'FRA', gabon: 'GAB', gambia: 'GMB', georgia: 'GEO',
  grenada: 'GRD', guatemala: 'GTM', guinea: 'GIN', guineabissau: 'GNB', guyana: 'GUY',
  haiti: 'HTI', hellas: 'GRC', honduras: 'HND', india: 'IND', indonesia: 'IDN',
  irak: 'IRQ', iran: 'IRN', irland: 'IRL', island: 'ISL', israel: 'ISR', italia: 'ITA',
  jamaica: 'JAM', japan: 'JPN', jemen: 'YEM', jordan: 'JOR', kambodsja: 'KHM',
  kamerun: 'CMR', kappverde: 'CPV', kasakhstan: 'KAZ', kenya: 'KEN', kina: 'CHN',
  kirgisistan: 'KGZ', kiribati: 'KIR', kosovo: 'XKX', kroatia: 'HRV', kuwait: 'KWT',
  kypros: 'CYP', laos: 'LAO', latvia: 'LVA', lesotho: 'LSO', libanon: 'LBN',
  liberia: 'LBR', libya: 'LBY', liechtenstein: 'LIE', litauen: 'LTU', luxembourg: 'LUX',
  madagaskar: 'MDG', makedonia: 'MKD', malawi: 'MWI', malaysia: 'MYS', maldivene: 'MDV',
  mali: 'MLI', malta: 'MLT', marokko: 'MAR', marshallislands: 'MHL', mauritania: 'MRT',
  mexico: 'MEX', mikronesia: 'FSM', moldova: 'MDA', mongolia: 'MNG', montenegro: 'MNE',
  mosambik: 'MOZ', myanmar: 'MMR', namibia: 'NAM', nauru: 'NRU', nederland: 'NLD',
  nepal: 'NPL', newzealand: 'NZL', nicaragua: 'NIC', niger: 'NER', nigeria: 'NGA',
  nordkorea: 'PRK', nordmakedonia: 'MKD', oman: 'OMN', osterrike: 'AUT', osttimor: 'TLS',
  pakistan: 'PAK', palau: 'PLW', panama: 'PAN', paraguay: 'PRY', peru: 'PER',
  polen: 'POL', portugal: 'PRT', repkongo: 'COG', romania: 'ROU', russland: 'RUS',
  rwanda: 'RWA', saintkitts: 'KNA', saintlucia: 'LCA', saintvincent: 'VCT',
  salomonoyene: 'SLB', samoa: 'WSM', sanmarino: 'SMR', saotome: 'STP',
  saudiarabia: 'SAU', senegal: 'SEN', serbia: 'SRB', seychellene: 'SYC',
  sierraleone: 'SLE', singapore: 'SGP', slovakia: 'SVK', slovenia: 'SVN',
  somalia: 'SOM', sorafrika: 'ZAF', sorkorea: 'KOR', sorsudan: 'SSD', spania: 'ESP',
  srilanka: 'LKA', sudan: 'SDN', surinam: 'SUR', sveits: 'CHE', sverige: 'SWE',
  swaziland: 'SWZ', tadsjikistan: 'TJK', tanzania: 'TZA', thailand: 'THA', togo: 'TGO',
  tonga: 'TON', triogto: 'TTO', tsjad: 'TCD', tsjekkia: 'CZE', tunisia: 'TUN',
  turkmenistan: 'TKM', tuvalu: 'TUV', tyrkia: 'TUR', tyskland: 'DEU', uganda: 'UGA',
  uk: 'GBR', ukraina: 'UKR', ungarn: 'HUN', uruguay: 'URY', usa: 'USA',
  usbekistan: 'UZB', vanuatu: 'VUT', venezuela: 'VEN', vietnam: 'VNM', zambia: 'ZMB',
  zimbabwe: 'ZWE',
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'src', 'data');

async function main() {
  // CDX_FILE=pad → lees een eerder opgehaalde CDX-dump (de API rate-limit
  // herhaalde queries); anders live opvragen.
  let text;
  if (process.env.CDX_FILE) {
    text = readFileSync(process.env.CDX_FILE, 'utf8');
  } else {
    const r = await fetch(CDX, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`CDX ${r.status}`);
    text = await r.text();
  }

  // Per slug het LANGSTE id bewaren — de archive bevat soms afgekapte
  // URL-varianten (bijv. id24174 naast het echte id2417496).
  const bySlug = {};
  for (const m of text.matchAll(/reiseinfo_([a-z0-9_-]+)\/id(\d+)/g)) {
    const [, slug, id] = m;
    if (!bySlug[slug] || id.length > bySlug[slug].length) bySlug[slug] = id;
  }
  const slugs = Object.keys(bySlug);
  console.log(`CDX: ${slugs.length} slugs`);
  if (slugs.length < 150) throw new Error('verdacht weinig slugs — CDX-query gewijzigd?');

  const map = {};
  const unknown = [];
  for (const slug of slugs) {
    const iso3 = NO_TO_ISO3[slug];
    if (!iso3) { unknown.push(slug); continue; }
    // Bij dubbelingen (makedonia/nordmakedonia, ewatini/swaziland) wint de
    // vorm met het langste id-nummer (nieuwste pagina).
    if (!map[iso3] || bySlug[slug].length > map[iso3].id.length) map[iso3] = { slug, id: bySlug[slug] };
  }
  if (unknown.length) throw new Error(`Onbekende slugs (voeg toe aan NO_TO_ISO3): ${unknown.join(', ')}`);

  writeFileSync(path.join(DATA, 'no-map.json'), JSON.stringify(map, null, 1) + '\n');

  const countriesFile = path.join(DATA, 'countries.json');
  const countries = JSON.parse(readFileSync(countriesFile, 'utf8'));
  let added = 0;
  for (const [iso3, rec] of Object.entries(countries)) {
    const entry = map[iso3];
    if (!entry) { if (rec.sources) delete rec.sources.no; continue; }
    rec.sources ||= {};
    const val = `${entry.slug}/${entry.id}`;
    if (rec.sources.no !== val) { rec.sources.no = val; added++; }
  }
  writeFileSync(countriesFile, JSON.stringify(countries, null, 2) + '\n');
  console.log(`no-map.json: ${Object.keys(map).length} landen; countries.json: ${added} no-koppelingen.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
