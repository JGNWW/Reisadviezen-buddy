/**
 * Bouwt de 0404.go.kr-landnummer-mapping voor de Zuid-Korea-bron.
 *
 * Het Koreaanse ministerie (MOFA KR) identificeert landen met een eigen
 * numeriek ID in de URL (아프가니스탄 = 284 → /ntnSafetyInfo/284/detail).
 * De indexpagina geeft ID + Koreaanse naam; de detailpagina toont daarnaast
 * de ENGELSE naam — daarop matchen we tegen countries.json (en-naam +
 * aliassen), zodat de mapping zelf-verifiërend is en geen handmatige
 * Koreaans-woordenlijst vergt. Schrijft:
 *
 *   src/data/kr-map.json       iso3 → { id, nameKo, nameEn }
 *   src/data/countries.json    voegt sources.kr = id toe per land
 *
 * Draaien: node scripts/build-kr-map.mjs
 * Onbekende Engelse namen worden gerapporteerd (en het script faalt) zodat
 * een alias kan worden toegevoegd — liever een expliciete fout dan een
 * stilzwijgend ontbrekend land.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SITE = 'https://www.0404.go.kr';
// De WAF van 0404.go.kr eist een browser-achtige User-Agent ÉN de volledige
// browser-Accept-header (mét q-waarden); een versimpelde Accept of een extra
// Accept-Language geeft — empirisch vastgesteld — een 503.
const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// Engelse naam op 0404.go.kr → ISO3, waar die afwijkt van countries.json.
const ALIASES = {
  'united states of america': 'USA', 'united states': 'USA',
  'united kingdom of great britain and northern ireland': 'GBR', 'united kingdom': 'GBR',
  'russian federation': 'RUS', 'republic of korea': 'KOR', "democratic people's republic of korea": 'PRK',
  'viet nam': 'VNM', 'vietnam': 'VNM', 'lao pdr': 'LAO', "lao people's democratic republic": 'LAO', 'laos': 'LAO',
  'czech republic': 'CZE', 'czechia': 'CZE', 'republic of guyana': 'GUY',
  'côte d’ivoire': 'CIV', "cote d'ivoire": 'CIV', 'ivory coast': 'CIV',
  'democratic republic of the congo': 'COD', 'dr congo': 'COD', 'congo, dem. rep.': 'COD',
  'republic of the congo': 'COG', 'congo': 'COG',
  'myanmar': 'MMR', 'burma': 'MMR', 'cabo verde': 'CPV', 'cape verde': 'CPV',
  'timor-leste': 'TLS', 'east timor': 'TLS', 'eswatini': 'SWZ', 'swaziland': 'SWZ',
  'north macedonia': 'MKD', 'macedonia': 'MKD', 'türkiye': 'TUR', 'turkiye': 'TUR', 'turkey': 'TUR',
  'syrian arab republic': 'SYR', 'syria': 'SYR', 'iran (islamic republic of)': 'IRN', 'iran': 'IRN',
  'bolivia (plurinational state of)': 'BOL', 'bolivia': 'BOL',
  'venezuela (bolivarian republic of)': 'VEN', 'venezuela': 'VEN',
  'tanzania, united republic of': 'TZA', 'tanzania': 'TZA',
  'moldova, republic of': 'MDA', 'moldova': 'MDA', 'brunei darussalam': 'BRN', 'brunei': 'BRN',
  'micronesia (federated states of)': 'FSM', 'micronesia': 'FSM',
  'saint kitts and nevis': 'KNA', 'saint vincent and the grenadines': 'VCT', 'saint lucia': 'LCA',
  'antigua and barbuda': 'ATG', 'trinidad and tobago': 'TTO', 'bosnia and herzegovina': 'BIH',
  'papua new guinea': 'PNG', 'solomon islands': 'SLB', 'marshall islands': 'MHL',
  'united arab emirates': 'ARE', 'saudi arabia': 'SAU', 'sri lanka': 'LKA',
  'south africa': 'ZAF', 'south sudan': 'SSD', 'sudan': 'SDN',
  'central african republic': 'CAF', 'burkina faso': 'BFA', 'sierra leone': 'SLE',
  'equatorial guinea': 'GNQ', 'guinea-bissau': 'GNB', 'guinea bissau': 'GNB',
  'sao tome and principe': 'STP', 'são tomé and príncipe': 'STP',
  'dominican republic': 'DOM', 'costa rica': 'CRI', 'el salvador': 'SLV',
  'new zealand': 'NZL', 'kosovo': 'XKX', 'vatican': 'VAT', 'holy see': 'VAT',
  'china': 'CHN', "people's republic of china": 'CHN', 'taiwan': 'TWN', 'hong kong': 'HKG', 'macao': 'MAC', 'macau': 'MAC',
  // Site-eigen varianten en typefouten (letterlijk zo op 0404.go.kr):
  'republic of south sudan': 'SSD', 'republic of south africa': 'ZAF', 'netherlands': 'NLD',
  'russia': 'RUS', 'st. vincent and the grenadines': 'VCT', 'solomon lslands': 'SLB',
  'kingdom of eswatini': 'SWZ', 'capeverde': 'CPV', 'costarica': 'CRI',
  'cote d ivoire': 'CIV', 'republic of congo': 'COG', 'cook island': 'COK',
  'palestine': 'PSE', 'hongkong': 'HKG',
};

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'src', 'data');

// De WAF rate-limit bursts (tijdelijke 503's): rustig opnieuw proberen.
async function fetchText(url) {
  for (const wait of [0, 10000, 30000, 60000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const r = await fetch(url, { headers: UA });
    if (r.ok) return r.text();
    if (r.status !== 503 && r.status !== 429) throw new Error(`${r.status} ${url}`);
  }
  throw new Error(`503 (na retries) ${url}`);
}

async function main() {
  const countries = JSON.parse(readFileSync(path.join(DATA, 'countries.json'), 'utf8'));
  const byEn = {};
  for (const [iso3, rec] of Object.entries(countries)) byEn[norm(rec.en)] = iso3;

  const index = await fetchText(`${SITE}/ntnSafetyInfo/list`);
  const items = [...index.matchAll(/href="\/ntnSafetyInfo\/(\d+)\/detail"[^>]*>\s*([^<]+)/g)]
    .map((m) => ({ id: m[1], nameKo: m[2].trim() }));
  const ids = [...new Map(items.map((x) => [x.id, x])).values()];
  console.log(`index: ${ids.length} landen`);
  if (ids.length < 150) throw new Error('verdacht weinig landen op de index — structuur gewijzigd?');

  // Resume-cache: id → Engelse naam, zodat een herstart (na een WAF-blok)
  // niet alle 198 pagina's opnieuw hoeft op te halen.
  const cacheFile = path.join(__dirname, '.kr-names-cache.json');
  const nameCache = (() => { try { return JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { return {}; } })();

  const map = {};
  const unknown = [];
  let done = 0;
  // Sequentieel met bescheiden tempo — dit is een eenmalige buildstap.
  for (const { id, nameKo } of ids) {
    let nameEn = nameCache[id] || null;
    if (!nameEn) {
      const html = await fetchText(`${SITE}/ntnSafetyInfo/${id}/detail`);
      // De kop bevat een expliciete Engelse naam: <span class="name-en">…</span>.
      const m = html.match(/class="name-en"[^>]*>\s*([^<]{2,60})</)
        || html.match(/<h4[^>]*>[^<]*<\/h4>\s*(?:<[^>]+>\s*)*?([A-Z][A-Za-z’'().,\- ]{2,60})</);
      nameEn = m ? m[1].trim() : null;
      if (nameEn) { nameCache[id] = nameEn; writeFileSync(cacheFile, JSON.stringify(nameCache)); }
      await new Promise((r) => setTimeout(r, 400));
    }
    const iso3 = nameEn ? (ALIASES[norm(nameEn)] || byEn[norm(nameEn)]) : null;
    if (!iso3) unknown.push(`${id} ${nameKo} | en="${nameEn}"`);
    else map[iso3] = { id, nameKo, nameEn };
    done++;
    if (done % 25 === 0) console.log(`  ${done}/${ids.length}…`);
  }

  if (unknown.length) {
    console.error(`ONBEKEND (${unknown.length}):\n${unknown.join('\n')}`);
    throw new Error('niet alle landen gematcht — voeg aliassen toe');
  }

  writeFileSync(path.join(DATA, 'kr-map.json'), JSON.stringify(map, null, 1) + '\n');
  let added = 0;
  for (const [iso3, rec] of Object.entries(countries)) {
    const entry = map[iso3];
    if (!entry) { if (rec.sources) delete rec.sources.kr; continue; }
    rec.sources ||= {};
    if (rec.sources.kr !== entry.id) { rec.sources.kr = entry.id; added++; }
  }
  writeFileSync(path.join(DATA, 'countries.json'), JSON.stringify(countries, null, 2) + '\n');
  console.log(`kr-map.json: ${Object.keys(map).length} landen; countries.json: ${added} kr-koppelingen.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
