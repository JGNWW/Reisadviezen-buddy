/**
 * Bouwt de eda.admin.ch-padmapping voor de Zwitserland-bron.
 *
 * De klassieke Duitstalige reisadvies-URL's zijn server-gerenderd (anders
 * dan de nieuwe /fr/conseils-…-SPA) en hebben de vorm:
 *   /eda/de/home/vertretungen-und-reisehinweise/{slug}/reisehinweise-fuer{slug2}.html
 * eda.admin.ch blokkeert datacenter-IP's, dus de padlijst komt uit de
 * Wayback-CDX-index; het woordenboek koppelt slugs aan ISO3 (archief-ruis
 * zoals "ukrai-ne" staat er niet in en valt automatisch weg). Schrijft
 * sources.ch (het volledige relatieve pad) in countries.json.
 *
 * Draaien: node scripts/build-ch-map.mjs   (CDX_FILE=pad voor een dump)
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CDX = 'https://web.archive.org/cdx/search/cdx?url=eda.admin.ch/eda/de/home/vertretungen-und-reisehinweise/&matchType=prefix&fl=original&collapse=urlkey&limit=8000&filter=original:.*reisehinweise-fuer.*';

const CH_TO_ISO3 = {
  aegypten: 'EGY', aequatorialguinea: 'GNQ', aethiopien: 'ETH', afghanistan: 'AFG',
  albanien: 'ALB', algerien: 'DZA', andorra: 'AND', angola: 'AGO',
  'antigua-und-barbuda': 'ATG', argentinien: 'ARG', armenien: 'ARM',
  aserbaidschan: 'AZE', australien: 'AUS', bahamas: 'BHS', bahrain: 'BHR',
  bangladesch: 'BGD', barbados: 'BRB', belarus: 'BLR', belgien: 'BEL',
  belize: 'BLZ', benin: 'BEN', bhutan: 'BTN', bolivien: 'BOL',
  'bosnien-und-herzegowina': 'BIH', botsuana: 'BWA', brasilien: 'BRA',
  'brunei-darussalam': 'BRN', bulgarien: 'BGR', 'burkina-faso': 'BFA',
  burundi: 'BDI', chile: 'CHL', china: 'CHN', cookinseln: 'COK',
  'costa-rica': 'CRI', 'cote-d-ivoire': 'CIV', daenemark: 'DNK',
  'demokratische-republik-kongo': 'COD', demokratischevolksrepublikkorea: 'PRK',
  'demokratische-volksrepublikkorea': 'PRK', deutschland: 'DEU',
  dominica: 'DMA', 'dominikanische-republik': 'DOM', dschibuti: 'DJI',
  ecuador: 'ECU', 'el-salvador': 'SLV', eritrea: 'ERI', estland: 'EST',
  finnland: 'FIN', frankreich: 'FRA', gabun: 'GAB', gambia: 'GMB',
  georgien: 'GEO', ghana: 'GHA', grenada: 'GRD', griechenland: 'GRC',
  grossbritannien: 'GBR', guatemala: 'GTM', guinea: 'GIN',
  'guinea-bissau': 'GNB', guyana: 'GUY', haiti: 'HTI',
  'heiliger-stuhl-vatikanstadt': 'VAT', honduras: 'HND', indien: 'IND',
  indonesien: 'IDN', irak: 'IRQ', iran: 'IRN', irland: 'IRL', island: 'ISL',
  italien: 'ITA', jamaika: 'JAM', japan: 'JPN', jemen: 'YEM',
  jordanien: 'JOR', kambodscha: 'KHM', kamerun: 'CMR', kanada: 'CAN',
  'kap-verde': 'CPV', kasachstan: 'KAZ', katar: 'QAT', kenia: 'KEN',
  kirgisistan: 'KGZ', kiribati: 'KIR', kolumbien: 'COL', komoren: 'COM',
  kosovo: 'XKX', kroatien: 'HRV', kuba: 'CUB', kuwait: 'KWT', laos: 'LAO',
  lesotho: 'LSO', lettland: 'LVA', libanon: 'LBN', liberia: 'LBR',
  libyen: 'LBY', liechtenstein: 'LIE', litauen: 'LTU', luxemburg: 'LUX',
  madagaskar: 'MDG', malawi: 'MWI', malaysia: 'MYS', malediven: 'MDV',
  mali: 'MLI', malta: 'MLT', marokko: 'MAR', marschallinseln: 'MHL',
  mauretanien: 'MRT', mauritius: 'MUS', mexiko: 'MEX', mikronesien: 'FSM',
  moldova: 'MDA', monaco: 'MCO', mongolei: 'MNG', montenegro: 'MNE',
  mosambik: 'MOZ', myanmar: 'MMR', namibia: 'NAM', nauru: 'NRU',
  nepal: 'NPL', neuseeland: 'NZL', nicaragua: 'NIC', niederlande: 'NLD',
  niger: 'NER', nigeria: 'NGA', norwegen: 'NOR', oesterreich: 'AUT',
  oman: 'OMN', pakistan: 'PAK', palau: 'PLW', panama: 'PAN',
  'papua-neuguinea': 'PNG', paraguay: 'PRY', peru: 'PER', philippinen: 'PHL',
  polen: 'POL', portugal: 'PRT', 'republik-fidschi': 'FJI',
  'republik-kongo': 'COG', 'republik-korea': 'KOR', ruanda: 'RWA',
  rumaenien: 'ROU', russland: 'RUS', salomoninseln: 'SLB', sambia: 'ZMB',
  samoa: 'WSM', 'san-marino': 'SMR', 'sao-tome-und-principe': 'STP',
  'saudi-arabien': 'SAU', schweden: 'SWE', senegal: 'SEN', serbien: 'SRB',
  seychellen: 'SYC', 'sierra-leone': 'SLE', simbabwe: 'ZWE', singapur: 'SGP',
  slowakei: 'SVK', slowenien: 'SVN', somalia: 'SOM', spanien: 'ESP',
  'sri-lanka': 'LKA', 'st-kitts-und-nevis': 'KNA', 'st-lucia': 'LCA',
  'st-vincent-und-diegrenadinen': 'VCT', sudan: 'SDN', suedafrika: 'ZAF',
  suedsudan: 'SSD', suriname: 'SUR', swasiland: 'SWZ', syrien: 'SYR',
  tadschikistan: 'TJK', 'taiwan-taipei': 'TWN', tansania: 'TZA',
  thailand: 'THA', 'timor-leste': 'TLS', togo: 'TGO', tonga: 'TON',
  'trinidad-und-tobago': 'TTO', tschad: 'TCD', 'tschechische-republik': 'CZE',
  tuerkei: 'TUR', tunesien: 'TUN', turkmenistan: 'TKM', tuvalu: 'TUV',
  uganda: 'UGA', ukraine: 'UKR', ungarn: 'HUN', uruguay: 'URY',
  usbekistan: 'UZB', vanuatu: 'VUT', venezuela: 'VEN',
  'vereinigte-arabischeemirate': 'ARE', 'vereinigte-staaten': 'USA',
  vietnam: 'VNM', zentralafrikanischerepublik: 'CAF', zypern: 'CYP',
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'src', 'data');

async function main() {
  let text;
  if (process.env.CDX_FILE) {
    text = readFileSync(process.env.CDX_FILE, 'utf8');
  } else {
    const r = await fetch(CDX, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`CDX ${r.status}`);
    text = await r.text();
  }

  // slug → volledig relatief pad ("{slug}/reisehinweise-fuer{slug2}.html").
  const bySlug = {};
  for (const m of text.matchAll(/vertretungen-und-reisehinweise\/([a-z0-9-]+)\/(reisehinweise-fuer[a-z0-9-]*\.html)/g)) {
    const [, slug, page] = m;
    const cur = bySlug[slug];
    // Langste paginanaam wint (afgekapte archiefvarianten uitsluiten).
    if (!cur || page.length > cur.length) bySlug[slug] = page;
  }
  console.log(`CDX: ${Object.keys(bySlug).length} slugs`);

  const map = {};
  for (const [slug, page] of Object.entries(bySlug)) {
    const iso3 = CH_TO_ISO3[slug];
    if (!iso3) continue; // archief-ruis of niet-landpagina
    const val = `${slug}/${page}`;
    if (!map[iso3] || val.length > map[iso3].length) map[iso3] = val;
  }
  if (Object.keys(map).length < 150) throw new Error(`verdacht weinig landen gemapt (${Object.keys(map).length})`);

  const countriesFile = path.join(DATA, 'countries.json');
  const countries = JSON.parse(readFileSync(countriesFile, 'utf8'));
  let added = 0;
  for (const [iso3, rec] of Object.entries(countries)) {
    const val = map[iso3];
    if (!val) { if (rec.sources) delete rec.sources.ch; continue; }
    rec.sources ||= {};
    if (rec.sources.ch !== val) { rec.sources.ch = val; added++; }
  }
  writeFileSync(countriesFile, JSON.stringify(countries, null, 2) + '\n');
  console.log(`countries.json: ${added} ch-koppelingen (${Object.keys(map).length} landen gemapt).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
