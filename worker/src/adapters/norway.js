/**
 * Noorwegen — Utenriksdepartementet (regjeringen.no, "reiseinformasjon").
 * URL-vorm: /no/tema/utenrikssaker/reiseinformasjon/velg-land/
 * reiseinfo_{slug}/id{nummer}/ — de slug/id-mapping staat in countries.json
 * (sources.no = "slug/id", gebouwd door scripts/build-no-map.mjs uit de
 * Wayback-CDX-index; regjeringen.no blokkeert datacenter-IP's).
 *
 * Ophalen gebeurt daarom via de reader-proxy (zoals bij Australië). De
 * pagina is klassiek server-gerenderd: een h2 "Reiseadvarsel for X"-blok
 * (alleen aanwezig bij een waarschuwing — "fraråder alle reiser" = 4,
 * "… som ikke er strengt nødvendige" = 3) en h3-secties (Sikkerhet, Helse,
 * Kriminalitet, …).
 */
import { parse } from 'node-html-parser';
import { getViaReader, getTextWithHeaders } from '../lib/fetch.js';
import { htmlToText, splitByHeadings, absolutiseLinks } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { analyzeAdvisory } from '../analysis/analysis-engine.js';

const SITE = 'https://www.regjeringen.no';

export const meta = { id: 'no', label: 'Noorwegen (Utenriksdept.)', flag: '🇳🇴', lang: 'no' };

/** Per-land pagina-URL zonder ophalen — voor een klikbare link ook als de fetch faalt. */
export function sourceUrl(slugId) {
  const [slug, id] = String(slugId || '').split('/');
  if (!slug || !id) return `${SITE}/no/tema/utenrikssaker/reiseinformasjon/velg-land/id2414365/`;
  return `${SITE}/no/tema/utenrikssaker/reiseinformasjon/velg-land/reiseinfo_${slug}/id${id}/`;
}

// Paginakoppen die geen adviesinhoud zijn.
const SKIP_HEADING = /du er her|tema\b|kontakt oss|om regjeringen|hovednavigasjon|s[øo]k\b|relatert/i;

// Cloudflare's wachtkamer ("Just a moment…") komt terug met HTTP 200. Een
// geslaagde fetch zei dus niets: de parser vond op zo'n pagina geen koppen en
// de adapter gaf stilletjes null terug — waardoor Noorwegen ongemerkt in geen
// enkel land in het snapshot-vangnet belandde. Herkennen en hardop melden.
const BOTCHECK = /just a moment|cf-chl|performing security verification|verifying you are|attention required|enable javascript and cookies/i;

/** Is dit een botcheck-/challenge-pagina in plaats van het advies zelf? */
export const looksBlocked = (html) => BOTCHECK.test(String(html || ''));

// Volledige browser-header-set. Cloudflare kijkt niet alleen naar het IP: een
// verzoek zonder Sec-Fetch-* en sec-ch-ua ziet er hoe dan ook uit als een bot.
// Dit maakt het IP niet beter, maar het haalt de tweede reden om te blokkeren
// weg — en dat is wat we zelf in de hand hebben.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'nb-NO,nb;q=0.9,no;q=0.8,en;q=0.7',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

/**
 * Ophalen in lagen, want er is geen enkele route die het altijd doet.
 *
 * 1. rechtstreeks, met een volledige browser-header-set. `getTextWithHeaders`
 *    valt intern terug op de CORS-proxy (een Worker-secret) als die er is —
 *    dat is meteen de enige laag die vanaf een ander IP kan uitkomen.
 * 2. de reader zonder engine: die haalt zelf op, dus met zijn eigen IP.
 * 3. de reader mét browser-engine: die voert de JS-challenge daadwerkelijk uit.
 *    Vereist een reader-key; zonder key geeft de dienst 401.
 *
 * Elke laag wordt op de wachtkamer gecontroleerd, want die komt met HTTP 200
 * terug — een geslaagde fetch zegt hier dus niets. Lukt geen enkele laag, dan
 * werpen we mét vermelding van wat er per laag misging: een stille null las
 * als "dit land heeft geen advies", en zo bleef Noorwegen maandenlang
 * onopgemerkt leeg.
 */
async function fetchPage(url) {
  const pogingen = [
    ['direct', () => getTextWithHeaders(url, BROWSER_HEADERS)],
    ['reader', () => getViaReader(url, 'html')],
    ['reader+browser', () => getViaReader(url, { format: 'html', browser: true, timeout: 45 })],
  ];
  const waarom = [];
  for (const [naam, poging] of pogingen) {
    try {
      const html = await poging();
      if (html && !looksBlocked(html)) return html;
      waarom.push(`${naam}: ${html ? 'botcheck' : 'leeg'}`);
    } catch (e) {
      waarom.push(`${naam}: ${String(e?.message || e).slice(0, 60)}`);
    }
  }
  throw new Error(`norway: Cloudflare-botcheck op ${url} (${waarom.join('; ')})`);
}

export async function getAdvisory(slugId) {
  if (!slugId) return null;
  const [slug, id] = String(slugId).split('/');
  if (!slug || !id) return null;
  const url = `${SITE}/no/tema/utenrikssaker/reiseinformasjon/velg-land/reiseinfo_${slug}/id${id}/`;
  const html = await fetchPage(url);
  if (!html) return null;
  const root = parse(html);

  // Hoofdcontent: het artikel-element met de h1 erin (val terug op de body).
  const h1 = root.querySelector('h1');
  let main = h1;
  while (main && !['ARTICLE', 'MAIN', 'BODY'].includes(main.tagName)) main = main.parentNode;
  const bodyHtml = absolutiseLinks((main || root).innerHTML, SITE);

  const sections = splitByHeadings(bodyHtml)
    .filter((s) => s.heading && s.text && s.text.length > 40 && !SKIP_HEADING.test(s.heading));
  if (!sections.length) return null;

  // Reiseadvarsel-blok (indien aanwezig) = het gestructureerde niveauveld;
  // afwezig = geen waarschuwing (niveau 1).
  const advarsel = sections.find((s) => /reiseadvarsel/i.test(s.heading));
  const advarselText = advarsel ? advarsel.text : '';

  const themes = sections.map((s) => ({
    category: s.heading,
    heading: s.heading,
    themeId: classifyTheme(s.heading, s.text),
    html: s.html,
    text: s.text,
    url,
  }));

  const assessment = analyzeAdvisory({
    sections: themes,
    lang: 'no',
    structured: { kind: 'no_advarsel', value: advarselText },
    anchorHeadingRe: /reiseadvarsel/i,
    countryName: htmlToText(h1?.innerHTML || '').split(/\s*-\s*/)[0].trim() || null,
  });

  // "Sist oppdatert"-datum, indien op de pagina aanwezig (dd.mm.jjjj).
  const dm = html.match(/[Oo]ppdatert:?\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  const lastModified = dm ? `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}` : null;

  return {
    source: meta.id,
    sourceLabel: meta.label,
    flag: meta.flag,
    name: null,
    url,
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
    hasMap: false,
    themes,
    fullText: themes.map((t) => t.text).join('\n'),
  };
}
