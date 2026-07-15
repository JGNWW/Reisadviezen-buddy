/**
 * Finland — Ulkoministeriö (um.fi), "matkustustiedote". Server-gerenderd
 * (Liferay), rechtstreeks op ISO2:
 *
 *   https://um.fi/matkustustiedote/-/c/{ISO2}
 *
 * Het landelijke niveau staat als vast "Turvallisuustaso"-veld bovenaan
 * (één van vier vaste formuleringen — zie de fi-patronen in de
 * ernst-detector); de rest van de pagina heeft schone h2-secties
 * (Yleinen turvallisuustilanne, Rikollisuus, Liikenne, Terveys, …).
 */
import { parse } from 'node-html-parser';
import { getText } from '../lib/fetch.js';
import { htmlToText, splitByHeadings, absolutiseLinks } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { analyzeAdvisory } from '../analysis/analysis-engine.js';

const SITE = 'https://um.fi';

export const meta = { id: 'fi', label: 'Finland (Ulkoministeriö)', flag: '🇫🇮', lang: 'fi' };

// Koppen die geen adviesinhoud zijn (navigatie/voettekst van de pagina).
const SKIP_HEADING = /kieliversiot|yhteystiedot|ennen matkaa|ulkoministeri[öo]|verkkosivuston|sosiaalinen media/i;

export async function getAdvisory(iso2) {
  if (!iso2) return null;
  const url = `${SITE}/matkustustiedote/-/c/${String(iso2).toUpperCase()}`;
  const html = await getText(url);
  if (!html) return null;
  const root = parse(html);

  // Turvallisuustaso-blok (gestructureerd niveauveld).
  const levelNode = root.querySelector('.safetylevel, #safetyLevelMainLevel');
  const levelText = levelNode ? htmlToText(levelNode.innerHTML) : '';
  if (!levelText) return null; // geen matkustustiedote voor dit land

  // Het advies-artikel: de portlet-body van de travelbulletin-portlet (de
  // eerste voorouder met die class) — dáár staan de advies-h2's; hogerop
  // zitten menu's en voetteksten van de hele site.
  let article = levelNode.parentNode;
  while (article && !(article.getAttribute?.('class') || '').includes('portlet-body')) {
    article = article.parentNode;
  }
  const bodyHtml = absolutiseLinks((article || levelNode).innerHTML, SITE);

  const themes = splitByHeadings(bodyHtml)
    .filter((s) => s.heading && s.text && s.text.length > 40 && !SKIP_HEADING.test(s.heading))
    .map((s) => ({
      category: s.heading,
      heading: s.heading,
      themeId: classifyTheme(s.heading, s.text),
      html: s.html,
      text: s.text,
      url,
    }));

  // "Muut turvallisuustason tiedot" (toelichting bij het niveau) zit vóór de
  // eerste h2 en komt via het niveaublok mee; als eerste thema opnemen.
  if (levelText.length > 60) {
    themes.unshift({
      category: 'Turvallisuustaso',
      heading: 'Turvallisuustaso',
      themeId: classifyTheme('safety security turvallisuus', levelText),
      html: null,
      text: levelText,
      url,
    });
  }
  if (!themes.length) return null;

  const assessment = analyzeAdvisory({
    sections: themes,
    lang: 'fi',
    structured: { kind: 'fi_security_level', value: levelText },
    countryName: null,
  });

  // Wijzigingsdatum: als data-attribuut in de pagina-meta
  // (data-modifydate="2026-06-05T14:20:22.260").
  const dm = html.match(/data-modifydate="(\d{4}-\d{2}-\d{2})/) || html.match(/data-display-date="(\d{4}-\d{2}-\d{2})/);
  const lastModified = dm ? dm[1] : null;

  return {
    source: meta.id,
    sourceLabel: meta.label,
    flag: meta.flag,
    name: htmlToText(root.querySelector('.country-name')?.innerHTML || '').split(':')[0].trim() || null,
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
