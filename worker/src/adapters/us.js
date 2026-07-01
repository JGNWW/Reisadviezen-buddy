/**
 * Verenigde Staten — State Department (travel.state.gov).
 * Niveau uit de titelkop; inhoud uit het advies-tekstblok. VS-adviezen zijn
 * weinig thematisch onderverdeeld; we tonen het samenvattende blok.
 */
import { parse } from 'node-html-parser';
import { getText } from '../lib/fetch.js';
import { htmlToText, splitByHeadings, absolutiseLinks } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { usLevel, levelToColor } from '../lib/levels.js';

const SITE = 'https://travel.state.gov';
const BASE = `${SITE}/content/travel/en/traveladvisories/traveladvisories`;

export const meta = { id: 'us', label: 'Verenigde Staten (State Dept)', flag: '🇺🇸', lang: 'en' };

export async function getAdvisory(slug) {
  if (!slug) return null;
  const url = `${BASE}/${slug}-travel-advisory.html`;
  const html = await getText(url);
  if (!html) return null;

  // Niveau uit "... - Level N: ..." kop.
  const lvlMatch = html.match(/Level\s*([1-4])\s*[:\-–]/i);
  const level = lvlMatch ? usLevel(lvlMatch[1]) : null;
  const labelMatch = html.match(/Level\s*[1-4]\s*[:\-–]\s*([A-Za-z ]{3,40})/i);
  const levelLabel = labelMatch ? `Level ${lvlMatch[1]}: ${labelMatch[1].trim()}` : null;

  const root = parse(html);
  const main =
    root.querySelector('.tsg-rwd-content-page-parsysxxx') ||
    root.querySelector('#inner-content') ||
    root.querySelector('#content') ||
    root;

  // Splits op koppen indien aanwezig; anders het hele blok als één thema.
  let sections = splitByHeadings(absolutiseLinks(main.innerHTML, SITE)).filter(
    (s) => s.text && s.text.length > 40
  );
  if (sections.length === 0) {
    const text = htmlToText(main.innerHTML);
    sections = text ? [{ heading: null, html: main.innerHTML, text }] : [];
  }

  const themes = sections.map((s) => ({
    category: 'Travel advisory',
    heading: s.heading || 'Country summary',
    themeId: classifyTheme(s.heading || 'safety security', s.text),
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
    levelLabel,
    hasMap: false,
    themes,
    fullText: themes.map((t) => t.text).join('\n'),
  };
}
