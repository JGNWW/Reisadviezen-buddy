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
import { parseHumanDate } from '../lib/dates.js';

const SITE = 'https://www.safetravel.govt.nz';

export const meta = { id: 'nz', label: 'Nieuw-Zeeland (SafeTravel)', flag: '🇳🇿', lang: 'en' };

// SafeTravel-niveaus (van licht naar zwaar), met bijbehorende schaal 1..4.
const LEVELS = [
  { re: /exercise normal safety( and security)? precautions/i, level: 1 },
  { re: /exercise increased caution/i, level: 2 },
  { re: /avoid non-essential travel/i, level: 3 },
  { re: /do not travel/i, level: 4 },
];
const LEVEL_COLOR = ['', 'groen', 'geel', 'oranje', 'rood'];
const LEVEL_LABEL = {
  1: 'Exercise normal safety precautions', 2: 'Exercise increased caution',
  3: 'Avoid non-essential travel', 4: 'Do not travel',
};

export async function getAdvisory(slug) {
  if (!slug) return null;
  const url = `${SITE}/destinations/${slug}`;
  const html = await getText(url);
  if (!html) return null;

  // Landelijk niveau = de EERST voorkomende niveau-formulering in de pagina
  // (de prominente kop bovenaan), niet de hoogste ergens op de pagina.
  let national = null;
  for (const l of LEVELS) {
    const m = html.match(l.re);
    if (m && (national === null || m.index < national.index)) national = { level: l.level, index: m.index };
  }

  // Regionale escalatie: SafeTravel meldt dit expliciet.
  const hasRegional = /higher advice levels? in some areas|higher advice level applies|regional advice/i.test(html);

  const root = parse(html);
  const main = root.querySelector('main') || root.querySelector('#main') || root;
  const themes = splitByHeadings(absolutiseLinks(main.innerHTML, SITE))
    .filter((s) => s.heading && s.text && s.text.length > 40)
    .filter((s) => !/^(consular assistance|nearest office|related news|share this|subscribe|about safetravel|register)/i.test(s.heading.trim()))
    .map((s) => ({ category: s.heading, heading: s.heading, themeId: classifyTheme(s.heading, s.text), html: s.html, text: s.text }));

  // "Updated 24 July 2025".
  const dm = htmlToText(html).match(/Updated\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i);
  const lastModified = dm ? parseHumanDate(dm[1]) : null;

  const level = national?.level ?? null;
  const regionalMaxLevel = hasRegional ? 4 : (level || null);
  return {
    source: meta.id,
    sourceLabel: meta.label,
    flag: meta.flag,
    name: null,
    url,
    lastModified,
    updateNote: null,
    level,
    color: level ? LEVEL_COLOR[level] : null,
    levelLabel: level ? LEVEL_LABEL[level] : null,
    regionalMaxLevel,
    hasRegionalWarnings: hasRegional,
    confidence: level ? 'high' : 'low',
    assessmentStatus: level ? 'ok' : 'uncertain',
    hasMap: false,
    themes,
    fullText: themes.map((t) => t.text).join('\n'),
  };
}
