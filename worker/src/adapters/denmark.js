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
import { analyzeAdvisory } from '../analysis/analysis-engine.js';
import { parseHumanDate } from '../lib/dates.js';
import { SEVERITY_LABELS } from '../analysis/severity-detector.js';

// Deense standaardtekst voor "geen bijzonderheden": als er niets aan de hand
// is, toont um.dk alleen de generieke veiligheidstips ("Brug din sunde
// fornuft …", "vær opmærksom på mistænkelig adfærd …") zonder enige
// rejsevejledning-waarschuwing. Dat is bewust een normaal/laag risico — geen
// ontbrekende data en geen fout.
const DK_STANDARD = /brug din sunde fornuft|v[æa]r opm[æa]rksom p[åa]|ingen s[æa]rlige (rejser[åa]d|forhold)|som udgangspunkt sikkert at rejse/i;
// Echte waarschuwingsvormen (niet het onschuldige "fraråder ikke rejser").
const DK_WARNING = /frar[åa]der (alle|rejser til|indrejse|mod|ophold)/i;

/**
 * Bevat de tekst uitsluitend de Deense standaard-veiligheidstekst (geen
 * bijzonderheden) zónder enige echte reiswaarschuwing? Dan is dit een
 * normaal/laag risico (niveau 1), geen ontbrekende data of fout.
 * @param {string} text
 * @returns {boolean}
 */
export function isDanishStandardOnly(text) {
  const t = String(text || '');
  return DK_STANDARD.test(t) && !DK_WARNING.test(t);
}

const SITE = 'https://um.dk';
const BASE = `${SITE}/rejse-og-ophold/rejse-til-udlandet/rejsevejledninger`;

/** Per-land pagina-URL zonder ophalen — voor een klikbare link ook als de fetch faalt. */
export function sourceUrl(slug) {
  return slug ? `${SITE}/rejse-og-ophold/rejse-til-udlandet/rejsevejledninger/${slug}` : `${SITE}/rejse-og-ophold/rejse-til-udlandet/rejsevejledninger`;
}

export const meta = { id: 'dk', label: 'Denemarken (Udenrigsministeriet)', flag: '🇩🇰', lang: 'da' };

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

  const root = parse(html);
  const main = root.querySelector('main') || root.querySelector('article') || root;
  const themes = splitByHeadings(absolutiseLinks(main.innerHTML, SITE))
    .filter((s) => s.heading && s.text && s.text.length > 40)
    .filter((s) => !/^(del med|del på|abonner|kontakt|følg os|se også|relaterede|cookie)/i.test(s.heading.trim()))
    .map((s) => ({ category: s.heading, heading: s.heading, themeId: classifyTheme(s.heading, s.text), html: s.html, text: s.text }));

  // Landelijk niveau uit het samenvattende ankerblok (Deense formuleringen);
  // de gekleurde "bjælker" (balken) van um.dk zijn een regionale-max-hint.
  const assessment = analyzeAdvisory({
    sections: themes,
    lang: 'da',
    anchorText: anchor,
    structured: { kind: 'dk_summary_bars', value: anchor },
  });

  // Standaardtekst-herkenning: kon er geen niveau uit het ankerblok worden
  // afgeleid (onzeker), maar staat de Deense standaardtekst wél op de pagina
  // zónder enige echte waarschuwing? Dan is dit een normaal/laag risico
  // (niveau 1), niet "geen data".
  let level = assessment.level;
  let color = assessment.color;
  let levelLabel = assessment.levelLabel;
  let assessmentStatus = assessment.assessmentStatus;
  let confidence = assessment.confidence;
  if (level == null || assessmentStatus === 'uncertain') {
    const body = `${anchor}\n${themes.map((t) => t.text).join('\n')}`;
    if (isDanishStandardOnly(body)) {
      level = 1;
      color = 'groen';
      levelLabel = SEVERITY_LABELS[1];
      assessmentStatus = 'ok';
      confidence = 'medium';
    }
  }

  return {
    source: meta.id,
    sourceLabel: meta.label,
    flag: meta.flag,
    name: null,
    url,
    lastModified: danishDate(html),
    updateNote: null,
    level,
    color,
    levelLabel,
    regionalMaxLevel: assessment.regionalMaxLevel,
    hasRegionalWarnings: assessment.hasRegionalWarnings,
    regionalBreakdown: assessment.regionalBreakdown,
    regionalCoverage: assessment.regionalCoverage,
    regions: assessment.regions,
    confidence,
    assessmentStatus,
    hasMap: false,
    themes,
    fullText: themes.map((t) => t.text).join('\n'),
  };
}
