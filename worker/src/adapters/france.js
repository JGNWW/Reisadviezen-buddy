/**
 * Frankrijk — France Diplomatie (diplomatie.gouv.fr), "Conseils aux voyageurs".
 * Franstalig; de Worker kan de teksten op verzoek naar NL vertalen.
 *
 * France Diplomatie is gemigreerd van één landpagina
 * (/fr/conseils-aux-voyageurs/conseils-par-pays-destination/{slug}/) naar
 * subpagina's per onderwerp:
 *   /fr/information-par-pays/{slug}/conseils-aux-voyageurs-securite
 *   /fr/information-par-pays/{slug}/conseils-aux-voyageurs-entree-sejour
 *   /fr/information-par-pays/{slug}/conseils-aux-voyageurs-sante
 * De veiligheidspagina bevat de "Zones de vigilance" (rouge/orange/jaune)
 * met de klassieke formuleringen ("formellement déconseillé", "déconseillé
 * sauf raison impérative", "vigilance renforcée") — de teksten van die
 * zonesecties samen vormen het anker voor het landelijke oordeel (een
 * "le reste du pays …"-zin geeft de landelijke basislijn; alleen zware
 * zonemeldingen zonder basislijn → landelijk laag gehouden).
 *
 * Niveau-interpretatie gebeurt — zoals bij alle bronnen — in de gedeelde
 * engine (worker/src/analysis/).
 */
import { parse } from 'node-html-parser';
import { getText } from '../lib/fetch.js';
import { splitByHeadings, absolutiseLinks, htmlToText } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { analyzeAdvisory } from '../analysis/analysis-engine.js';
import { parseHumanDate } from '../lib/dates.js';

const SITE = 'https://www.diplomatie.gouv.fr';
const BASE = `${SITE}/fr/information-par-pays`;
const LEGACY = `${SITE}/fr/conseils-aux-voyageurs/conseils-par-pays-destination`;

export const meta = { id: 'fr', label: 'Frankrijk (France Diplomatie)', flag: '🇫🇷', lang: 'fr' };

/** Per-land pagina-URL zonder ophalen — voor een klikbare link ook als de fetch faalt. */
export function sourceUrl(slug) {
  return slug ? `${BASE}/${slug}/conseils-aux-voyageurs-securite` : `${SITE}/fr/conseils-aux-voyageurs/`;
}

/**
 * URL van de "carte des zones de vigilance" (een statische JPG onder
 * /files/files/cav/{slug}/..._fcv...jpg). Staat in de securite-HTML in de
 * sectie "Zones de vigilance"; de kaart-kleurbemonstering (map-colors CI)
 * leidt hier de kleurcode uit af. Geeft null als er geen zonekaart is.
 */
export async function resolveMapUrl(slug) {
  if (!slug) return null;
  const html = await getText(`${BASE}/${slug}/conseils-aux-voyageurs-securite`);
  if (!html) return null;
  const root = parse(html);
  // De zonekaart staat in de map /files/files/cav/{slug}/ als JPG/PNG. Meestal
  // met "fcv" in de naam ("fiche conseils voyageurs"), maar niet altijd — dus
  // accepteer elke afbeelding in die landmap en geef voorrang aan een fcv-naam.
  const cands = root.querySelectorAll('img')
    .map((im) => im.getAttribute('src') || '')
    .filter((s) => /\/cav\//i.test(s) && /\.(jpe?g|png)(\?|$)/i.test(s));
  let src = cands.find((s) => /fcv/i.test(s)) || cands[0] || null;
  if (src && src.startsWith('/')) src = SITE + src;
  return src;
}

// Ankerkop voor de oude paginastructuur (terugvalpad).
const ANCHOR_HEADING = /^(situation s[ée]curitaire|s[ée]curit[ée]|s[ûu]ret[ée]|recommandations? g[ée]n[ée]rales?)/i;

// Site-boilerplate (beide layouts): navigatie, follow-blokken, adresboeken.
const BOILER = /^(navigation|menu|partager|sommaire|derni[eè]re|en r[eé]sum|fil d|vous voyagez|donnez-nous|v[ée]rifiez que|urgence attentat|pr[ée]sentation|nos ambassades|à d[ée]couvrir|sur le m[êe]me|annuaire|liste des repr[ée]sentations|ambassade de france|d[ée]couvrez notre|suivez-nous|hausse des cas)/i;

const ZONE_HEADING = /^zones (formellement d[ée]conseill[ée]es|d[ée]conseill[ée]es sauf|en vigilance)/i;

function sectionsOf(html, url) {
  return splitByHeadings(absolutiseLinks(html, SITE))
    .filter((s) => s.heading && s.text && s.text.length > 60)
    .filter((s) => !BOILER.test(s.heading.trim()))
    .filter((s) => !/Conseils aux voyageurs.*Derni[eè]res minutes/i.test(s.text))
    .map((s) => ({ ...s, url }));
}

export async function getAdvisory(slug) {
  if (!slug) return null;

  // Nieuwe structuur: subpagina's per onderwerp (best effort per pagina).
  const tabs = ['securite', 'entree-sejour', 'sante'];
  const pages = await Promise.all(tabs.map(async (tab) => {
    const url = `${BASE}/${slug}/conseils-aux-voyageurs-${tab}`;
    try {
      const html = await getText(url);
      return html ? { tab, url, html } : null;
    } catch { return null; }
  }));
  const got = pages.filter(Boolean);

  let sections = [];
  let anchorText = null;
  let anchorHeadingRe = null;
  let mainUrl;
  let dateSource = '';

  if (got.length && got.some((p) => p.tab === 'securite')) {
    for (const p of got) sections.push(...sectionsOf(p.html, p.url));
    mainUrl = got.find((p) => p.tab === 'securite').url;
    dateSource = got.find((p) => p.tab === 'securite').html;
    // Anker: de teksten van de vigilance-zonesecties samen — dáár staat de
    // landelijke basislijn ("le reste du pays est en vigilance renforcée")
    // en de zware zonemeldingen.
    const zones = sections.filter((s) => ZONE_HEADING.test(s.heading.trim()) || /^zones de vigilance/i.test(s.heading.trim()));
    if (zones.length) anchorText = zones.map((s) => s.text).join('\n');
  } else {
    // Terugvalpad: oude één-pagina-structuur.
    const url = `${LEGACY}/${slug}/`;
    const html = await getText(url);
    if (!html) return null;
    sections = sectionsOf(html, url);
    mainUrl = url;
    dateSource = html;
    anchorHeadingRe = ANCHOR_HEADING;
  }
  if (!sections.length) return null;

  // "Dernière actualisation le 10/03/2026" (nieuw) of
  // "Dernière mise à jour le : 7 avril 2026" (oud).
  const dm = dateSource.match(/Derni[eè]re actualisation le\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  const dmOld = htmlToText(dateSource).match(/Derni[eè]re mise [aà] jour le\s*:?\s*(\d{1,2}\s+\S+\s+\d{4})/i);
  const lastModified = dm
    ? `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`
    : (dmOld ? parseHumanDate(dmOld[1]) : null);

  const themes = sections.map((s) => ({
    category: s.heading,
    heading: s.heading,
    themeId: classifyTheme(s.heading, s.text),
    html: s.html,
    text: s.text,
    url: s.url,
  }));

  const assessment = analyzeAdvisory({
    sections: themes,
    lang: 'fr',
    anchorText: anchorText || undefined,
    anchorHeadingRe: anchorHeadingRe || undefined,
  });

  return {
    source: meta.id,
    sourceLabel: meta.label,
    flag: meta.flag,
    name: null,
    url: mainUrl,
    lastModified,
    updateNote: null,
    level: assessment.level,
    color: assessment.color,
    levelLabel: assessment.levelLabel,
    regionalMaxLevel: assessment.regionalMaxLevel,
    hasRegionalWarnings: assessment.hasRegionalWarnings,
    regionalBreakdown: assessment.regionalBreakdown,
    regionalCoverage: assessment.regionalCoverage,
    regions: assessment.regions,
    confidence: assessment.confidence,
    assessmentStatus: assessment.assessmentStatus,
    hasMap: true,
    themes,
    fullText: themes.map((t) => t.text).join('\n'),
  };
}
