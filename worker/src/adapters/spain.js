/**
 * Spanje — Ministerio de Asuntos Exteriores (exteriores.gob.es).
 * Server-side gerenderde .aspx-pagina (geen JS-rendering nodig). De
 * landpagina wordt geadresseerd met de Spaanse landnaam (?trc=...).
 * Spaanstalig; de Worker kan de teksten naar NL vertalen.
 *
 * Niveau: geen gestructureerd veld beschikbaar. Gezocht wordt uitsluitend in
 * de "Notas importantes"-sectie (het algemene overzicht, altijd de eerste
 * accordion-sectie) — nooit de hele pagina — met scope-detectie (landelijk
 * vs. regionaal). Zie worker/src/lib/level-assessment.js voor de achtergrond.
 */
import { parse } from 'node-html-parser';
import { getText } from '../lib/fetch.js';
import { splitByHeadings, absolutiseLinks } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { assessFromAnchoredText, REGIONAL_WORDS } from '../lib/level-assessment.js';

const SITE = 'https://www.exteriores.gob.es';
const BASE = `${SITE}/es/ServiciosAlCiudadano/Paginas/Detalle-recomendaciones-de-viaje.aspx`;

export const meta = { id: 'es', label: 'Spanje (Exteriores)', flag: '🇪🇸', lang: 'es' };

// Spaanse formuleringen -> niveau 1..4, van zwaar naar licht.
const VIG_PATTERNS = [
  { re: /se desaconseja (todo|cualquier) (viaje|desplazamiento)|se recomienda (valorar )?no viajar\b(?!.*salvo)|evitar (todo|cualquier) desplazamiento/i, level: 4 },
  { re: /no viajar salvo|salvo (por )?razones (ineludibles|de fuerza mayor)|desaconseja(n)? (los|el) (viaje|desplazamiento)/i, level: 3 },
  { re: /viajar con (mucha|extrema|extremada)? ?precauci[oó]n|extrem(ar|e|a) (las )?precauci|adoptar precauciones|alto grado de precauci/i, level: 2 },
  { re: /viaje sin restricciones|sin restricciones|no hay restricciones/i, level: 1 },
];

const ANCHOR_HEADING = /^notas importantes/i;

export async function getAdvisory(trc) {
  if (!trc) return null;
  const url = `${BASE}?trc=${encodeURIComponent(trc)}`;
  const html = await getText(url);
  if (!html) return null;

  const root = parse(html);
  // De reisadviesteksten staan als accordion-secties (h3.accordion__main +
  // bijbehorende content) binnen deze wrapper.
  const wrap = root.querySelector('.section__accordion-wrapper') || root.querySelector('.single__textDetalleRV') || root;

  const themes = splitByHeadings(absolutiseLinks(wrap.innerHTML, SITE))
    .filter((s) => s.heading && s.text && s.text.length > 40)
    .map((s) => ({ category: s.heading, heading: s.heading, themeId: classifyTheme(s.heading, s.text), html: s.html, text: s.text }));

  // Anker: "Notas importantes" is het algemene overzicht (altijd eerste
  // sectie); val terug op de eerste sectie als die titel niet gevonden wordt.
  const anchor = themes.find((t) => ANCHOR_HEADING.test(t.heading.trim())) || themes[0] || null;
  const assessment = assessFromAnchoredText(anchor?.text || '', VIG_PATTERNS, REGIONAL_WORDS.es);

  return {
    source: meta.id,
    sourceLabel: meta.label,
    flag: meta.flag,
    name: null,
    url,
    lastModified: null,
    level: assessment.level,
    color: assessment.color,
    levelLabel: assessment.explanation,
    regionalMaxLevel: assessment.regionalMaxLevel,
    hasRegionalWarnings: assessment.hasRegionalWarnings,
    confidence: assessment.confidence,
    assessmentStatus: assessment.assessmentStatus,
    hasMap: false,
    themes,
    fullText: themes.map((t) => t.text).join('\n'),
  };
}
