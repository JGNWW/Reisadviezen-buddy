import { parse } from 'node-html-parser';

/**
 * Verwijdert script-, style- en noscript-blokken uit rauwe HTML. Nodig vóór
 * elke regex-gebaseerde bewerking: een <h2> bínnen een script (bijv. een
 * chat-widget die HTML in JS-strings opbouwt) zou anders als sectiekop
 * worden aangezien — met code als "kop" in de data tot gevolg.
 */
export function stripNonContent(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

/**
 * Zet HTML om naar platte tekst (voor zoeken en snippets).
 */
export function htmlToText(html) {
  if (!html) return '';
  const root = parse(stripNonContent(html), { blockTextElements: { script: false, style: false, noscript: false } });
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
  // Werkt op de geserialiseerde HTML zodat het ook koppen vindt die diep
  // genest zijn (overheidssites zoals travel.gc.ca en dfa.ie nesten hun
  // sectiekoppen in meerdere div/section-lagen). Scripts/styles eerst weg,
  // anders matcht de kop-regex ook HTML die in JS-strings staat.
  html = stripNonContent(html);
  const re = /<h([2-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  const sections = [];
  let last = 0;
  let curHeading = null;
  let curLevel = 0;
  const flush = (body) => {
    const bodyHtml = body || '';
    const text = htmlToText(bodyHtml);
    if (curHeading || text) sections.push({ heading: curHeading, level: curLevel, html: bodyHtml, text });
  };
  let m;
  while ((m = re.exec(html))) {
    flush(html.slice(last, m.index));
    curHeading = htmlToText(m[2]);
    curLevel = Number(m[1]);
    last = re.lastIndex;
  }
  flush(html.slice(last));
  return sections;
}

/** Zet markdown (van de reader-proxy) om naar leesbare platte tekst. */
export function mdToText(md) {
  return (md || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // afbeeldingen
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> tekst
    .replace(/[*_`>#]+/g, ' ')
    .replace(/\|/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Splitst markdown op koppen (## t/m ####) in secties {heading, level, text}. */
export function splitMarkdown(md) {
  if (!md) return [];
  const sections = [];
  let cur = { heading: null, level: 0, lines: [] };
  for (const line of md.split('\n')) {
    const m = line.match(/^(#{2,4})\s+(.+?)\s*$/);
    if (m) {
      if (cur.heading || cur.lines.length) sections.push(cur);
      cur = { heading: m[2].replace(/[*_`\[\]]/g, '').trim(), level: m[1].length, lines: [] };
    } else cur.lines.push(line);
  }
  if (cur.heading || cur.lines.length) sections.push(cur);
  return sections.map((s) => ({ heading: s.heading, level: s.level, text: mdToText(s.lines.join('\n')) }));
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
