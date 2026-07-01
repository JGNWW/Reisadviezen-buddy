import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'countries.json'), 'utf8')
);

const byIso = new Map(); // ISO3 -> record
const byKey = new Map(); // locationkey -> record
for (const rec of Object.values(DATA)) {
  byIso.set(rec.iso3, rec);
  if (rec.key) byKey.set(rec.key.toLowerCase(), rec);
}

const norm = (s) =>
  (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export function allCountries() {
  return Object.values(DATA)
    .map((c) => ({ iso3: c.iso3, nl: c.nl, en: c.en, key: c.key, hasUk: !!c.sources.uk }))
    .sort((a, b) => a.nl.localeCompare(b.nl, 'nl'));
}

export function getCountryByIso(iso3) {
  return byIso.get((iso3 || '').toUpperCase()) || null;
}

export function getUkSlug(iso3) {
  return byIso.get((iso3 || '').toUpperCase())?.sources?.uk || null;
}

/**
 * Zoekt een land op basis van vrije invoer: ISO3-code, locationkey,
 * Nederlandse of Engelse naam (met wat tolerantie).
 */
export function resolveCountry(query) {
  if (!query) return null;
  const q = query.trim();
  const upper = q.toUpperCase();
  if (byIso.has(upper)) return byIso.get(upper);

  const nq = norm(q);
  if (byKey.has(q.toLowerCase())) return byKey.get(q.toLowerCase());

  // Exacte NL- of EN-naam
  for (const rec of byIso.values()) {
    if (norm(rec.nl) === nq || norm(rec.en) === nq) return rec;
  }
  // Begint-met / bevat
  let partial = null;
  for (const rec of byIso.values()) {
    const nnl = norm(rec.nl);
    const nen = norm(rec.en);
    if (nnl.startsWith(nq) || nen.startsWith(nq)) return rec;
    if (!partial && (nnl.includes(nq) || nen.includes(nq))) partial = rec;
  }
  return partial;
}
