/**
 * Snapshot van buitenlandse reisadviezen — houdt bij welke landen een
 * wijziging kregen bij VK/VS/Canada/Ierland/Frankrijk/Australië/Spanje,
 * en wat die wijziging inhield. Dit gaat NIET over de Nederlandse
 * reisadviezen (die worden door NederlandWereldwijd zelf bijgehouden en
 * bij elke build al vers opgehaald) — alleen over de buitenlandse bronnen,
 * die verder alleen live (per bezoek) worden opgevraagd en dus zonder dit
 * script geen geschiedenis hebben.
 *
 * Draait dagelijks via .github/workflows/snapshot-changes.yml, commit de
 * resultaten terug naar de repo:
 *   worker/data/history/<ISO3>.json   volledige (compacte) geschiedenis per land
 *   worker/data/recent-changes.json   platte, gesorteerde lijst met de laatste
 *                                     wijzigingen over alle landen heen
 *
 * Bij een fout of lege respons voor een bron wordt die bron dit keer
 * overgeslagen (het vorige snapshot blijft staan) — een tijdelijke
 * netwerk-hik mag nooit als "bron niet meer beschikbaar" gerapporteerd
 * worden.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import countries from '../src/data/countries.json' with { type: 'json' };
import * as uk from '../src/adapters/uk.js';
import * as us from '../src/adapters/us.js';
import * as canada from '../src/adapters/canada.js';
import * as ireland from '../src/adapters/ireland.js';
import * as france from '../src/adapters/france.js';
import * as australia from '../src/adapters/australia.js';
import * as spain from '../src/adapters/spain.js';
import { setReaderKey, setCorsProxy } from '../src/lib/fetch.js';

setReaderKey(process.env.JINA_KEY);
setCorsProxy(process.env.CORS_PROXY_URL);

const ADAPTERS = { uk, us, ca: canada, ie: ireland, fr: france, au: australia, es: spain };
const LEVEL_COLOR = ['', 'groen', 'geel', 'oranje', 'rood'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_DIR = path.join(__dirname, '..', 'data', 'history');
const CHANGES_FILE = path.join(__dirname, '..', 'data', 'recent-changes.json');
const MAX_ENTRIES_PER_COUNTRY = 60;
const MAX_CHANGES = 300;
const CONCURRENCY = 5;

/** Compacte, diff-vriendelijke vorm — alleen wat nodig is om wijzigingen te herkennen. */
function compact(adv) {
  return {
    level: adv.level ?? null,
    color: adv.color ?? null,
    regionalMaxLevel: adv.regionalMaxLevel ?? null,
    hasRegionalWarnings: !!adv.hasRegionalWarnings,
    assessmentStatus: adv.assessmentStatus ?? null,
    regionalBreakdown: (adv.regionalBreakdown || []).map((r) => ({ region: r.region, level: r.level })),
  };
}

function regionKey(region) {
  return region.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Vergelijkt twee compacte snapshots van dezelfde bron en geeft leesbare wijzigingen terug. */
function diffSource(before, after) {
  const changes = [];

  if (before.level !== after.level) {
    changes.push({
      kind: (after.level ?? 0) > (before.level ?? 0) ? 'up' : 'down',
      description: `Landelijk niveau gewijzigd van ${before.color || 'onbekend'} naar ${after.color || 'onbekend'}.`,
    });
  }
  if (before.assessmentStatus !== after.assessmentStatus) {
    changes.push({
      kind: 'status',
      description: after.assessmentStatus === 'uncertain'
        ? 'Landelijke beoordeling is nu onzeker (geen betrouwbare niveau-formulering meer gevonden in de brontekst).'
        : 'Landelijke beoordeling kon nu wel betrouwbaar worden vastgesteld.',
    });
  }

  const beforeMap = new Map((before.regionalBreakdown || []).map((r) => [regionKey(r.region), r]));
  const afterMap = new Map((after.regionalBreakdown || []).map((r) => [regionKey(r.region), r]));

  for (const [key, r] of afterMap) {
    const prev = beforeMap.get(key);
    if (!prev) {
      changes.push({ kind: 'regional-new', description: `Nieuwe regionale vermelding: "${r.region}" (${LEVEL_COLOR[r.level] || '?'}).` });
    } else if (prev.level !== r.level) {
      changes.push({
        kind: r.level > prev.level ? 'regional-up' : 'regional-down',
        description: `Regionale vermelding "${r.region}" gewijzigd van ${LEVEL_COLOR[prev.level] || '?'} naar ${LEVEL_COLOR[r.level] || '?'}.`,
      });
    }
  }
  for (const [key, r] of beforeMap) {
    if (!afterMap.has(key)) {
      changes.push({ kind: 'regional-removed', description: `Regionale vermelding "${r.region}" komt niet meer voor.` });
    }
  }
  return changes;
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx], idx);
      }
    })
  );
}

async function main() {
  mkdirSync(HISTORY_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);

  let entries = Object.entries(countries).filter(
    ([, rec]) => rec.sources && Object.values(rec.sources).some(Boolean)
  );
  // Handig voor handmatig testen: SNAPSHOT_LIMIT=3 node scripts/snapshot-foreign.mjs
  if (process.env.SNAPSHOT_LIMIT) entries = entries.slice(0, Number(process.env.SNAPSHOT_LIMIT));

  const priorChanges = existsSync(CHANGES_FILE)
    ? JSON.parse(readFileSync(CHANGES_FILE, 'utf8')).changes || []
    : [];
  const newChanges = [];
  let checked = 0;
  let failed = 0;

  await mapLimit(entries, CONCURRENCY, async ([iso3, rec]) => {
    const histFile = path.join(HISTORY_DIR, `${iso3}.json`);
    const hist = existsSync(histFile) ? JSON.parse(readFileSync(histFile, 'utf8')) : { iso3, entries: [] };
    const lastEntry = hist.entries[hist.entries.length - 1] || null;
    // Begin bij het vorige snapshot; bronnen die dit keer mislukken behouden hun laatste bekende staat.
    const nextSnapshot = { ...(lastEntry?.sources || {}) };
    let changedAny = false;

    for (const [sid, adapter] of Object.entries(ADAPTERS)) {
      const id = rec.sources[sid];
      if (!id) continue;
      checked++;
      let adv = null;
      try {
        adv = await adapter.getAdvisory(id);
      } catch {
        adv = null;
      }
      if (!adv) { failed++; continue; } // tijdelijke fout: vorige staat behouden, geen diff

      const after = compact(adv);
      const before = lastEntry?.sources?.[sid];
      nextSnapshot[sid] = after;
      if (!before) continue; // eerste keer voor deze bron: niets om mee te vergelijken

      const diffs = diffSource(before, after);
      if (diffs.length) {
        changedAny = true;
        diffs.forEach((d) => newChanges.push({
          date: today,
          iso3,
          countryNl: rec.nl,
          source: sid,
          sourceLabel: adapter.meta.label,
          flag: adapter.meta.flag,
          ...d,
        }));
      }
    }

    if (!lastEntry || changedAny) {
      hist.entries.push({ date: today, sources: nextSnapshot });
      if (hist.entries.length > MAX_ENTRIES_PER_COUNTRY) hist.entries = hist.entries.slice(-MAX_ENTRIES_PER_COUNTRY);
      writeFileSync(histFile, JSON.stringify(hist));
    }
  });

  const allChanges = [...newChanges, ...priorChanges]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, MAX_CHANGES);
  writeFileSync(CHANGES_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), changes: allChanges }));

  console.log(`Snapshot klaar: ${entries.length} landen, ${checked} bron-aanvragen (${failed} mislukt/overgeslagen), ${newChanges.length} wijziging(en) gevonden vandaag.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
