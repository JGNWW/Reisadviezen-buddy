/**
 * Mapping-bewaking: valideert de land→bron-koppelingen tegen de indexen van
 * de bronnen zelf, zodat hernoemingen (gov.uk: czech-republic → czechia,
 * swaziland → eswatini) niet maandenlang stil falen.
 *
 * Gevalideerd tegen een volledige bron-index (goedkoop, één call per bron):
 *   VK        gov.uk content-API (alle geldige slugs)
 *   Duitsland Auswärtiges Amt open data (alle ISO3-codes)
 *   Canada    data.international.gc.ca (alle ISO2-codes)
 *   Ierland   A-Z-pagina (alle slugs)
 * Voor kapotte VK/Ierland-slugs wordt de dichtstbijzijnde geldige slug
 * gesuggereerd (bigram-overeenkomst) — vaak direct de juiste override.
 *
 * Schrijft worker/data/mapping-health.json; exitcode is altijd 0 (de
 * workflow beslist over issue/alarm op basis van de JSON).
 *
 * Draaien: cd worker && node scripts/verify-mappings.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import countries from '../src/data/countries.json' with { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'data', 'mapping-health.json');

const UK_INDEX = 'https://www.gov.uk/api/content/foreign-travel-advice';
const DE_INDEX = 'https://www.auswaertiges-amt.de/opendata/travelwarning';
const CA_INDEX = 'https://data.international.gc.ca/travel-voyage/index-alpha-eng.json';
const IE_AZ = 'https://www.dfa.ie/travel/travel-advice/a-z-list-of-countries/';
const UA = 'Mozilla/5.0 (compatible; ReisadviezenBuddy/1.0)';

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

/** Dice-coëfficiënt op bigrammen, voor slug-suggesties. */
function dice(a, b) {
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const ga = grams(a), gb = grams(b);
  let ov = 0;
  for (const [g, n] of ga) ov += Math.min(n, gb.get(g) || 0);
  return (2 * ov) / (a.length - 1 + b.length - 1);
}
function suggest(slug, validSet) {
  let best = null, score = 0.5;
  for (const cand of validSet) {
    const s = dice(slug, cand);
    if (s > score) { best = cand; score = s; }
  }
  return best;
}

async function checkAgainstSet(sid, extract, validSet) {
  const broken = [];
  let checked = 0;
  for (const [iso3, rec] of Object.entries(countries)) {
    const id = extract(rec);
    if (!id) continue;
    checked++;
    if (!validSet.has(id)) {
      broken.push({ iso3, land: rec.nl, id, suggestie: suggest(String(id).toLowerCase(), validSet) });
    }
  }
  return { checked, broken };
}

async function main() {
  const result = { generatedAt: new Date().toISOString(), sources: {} };

  // VK: alle geldige slugs uit de content-API.
  try {
    const idx = await getJson(UK_INDEX);
    const slugs = new Set((idx?.links?.children || [])
      .map((l) => (l.base_path || '').replace('/foreign-travel-advice/', ''))
      .filter(Boolean));
    result.sources.uk = await checkAgainstSet('uk', (r) => r.sources.uk, slugs);
  } catch (e) { result.sources.uk = { error: e.message }; }

  // Duitsland: alle ISO3-codes uit de open-data-index.
  try {
    const idx = await getJson(DE_INDEX);
    const iso3s = new Set(Object.values(idx?.response || {})
      .filter((v) => v && typeof v === 'object' && v.iso3CountryCode)
      .map((v) => v.iso3CountryCode.toUpperCase()));
    result.sources.de = await checkAgainstSet('de', (r) => r.sources.de, iso3s);
  } catch (e) { result.sources.de = { error: e.message }; }

  // Canada: alle ISO2-codes uit de index.
  try {
    const idx = await getJson(CA_INDEX);
    const iso2s = new Set(Object.keys(idx?.data || {}));
    result.sources.ca = await checkAgainstSet('ca', (r) => r.sources.ca?.iso2, iso2s);
  } catch (e) { result.sources.ca = { error: e.message }; }

  // Ierland: alle slugs van de A-Z-pagina.
  try {
    const html = await getText(IE_AZ);
    const slugs = new Set([...html.matchAll(/\/a-z-list-of-countries\/([a-z0-9-]+)\//g)].map((m) => m[1]));
    result.sources.ie = await checkAgainstSet('ie', (r) => r.sources.ie, slugs);
  } catch (e) { result.sources.ie = { error: e.message }; }

  let totalBroken = 0;
  for (const [sid, r] of Object.entries(result.sources)) {
    if (r.error) { console.log(`⚠️ ${sid}: index niet op te halen (${r.error})`); continue; }
    totalBroken += r.broken.length;
    console.log(`${r.broken.length ? '❌' : '✅'} ${sid}: ${r.checked} gecontroleerd, ${r.broken.length} kapot`);
    for (const b of r.broken) {
      console.log(`   ${b.iso3} (${b.land}): "${b.id}"${b.suggestie ? ` → suggestie: "${b.suggestie}"` : ''}`);
    }
  }
  result.totalBroken = totalBroken;
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`\nRapport: ${OUT} (${totalBroken} kapotte koppeling(en)).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
