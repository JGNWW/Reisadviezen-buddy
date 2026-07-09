/**
 * Denemarken — Udenrigsministeriet (um.dk), "Rejsevejledninger".
 * Server-gerenderde pagina, Deenstalig. Het landelijke niveau staat in een
 * samenvattend blok direct na "Rejsevejledning opdateret … Gyldig …"; regio's
 * kunnen zwaarder zijn. We beoordelen alleen dat samenvattende blok (met
 * scope-detectie landelijk vs. regionaal) — nooit de hele pagina, die immers
 * alle regionale niveaus door elkaar noemt.
 */
import { parse } from 'node-html-parser';
import { getText } from '../lib/fetch.js';
import { splitByHeadings, absolutiseLinks, htmlToText } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { assessFromAnchoredText, REGIONAL_WORDS } from '../lib/level-assessment.js';
import { parseHumanDate } from '../lib/dates.js';

const SITE = 'https://um.dk';
const BASE = `${SITE}/rejse-og-ophold/rejse-til-udlandet/rejsevejledninger`;

export const meta = { id: 'dk', label: 'Denemarken (Udenrigsministeriet)', flag: '🇩🇰', lang: 'da' };

// Deense formuleringen -> niveau 1..4 (zwaar naar licht). "ikke-nødvendige"
// staat vóór het bredere "alle rejser" zodat de juiste variant eerst matcht.
const VIG_PATTERNS = [
  { re: /fraråder alle ikke-nødvendige rejser/i, level: 3 },
  { re: /fraråder alle rejser/i, level: 4 },
  { re: /vær ekstra forsigtig|skærpet (sikkerhed|forsigtighed)/i, level: 2 },
  { re: /vær forsigtig/i, level: 2 },
  // "Vær opmærksom" (wees oplettend) is de laagste categorie van um.dk = groen.
  { re: /vær opmærksom|ingen særlige|normale forholdsregler|ingen (særlig )?rejsevejledning/i, level: 1 },
];

/** Maandnamen NB: Deense datums zijn dd.mm.yyyy — direct te normaliseren. */
function danishDate(html) {
  const m = html.match(/opdateret:\s*(\d{2})\.(\d{2})\.(\d{4})/i);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

export async function getAdvisory(slug) {
  if (!slug) return null;
  const url = `${BASE}/${slug}`;
  const html = await getText(url);
  if (!html) return null;

  const text = htmlToText(html);
  // Anker: het samenvattende blok begint bij "Gyldig: <datum>" en loopt tot de
  // eerste inhoudelijke sectiekop. Neem een ruime maar begrensde window.
  const gyldig = text.search(/Gyldig:\s*\d{2}\.\d{2}\.\d{4}/i);
  const start = gyldig >= 0 ? gyldig : 0;
  const anchor = text.slice(start, start + 700);
  const assessment = assessFromAnchoredText(anchor, VIG_PATTERNS, REGIONAL_WORDS.da);

  // um.dk toont regionale afwijkingen als gekleurde "bjælker" (balken). De
  // zwaarste die genoemd wordt bepaalt regionalMaxLevel; is die hoger dan het
  // landelijke niveau, dan zijn er regionale waarschuwingen.
  let barMax = null;
  if (/r[øo]de? bj[æa]lke/i.test(anchor)) barMax = 4;
  else if (/orange bj[æa]lke/i.test(anchor)) barMax = 3;
  else if (/gule? bj[æa]lke/i.test(anchor)) barMax = 2;
  const natLevel = assessment.level;
  const regionalMaxLevel = Math.max(natLevel || 0, barMax || 0) || assessment.regionalMaxLevel;
  const hasRegionalWarnings = assessment.hasRegionalWarnings || (barMax != null && natLevel != null && barMax > natLevel);

  const root = parse(html);
  const main = root.querySelector('main') || root.querySelector('article') || root;
  const themes = splitByHeadings(absolutiseLinks(main.innerHTML, SITE))
    .filter((s) => s.heading && s.text && s.text.length > 40)
    .filter((s) => !/^(del med|del på|abonner|kontakt|følg os|se også|relaterede|cookie)/i.test(s.heading.trim()))
    .map((s) => ({ category: s.heading, heading: s.heading, themeId: classifyTheme(s.heading, s.text), html: s.html, text: s.text }));

  return {
    source: meta.id,
    sourceLabel: meta.label,
    flag: meta.flag,
    name: null,
    url,
    lastModified: danishDate(html),
    updateNote: null,
    level: assessment.level,
    color: assessment.color,
    levelLabel: assessment.explanation,
    regionalMaxLevel,
    hasRegionalWarnings,
    confidence: assessment.confidence,
    assessmentStatus: assessment.assessmentStatus,
    hasMap: false,
    themes,
    fullText: themes.map((t) => t.text).join('\n'),
  };
}
