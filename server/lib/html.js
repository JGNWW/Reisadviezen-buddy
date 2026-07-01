import { parse } from 'node-html-parser';

/**
 * Zet HTML om naar platte tekst (voor zoeken en snippets).
 */
export function htmlToText(html) {
  if (!html) return '';
  const root = parse(html, { blockTextElements: { script: false, style: false } });
  // Voeg spaties toe rond blok-elementen zodat woorden niet aan elkaar plakken.
  root.querySelectorAll('p, li, h1, h2, h3, h4, h5, div, br, tr').forEach((el) => {
    el.insertAdjacentHTML('afterend', ' ');
  });
  return root.textContent.replace(/\s+/g, ' ').trim();
}

/**
 * Splitst een HTML-body op in secties op basis van kop-elementen (h2-h4).
 * Retourneert een lijst van { heading, level, html, text }.
 * Tekst vóór de eerste kop komt in een sectie met heading = null.
 */
export function splitByHeadings(html) {
  if (!html) return [];
  const root = parse(html);
  const sections = [];
  let current = { heading: null, level: 0, nodes: [] };

  for (const node of root.childNodes) {
    const tag = node.rawTagName ? node.rawTagName.toLowerCase() : null;
    if (tag && /^h[2-4]$/.test(tag)) {
      if (current.nodes.length || current.heading) sections.push(current);
      current = {
        heading: node.textContent.replace(/\s+/g, ' ').trim(),
        level: Number(tag[1]),
        nodes: [],
      };
    } else {
      current.nodes.push(node);
    }
  }
  if (current.nodes.length || current.heading) sections.push(current);

  return sections.map((s) => {
    const bodyHtml = s.nodes.map((n) => n.toString()).join('');
    return {
      heading: s.heading,
      level: s.level,
      html: bodyHtml,
      text: htmlToText(bodyHtml),
    };
  });
}

/**
 * Maakt een kort tekstfragment rond het eerste voorkomen van een zoekterm.
 */
export function snippetAround(text, term, radius = 160) {
  if (!text) return '';
  const lower = text.toLowerCase();
  const idx = lower.indexOf(term.toLowerCase());
  if (idx === -1) return text.slice(0, radius * 2).trim() + (text.length > radius * 2 ? '…' : '');
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + term.length + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

/**
 * Herschrijft relatieve of protocol-loze links naar absolute https-links op de
 * opgegeven host, zodat links in gerenderde HTML blijven werken.
 */
export function absolutiseLinks(html, base) {
  if (!html) return '';
  const root = parse(html);
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (href && href.startsWith('/')) {
      try {
        a.setAttribute('href', new URL(href, base).toString());
      } catch {
        /* laat staan */
      }
    }
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  return root.toString();
}
