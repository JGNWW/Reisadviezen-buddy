/**
 * Client + normalisatie voor de open data feed van NederlandWereldwijd.
 * https://www.nederlandwereldwijd.nl/open-data
 */
import { htmlToText, splitByHeadings, absolutiseLinks } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { extractNlColors } from '../lib/colors.js';

const BASE =
  'https://opendata.nederlandwereldwijd.nl/v2/sources/nederlandwereldwijd/infotypes';
const SITE = 'https://www.nederlandwereldwijd.nl';

// Simpele in-memory cache met TTL om de bron te ontlasten.
const cache = new Map();
const TTL_MS = 30 * 60 * 1000;

async function getJson(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < TTL_MS) return hit.v;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`NL open data ${res.status} voor ${url}`);
  const v = await res.json();
  cache.set(url, { t: Date.now(), v });
  return v;
}

/**
 * Lijst van alle landen met een NL-reisadvies. De API geeft maximaal 200
 * rijen per pagina (ook als je meer vraagt) — pagineer met offset tot een
 * pagina niet meer vol is, anders vallen er stilletjes landen buiten de boot
 * (de lijst telt er ±226, waaronder de VS en Frankrijk op pagina 2).
 */
export async function listAdvisories() {
  const ROWS = 200;
  const all = [];
  for (let offset = 0; ; offset += ROWS) {
    const page = await getJson(`${BASE}/traveladvice?output=json&rows=${ROWS}&offset=${offset}`);
    if (!Array.isArray(page) || !page.length) break;
    all.push(...page);
    if (page.length < ROWS) break;
  }
  return all.map((d) => ({
    iso3: (d.isocode || '').toUpperCase(),
    nl: d.location,
    key: d.locationkey,
    canonical: d.canonical,
    lastmodified: d.lastmodified,
  }));
}

/** URL van de kaartafbeelding (standard of legend). */
export function mapUrl(iso3, type = 'standard') {
  return `${BASE}/countries/${iso3.toLowerCase()}/traveladvice/map?type=${type === 'legend' ? 'legend' : 'standard'}`;
}

/**
 * Haalt één reisadvies op en normaliseert het naar:
 * { source, iso3, name, url, lastModified, summaryHtml, colors, themes: [...], maps }
 * waarbij elk thema een canoniek thema-id, de originele kop, html en tekst bevat.
 */
export async function getAdvisory(iso3) {
  const iso = iso3.toLowerCase();
  const d = await getJson(`${BASE}/countries/${iso}/traveladvice?output=json`);

  const colors = extractNlColors(d.introduction);

  // De koppenstructuur van NederlandWereldwijd: elke <category> bevat
  // contentblocks met een paragraphtitle (de subthema's). We nemen de
  // paragraphtitles als primaire thema-koppen (de <category> als groep).
  const themes = [];
  for (const category of d.content || []) {
    const categoryName = category.category;
    for (const block of category.contentblocks || []) {
      const heading = block.paragraphtitle || categoryName;
      const html = absolutiseLinks(block.paragraph || '', SITE);
      const text = htmlToText(html);
      themes.push({
        category: categoryName,
        heading,
        themeId: classifyTheme(heading, text),
        html,
        text,
        // Subkoppen binnen het blok (h4's) voor fijnmazig zoeken/tonen.
        sections: splitByHeadings(html)
          .filter((s) => s.heading)
          .map((s) => ({ heading: s.heading, text: s.text })),
      });
    }
  }

  return {
    source: 'nl',
    sourceLabel: 'NederlandWereldwijd',
    iso3: (d.isocode || iso3).toUpperCase(),
    name: d.location,
    url: d.canonical,
    lastModified: d.lastmodified,
    modificationDate: d.modificationdate,
    summaryHtml: absolutiseLinks(d.introduction || '', SITE),
    summaryText: htmlToText(d.introduction),
    colors,
    themes,
    maps: {
      standard: mapUrl(iso3, 'standard'),
      legend: mapUrl(iso3, 'legend'),
    },
  };
}

/** Proxy de kaartafbeelding (vermijdt CORS/mixed-content in de browser). */
export async function fetchMap(iso3, type) {
  const res = await fetch(mapUrl(iso3, type));
  if (!res.ok) throw new Error(`Kaart ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buffer: buf, contentType: res.headers.get('content-type') || 'image/png' };
}
