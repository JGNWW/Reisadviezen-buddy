/**
 * Spanje — Ministerio de Asuntos Exteriores (exteriores.gob.es).
 * Server-side gerenderde .aspx-pagina (geen JS-rendering nodig). De
 * landpagina wordt geadresseerd met de Spaanse landnaam (?trc=...).
 * Spaanstalig; de Worker kan de teksten naar NL vertalen.
 */
import { parse } from 'node-html-parser';
import { getText } from '../lib/fetch.js';
import { splitByHeadings, absolutiseLinks, htmlToText } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { levelToColor } from '../lib/levels.js';

const SITE = 'https://www.exteriores.gob.es';
const BASE = `${SITE}/es/ServiciosAlCiudadano/Paginas/Detalle-recomendaciones-de-viaje.aspx`;

export const meta = { id: 'es', label: 'Spanje (Exteriores)', flag: '🇪🇸', lang: 'es' };

// Spaanse formuleringen -> niveau 1..4 (eerste algemene vermelding wint).
const VIG = [
  { re: /se desaconseja (todo|cualquier) (viaje|desplazamiento)|se recomienda no viajar\b(?!.*salvo)/i, level: 4 },
  { re: /no viajar salvo|salvo (por )?razones (ineludibles|de fuerza mayor)|desaconseja(n)? (los|el) (viaje|desplazamiento)/i, level: 3 },
  { re: /extrem(ar|e) (las )?precauci|adoptar precauciones|alto grado de precauci/i, level: 2 },
  { re: /viaje sin restricciones|sin restricciones/i, level: 1 },
];
const VIG_LABEL = { 1: 'Viaje sin restricciones', 2: 'Extremar la precaución', 3: 'No viajar salvo razones ineludibles', 4: 'Se desaconseja todo viaje' };

function overallLevel(text) {
  let best = null, bestIdx = Infinity;
  for (const v of VIG) { const m = text.match(v.re); if (m && m.index < bestIdx) { bestIdx = m.index; best = v.level; } }
  return best;
}

export async function getAdvisory(trc) {
  if (!trc) return null;
  const url = `${BASE}?trc=${encodeURIComponent(trc)}`;
  const html = await getText(url);
  if (!html) return null;

  const root = parse(html);
  // De reisadviesteksten staan als accordion-secties (h3.accordion__main +
  // bijbehorende content) binnen deze wrapper.
  const wrap = root.querySelector('.section__accordion-wrapper') || root.querySelector('.single__textDetalleRV') || root;

  const level = overallLevel(htmlToText(wrap.innerHTML).slice(0, 6000));

  const themes = splitByHeadings(absolutiseLinks(wrap.innerHTML, SITE))
    .filter((s) => s.heading && s.text && s.text.length > 40)
    .map((s) => ({ category: s.heading, heading: s.heading, themeId: classifyTheme(s.heading, s.text), html: s.html, text: s.text }));

  return {
    source: meta.id,
    sourceLabel: meta.label,
    flag: meta.flag,
    name: null,
    url,
    lastModified: null,
    level,
    color: levelToColor(level),
    levelLabel: level ? VIG_LABEL[level] : null,
    hasMap: false,
    themes,
    fullText: themes.map((t) => t.text).join('\n'),
  };
}
