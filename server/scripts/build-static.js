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
 *   docs/data/search/foreign.json          (zoekindex buitenlandse adviezen)
 *
 * Kaartafbeeldingen worden NIET gedownload: de frontend hotlinkt ze
 * rechtstreeks vanaf de open data (cross-origin <img> werkt zonder CORS).
 *
 * Draaien: npm run build
 */
import { mkdir, writeFile, rm, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as nlSource from '../sources/nl.js';
import * as ukSource from '../sources/uk.js';
import { allCountries, getUkSlug } from '../lib/countries.js';
import { buildThemeComparison, buildColorComparison } from '../lib/compare.js';
import { THEMES, themeById } from '../lib/themes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const PUBLIC = join(ROOT, 'public');
const OUT = join(ROOT, 'docs');
const DATA = join(OUT, 'data');

const FOREIGN_SOURCES = { uk: ukSource };

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
    join(DATA, 'sources.json'),
    JSON.stringify(Object.values(FOREIGN_SOURCES).map((s) => s.meta))
  );
  await writeFile(
    join(DATA, 'themes.json'),
    JSON.stringify(THEMES.map((t) => ({ id: t.id, label: t.label, group: t.group })))
  );

  const list = await nlSource.listAdvisories();
  console.log(`Reisadviezen ophalen en vergelijken voor ${list.length} landen…`);

  const nlIndex = [];
  const foreignIndex = [];
  let ok = 0;
  let withUk = 0;
  const failures = [];

  await mapLimit(list, 8, async (item) => {
    const iso = item.iso3;
    if (!iso) return;
    try {
      const nl = await nlSource.getAdvisory(iso);

      // Buitenlandse bronnen ophalen
      const foreignList = [];
      const unavailable = [];
      for (const [sid, src] of Object.entries(FOREIGN_SOURCES)) {
        const slug = sid === 'uk' ? getUkSlug(iso) : null;
        const adv = slug ? await src.getAdvisory(slug) : null;
        if (adv) foreignList.push(adv);
        else unavailable.push({ source: sid, label: src.meta.label });
      }
      if (foreignList.length) withUk++;

      const payload = {
        country: { iso3: iso, nl: nl.name, en: item.nl },
        nl,
        foreign: foreignList,
        unavailable,
        colorComparison: buildColorComparison(nl, foreignList),
        themeComparison: buildThemeComparison(nl, foreignList),
      };
      await writeFile(join(DATA, 'compare', `${iso}.json`), JSON.stringify(payload));

      // Zoekindexen vullen
      nlIndex.push({
        iso3: iso,
        name: nl.name,
        url: nl.url,
        color: nl.colors?.overall || null,
        summaryText: nl.summaryText,
        blocks: searchBlocks(nl.themes),
      });
      for (const f of foreignList) {
        foreignIndex.push({
          iso3: iso,
          name: nl.name,
          source: f.source,
          sourceLabel: f.sourceLabel,
          url: f.url,
          blocks: searchBlocks(f.themes),
        });
      }
      ok++;
    } catch (e) {
      failures.push(`${iso}: ${e.message}`);
    }
  });

  nlIndex.sort((a, b) => a.name.localeCompare(b.name, 'nl'));
  foreignIndex.sort((a, b) => a.name.localeCompare(b.name, 'nl'));
  await writeFile(join(DATA, 'search', 'nl.json'), JSON.stringify(nlIndex));
  await writeFile(join(DATA, 'search', 'foreign.json'), JSON.stringify(foreignIndex));

  // .nojekyll zodat GitHub Pages de map/bestanden ongemoeid laat.
  await writeFile(join(OUT, '.nojekyll'), '');

  // Bouwmoment voor de UI
  await writeFile(
    join(DATA, 'meta.json'),
    JSON.stringify({ builtAt: new Date().toISOString(), countries: ok, withForeign: withUk })
  );

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `Klaar in ${secs}s: ${ok} landen weggeschreven (${withUk} met buitenlands advies).`
  );
  if (failures.length) {
    console.log(`\n${failures.length} land(en) overgeslagen:`);
    console.log(failures.join('\n'));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
