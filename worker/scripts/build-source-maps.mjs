/**
 * Bouwt de landkoppelingen voor de bronnen Italië en Finland in
 * src/data/countries.json:
 *
 *   sources.it = ISO3   (Viaggiare Sicuri: /schede_paese/{ISO3}.json —
 *                        alleen landen uit hun eigen lista_nazioni.json)
 *   sources.fi = ISO2   (um.fi: /matkustustiedote/-/c/{ISO2} — alleen landen
 *                        met een matkustustiedote op de A-Ö-indexpagina)
 *
 * Draaien (eenmalig, of ter controle na een sitewijziging):
 *   node scripts/build-source-maps.mjs
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COUNTRIES_FILE = path.join(__dirname, '..', 'src', 'data', 'countries.json');
const UA = { 'User-Agent': 'Mozilla/5.0 (ReisadviezenBuddy mapping-build)' };

async function main() {
  const countries = JSON.parse(readFileSync(COUNTRIES_FILE, 'utf8'));

  // ---- Italië: lista_nazioni.json → set van ISO3-codes.
  const itRes = await fetch('https://www.viaggiaresicuri.it/schede_paese/lista_nazioni.json', { headers: UA });
  if (!itRes.ok) throw new Error(`IT lista_nazioni ${itRes.status}`);
  const itList = await itRes.json();
  const itIso3 = new Set((Array.isArray(itList) ? itList : []).map((x) => x['Codice-3']).filter(Boolean));
  if (itIso3.size < 150) throw new Error(`IT: verdacht weinig landen (${itIso3.size})`);

  // ---- Finland: A-Ö-indexpagina → set van ISO2-codes.
  const fiRes = await fetch('https://um.fi/matkustustiedotteet-a-o', { headers: UA });
  if (!fiRes.ok) throw new Error(`FI index ${fiRes.status}`);
  const fiHtml = await fiRes.text();
  const fiIso2 = new Set([...fiHtml.matchAll(/matkustustiedote\/-\/c\/([A-Z]{2})/g)].map((m) => m[1]));
  if (fiIso2.size < 100) throw new Error(`FI: verdacht weinig landen (${fiIso2.size})`);

  let itAdded = 0;
  let fiAdded = 0;
  for (const rec of Object.values(countries)) {
    rec.sources ||= {};
    if (itIso3.has(rec.iso3)) {
      if (rec.sources.it !== rec.iso3) { rec.sources.it = rec.iso3; itAdded++; }
    } else delete rec.sources.it;
    if (rec.iso2 && fiIso2.has(rec.iso2)) {
      if (rec.sources.fi !== rec.iso2) { rec.sources.fi = rec.iso2; fiAdded++; }
    } else delete rec.sources.fi;
  }

  writeFileSync(COUNTRIES_FILE, JSON.stringify(countries, null, 2) + '\n');
  console.log(`countries.json: it ${itAdded} gezet (${itIso3.size} bij bron), fi ${fiAdded} gezet (${fiIso2.size} bij bron).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
