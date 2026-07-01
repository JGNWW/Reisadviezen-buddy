import { themeById, orderThemes } from './themes.js';

/**
 * Groepeert de thema-blokken van een genormaliseerd reisadvies per canoniek
 * thema-id. Blokken zonder herkenbaar thema komen onder de sleutel '_other'.
 */
function indexByTheme(advisory) {
  const map = new Map();
  for (const block of advisory?.themes || []) {
    const key = block.themeId || '_other';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(block);
  }
  return map;
}

/**
 * Bouwt de thematische vergelijking tussen het NL-advies en één of meer
 * buitenlandse adviezen.
 *
 * Retourneert:
 *  - themes: [{ theme, nl: [blocks], foreign: {source: [blocks]} }] in vaste volgorde
 *  - missingFromNl: thema's die minstens één buitenlandse bron behandelt en NL niet
 *  - onlyNl: thema's die alleen NL behandelt
 */
export function buildThemeComparison(nl, foreignList) {
  const nlIdx = indexByTheme(nl);
  const foreignIdx = foreignList.map((f) => ({ source: f.source, label: f.sourceLabel, idx: indexByTheme(f) }));

  // Alle thema-ids die ergens voorkomen, in taxonomie-volgorde.
  const allIds = new Set([...nlIdx.keys()]);
  for (const f of foreignIdx) for (const k of f.idx.keys()) allIds.add(k);
  const ordered = orderThemes([...allIds].filter((id) => id !== '_other'));
  if (allIds.has('_other')) ordered.push('_other');

  const themes = [];
  const missingFromNl = [];
  const onlyNl = [];

  for (const id of ordered) {
    const theme =
      id === '_other'
        ? { id: '_other', label: 'Overige / niet ingedeeld', group: 'Overig' }
        : themeById(id);
    const nlBlocks = nlIdx.get(id) || [];
    const foreign = {};
    let foreignHasIt = false;
    for (const f of foreignIdx) {
      const blocks = f.idx.get(id) || [];
      foreign[f.source] = { label: f.label, blocks };
      if (blocks.length) foreignHasIt = true;
    }

    themes.push({ theme, nl: nlBlocks, foreign, nlHasIt: nlBlocks.length > 0, foreignHasIt });

    if (id !== '_other') {
      if (nlBlocks.length === 0 && foreignHasIt) missingFromNl.push({ theme, foreign });
      if (nlBlocks.length > 0 && !foreignHasIt) onlyNl.push({ theme });
    }
  }

  return { themes, missingFromNl, onlyNl };
}

/**
 * Vergelijkt de kleurcodes.
 */
export function buildColorComparison(nl, foreignList) {
  return {
    nl: {
      source: 'nl',
      label: 'NederlandWereldwijd',
      overall: nl?.colors?.overall || null,
      colors: nl?.colors?.colors || [],
    },
    foreign: foreignList.map((f) => ({
      source: f.source,
      label: f.sourceLabel,
      flag: f.flag,
      mappedColor: f.mappedColor,
      basis: f.mappedColorBasis,
      alertStatus: f.alertStatus || [],
      url: f.url,
    })),
  };
}
