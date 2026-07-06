/**
 * Frankrijk — France Diplomatie (diplomatie.gouv.fr), "Conseils aux voyageurs".
 * Franstalig; de Worker kan de teksten op verzoek naar NL vertalen.
 *
 * Niveau: France Diplomatie publiceert geen gestructureerd niveauveld (in
 * tegenstelling tot het VK). Daarom wordt gezocht in een geïdentificeerd
 * samenvattend sectieblok ("Situation sécuritaire" o.i.d.) — nooit in de hele
 * pagina — met scope-detectie (landelijk vs. regionaal), zie
 * worker/src/lib/level-assessment.js voor de achtergrond.
 */
import { parse } from 'node-html-parser';
import { getText } from '../lib/fetch.js';
import { splitByHeadings, absolutiseLinks, htmlToText } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { assessFromAnchoredText, extractRegionalMentions, findBestMatch, mergeRegionalMax, REGIONAL_WORDS } from '../lib/level-assessment.js';

const SITE = 'https://www.diplomatie.gouv.fr';
const BASE = `${SITE}/fr/conseils-aux-voyageurs/conseils-par-pays-destination`;

export const meta = { id: 'fr', label: 'Frankrijk (France Diplomatie)', flag: '🇫🇷', lang: 'fr' };

// Franse vigilance-niveaus, van zwaar naar licht (eerste match in het anker-
// blok telt); "normale"/"renforcée" zijn doorgaans sowieso landelijke termen.
const VIGILANCE_PATTERNS = [
  { re: /formellement d[ée]conseill[ée]/i, level: 4 },
  { re: /d[ée]conseill[ée] sauf raison imp[ée]rative/i, level: 3 },
  { re: /vigilance renforc[ée]e/i, level: 2 },
  { re: /vigilance normale/i, level: 1 },
];

const ANCHOR_HEADING = /^(situation s[ée]curitaire|s[ée]curit[ée]|s[ûu]ret[ée]|recommandations? g[ée]n[ée]rales?)/i;

export async function getAdvisory(slug) {
  if (!slug) return null;
  const url = `${BASE}/${slug}/`;
  const html = await getText(url);
  if (!html) return null;

  const root = parse(html);
  const main = root.querySelector('main') || root.querySelector('#main-content') || root;

  const BOILER = /^(navigation|menu|partager|sommaire|derni[eè]re|en r[eé]sum|fil d|vous voyagez|donnez-nous|urgence attentat|présentation|nos ambassades|à découvrir|sur le m[êe]me)/i;
  const sections = splitByHeadings(absolutiseLinks(main.innerHTML, SITE))
    .filter((s) => s.heading && s.text && s.text.length > 60)
    .filter((s) => !BOILER.test(s.heading.trim()))
    // Nav-dumps bevatten typisch de hele menustructuur op één regel.
    .filter((s) => !/Conseils aux voyageurs.*Derni[eè]res minutes/i.test(s.text));

  // Anker: de sectie die de algemene veiligheidssituatie beschrijft (niet
  // regiospecifieke subsecties die er in documentvolgorde vaak op volgen).
  const anchor = sections.find((s) => ANCHOR_HEADING.test(s.heading.trim())) || sections[0] || null;
  const assessment = assessFromAnchoredText(anchor?.text || '', VIGILANCE_PATTERNS, REGIONAL_WORDS.fr);
  // regionalBreakdown is aanvullend bewijs, geen vervanging van het
  // landelijke oordeel hierboven — zie worker/src/lib/level-assessment.js.
  const anchorBest = anchor?.text ? findBestMatch(anchor.text, VIGILANCE_PATTERNS) : null;
  const regionalBreakdown = extractRegionalMentions({
    sections: sections.filter((s) => s !== anchor),
    anchorText: anchor?.text || '',
    anchorSkipMatch: anchorBest,
    patterns: VIGILANCE_PATTERNS,
    regionalWordsRe: REGIONAL_WORDS.fr,
  });
  const regionalMaxLevel = mergeRegionalMax(assessment.regionalMaxLevel, regionalBreakdown);
  const hasRegionalWarnings = assessment.hasRegionalWarnings || regionalBreakdown.length > 0;

  const themes = sections.map((s) => ({
    category: s.heading,
    heading: s.heading,
    themeId: classifyTheme(s.heading, s.text),
    html: s.html,
    text: s.text,
  }));

  return {
    source: meta.id,
    sourceLabel: meta.label,
    flag: meta.flag,
    name: null,
    url,
    lastModified: null,
    level: assessment.level,
    color: assessment.color,
    levelLabel: assessment.explanation,
    regionalMaxLevel,
    hasRegionalWarnings,
    regionalBreakdown: regionalBreakdown.length ? regionalBreakdown : null,
    regionalCoverage: hasRegionalWarnings ? 'partial' : null,
    confidence: assessment.confidence,
    assessmentStatus: assessment.assessmentStatus,
    hasMap: false,
    themes,
    fullText: themes.map((t) => t.text).join('\n'),
  };
}
