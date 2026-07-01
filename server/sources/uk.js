/**
 * Client + normalisatie voor de reisadviezen van het Verenigd Koninkrijk
 * (FCDO), via de GOV.UK Content API.
 * https://www.gov.uk/api/content/foreign-travel-advice/{slug}
 */
import { htmlToText, splitByHeadings, absolutiseLinks } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { mapForeignToNlColor } from '../lib/colors.js';

const API = 'https://www.gov.uk/api/content/foreign-travel-advice';
const SITE = 'https://www.gov.uk';

const cache = new Map();
const TTL_MS = 30 * 60 * 1000;

async function getJson(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < TTL_MS) return hit.v;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`FCDO ${res.status} voor ${url}`);
  const v = await res.json();
  cache.set(url, { t: Date.now(), v });
  return v;
}

export const meta = {
  id: 'uk',
  label: 'Verenigd Koninkrijk (FCDO)',
  flag: '🇬🇧',
};

/**
 * Haalt en normaliseert het FCDO-reisadvies voor de gegeven bron-slug.
 * Zelfde vorm als de NL-normalisatie zodat vergelijking eenvoudig is.
 */
export async function getAdvisory(slug) {
  if (!slug) return null;
  const d = await getJson(`${API}/${slug}`);
  if (!d) return null;
  const det = d.details || {};
  const parts = det.parts || [];

  const fullTextParts = [];
  const themes = [];

  for (const part of parts) {
    const partHtml = absolutiseLinks(part.body || '', SITE);
    fullTextParts.push(htmlToText(partHtml));

    // Splits de part-body op koppen zodat we fijnmaziger thema's herkennen.
    const sections = splitByHeadings(partHtml);
    const intro = sections.find((s) => !s.heading);
    const subs = sections.filter((s) => s.heading);

    if (subs.length === 0) {
      // Geen subkoppen: het hele part is één thema.
      const text = htmlToText(partHtml);
      themes.push({
        category: part.title,
        heading: part.title,
        themeId: classifyTheme(part.title, text),
        html: partHtml,
        text,
        sections: [],
      });
    } else {
      // Elke subkop wordt een thema-blok; de part-titel is de groep.
      if (intro && intro.text) {
        themes.push({
          category: part.title,
          heading: part.title,
          themeId: classifyTheme(part.title, intro.text),
          html: intro.html,
          text: intro.text,
          sections: [],
        });
      }
      for (const s of subs) {
        themes.push({
          category: part.title,
          heading: s.heading,
          themeId: classifyTheme(s.heading, s.text) || classifyTheme(part.title, s.text),
          html: s.html,
          text: s.text,
          sections: [],
        });
      }
    }
  }

  const fullText = fullTextParts.join('\n');
  const mapped = mapForeignToNlColor(fullText);

  // Verandergeschiedenis (handig voor thema-zoeken, bijv. "election").
  const changes = (det.change_history || []).slice(0, 8).map((c) => ({
    note: c.note,
    date: c.public_timestamp,
  }));

  return {
    source: 'uk',
    sourceLabel: meta.label,
    flag: meta.flag,
    iso3: null,
    name: det.country?.name || d.title,
    url: `${SITE}${d.base_path || '/foreign-travel-advice/' + slug}`,
    lastModified: det.updated_at || det.reviewed_at,
    alertStatus: det.alert_status || [],
    mappedColor: mapped.color,
    mappedColorBasis: mapped.basis,
    changeDescription: det.change_description || '',
    changes,
    themes,
    fullText,
  };
}
