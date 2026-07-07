/**
 * Ierland — Department of Foreign Affairs (dfa.ie).
 * Niveau uit de `security-status`-class; thema's uit de kopstructuur.
 */
import { parse } from 'node-html-parser';
import { getText } from '../lib/fetch.js';
import { htmlToText, splitByHeadings, absolutiseLinks } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { levelToColor } from '../lib/levels.js';

const SITE = 'https://www.dfa.ie';
const BASE = `${SITE}/travel/travel-advice/a-z-list-of-countries`;

export const meta = { id: 'ie', label: 'Ierland (DFA)', flag: '🇮🇪', lang: 'en' };

const STATUS_LEVEL = { normal: 1, 'high-caution': 2, avoid: 3, 'do-not': 4 };
const STATUS_LABEL = {
  normal: 'Normal precautions',
  'high-caution': 'High degree of caution',
  avoid: 'Avoid non-essential travel',
  'do-not': 'Do not travel',
};

export async function getAdvisory(slug) {
  if (!slug) return null;
  const url = `${BASE}/${slug}/`;
  const html = await getText(url);
  if (!html) return null;

  // Huidige status staat in class="... security-status <mod>" (niet de
  // __status--legenda). De modifier is een los class-token.
  const m = html.match(/class="[^"]*\bsecurity-status\s+(normal|high-caution|avoid|do-not)\b/i);
  const status = m ? m[1].toLowerCase() : null;
  const level = status ? STATUS_LEVEL[status] : null;

  // DFA verstopt per contentblok een "updated-date" (RFC-datum) in de HTML;
  // de recentste daarvan is de beste benadering van "laatst bijgewerkt".
  let lastModified = null;
  for (const dm of html.matchAll(/class="updated-date"[^>]*>([^<]+)</gi)) {
    const d = new Date(dm[1].trim());
    if (!isNaN(d)) {
      const isoDate = d.toISOString().slice(0, 10);
      if (!lastModified || isoDate > lastModified) lastModified = isoDate;
    }
  }

  const root = parse(html);
  const main =
    root.querySelector('.main-body--general-content') ||
    root.querySelector('.main-body') ||
    root.querySelector('main') ||
    root;
  const sections = splitByHeadings(absolutiseLinks(main.innerHTML, SITE))
    .filter((s) => s.heading && s.text && s.text.length > 20)
    .filter((s) => !/^(security status|share|related|contact|overview$)/i.test(s.heading.trim()));

  const themes = sections.map((s) => ({
    category: s.heading,
    heading: s.heading,
    themeId: classifyTheme(s.heading, s.text),
    html: s.html,
    text: s.text,
  }));

  // "Latest Travel Alert" is DFA's eigen mededeling over de recentste wijziging.
  const alert = themes.find((t) => /^latest travel alert/i.test(t.heading.trim()));
  const updateNote = alert ? alert.text.slice(0, 400) : null;

  return {
    source: meta.id,
    sourceLabel: meta.label,
    flag: meta.flag,
    name: null,
    url,
    lastModified,
    updateNote,
    level,
    color: levelToColor(level),
    levelLabel: status ? STATUS_LABEL[status] : null,
    hasMap: false,
    themes,
    fullText: themes.map((t) => t.text).join('\n'),
  };
}
