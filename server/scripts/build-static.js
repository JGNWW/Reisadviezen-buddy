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
import { mkdir, writeFile, rm, cp } from 'node:fs/promises';
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
  let ok = 0;
  const failures = [];

  await mapLimit(list, 8, async (item) => {
    const iso = item.iso3;
    if (!iso) return;
    try {
      const nl = await nlSource.getAdvisory(iso);

      const payload = { country: { iso3: iso, nl: nl.name, en: item.nl }, nl };
      await writeFile(join(DATA, 'compare', `${iso}.json`), JSON.stringify(payload));

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
