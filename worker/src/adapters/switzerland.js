/**
 * Zwitserland — Eidgenössisches Departement für auswärtige Angelegenheiten
 * (EDA, eda.admin.ch, "Reisehinweise").
 *
 * De nieuwe /fr/conseils-…-pagina's zijn een client-side SPA (leeg zonder
 * JavaScript), maar de klassieke Duitstalige URL's zijn server-gerenderd:
 *   /eda/de/home/vertretungen-und-reisehinweise/{slug}/reisehinweise-fuer{slug}.html
 * De padmapping staat in countries.json (sources.ch, gebouwd door
 * scripts/build-ch-map.mjs uit de Wayback-CDX; eda.admin.ch blokkeert
 * datacenter-IP's, dus ophalen probeert direct/CORS-proxy en valt terug op
 * de reader).
 *
 * Niveau is tekstueel (EDA kent geen cijferschaal): "Von Reisen nach X …
 * wird abgeraten" (zwaarste vorm, 4) vs "Von touristischen/nicht dringenden
 * Reisen wird abgeraten" (3) — zie de Zwitserse patronen in de
 * ernst-detector ('de'). De advieszin staat in het intro-blok vóór de
 * eerste kop; dat blok is het anker.
 */
import { getText, getViaReader } from '../lib/fetch.js';
import { splitByHeadings, absolutiseLinks } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { assessChAdvisory } from '../analysis/ch-classify.js';

const SITE = 'https://www.eda.admin.ch';
const BASE = `${SITE}/eda/de/home/vertretungen-und-reisehinweise`;

export const meta = { id: 'ch', label: 'Zwitserland (EDA)', flag: '🇨🇭', lang: 'de' };

/** Per-land pagina-URL zonder ophalen — voor een klikbare link ook als de fetch faalt. */
export function sourceUrl(pathRel) {
  return pathRel ? `${BASE}/${pathRel}` : `${SITE}/eda/de/home/laender-reise-information.html`;
}

// Navigatie-/voetkoppen zonder adviesinhoud.
const SKIP_HEADING = /l[äa]nderunabh[äa]ngige|fokusthemen|n[üu]tzliche adressen|kontakt\b|footer|navigation|suche\b/i;

export async function getAdvisory(pathRel) {
  if (!pathRel) return null;
  const url = `${BASE}/${pathRel}`;
  let html = null;
  try {
    html = await getText(url);
  } catch {
    html = await getViaReader(url, 'html');
  }
  if (!html) return null;

  // Guard tegen de generieke landingspagina: eda.admin.ch serveert de
  // klassieke URL soms zónder landspecifieke inhoud (alleen "Reisehinweise
  // kurz erklärt", FAQ's en fokusthema's). Generieke site-tips als
  // landthema's tonen zou misleidend zijn — dan liever eerlijk "geen
  // advies" (en het snapshot-vangnet serveert de laatste goede versie).
  if (!/Diese Reisehinweise sind [üu]berpr[üu]ft|Grunds[äa]tzliche Einsch[äa]tzung/i.test(html)) return null;

  const sections = splitByHeadings(absolutiseLinks(html, SITE));
  const themes = sections
    .filter((s) => s.heading && s.text && s.text.length > 60 && !SKIP_HEADING.test(s.heading))
    .map((s) => ({
      category: s.heading,
      heading: s.heading,
      themeId: classifyTheme(s.heading, s.text),
      html: s.html,
      text: s.text,
      url,
    }));

  // Het landelijke EDA-oordeel staat in de sectie "Grundsätzliche
  // Einschätzung" (eerste zin daarvan); het regionale maximum in de volledige
  // Reisehinweise-tekst. We lezen dus expliciet díe sectie (i.p.v. het
  // navigatie-zware intro-blok) en interpreteren met dezelfde classifier als
  // de crisis-snapshot (ch-classify.js) — één bron van waarheid voor CH.
  const grundSection = sections.find((s) => s.heading && /grunds[äa]tzliche einsch[äa]tzung/i.test(s.heading));
  const intro = sections.find((s) => !s.heading && s.text && /reisehinweise/i.test(s.text));
  const grundText = grundSection?.text || (intro ? intro.text.slice(-4000) : '');
  const fullText = themes.map((t) => t.text).join('\n') || grundText;
  if (!themes.length && !grundText) return null;

  const a = assessChAdvisory(grundText, fullText);

  // "Diese Reisehinweise … (Stand: 25.01.2026)" of vergelijkbare datering.
  const dm = html.match(/(?:Stand|aktualisiert am|publiziert am)[^0-9]{0,10}(\d{1,2})\.(\d{1,2})\.(\d{4})/i);
  const lastModified = dm ? `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}` : null;

  return {
    source: meta.id,
    sourceLabel: meta.label,
    flag: meta.flag,
    name: null,
    url,
    lastModified,
    updateNote: null,
    level: a ? a.level : null,
    color: a ? a.color : null,
    levelLabel: a ? a.levelLabel : null,
    regionalMaxLevel: a ? a.regionalMaxLevel : null,
    hasRegionalWarnings: a ? a.hasRegionalWarnings : false,
    regionalBreakdown: [],
    regionalCoverage: null,
    regions: null,
    confidence: a ? 'high' : 'low',
    assessmentStatus: a ? 'ok' : 'uncertain',
    hasMap: false,
    themes,
    fullText,
  };
}
