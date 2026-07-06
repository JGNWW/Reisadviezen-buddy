/**
 * Verenigd Koninkrijk — FCDO, via de GOV.UK Content API.
 * Kaart: gescrapet van de gov.uk-adviespagina (staat niet in de content-API).
 */
import { parse } from 'node-html-parser';
import { getJson, getText } from '../lib/fetch.js';
import { htmlToText, splitByHeadings, absolutiseLinks } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { assessUkAlertStatus } from '../lib/level-assessment.js';

const API = 'https://www.gov.uk/api/content/foreign-travel-advice';
const SITE = 'https://www.gov.uk';

export const meta = { id: 'uk', label: 'Verenigd Koninkrijk (FCDO)', flag: '🇬🇧', lang: 'en' };

export async function getAdvisory(slug) {
  if (!slug) return null;
  const d = await getJson(`${API}/${slug}`);
  if (!d) return null;
  const det = d.details || {};
  const parts = det.parts || [];

  const fullTextParts = [];
  const themes = [];
  for (const part of parts) {
    const partHtml = absolutiseLinks(part.body || '', SITE);
    fullTextParts.push(htmlToText(partHtml));
    const sections = splitByHeadings(partHtml);
    const intro = sections.find((s) => !s.heading);
    const subs = sections.filter((s) => s.heading);
    if (subs.length === 0) {
      const text = htmlToText(partHtml);
      themes.push({ category: part.title, heading: part.title, themeId: classifyTheme(part.title, text), html: partHtml, text });
    } else {
      if (intro && intro.text) {
        themes.push({ category: part.title, heading: part.title, themeId: classifyTheme(part.title, intro.text), html: intro.html, text: intro.text });
      }
      for (const s of subs) {
        themes.push({ category: part.title, heading: s.heading, themeId: classifyTheme(s.heading, s.text) || classifyTheme(part.title, s.text), html: s.html, text: s.text });
      }
    }
  }

  const fullText = fullTextParts.join('\n');
  // Niveau komt uit het gestructureerde GOV.UK alert_status-veld, niet uit
  // vrije tekst — zie worker/src/lib/level-assessment.js voor de reden
  // (regionale waarschuwingen escaleerden anders ten onrechte het hele land).
  const assessment = assessUkAlertStatus(det.alert_status);
  return {
    source: meta.id,
    sourceLabel: meta.label,
    flag: meta.flag,
    name: det.country?.name || d.title,
    url: `${SITE}${d.base_path || '/foreign-travel-advice/' + slug}`,
    lastModified: det.updated_at || det.reviewed_at || null,
    level: assessment.level,
    color: assessment.color,
    levelLabel: assessment.explanation,
    regionalMaxLevel: assessment.regionalMaxLevel,
    hasRegionalWarnings: assessment.hasRegionalWarnings,
    confidence: assessment.confidence,
    assessmentStatus: assessment.assessmentStatus,
    alertStatus: det.alert_status || [],
    hasMap: true,
    themes,
    fullText,
  };
}

/** Scrapet de kaartafbeelding-URL van de gov.uk-adviespagina. */
export async function resolveMapUrl(slug) {
  if (!slug) return null;
  const html = await getText(`${SITE}/foreign-travel-advice/${slug}`);
  if (!html) return null;
  const root = parse(html);
  // FCDO toont de kaart als <img> in de map-sectie (map__image o.i.d.).
  const img =
    root.querySelector('.map img') ||
    root.querySelector('img[src*="/map"]') ||
    root.querySelector('figure img[src*="assets"]');
  let src = img?.getAttribute('src') || null;
  if (src && src.startsWith('/')) src = SITE + src;
  return src;
}
