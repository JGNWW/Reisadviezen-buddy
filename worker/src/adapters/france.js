/**
 * Frankrijk — France Diplomatie (diplomatie.gouv.fr), "Conseils aux voyageurs".
 * Franstalig; de Worker kan de teksten op verzoak naar NL vertalen.
 * Niveau uit de "vigilance"-formulering; thema's uit de kopstructuur.
 */
import { parse } from 'node-html-parser';
import { getText } from '../lib/fetch.js';
import { splitByHeadings, absolutiseLinks, htmlToText } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { levelToColor } from '../lib/levels.js';

const SITE = 'https://www.diplomatie.gouv.fr';
const BASE = `${SITE}/fr/conseils-aux-voyageurs/conseils-par-pays-destination`;

export const meta = { id: 'fr', label: 'Frankrijk (France Diplomatie)', flag: '🇫🇷', lang: 'fr' };

// Franse vigilance-niveaus -> 1..4 (groen/geel/oranje/rood).
const VIGILANCE = [
  { re: /formellement d[ée]conseill[ée]/i, level: 4 },
  { re: /d[ée]conseill[ée] sauf raison imp[ée]rative/i, level: 3 },
  { re: /vigilance renforc[ée]e/i, level: 2 },
  { re: /vigilance normale/i, level: 1 },
];
const VIGILANCE_LABEL = { 1: 'Vigilance normale', 2: 'Vigilance renforcée', 3: 'Déconseillé sauf raison impérative', 4: 'Formellement déconseillé' };

function overallLevel(text) {
  // Het algemene niveau staat doorgaans bovenaan; pak de eerste vermelding in
  // documentvolgorde.
  let best = null, bestIdx = Infinity;
  for (const v of VIGILANCE) {
    const m = text.match(v.re);
    if (m && m.index < bestIdx) { bestIdx = m.index; best = v.level; }
  }
  return best;
}

export async function getAdvisory(slug) {
  if (!slug) return null;
  const url = `${BASE}/${slug}/`;
  const html = await getText(url);
  if (!html) return null;

  const root = parse(html);
  const main = root.querySelector('main') || root.querySelector('#main-content') || root;
  const mainText = htmlToText(main.innerHTML).slice(0, 4000);
  const level = overallLevel(mainText);

  const BOILER = /^(navigation|menu|partager|sommaire|derni[eè]re|en r[eé]sum|fil d|vous voyagez|donnez-nous|urgence attentat|présentation|nos ambassades|à découvrir|sur le m[êe]me)/i;
  const sections = splitByHeadings(absolutiseLinks(main.innerHTML, SITE))
    .filter((s) => s.heading && s.text && s.text.length > 60)
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

  return {
    source: meta.id,
    sourceLabel: meta.label,
    flag: meta.flag,
    name: null,
    url,
    lastModified: null,
    level,
    color: levelToColor(level),
    levelLabel: level ? VIGILANCE_LABEL[level] : null,
    hasMap: false,
    themes,
    fullText: themes.map((t) => t.text).join('\n'),
  };
}
