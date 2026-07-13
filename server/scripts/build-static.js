/**
 * Bouwt een volledig statische versie van Reisadviezen-buddy naar ./docs,
 * geschikt voor GitHub Pages (geen server nodig tijdens runtime).
 *
 * Het script haalt alle reisadviezen op, draait dezelfde normalisatie en
 * thema-classificatie als de dynamische server, en schrijft het resultaat weg
 * als statische JSON:
 *
 *   docs/index.html, app.js, styles.css   (kopie van public/)
 *   docs/data/countries.json               (landenlijst)
 *   docs/data/sources.json                 (buitenlandse bronnen)
 *   docs/data/themes.json                  (canonieke thema's)
 *   docs/data/compare/<iso>.json           (kant-en-klare vergelijking per land)
 *   docs/data/search/nl.json               (zoekindex NL-adviezen)
 *   docs/data/recent-changes.json          (recente wijzigingen buitenlandse bronnen,
 *                                            bijgehouden door de aparte snapshot-workflow)
 *
 * Kaartafbeeldingen worden NIET gedownload: de frontend hotlinkt ze
 * rechtstreeks vanaf de open data (cross-origin <img> werkt zonder CORS).
 *
 * Draaien: npm run build
 */
import { mkdir, writeFile, rm, cp, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as nlSource from '../sources/nl.js';
import { allCountries } from '../lib/countries.js';
import { THEMES, themeById } from '../lib/themes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const PUBLIC = join(ROOT, 'public');
const OUT = join(ROOT, 'docs');
const DATA = join(OUT, 'data');
const RECENT_CHANGES_SRC = join(ROOT, 'worker', 'data', 'recent-changes.json');
const SOURCE_DATES_SRC = join(ROOT, 'worker', 'data', 'source-dates.json');
const HISTORY_DIR = join(ROOT, 'worker', 'data', 'history');

const COLOR_LEVEL = { groen: 1, geel: 2, oranje: 3, rood: 4 };
const LEVEL_COLOR = ['', 'groen', 'geel', 'oranje', 'rood'];

/**
 * Divergentie-werklijst: per land het NL-niveau naast de internationale
 * consensus (mediaan van de buitenlandse bronnen uit de laatste snapshot).
 * Gesorteerd op grootte van de afwijking — de redactionele "kijk hier eerst"-
 * lijst. Alleen landen met minstens 3 betrouwbaar beoordeelde bronnen.
 */
async function buildDivergence(nlColors) {
  if (!existsSync(HISTORY_DIR)) return null;
  const files = (await readdir(HISTORY_DIR)).filter((f) => f.endsWith('.json'));
  const items = [];
  for (const f of files) {
    const iso3 = f.replace(/\.json$/, '');
    const nl = nlColors.get(iso3);
    const nlLevel = nl ? COLOR_LEVEL[nl.color] : null;
    if (!nlLevel) continue;
    let hist;
    try { hist = JSON.parse(await readFile(join(HISTORY_DIR, f), 'utf8')); } catch { continue; }
    const last = hist.entries?.[hist.entries.length - 1];
    if (!last?.sources) continue;
    const perSource = {};
    const quotes = {};
    const levels = [];
    for (const [sid, s] of Object.entries(last.sources)) {
      // assessmentStatus ontbreekt bij sommige bronnen (dan geldt: ok).
      if (s.level == null || (s.assessmentStatus && s.assessmentStatus !== 'ok')) continue;
      perSource[sid] = s.level;
      if (s.levelLabel) quotes[sid] = s.levelLabel;
      levels.push(s.level);
    }
    if (levels.length < 3) continue;
    levels.sort((a, b) => a - b);
    const mid = Math.floor(levels.length / 2);
    const consensus = levels.length % 2 ? levels[mid] : Math.round((levels[mid - 1] + levels[mid]) / 2);
    items.push({
      iso3,
      nl: nl.name,
      nlColor: nl.color,
      nlLevel,
      consensusLevel: consensus,
      consensusColor: LEVEL_COLOR[consensus],
      delta: nlLevel - consensus,
      nSources: levels.length,
      perSource,
      quotes,
      snapshotDate: last.date || null,
    });
  }
  items.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.nl.localeCompare(b.nl, 'nl'));
  return { generatedAt: new Date().toISOString(), items };
}

/** Voert async taken uit met beperkte gelijktijdigheid. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          results[idx] = await fn(items[idx], idx);
        } catch (e) {
          results[idx] = { __error: String(e?.message || e), item: items[idx] };
        }
      }
    })
  );
  return results;
}

function searchBlocks(themes) {
  return themes.map((t) => ({
    category: t.category,
    heading: t.heading,
    themeId: t.themeId,
    themeLabel: t.themeId ? themeById(t.themeId)?.label || null : null,
    text: t.text,
  }));
}

async function main() {
  const started = Date.now();
  console.log('Statische build starten…');

  // Schone map + datastructuur
  await rm(OUT, { recursive: true, force: true });
  await mkdir(join(DATA, 'compare'), { recursive: true });
  await mkdir(join(DATA, 'search'), { recursive: true });

  // Frontend kopiëren
  await cp(PUBLIC, OUT, { recursive: true });

  // Cache-busting: app.js/styles.css krijgen een ?v=<build-timestamp>, zodat
  // een browser (of GitHub Pages' CDN) na elke nieuwe build gegarandeerd de
  // nieuwste versie ophaalt i.p.v. een gecachet bestand van vóór een fix.
  const buildVersion = String(started);
  const indexPath = join(OUT, 'index.html');
  const indexHtml = (await readFile(indexPath, 'utf8'))
    .replace('href="styles.css"', `href="styles.css?v=${buildVersion}"`)
    .replace('src="app.js"', `src="app.js?v=${buildVersion}"`);
  await writeFile(indexPath, indexHtml);

  // Metadata
  const countries = allCountries();
  await writeFile(join(DATA, 'countries.json'), JSON.stringify(countries));
  await writeFile(
    join(DATA, 'themes.json'),
    JSON.stringify(THEMES.map((t) => ({ id: t.id, label: t.label, group: t.group })))
  );

  const list = await nlSource.listAdvisories();
  console.log(`Nederlandse reisadviezen ophalen voor ${list.length} landen…`);

  // De buitenlandse vergelijking komt tijdens runtime live van de proxy
  // (Cloudflare Worker). De statische build bevat alleen de NL-data en de
  // NL-zoekindex.
  const nlIndex = [];
  const nlColors = new Map(); // iso3 -> { name, color } t.b.v. de divergentie-werklijst
  const nlDates = new Map(); // iso3 -> { name, color, date } t.b.v. het actualiteitsoverzicht
  let ok = 0;
  const failures = [];

  await mapLimit(list, 8, async (item) => {
    const iso = item.iso3;
    if (!iso) return;
    try {
      const nl = await nlSource.getAdvisory(iso);

      const payload = { country: { iso3: iso, nl: nl.name, en: item.nl }, nl };
      await writeFile(join(DATA, 'compare', `${iso}.json`), JSON.stringify(payload));

      if (nl.colors?.overall) nlColors.set(iso, { name: nl.name, color: nl.colors.overall });
      nlDates.set(iso, {
        name: nl.name,
        color: nl.colors?.overall || null,
        date: nl.lastModified ? String(nl.lastModified).slice(0, 10) : null,
      });
      nlIndex.push({
        iso3: iso,
        name: nl.name,
        url: nl.url,
        color: nl.colors?.overall || null,
        summaryText: nl.summaryText,
        blocks: searchBlocks(nl.themes),
      });
      ok++;
    } catch (e) {
      failures.push(`${iso}: ${e.message}`);
    }
  });

  nlIndex.sort((a, b) => a.name.localeCompare(b.name, 'nl'));
  await writeFile(join(DATA, 'search', 'nl.json'), JSON.stringify(nlIndex));

  // Recente wijzigingen bij buitenlandse bronnen (bijgehouden door de aparte
  // snapshot-workflow, zie .github/workflows/snapshot-changes.yml). Bestaat
  // niet bij de allereerste build — dan wordt de sectie leeg getoond.
  if (existsSync(RECENT_CHANGES_SRC)) {
    await cp(RECENT_CHANGES_SRC, join(DATA, 'recent-changes.json'));
  }
  if (existsSync(SOURCE_DATES_SRC)) {
    await cp(SOURCE_DATES_SRC, join(DATA, 'source-dates.json'));
  }

  // Trefwoordindex over de buitenlandse adviezen (a-z-shards uit de
  // snapshot-workflow; docs.json is bewust géén onderdeel van de site).
  const INDEX_SRC = join(ROOT, 'worker', 'data', 'foreign-index');
  if (existsSync(INDEX_SRC)) {
    await mkdir(join(DATA, 'foreign-index'), { recursive: true });
    for (const f of await readdir(INDEX_SRC)) {
      if (/^[a-z]\.json$/.test(f)) await cp(join(INDEX_SRC, f), join(DATA, 'foreign-index', f));
    }
  }

  // Divergentie-werklijst uit de laatste snapshot van de buitenlandse bronnen.
  const divergence = await buildDivergence(nlColors);
  if (divergence) {
    await writeFile(join(DATA, 'divergence.json'), JSON.stringify(divergence));
    console.log(`Divergentie-werklijst: ${divergence.items.length} landen (met ≥3 betrouwbare bronnen).`);
  }

  // Actualiteitsoverzicht (punt 7): NL-bijwerkdatum naast de recentste
  // bron-update per land, zodat "bronnen bijgewerkt, NL al lang niet" een
  // gesorteerde takenlijst wordt.
  const sourceDates = existsSync(SOURCE_DATES_SRC)
    ? (JSON.parse(await readFile(SOURCE_DATES_SRC, 'utf8')).dates || {})
    : {};
  const today = new Date();
  const ageItems = [];
  for (const [iso3, info] of nlDates) {
    const foreign = sourceDates[iso3] || {};
    const foreignDates = Object.values(foreign).filter(Boolean).sort();
    const latestForeign = foreignDates.length ? foreignDates[foreignDates.length - 1] : null;
    const nlAgeDays = info.date ? Math.floor((today - new Date(info.date)) / 86400000) : null;
    // "Achterstand": bron recenter bijgewerkt dan NL (positief = NL loopt achter).
    const behindDays = (info.date && latestForeign)
      ? Math.floor((new Date(latestForeign) - new Date(info.date)) / 86400000)
      : null;
    ageItems.push({
      iso3, nl: info.name, nlColor: info.color,
      nlDate: info.date, nlAgeDays,
      latestForeign, nForeign: foreignDates.length, behindDays,
    });
  }
  ageItems.sort((a, b) => (b.behindDays ?? -99999) - (a.behindDays ?? -99999));
  await writeFile(join(DATA, 'advisory-ages.json'), JSON.stringify({ generatedAt: new Date().toISOString(), items: ageItems }));

  // Seizoenskalender (punt 9): handmatige dataset met voorspelbare
  // natuurrisico's; de frontend toont een banner bij een actief seizoen.
  const SEASONS_SRC = join(ROOT, 'server', 'data', 'seasons.json');
  if (existsSync(SEASONS_SRC)) await cp(SEASONS_SRC, join(DATA, 'seasons.json'));

  // .nojekyll zodat GitHub Pages de map/bestanden ongemoeid laat.
  await writeFile(join(OUT, '.nojekyll'), '');

  // Bouwmoment voor de UI
  await writeFile(
    join(DATA, 'meta.json'),
    JSON.stringify({ builtAt: new Date().toISOString(), countries: ok })
  );

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Klaar in ${secs}s: ${ok} landen weggeschreven (NL-data + zoekindex).`);
  if (failures.length) {
    console.log(`\n${failures.length} land(en) overgeslagen:`);
    console.log(failures.join('\n'));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
