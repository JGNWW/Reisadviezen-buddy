/**
 * Nieuw-Zeeland — SafeTravel (safetravel.govt.nz), "Destinations".
 * Server-gerenderde pagina. Het landelijke adviesniveau staat prominent
 * bovenaan als vaste formulering; regio's kunnen een hoger niveau hebben
 * ("higher advice levels in some areas"). We leiden het landelijke niveau af
 * uit die kop-formulering — niet uit de hele paginatekst — zodat een
 * regionale escalatie het landelijke oordeel niet ten onrechte verhoogt.
 */
import { parse } from 'node-html-parser';
import { getText } from '../lib/fetch.js';
import { splitByHeadings, absolutiseLinks, htmlToText } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { analyzeAdvisory } from '../analysis/analysis-engine.js';
import { parseHumanDate } from '../lib/dates.js';

const SITE = 'https://www.safetravel.govt.nz';

export const meta = { id: 'nz', label: 'Nieuw-Zeeland (SafeTravel)', flag: '🇳🇿', lang: 'en' };

export async function getAdvisory(slug) {
  if (!slug) return null;
  const url = `${SITE}/destinations/${slug}`;
  const html = await getText(url);
  if (!html) return null;

  const root = parse(html);
  const main = root.querySelector('main') || root.querySelector('#main') || root;
  const themes = splitByHeadings(absolutiseLinks(main.innerHTML, SITE))
    .filter((s) => s.heading && s.text && s.text.length > 40)
    .filter((s) => !/^(consular assistance|nearest office|related news|share this|subscribe|about safetravel|register)/i.test(s.heading.trim()))
    .map((s) => ({ category: s.heading, heading: s.heading, themeId: classifyTheme(s.heading, s.text), html: s.html, text: s.text }));

  // "Updated 24 July 2025".
  const dm = htmlToText(html).match(/Updated\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i);
  const lastModified = dm ? parseHumanDate(dm[1]) : null;

  // Landelijk niveau = de EERST voorkomende niveau-formulering op de pagina
  // (het prominente kopadvies); de engine interpreteert de ruwe paginatekst.
  const assessment = analyzeAdvisory({
    sections: themes,
    lang: 'en',
    structured: { kind: 'nz_prominent_text', value: htmlToText(html) },
    countryName: slug ? slug.replace(/-/g, ' ') : null,
  });

  return {
    source: meta.id,
    sourceLabel: meta.label,
    flag: meta.flag,
    name: null,
    url,
    lastModified,
    updateNote: null,
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
