/**
 * Gedeelde fixture-fetch voor de offline tests: elke URL wordt beantwoord uit
 * test/fixtures/ (echte, opgeslagen bronpagina's). Volgorde is belangrijk:
 * specifieke routes vóór generieke (de-index).
 */
import { readFileSync } from 'node:fs';

export const ROUTES = [
  ['gov.uk/api/content/foreign-travel-advice/nepal', 'uk-nepal.json'],
  ['nepal-travel-advisory.html', 'us-nepal.html'],
  ['index-alpha-eng.json', 'ca-index.json'],
  ['travel.gc.ca/destinations/nepal', 'ca-nepal.html'],
  ['a-z-list-of-countries/nepal', 'ie-nepal.html'],
  ['conseils-par-pays-destination/nepal', 'fr-nepal.html'],
  ['trc=Nepal', 'es-nepal.html'],
  ['opendata/travelwarning/221216', 'de-nepal.json'],
  ['opendata/travelwarning', 'de-index.json'],
  ['safetravel.govt.nz/destinations/nepal', 'nz-nepal.html'],
  ['rejsevejledninger/nepal', 'dk-nepal.html'],
  ['pcinfectionspothazardinfo_010.html', 'jp-nepal.html'],
  ['pchazardspecificinfo_', 'jp-nepal-detail.html'],
  ['schede_paese/NPL.json', 'it-nepal.json'],
  ['matkustustiedote/-/c/NP', 'fi-nepal.html'],
  ['ntnSafetyInfo/284/detail', 'kr-afghanistan.html'],
  ['reiseinfo_afghanistan/id2415875', 'no-afghanistan.html'],
];

export function installFixtureFetch() {
  globalThis.fetch = async (url) => {
    const u = String(url);
    const hit = ROUTES.find(([frag]) => u.includes(frag));
    if (!hit) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    const body = readFileSync(new URL(`./fixtures/${hit[1]}`, import.meta.url), 'utf8');
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
  };
}
