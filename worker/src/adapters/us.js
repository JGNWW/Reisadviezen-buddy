/**
 * Verenigde Staten — State Department (travel.state.gov).
 * Niveau uit de titelkop; inhoud uit het advies-tekstblok. VS-adviezen zijn
 * weinig thematisch onderverdeeld; we tonen het samenvattende blok.
 */
import { parse } from 'node-html-parser';
import { getTextResolved } from '../lib/fetch.js';
import { htmlToText, splitByHeadings, absolutiseLinks } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { usLevel, levelToColor } from '../lib/levels.js';
import { parseHumanDate } from '../lib/dates.js';

const SITE = 'https://travel.state.gov';
const BASE = `${SITE}/content/travel/en/traveladvisories/traveladvisories`;

export const meta = { id: 'us', label: 'Verenigde Staten (State Dept)', flag: '🇺🇸', lang: 'en' };

export async function getAdvisory(slug) {
  if (!slug) return null;
  // travel.state.gov migreert geleidelijk naar een nieuwe URL-structuur:
  // sommige landen 301-redirecten al naar /en/international-travel/...
  // De Text-Fragment-deeplinks in de matrix vereisen de UITEINDELIJKE URL
  // (waar de tekst daadwerkelijk staat), dus gebruik de na-redirect URL i.p.v.
  // de aangevraagde.
  const requestUrl = `${BASE}/${slug}-travel-advisory.html`;
  const resolved = await getTextResolved(requestUrl);
  if (!resolved) return null;
  const { text: html, url } = resolved;

  // Niveau uit "... - Level N: ..." kop.
  const lvlMatch = html.match(/Level\s*([1-4])\s*[:\-–]/i);
  const level = lvlMatch ? usLevel(lvlMatch[1]) : null;
  const labelMatch = html.match(/Level\s*[1-4]\s*[:\-–]\s*([A-Za-z ]{3,40})/i);
  const levelLabel = labelMatch ? `Level ${lvlMatch[1]}: ${labelMatch[1].trim()}` : null;

  // Uitgiftedatum van het advies zelf ("Date issued: June 12, 2026") —
  // betrouwbaarder dan de paginavoettekst-datum, die bij elke site-aanpassing
  // kan verschuiven.
  const issued = html.match(/Date issued:?\s*<[^>]*>?\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i) || html.match(/Date issued:?\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i);
  const lastModified = issued ? parseHumanDate(issued[1]) : null;

  const root = parse(html);
  const main =
    root.querySelector('.tsg-rwd-content-page-parsysxxx') ||
    root.querySelector('#inner-content') ||
    root.querySelector('#content') ||
    null;
  // travel.state.gov migreert geleidelijk naar een nieuwe, tab-gebaseerde
  // layout zonder de klassieke content-wrapper hierboven — de tekst zit dan
  // in losse .usa-prose-blokken (niet genest) die we samenvoegen. Zonder
  // deze val-terug bleef `main` de HELE pagina (root), waardoor <title>,
  // navigatie en scripts als "inhoud" werden meegescrapet.
  const mainHtml = main
    ? main.innerHTML
    : root.querySelectorAll('.usa-prose').map((n) => n.innerHTML).join('\n') || root.innerHTML;

  // Splits op koppen indien aanwezig; anders het hele blok als één thema.
  let sections = splitByHeadings(absolutiseLinks(mainHtml, SITE)).filter(
    (s) => s.text && s.text.length > 40
  );
  if (sections.length === 0) {
    const text = htmlToText(mainHtml);
    sections = text ? [{ heading: null, html: mainHtml, text }] : [];
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
    lastModified,
    updateNote: null,
    level,
    color: levelToColor(level),
    levelLabel,
    hasMap: false,
    themes,
    fullText: themes.map((t) => t.text).join('\n'),
  };
}
