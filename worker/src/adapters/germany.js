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
import { analyzeAdvisory } from '../analysis/analysis-engine.js';

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

export async function getAdvisory(iso3) {
  if (!iso3) return null;
  const index = await getIndex();
  const id = index[String(iso3).toUpperCase()];
  if (!id) return null;

  const d = await getJson(`${INDEX}/${id}`);
  const e = d?.response?.[id];
  if (!e) return null;

  // Publieke URL van de "Reise- und Sicherheitshinweise"-pagina zelf, met het
  // opendata-content-ID in het pad — NIET de politieke landenpagina
  // (/de/aussenpolitik/laender/{slug}-node), waar het reisadvies niet staat.
  const slug = countrySlug(e.countryName);
  const publicUrl = `${SITE}/de/service/laender/${slug}-node/${slug}sicherheit-${id}`;

  const html = absolutiseLinks(e.content || '', SITE);
  const themes = splitByHeadings(html)
    .filter((s) => s.heading && s.text && s.text.length > 30)
    .map((s) => ({ category: s.heading, heading: s.heading, themeId: classifyTheme(s.heading, s.text), html: s.html, text: s.text }));

  // Landelijk niveau uit de gestructureerde waarschuwingsvlaggen van de
  // opendata-API; regionale vermeldingen ("Vor Reisen in das Grenzgebiet zu X
  // wird gewarnt") uit de Duitse tekst — beide via de gedeelde engine.
  const assessment = analyzeAdvisory({
    sections: themes,
    lang: 'de',
    structured: {
      kind: 'de_warning_flags',
      value: {
        warning: !!e.warning, partialWarning: !!e.partialWarning,
        situationWarning: !!e.situationWarning, situationPartWarning: !!e.situationPartWarning,
      },
    },
    countryName: e.countryName || null,
  });
  // "Letzte Änderungen: ..." → nette wijzigingsnotitie.
  const note = e.lastChanges ? htmlToText(e.lastChanges).replace(/^Letzte Änderungen:\s*/i, '').trim() : null;

  return {
    source: meta.id,
    sourceLabel: meta.label,
    flag: meta.flag,
    name: e.countryName || null,
    url: publicUrl,
    lastModified: e.lastModified ? new Date(e.lastModified * 1000).toISOString() : null,
    updateNote: note || null,
    level: assessment.level,
    color: assessment.color,
    levelLabel: assessment.levelLabel,
    regionalMaxLevel: assessment.regionalMaxLevel,
    hasRegionalWarnings: assessment.hasRegionalWarnings,
    regionalBreakdown: assessment.regionalBreakdown,
    regionalCoverage: assessment.regionalCoverage,
    regions: assessment.regions,
    confidence: assessment.confidence,
    assessmentStatus: assessment.assessmentStatus,
    hasMap: false,
    themes,
    fullText: themes.map((t) => t.text).join('\n'),
  };
}
