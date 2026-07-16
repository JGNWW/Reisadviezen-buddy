/**
 * Zwitserland — Eidgenössisches Departement für auswärtige Angelegenheiten
 * (EDA, eda.admin.ch, "Reisehinweise").
 *
 * De nieuwe /fr/conseils-…-pagina's zijn een client-side SPA (leeg zonder
 * JavaScript), maar de klassieke Duitstalige URL's zijn server-gerenderd:
 *   /eda/de/home/vertretungen-und-reisehinweise/{slug}/reisehinweise-fuer{slug}.html
 * De padmapping staat in countries.json (sources.ch, gebouwd door
 * scripts/build-ch-map.mjs uit de Wayback-CDX; eda.admin.ch blokkeert
 * datacenter-IP's, dus ophalen probeert direct/CORS-proxy en valt terug op
 * de reader).
 *
 * Niveau is tekstueel (EDA kent geen cijferschaal): "Von Reisen nach X …
 * wird abgeraten" (zwaarste vorm, 4) vs "Von touristischen/nicht dringenden
 * Reisen wird abgeraten" (3) — zie de Zwitserse patronen in de
 * ernst-detector ('de'). De advieszin staat in het intro-blok vóór de
 * eerste kop; dat blok is het anker.
 */
import { getText, getViaReader } from '../lib/fetch.js';
import { splitByHeadings, absolutiseLinks } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { analyzeAdvisory } from '../analysis/analysis-engine.js';

const SITE = 'https://www.eda.admin.ch';
const BASE = `${SITE}/eda/de/home/vertretungen-und-reisehinweise`;

export const meta = { id: 'ch', label: 'Zwitserland (EDA)', flag: '🇨🇭', lang: 'de' };

// Navigatie-/voetkoppen zonder adviesinhoud.
const SKIP_HEADING = /l[äa]nderunabh[äa]ngige|fokusthemen|n[üu]tzliche adressen|kontakt\b|footer|navigation|suche\b/i;

export async function getAdvisory(pathRel) {
  if (!pathRel) return null;
  const url = `${BASE}/${pathRel}`;
  let html = null;
  try {
    html = await getText(url);
  } catch {
    html = await getViaReader(url, 'html');
  }
  if (!html) return null;

  const sections = splitByHeadings(absolutiseLinks(html, SITE));
  // De kern-advieszin ("Diese Reisehinweise sind überprüft … Von Reisen
  // nach X wird abgeraten.") staat aan het EINDE van het blok vóór de
  // eerste kop (daarvóór zit de complete site-navigatie) — neem de staart.
  const intro = sections.find((s) => !s.heading && s.text && /reisehinweise/i.test(s.text));
  const anchorText = intro ? intro.text.slice(-4000) : null;

  const themes = sections
    .filter((s) => s.heading && s.text && s.text.length > 60 && !SKIP_HEADING.test(s.heading))
    .map((s) => ({
      category: s.heading,
      heading: s.heading,
      themeId: classifyTheme(s.heading, s.text),
      html: s.html,
      text: s.text,
      url,
    }));
  if (!themes.length && !anchorText) return null;

  const assessment = analyzeAdvisory({
    sections: themes,
    lang: 'de',
    anchorText: anchorText || undefined,
    countryName: (pathRel.split('/')[0] || '').replace(/-/g, ' '),
  });

  // "Diese Reisehinweise … (Stand: 25.01.2026)" of vergelijkbare datering.
  const dm = html.match(/(?:Stand|aktualisiert am|publiziert am)[^0-9]{0,10}(\d{1,2})\.(\d{1,2})\.(\d{4})/i);
  const lastModified = dm ? `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}` : null;

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
