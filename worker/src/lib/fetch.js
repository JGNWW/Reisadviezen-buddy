const UA = 'Mozilla/5.0 (compatible; ReisadviezenBuddy/1.0; +https://github.com/JGNWW/Reisadviezen-buddy)';

export async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

export async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

/**
 * Haalt een pagina op via de publieke reader-proxy r.jina.ai. Nodig voor
 * bronnen die datacenter-IP's blokkeren (bijv. Smartraveller/Australië) of die
 * volledig client-side renderen. `format` 'html' geeft de HTML terug, anders
 * opgeschoonde markdown.
 *
 * Let op: dit is een externe, gratis dienst met eigen limieten. Zie ook de
 * discussie over publieke proxies in de README.
 */
let READER_KEY = null;
/** Stel een (gratis) r.jina.ai API-key in voor hogere limieten/betrouwbaarheid. */
export function setReaderKey(key) { READER_KEY = key || null; }

export async function getViaReader(url, opts = {}) {
  const { format = 'html', browser = false, timeout = 30 } = typeof opts === 'string' ? { format: opts } : opts;
  const headers = { 'User-Agent': UA, 'X-Return-Format': format, 'X-Timeout': String(timeout) };
  if (browser) headers['X-Engine'] = 'browser'; // rendert JavaScript-SPA's
  if (READER_KEY) headers.Authorization = `Bearer ${READER_KEY}`;
  const res = await fetch(`https://r.jina.ai/${url}`, { headers });
  if (!res.ok) throw new Error(`reader ${res.status} ${url}`);
  return res.text();
}
