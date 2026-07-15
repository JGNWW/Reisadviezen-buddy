/**
 * Bouwt de MOFA-landnummer-mapping voor de Japan-bron (anzen.mofa.go.jp).
 *
 * MOFA identificeert landen met een eigen 3-cijferig nummer in de pagina-URL
 * (アフガニスタン = 041 → /info/pcinfectionspothazardinfo_041.html). Dit
 * script haalt de volledige lijst van de risicokaart-pagina, koppelt de
 * Japanse landnamen aan ISO3 via de onderstaande tabel, en schrijft:
 *
 *   src/data/mofa-jp.json      iso3 → { num, name }
 *   src/data/countries.json    voegt sources.jp = num toe per land
 *
 * Draaien (eenmalig, of ter controle na een MOFA-sitewijziging):
 *   node scripts/build-mofa-map.mjs
 *
 * Het script faalt hard op onbekende namen — liever een expliciete fout dan
 * een stilzwijgend ontbrekend land.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const RISKMAP = 'https://www.anzen.mofa.go.jp/riskmap/';

// Japanse landnaam (zoals op de risicokaart) → ISO3. Gebieden zonder eigen
// vermelding in countries.json (zoals ハワイ, onderdeel van de VS) → null.
const JA_TO_ISO3 = {
  'インド': 'IND', 'インドネシア': 'IDN', '大韓民国（韓国）': 'KOR', 'カンボジア': 'KHM',
  'シンガポール': 'SGP', 'スリランカ': 'LKA', 'タイ': 'THA', '台湾': 'TWN',
  '中華人民共和国（中国）': 'CHN', 'ネパール': 'NPL', 'パキスタン': 'PAK',
  'バングラデシュ': 'BGD', 'フィリピン': 'PHL', 'ブルネイ': 'BRN', 'ベトナム': 'VNM',
  '香港': 'HKG', 'マレーシア': 'MYS', 'ミャンマー': 'MMR', 'モンゴル': 'MNG',
  'ラオス': 'LAO', 'モルディブ': 'MDV', '北朝鮮': 'PRK', 'マカオ': 'MAC',
  'ブータン': 'BTN', 'アフガニスタン': 'AFG', 'アラブ首長国連邦': 'ARE',
  'イエメン': 'YEM', 'イスラエル': 'ISR', 'イラク': 'IRQ', 'イラン': 'IRN',
  'オマーン': 'OMN', 'カタール': 'QAT', 'クウェート': 'KWT', 'サウジアラビア': 'SAU',
  'シリア': 'SYR', 'トルコ': 'TUR', 'バーレーン': 'BHR', 'ヨルダン': 'JOR',
  'レバノン': 'LBN', 'オーストラリア': 'AUS', 'ソロモン諸島': 'SLB', 'サモア': 'WSM',
  'ニュージーランド': 'NZL', 'パプアニューギニア': 'PNG', 'フィジー': 'FJI',
  'バヌアツ': 'VUT', 'タヒチ': 'PYF', 'アルジェリア': 'DZA', 'アンゴラ': 'AGO',
  'ウガンダ': 'UGA', 'エジプト': 'EGY', 'エチオピア': 'ETH', 'ガーナ': 'GHA',
  'ガボン': 'GAB', 'カメルーン': 'CMR', 'ギニア': 'GIN', 'ケニア': 'KEN',
  'コートジボワール': 'CIV', 'コンゴ共和国': 'COG', 'コンゴ民主共和国': 'COD',
  'ザンビア': 'ZMB', 'シエラレオネ': 'SLE', 'ジンバブエ': 'ZWE', 'スーダン': 'SDN',
  'セーシェル': 'SYC', 'セネガル': 'SEN', 'ソマリア': 'SOM', 'タンザニア': 'TZA',
  '中央アフリカ': 'CAF', 'チュニジア': 'TUN', 'トーゴ': 'TGO', 'ナイジェリア': 'NGA',
  'ニジェール': 'NER', 'ブルキナファソ': 'BFA', 'ベナン': 'BEN', 'マダガスカル': 'MDG',
  'マラウイ': 'MWI', 'マリ': 'MLI', '南アフリカ共和国': 'ZAF', 'モザンビーク': 'MOZ',
  'モロッコ': 'MAR', 'リビア': 'LBY', 'リベリア': 'LBR', 'ブルンジ': 'BDI',
  'レソト': 'LSO', 'ルワンダ': 'RWA', 'コモロ': 'COM', 'チャド': 'TCD',
  'エリトリア': 'ERI', 'ギニアビサウ': 'GNB', 'ジブチ': 'DJI', '西サハラ地域': 'ESH',
  'ナミビア': 'NAM', 'アイルランド': 'IRL', 'アゼルバイジャン': 'AZE', 'イタリア': 'ITA',
  '英国': 'GBR', 'エストニア': 'EST', 'オーストリア': 'AUT', 'オランダ': 'NLD',
  'ギリシャ': 'GRC', 'スイス': 'CHE', 'スウェーデン': 'SWE', 'スペイン': 'ESP',
  'スロベニア': 'SVN', 'チェコ': 'CZE', 'デンマーク': 'DNK', 'ドイツ': 'DEU',
  'ノルウェー': 'NOR', 'バチカン': 'VAT', 'ハンガリー': 'HUN', 'フィンランド': 'FIN',
  'フランス': 'FRA', 'ブルガリア': 'BGR', 'ベルギー': 'BEL', 'ポーランド': 'POL',
  'ポルトガル': 'PRT', 'セルビア': 'SRB', 'ルクセンブルク': 'LUX', 'ルーマニア': 'ROU',
  'ロシア': 'RUS', 'モンテネグロ': 'MNE', 'コソボ': 'XKX', 'ウクライナ': 'UKR',
  'ウズベキスタン': 'UZB', 'スロバキア': 'SVK', 'ベラルーシ': 'BLR', 'ラトビア': 'LVA',
  'カザフスタン': 'KAZ', 'クロアチア': 'HRV', 'ボスニア・ヘルツェゴビナ': 'BIH',
  'リトアニア': 'LTU', 'キプロス': 'CYP', 'マルタ': 'MLT', 'アルバニア': 'ALB',
  'ジブラルタル': 'GIB', 'モルドバ': 'MDA', 'アルメニア': 'ARM', 'ジョージア': 'GEO',
  'タジキスタン': 'TJK', 'トルクメニスタン': 'TKM', '北マケドニア共和国': 'MKD',
  'アメリカ合衆国（米国）': 'USA', 'カナダ': 'CAN', '北マリアナ諸島': 'MNP',
  'グアム': 'GUM', 'ハワイ': null, 'アルゼンチン': 'ARG', 'ウルグアイ': 'URY',
  'エクアドル': 'ECU', 'エルサルバドル': 'SLV', 'キューバ': 'CUB', 'グアテマラ': 'GTM',
  'コスタリカ': 'CRI', 'コロンビア': 'COL', 'ジャマイカ': 'JAM', 'スリナム': 'SUR',
  'チリ': 'CHL', 'ドミニカ共和国': 'DOM', 'トリニダード・トバゴ': 'TTO',
  'ニカラグア': 'NIC', 'ハイチ': 'HTI', 'パナマ': 'PAN', 'バハマ': 'BHS',
  'パラグアイ': 'PRY', 'ブラジル': 'BRA', 'ベネズエラ': 'VEN', 'ペルー': 'PER',
  'ボリビア': 'BOL', 'ホンジュラス': 'HND', 'メキシコ': 'MEX', 'キルギス': 'KGZ',
  'キリバス': 'KIR', 'マーシャル': 'MHL', 'ミクロネシア': 'FSM', 'ナウル': 'NRU',
  'パラオ': 'PLW', 'トンガ': 'TON', 'ツバル': 'TUV', 'カーボベルデ': 'CPV',
  '赤道ギニア': 'GNQ', 'ガンビア': 'GMB', 'モーリタニア': 'MRT', 'モーリシャス': 'MUS',
  'サントメ・プリンシペ': 'STP', 'エスワティニ王国': 'SWZ', 'アイスランド': 'ISL',
  'リヒテンシュタイン': 'LIE', 'モナコ': 'MCO', 'サンマリノ': 'SMR',
  'アンティグア・バーブーダ': 'ATG', 'バルバドス': 'BRB', 'ベリーズ': 'BLZ',
  'ドミニカ': 'DMA', 'グレナダ': 'GRD', 'セントクリストファー・ネービス': 'KNA',
  'セントルシア': 'LCA', 'セントビンセント': 'VCT', 'ガイアナ': 'GUY',
  '東ティモール': 'TLS', 'ボツワナ': 'BWA', 'アンドラ': 'AND',
  'ニューカレドニア': 'NCL', 'クック諸島': 'COK', '南スーダン': 'SSD', 'ニウエ': 'NIU',
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'src', 'data');

async function main() {
  const res = await fetch(RISKMAP, { headers: { 'User-Agent': 'Mozilla/5.0 (ReisadviezenBuddy mapping-build)' } });
  if (!res.ok) throw new Error(`riskmap ${res.status}`);
  const html = await res.text();

  const map = {}; // iso3 -> { num, name }
  const unknown = [];
  for (const m of html.matchAll(/<a[^>]*href="[^"]*pcinfectionspothazardinfo_(\d+)\.html"[^>]*>(.*?)<\/a>/gs)) {
    const num = m[1];
    const name = m[2].replace(/<[^>]+>|\s+/g, '').trim();
    if (!name) continue;
    if (!(name in JA_TO_ISO3)) { unknown.push(`${num} ${name}`); continue; }
    const iso3 = JA_TO_ISO3[name];
    if (!iso3) continue; // bewust overgeslagen (bijv. ハワイ)
    if (map[iso3] && map[iso3].num !== num) throw new Error(`dubbele ISO3 ${iso3}: ${map[iso3].num} én ${num}`);
    map[iso3] = { num, name };
  }
  if (unknown.length) {
    throw new Error(`Onbekende MOFA-landnamen (voeg toe aan JA_TO_ISO3):\n${unknown.join('\n')}`);
  }
  if (Object.keys(map).length < 190) {
    throw new Error(`Verdacht weinig landen (${Object.keys(map).length}) — risicokaart-structuur gewijzigd?`);
  }

  writeFileSync(path.join(DATA, 'mofa-jp.json'), JSON.stringify(map, null, 1) + '\n');

  // countries.json bijwerken: sources.jp = MOFA-nummer.
  const countriesFile = path.join(DATA, 'countries.json');
  const countries = JSON.parse(readFileSync(countriesFile, 'utf8'));
  let added = 0;
  for (const [iso3, rec] of Object.entries(countries)) {
    const entry = map[iso3];
    if (!entry) { if (rec.sources) delete rec.sources.jp; continue; }
    rec.sources ||= {};
    if (rec.sources.jp !== entry.num) { rec.sources.jp = entry.num; added++; }
  }
  writeFileSync(countriesFile, JSON.stringify(countries, null, 2) + '\n');

  console.log(`mofa-jp.json: ${Object.keys(map).length} landen; countries.json: ${added} jp-koppelingen gezet/bijgewerkt.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
