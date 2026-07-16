/**
 * Bouwt de bmeia.gv.at-slugmapping voor de Oostenrijk-bron.
 *
 * URL-vorm: /reise-services/reiseinformation/land/{slug} (Duitse landnamen,
 * umlauten → ae/oe/ue, spaties → koppeltekens). bmeia.gv.at blokkeert
 * datacenter-IP's, dus de sluglijst komt uit de Wayback-CDX-index; het
 * onderstaande woordenboek koppelt de daar aangetroffen slugs aan ISO3 —
 * archief-ruis (afgekapte URL's, hashes) staat er bewust niet in en valt
 * dus automatisch weg. Schrijft sources.at in countries.json.
 *
 * Draaien: node scripts/build-at-map.mjs
 *   (CDX_FILE=pad om een eerder opgehaalde CDX-dump te gebruiken)
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CDX = 'https://web.archive.org/cdx/search/cdx?url=bmeia.gv.at/reise-services/reiseinformation/land/&matchType=prefix&fl=original&collapse=urlkey&limit=5000';

// Duitse slug → ISO3, in voorkeursvolgorde: bij twee slugs voor hetzelfde
// land (tschechien/tschechische-republik) wint de eerstgenoemde.
const AT_TO_ISO3 = {
  aegypten: 'EGY', aequatorialguinea: 'GNQ', aethiopien: 'ETH', afghanistan: 'AFG',
  albanien: 'ALB', algerien: 'DZA', andorra: 'AND', angola: 'AGO',
  'antigua-und-barbuda': 'ATG', argentinien: 'ARG', armenien: 'ARM',
  aserbaidschan: 'AZE', australien: 'AUS', bahamas: 'BHS', bahrain: 'BHR',
  bangladesch: 'BGD', barbados: 'BRB', belarus: 'BLR', belgien: 'BEL',
  belize: 'BLZ', benin: 'BEN', bhutan: 'BTN', bolivien: 'BOL',
  'bosnien-und-herzegowina': 'BIH', botsuana: 'BWA', brasilien: 'BRA',
  'brunei-darussalam': 'BRN', bulgarien: 'BGR', 'burkina-faso': 'BFA',
  burundi: 'BDI', 'cabo-verde': 'CPV', chile: 'CHL', china: 'CHN',
  'costa-rica': 'CRI', 'cote-divoire': 'CIV', daenemark: 'DNK',
  deutschland: 'DEU', dominica: 'DMA', 'dominikanische-republik': 'DOM',
  dschibuti: 'DJI', ecuador: 'ECU', 'el-salvador': 'SLV', eritrea: 'ERI',
  estland: 'EST', eswatini: 'SWZ', swasiland: 'SWZ', fidschi: 'FJI',
  finnland: 'FIN', frankreich: 'FRA', gabun: 'GAB', gambia: 'GMB',
  georgien: 'GEO', ghana: 'GHA', grenada: 'GRD', griechenland: 'GRC',
  groenland: 'GRL', guatemala: 'GTM', guinea: 'GIN', 'guinea-bissau': 'GNB',
  guyana: 'GUY', haiti: 'HTI', 'heiliger-stuhl': 'VAT', honduras: 'HND',
  hongkong: 'HKG', indien: 'IND', indonesien: 'IDN', irak: 'IRQ', iran: 'IRN',
  irland: 'IRL', island: 'ISL', israel: 'ISR', italien: 'ITA', jamaika: 'JAM',
  japan: 'JPN', jemen: 'YEM', jordanien: 'JOR', kambodscha: 'KHM',
  kamerun: 'CMR', kanada: 'CAN', kasachstan: 'KAZ', katar: 'QAT', kenia: 'KEN',
  kirgisistan: 'KGZ', kiribati: 'KIR', kolumbien: 'COL', komoren: 'COM',
  'kongo-dem-rep': 'COD', 'korea-dem-vr': 'PRK', 'korea-rep': 'KOR',
  kosovo: 'XKX', kroatien: 'HRV', kuba: 'CUB', kuwait: 'KWT', laos: 'LAO',
  lesotho: 'LSO', lettland: 'LVA', libanon: 'LBN', liberia: 'LBR',
  libyen: 'LBY', liechtenstein: 'LIE', litauen: 'LTU', luxemburg: 'LUX',
  macao: 'MAC', madagaskar: 'MDG', malawi: 'MWI', malaysia: 'MYS',
  malediven: 'MDV', mali: 'MLI', malta: 'MLT', marokko: 'MAR',
  marshallinseln: 'MHL', mauretanien: 'MRT', mauritius: 'MUS',
  nordmazedonien: 'MKD', mazedonien: 'MKD', mexiko: 'MEX', mikronesien: 'FSM',
  moldau: 'MDA', monaco: 'MCO', mongolei: 'MNG', montenegro: 'MNE',
  mosambik: 'MOZ', myanmar: 'MMR', namibia: 'NAM', nauru: 'NRU', nepal: 'NPL',
  neuseeland: 'NZL', nicaragua: 'NIC', 'niederlande-1': 'NLD', niger: 'NER',
  nigeria: 'NGA', norwegen: 'NOR', oesterreich: 'AUT', oman: 'OMN',
  pakistan: 'PAK', 'palaestinensische-gebiete': 'PSE', palaestina: 'PSE',
  palau: 'PLW', panama: 'PAN', 'papua-neuguinea': 'PNG', paraguay: 'PRY',
  peru: 'PER', philippinen: 'PHL', polen: 'POL', portugal: 'PRT',
  ruanda: 'RWA', rumaenien: 'ROU', 'russische-foederation': 'RUS',
  salomonen: 'SLB', sambia: 'ZMB', samoa: 'WSM', 'san-marino': 'SMR',
  'sao-tome-und-principe': 'STP', 'saudi-arabien': 'SAU', schweden: 'SWE',
  schweiz: 'CHE', senegal: 'SEN', serbien: 'SRB', seychellen: 'SYC',
  'sierra-leone': 'SLE', simbabwe: 'ZWE', singapur: 'SGP', slowakei: 'SVK',
  slowenien: 'SVN', somalia: 'SOM', spanien: 'ESP', 'sri-lanka': 'LKA',
  'st-kitts-und-nevis': 'KNA', 'st-lucia': 'LCA',
  'st-vincent-und-die-grenadinen': 'VCT', sudan: 'SDN', suedafrika: 'ZAF',
  suedsudan: 'SSD', suriname: 'SUR', syrien: 'SYR', tadschikistan: 'TJK',
  'taiwan-chinesisches-taipei': 'TWN', tansania: 'TZA', thailand: 'THA',
  'timor-leste': 'TLS', togo: 'TGO', tonga: 'TON', 'trinidad-und-tobago': 'TTO',
  tschad: 'TCD', tschechien: 'CZE', 'tschechische-republik': 'CZE',
  tuerkei: 'TUR', tunesien: 'TUN', turkmenistan: 'TKM', tuvalu: 'TUV',
  uganda: 'UGA', ukraine: 'UKR', ungarn: 'HUN', uruguay: 'URY',
  usbekistan: 'UZB', vanuatu: 'VUT', venezuela: 'VEN',
  'vereinigte-arabische-emirate': 'ARE', 'vereinigte-staaten-1': 'USA',
  'vereinigtes-koenigreich': 'GBR', vietnam: 'VNM',
  'zentralafrikanische-republik': 'CAF', zypern: 'CYP',
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
  const found = new Set([...text.matchAll(/reiseinformation\/land\/([a-z0-9-]+)/g)].map((m) => m[1]));
  console.log(`CDX: ${found.size} slugs (incl. archief-ruis)`);

  // Woordenboek-volgorde bepaalt voorkeur bij dubbelingen per ISO3.
  const map = {};
  for (const [slug, iso3] of Object.entries(AT_TO_ISO3)) {
    if (found.has(slug) && !map[iso3]) map[iso3] = slug;
  }
  if (Object.keys(map).length < 150) throw new Error(`verdacht weinig landen gemapt (${Object.keys(map).length})`);

  const countriesFile = path.join(DATA, 'countries.json');
  const countries = JSON.parse(readFileSync(countriesFile, 'utf8'));
  let added = 0;
  for (const [iso3, rec] of Object.entries(countries)) {
    const slug = map[iso3];
    if (!slug) { if (rec.sources) delete rec.sources.at; continue; }
    rec.sources ||= {};
    if (rec.sources.at !== slug) { rec.sources.at = slug; added++; }
  }
  writeFileSync(countriesFile, JSON.stringify(countries, null, 2) + '\n');
  console.log(`countries.json: ${added} at-koppelingen (${Object.keys(map).length} landen gemapt).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
