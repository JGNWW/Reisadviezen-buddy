/**
 * Spanje — Ministerio de Asuntos Exteriores (exteriores.gob.es).
 * Server-side gerenderde .aspx-pagina (geen JS-rendering nodig). De
 * landpagina wordt geadresseerd met de Spaanse landnaam (?trc=...).
 * Spaanstalig; de Worker kan de teksten naar NL vertalen.
 *
 * Niveau: geen gestructureerd veld beschikbaar. Gezocht wordt uitsluitend in
 * de "Notas importantes"-sectie (het algemene overzicht, altijd de eerste
 * accordion-sectie) — nooit de hele pagina — met scope-detectie (landelijk
 * vs. regionaal). Alle interpretatie gebeurt in worker/src/analysis/.
 */
import { parse } from 'node-html-parser';
import { getText } from '../lib/fetch.js';
import { splitByHeadings, absolutiseLinks } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { analyzeAdvisory } from '../analysis/analysis-engine.js';
import { parseHumanDate } from '../lib/dates.js';

const SITE = 'https://www.exteriores.gob.es';
const BASE = `${SITE}/es/ServiciosAlCiudadano/Paginas/Detalle-recomendaciones-de-viaje.aspx`;

export const meta = { id: 'es', label: 'Spanje (Exteriores)', flag: '🇪🇸', lang: 'es' };

// "Notas importantes" is het algemene overzicht (altijd de eerste sectie).
const ANCHOR_HEADING = /^notas importantes/i;

export async function getAdvisory(trc) {
  if (!trc) return null;
  const url = `${BASE}?trc=${encodeURIComponent(trc)}`;
  const html = await getText(url);
  if (!html) return null;

  const root = parse(html);
  // "Última actualización el 29 de mayo de 2026" — de echte redactiedatum.
  // (Niet "Recomendaciones vigentes a …", dat is de dynamische dagdatum.)
  const dateMatch = html.match(/Última actualización el\s*(\d{1,2}\s+de\s+\S+\s+de\s+\d{4})/i);
  const lastModified = dateMatch ? parseHumanDate(dateMatch[1]) : null;

  // De reisadviesteksten staan als accordion-secties (h3.accordion__main +
  // bijbehorende content) binnen deze wrapper.
  const wrap = root.querySelector('.section__accordion-wrapper') || root.querySelector('.single__textDetalleRV') || root;

  const themes = splitByHeadings(absolutiseLinks(wrap.innerHTML, SITE))
    .filter((s) => s.heading && s.text && s.text.length > 40)
    .map((s) => ({ category: s.heading, heading: s.heading, themeId: classifyTheme(s.heading, s.text), html: s.html, text: s.text }));

  // Landelijk oordeel + regionale vermeldingen via de gedeelde engine.
  // Spanje bundelt landelijke én regionale zinnen vaak in "Notas
  // importantes" zelf; de engine scant dat ankerblok op zinsniveau.
  const assessment = analyzeAdvisory({
    sections: themes,
    lang: 'es',
    anchorHeadingRe: ANCHOR_HEADING,
    countryName: trc,
  });

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
