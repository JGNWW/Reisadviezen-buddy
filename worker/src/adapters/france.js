/**
 * Frankrijk — France Diplomatie (diplomatie.gouv.fr), "Conseils aux voyageurs".
 * Franstalig; de Worker kan de teksten op verzoek naar NL vertalen.
 *
 * Niveau: France Diplomatie publiceert geen gestructureerd niveauveld (in
 * tegenstelling tot het VK). Daarom wordt gezocht in een geïdentificeerd
 * samenvattend sectieblok ("Situation sécuritaire" o.i.d.) — nooit in de hele
 * pagina — met scope-detectie (landelijk vs. regionaal), zie
 * worker/src/analysis/ voor de gedeelde interpretatie.
 */
import { parse } from 'node-html-parser';
import { getText } from '../lib/fetch.js';
import { splitByHeadings, absolutiseLinks, htmlToText } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { analyzeAdvisory } from '../analysis/analysis-engine.js';
import { parseHumanDate } from '../lib/dates.js';

const SITE = 'https://www.diplomatie.gouv.fr';
const BASE = `${SITE}/fr/conseils-aux-voyageurs/conseils-par-pays-destination`;

export const meta = { id: 'fr', label: 'Frankrijk (France Diplomatie)', flag: '🇫🇷', lang: 'fr' };

// Kop van het samenvattende blok (het anker voor het landelijke oordeel).
const ANCHOR_HEADING = /^(situation s[ée]curitaire|s[ée]curit[ée]|s[ûu]ret[ée]|recommandations? g[ée]n[ée]rales?)/i;

export async function getAdvisory(slug) {
  if (!slug) return null;
  const url = `${BASE}/${slug}/`;
  const html = await getText(url);
  if (!html) return null;

  const root = parse(html);
  const main = root.querySelector('main') || root.querySelector('#main-content') || root;

  // Paginadatum ("Dernière mise à jour le : 7 avril 2026").
  const dateMatch = htmlToText(html).match(/Derni[eè]re mise [aà] jour le\s*:?\s*(\d{1,2}\s+\S+\s+\d{4})/i);
  const lastModified = dateMatch ? parseHumanDate(dateMatch[1]) : null;

  const rawSections = splitByHeadings(absolutiseLinks(main.innerHTML, SITE))
    .filter((s) => s.heading && s.text && s.text.length > 60);

  // "Dernières minutes" is France Diplomatie's eigen blok met recente
  // wijzigingen — bewaren als notitie vóór het als boilerplate wegvalt.
  const minutes = rawSections.find((s) => /derni[eè]res? minutes/i.test(s.heading.trim()) && !/Conseils aux voyageurs.*Derni[eè]res minutes/i.test(s.text));
  const updateNote = minutes ? minutes.text.slice(0, 400) : null;

  const BOILER = /^(navigation|menu|partager|sommaire|derni[eè]re|en r[eé]sum|fil d|vous voyagez|donnez-nous|urgence attentat|présentation|nos ambassades|à découvrir|sur le m[êe]me)/i;
  const sections = rawSections
    .filter((s) => !BOILER.test(s.heading.trim()))
    // Nav-dumps bevatten typisch de hele menustructuur op één regel.
    .filter((s) => !/Conseils aux voyageurs.*Derni[eè]res minutes/i.test(s.text));

  const themes = sections.map((s) => ({
    category: s.heading,
    heading: s.heading,
    themeId: classifyTheme(s.heading, s.text),
    html: s.html,
    text: s.text,
  }));

  // Landelijk oordeel + regionale vermeldingen via de gedeelde engine: het
  // anker is de sectie die de algemene veiligheidssituatie beschrijft, niet
  // de regiospecifieke subsecties die er in documentvolgorde op volgen.
  const assessment = analyzeAdvisory({
    sections: themes,
    lang: 'fr',
    anchorHeadingRe: ANCHOR_HEADING,
  });

  return {
    source: meta.id,
    sourceLabel: meta.label,
    flag: meta.flag,
    name: null,
    url,
    lastModified,
    updateNote,
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
