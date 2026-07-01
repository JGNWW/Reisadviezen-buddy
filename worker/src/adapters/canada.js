/**
 * Canada — Global Affairs Canada (travel.gc.ca).
 * Niveau uit de officiële JSON-index (advisory-state); thema's + regiokaart
 * uit de adviespagina.
 */
import { parse } from 'node-html-parser';
import { getText, getJson } from '../lib/fetch.js';
import { splitByHeadings, absolutiseLinks } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { canadaStateToLevel, levelToColor } from '../lib/levels.js';

const SITE = 'https://travel.gc.ca';
const INDEX = 'https://data.international.gc.ca/travel-voyage/index-alpha-eng.json';

export const meta = { id: 'ca', label: 'Canada (Global Affairs)', flag: '🇨🇦', lang: 'en' };

let indexCache = null;
let indexAt = 0;
async function getIndex() {
  if (indexCache && Date.now() - indexAt < 30 * 60 * 1000) return indexCache;
  const d = await getJson(INDEX);
  indexCache = d?.data || {};
  indexAt = Date.now();
  return indexCache;
}

const STATE_LABEL = {
  0: 'Take normal security precautions',
  1: 'Exercise a high degree of caution',
  2: 'Avoid non-essential travel',
  3: 'Avoid all travel',
};

export async function getAdvisory(id) {
  if (!id) return null;
  const { iso2, slug } = typeof id === 'string' ? { iso2: id, slug: id } : id;

  const index = await getIndex();
  const entry = iso2 ? index[iso2] : null;
  const state = entry ? entry['advisory-state'] : null;
  const level = state != null ? canadaStateToLevel(state) : null;

  const url = `${SITE}/destinations/${slug}`;
  const html = await getText(url);
  const themes = [];
  let mapUrl = null;
  if (html) {
    const root = parse(html);
    const main = root.querySelector('main') || root.querySelector('#wb-cont')?.parentNode || root;
    const sections = splitByHeadings(absolutiseLinks(main.innerHTML, SITE))
      .filter((s) => s.heading && s.text && s.text.length > 25)
      .filter((s) => !/^(search|menu|you are here|language|contact|share|on this page|risk levels|table of contents|about this)/i.test(s.heading.trim()));
    for (const s of sections) {
      themes.push({ category: s.heading, heading: s.heading, themeId: classifyTheme(s.heading, s.text), html: s.html, text: s.text });
    }
    const img =
      root.querySelector('img[src*="map"]') ||
      root.querySelector('img[alt*="map" i]') ||
      root.querySelector('.mrgn-tp-md img[src*=".png"]');
    let src = img?.getAttribute('src') || null;
    if (src && src.startsWith('/')) src = SITE + src;
    mapUrl = src;
  }

  return {
    source: meta.id,
    sourceLabel: meta.label,
    flag: meta.flag,
    name: entry ? entry['country-eng'] : null,
    url,
    lastModified: entry?.['date-published']?.date || null,
    level,
    color: levelToColor(level),
    levelLabel: state != null ? STATE_LABEL[state] : null,
    hasMap: !!mapUrl,
    mapUrl,
    themes,
    fullText: themes.map((t) => t.text).join('\n'),
  };
}

export async function resolveMapUrl(id) {
  const adv = await getAdvisory(id);
  return adv?.mapUrl || null;
}
