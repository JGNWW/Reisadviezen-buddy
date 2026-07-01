import * as nlSource from '../sources/nl.js';
import * as ukSource from '../sources/uk.js';
import { classifyTheme, themeById } from './themes.js';
import { snippetAround } from './html.js';
import { getCountryByIso, getUkSlug } from './countries.js';

/**
 * Voert een reeks async taken uit met een maximale gelijktijdigheid.
 */
async function mapLimit(items, limit, fn) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (e) {
        results[idx] = { error: String(e?.message || e), item: items[idx] };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// ---- NL-index -------------------------------------------------------------

let nlIndex = null; // { builtAt, byIso: Map }
let nlIndexPromise = null;

async function buildNlIndex() {
  const list = await nlSource.listAdvisories();
  const byIso = new Map();
  await mapLimit(list, 8, async (item) => {
    if (!item.iso3) return;
    const adv = await nlSource.getAdvisory(item.iso3);
    byIso.set(item.iso3, {
      iso3: adv.iso3,
      name: adv.name,
      url: adv.url,
      color: adv.colors?.overall || null,
      summaryText: adv.summaryText,
      blocks: adv.themes.map((t) => ({
        category: t.category,
        heading: t.heading,
        themeId: t.themeId,
        text: t.text,
      })),
    });
  });
  nlIndex = { builtAt: Date.now(), byIso };
  return nlIndex;
}

export function nlIndexStatus() {
  return {
    ready: !!nlIndex,
    building: !!nlIndexPromise && !nlIndex,
    countries: nlIndex ? nlIndex.byIso.size : 0,
    builtAt: nlIndex?.builtAt || null,
  };
}

export async function ensureNlIndex() {
  if (nlIndex) return nlIndex;
  if (!nlIndexPromise) {
    nlIndexPromise = buildNlIndex().finally(() => {
      nlIndexPromise = null;
    });
  }
  return nlIndexPromise;
}

/**
 * Zoekt een zoekwoord/thema in alle NL-reisadviezen.
 * Retourneert per land de matchende blokken (met thema + snippet).
 */
export async function searchNl(term) {
  const idx = await ensureNlIndex();
  const t = term.toLowerCase();
  const results = [];
  for (const entry of idx.byIso.values()) {
    const matches = [];
    for (const block of entry.blocks) {
      if (block.text.toLowerCase().includes(t)) {
        matches.push({
          category: block.category,
          heading: block.heading,
          theme: block.themeId ? themeById(block.themeId)?.label : null,
          themeId: block.themeId,
          snippet: snippetAround(block.text, term),
        });
      }
    }
    // Ook de samenvatting doorzoeken.
    const inSummary = entry.summaryText.toLowerCase().includes(t);
    if (matches.length || inSummary) {
      results.push({
        iso3: entry.iso3,
        name: entry.name,
        url: entry.url,
        color: entry.color,
        inSummary,
        summarySnippet: inSummary ? snippetAround(entry.summaryText, term) : null,
        matches,
        matchCount: matches.length + (inSummary ? 1 : 0),
      });
    }
  }
  results.sort((a, b) => b.matchCount - a.matchCount || a.name.localeCompare(b.name));
  return results;
}

// ---- Buitenlandse index (FCDO) -------------------------------------------

async function getForeign(iso3) {
  const slug = getUkSlug(iso3);
  if (!slug) return null;
  return ukSource.getAdvisory(slug);
}

/**
 * Zoekt een zoekwoord/thema in buitenlandse reisadviezen.
 * scope: 'country' (één land) of 'all' (alle landen met een koppeling).
 */
export async function searchForeign(term, { iso3 = null } = {}) {
  const t = term.toLowerCase();
  let targets;
  if (iso3) {
    targets = [iso3.toUpperCase()];
  } else {
    // Alle landen die een NL-advies hebben én een FCDO-koppeling.
    const list = await nlSource.listAdvisories();
    targets = list.map((c) => c.iso3).filter((iso) => getUkSlug(iso));
  }

  const advisories = await mapLimit(targets, 8, async (iso) => {
    const adv = await getForeign(iso);
    return adv ? { iso, adv } : null;
  });

  const results = [];
  for (const row of advisories) {
    if (!row || row.error || !row.adv) continue;
    const { iso, adv } = row;
    const country = getCountryByIso(iso);
    const matches = [];
    for (const block of adv.themes) {
      if (block.text.toLowerCase().includes(t)) {
        matches.push({
          category: block.category,
          heading: block.heading,
          theme: block.themeId ? themeById(block.themeId)?.label : null,
          themeId: block.themeId,
          snippet: snippetAround(block.text, term),
        });
      }
    }
    if (matches.length) {
      results.push({
        iso3: iso,
        name: country?.nl || adv.name,
        source: 'uk',
        sourceLabel: adv.sourceLabel,
        url: adv.url,
        matches,
        matchCount: matches.length,
      });
    }
  }
  results.sort((a, b) => b.matchCount - a.matchCount || a.name.localeCompare(b.name));
  return results;
}
