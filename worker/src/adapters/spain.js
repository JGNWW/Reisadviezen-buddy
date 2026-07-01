/**
 * Spanje — Ministerio de Asuntos Exteriores (exteriores.gob.es).
 * De site is een JS-SPA, dus we renderen via de reader-proxy (browser-engine).
 * De landpagina wordt geadresseerd met de Spaanse landnaam (?trc=...).
 * Spaanstalig; de Worker kan de teksten naar NL vertalen.
 */
import { getViaReader } from '../lib/fetch.js';
import { splitMarkdown } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { levelToColor } from '../lib/levels.js';

const BASE = 'https://www.exteriores.gob.es/es/ServiciosAlCiudadano/Paginas/Detalle-recomendaciones-de-viaje.aspx';

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
  const md = await getViaReader(url, { format: 'markdown', browser: true, timeout: 40 });
  if (!md || !/##\s+/.test(md)) return null;

  // Alleen de inhoud vanaf de landkop; sla de sitebrede navigatie ervoor over.
  const start = md.search(/^#\s+Detalle recomendaciones|^##\s+/m);
  const body = start > 0 ? md.slice(start) : md;

  const level = overallLevel(body.slice(0, 6000));

  const BOILER = /^(aviso general|recomendaciones de viaje|men[uú]|compartir|redes sociales|contacto|detalle recomendaciones)/i;
  const themes = splitMarkdown(body)
    .filter((s) => s.heading && s.text && s.text.length > 60 && s.level >= 3)
    .filter((s) => !BOILER.test(s.heading.trim()))
    .map((s) => ({ category: s.heading, heading: s.heading, themeId: classifyTheme(s.heading, s.text), html: null, text: s.text }));

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
