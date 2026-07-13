/**
 * Duitsland — Auswärtiges Amt, "Reise- und Sicherheitshinweise".
 * Gebruikt de officiële open API (JSON): één index-call geeft alle landen met
 * ISO3-code, en een detail-call per land geeft de content, de wijzigingsnotitie
 * en gestructureerde waarschuwingsvlaggen. Het niveau komt dus uit die vlaggen
 * (niet uit vrije tekst) — vergelijkbaar met de betrouwbaarheid van het VK.
 */
import { getJson } from '../lib/fetch.js';
import { splitByHeadings, absolutiseLinks, htmlToText } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';

const SITE = 'https://www.auswaertiges-amt.de';
const INDEX = `${SITE}/opendata/travelwarning`;

/**
 * Bouwt de publieke landpagina-slug zoals het Auswärtiges Amt die zelf
 * gebruikt: kleine letters, umlauten getranslitereerd, en alle spaties/
 * koppeltekens/leestekens verwijderd (niet vervangen door een koppelteken!)
 * — bijv. "Saudi-Arabien" → "saudiarabien", "Côte d'Ivoire" → "cotedivoire".
 * Eerder gebruikten we `naam.toLowerCase()` zonder deze transliteratie/
 * opschoning, wat voor de meeste landen toevallig een 404 opleverde.
 */
function countrySlug(name) {
  return (name || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');
}

export const meta = { id: 'de', label: 'Duitsland (Auswärtiges Amt)', flag: '🇩🇪', lang: 'de' };

let indexCache = null;
let indexAt = 0;
/** ISO3 -> content-id, uit de index (30 min gecachet). */
async function getIndex() {
  if (indexCache && Date.now() - indexAt < 30 * 60 * 1000) return indexCache;
  const d = await getJson(INDEX);
  const map = {};
  for (const [id, v] of Object.entries(d?.response || {})) {
    if (id === 'lastModified' || !v || typeof v !== 'object') continue;
    if (v.iso3CountryCode) map[v.iso3CountryCode.toUpperCase()] = id;
  }
  indexCache = map;
  indexAt = Date.now();
  return indexCache;
}

/** Leidt niveau/kleur af uit de gestructureerde waarschuwingsvlaggen. */
function assess(e) {
  // Volledige reiswaarschuwing voor het hele land.
  if (e.warning) {
    return {
      level: 4, color: 'rood', regionalMaxLevel: 4, hasRegionalWarnings: !!e.partialWarning,
      confidence: 'high', assessmentStatus: 'ok',
      levelLabel: 'Reisewarnung (het Auswärtiges Amt raadt reizen af).',
    };
  }
  // Teilreisewarnung: waarschuwing voor delen van het land, niet landelijk.
  if (e.partialWarning) {
    return {
      level: 1, color: 'groen', regionalMaxLevel: 4, hasRegionalWarnings: true,
      confidence: 'high', assessmentStatus: 'ok',
      levelLabel: 'Teilreisewarnung: reiswaarschuwing voor delen van het land, niet landelijk.',
    };
  }
  // Landelijke situatie-/veiligheidsaanwijzing zonder reiswaarschuwing.
  if (e.situationWarning) {
    return {
      level: 2, color: 'geel', regionalMaxLevel: 2, hasRegionalWarnings: false,
      confidence: 'medium', assessmentStatus: 'ok',
      levelLabel: 'Sicherheitshinweis: verhoogde aandacht voor het hele land.',
    };
  }
  if (e.situationPartWarning) {
    return {
      level: 1, color: 'groen', regionalMaxLevel: 2, hasRegionalWarnings: true,
      confidence: 'medium', assessmentStatus: 'ok',
      levelLabel: 'Regionale veiligheidsaanwijzing voor delen van het land.',
    };
  }
  return {
    level: 1, color: 'groen', regionalMaxLevel: null, hasRegionalWarnings: false,
    confidence: 'high', assessmentStatus: 'ok',
    levelLabel: 'Geen reiswaarschuwing of veiligheidsaanwijzing.',
  };
}

export async function getAdvisory(iso3) {
  if (!iso3) return null;
  const index = await getIndex();
  const id = index[String(iso3).toUpperCase()];
  if (!id) return null;

  const d = await getJson(`${INDEX}/${id}`);
  const e = d?.response?.[id];
  if (!e) return null;

  const html = absolutiseLinks(e.content || '', SITE);
  const themes = splitByHeadings(html)
    .filter((s) => s.heading && s.text && s.text.length > 30)
    .map((s) => ({ category: s.heading, heading: s.heading, themeId: classifyTheme(s.heading, s.text), html: s.html, text: s.text }));

  const a = assess(e);
  // "Letzte Änderungen: ..." → nette wijzigingsnotitie.
  const note = e.lastChanges ? htmlToText(e.lastChanges).replace(/^Letzte Änderungen:\s*/i, '').trim() : null;

  return {
    source: meta.id,
    sourceLabel: meta.label,
    flag: meta.flag,
    name: e.countryName || null,
    url: `${SITE}/de/aussenpolitik/laender/${countrySlug(e.countryName)}-node`,
    lastModified: e.lastModified ? new Date(e.lastModified * 1000).toISOString() : null,
    updateNote: note || null,
    level: a.level,
    color: a.color,
    levelLabel: a.levelLabel,
    regionalMaxLevel: a.regionalMaxLevel,
    hasRegionalWarnings: a.hasRegionalWarnings,
    confidence: a.confidence,
    assessmentStatus: a.assessmentStatus,
    hasMap: false,
    themes,
    fullText: themes.map((t) => t.text).join('\n'),
  };
}
