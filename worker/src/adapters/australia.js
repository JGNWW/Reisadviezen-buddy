/**
 * Australië — Smartraveller (smartraveller.gov.au).
 * Smartraveller blokkeert datacenter-IP's, dus we halen de pagina op via de
 * publieke reader-proxy (r.jina.ai). Niveau uit het "overall advice level";
 * thema's uit de kopstructuur.
 */
import { parse } from 'node-html-parser';
import { getViaReader } from '../lib/fetch.js';
import { splitByHeadings, absolutiseLinks, htmlToText } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { textToLevel, levelToColor } from '../lib/levels.js';

const SITE = 'https://www.smartraveller.gov.au';

export const meta = { id: 'au', label: 'Australië (Smartraveller)', flag: '🇦🇺', lang: 'en' };

const LEVEL_LABEL = {
  1: 'Exercise normal safety precautions',
  2: 'Exercise a high degree of caution',
  3: 'Reconsider your need to travel',
  4: 'Do not travel',
};

export async function getAdvisory(id) {
  if (!id) return null;
  // id = { continent, slug }
  const { continent, slug } = typeof id === 'string' ? { continent: null, slug: id } : id;
  const url = continent ? `${SITE}/destinations/${continent}/${slug}` : `${SITE}/destinations/${slug}`;
  const html = await getViaReader(url, 'html');
  if (!html) return null;

  const root = parse(html);

  // Overall advice level: het element met class/id 'overall-advice-level'.
  let level = null;
  const overall = root.querySelector('[id*="overall-advice-level" i], [class*="overall-advice-level" i]');
  if (overall) level = textToLevel(overall.textContent);
  if (!level) {
    // Fallback: de zin met "overall".
    const m = htmlToText(html).match(/[^.]*\boverall\b[^.]*\./i);
    if (m) level = textToLevel(m[0]);
  }

  const KNOWN = /^(latest update|safety|security|health|local laws|travel|local contacts|full advice|terrorism|crime|civil unrest|natural disasters|climate|getting around)/i;
  const NAV = /^(global alert|main navigation|police|ambulance|fire|advice levels|read more|subscribe|sign up|follow|get help|emergency|before you go|explore|footer|smartraveller|search|related|about|contact|newsletter|share)/i;
  const themes = splitByHeadings(absolutiseLinks(root.innerHTML, SITE))
    .filter((s) => s.heading && s.text && s.text.length > 60)
    .map((s) => ({ category: s.heading, heading: s.heading, themeId: classifyTheme(s.heading, s.text), html: s.html, text: s.text }))
    // Houd alleen herkenbare advies-secties of blokken die op een thema mappen.
    .filter((t) => !NAV.test(t.heading.trim()) && (t.themeId || KNOWN.test(t.heading.trim())));

  return {
    source: meta.id,
    sourceLabel: meta.label,
    flag: meta.flag,
    name: null,
    url,
    lastModified: null,
    level,
    color: levelToColor(level),
    levelLabel: level ? LEVEL_LABEL[level] : null,
    hasMap: false,
    themes,
    fullText: themes.map((t) => t.text).join('\n'),
  };
}
