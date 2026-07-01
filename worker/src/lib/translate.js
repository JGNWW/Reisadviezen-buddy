/**
 * Gratis vertaling via het publieke Google-translate-endpoint (geen API-key).
 * Wordt server-side in de Worker gebruikt zodat er geen CORS-/keyproblemen zijn
 * en resultaten gecachet kunnen worden.
 *
 * Let op: dit is een niet-officieel endpoint; het kan rate-limiten. Voor een
 * redactionele tool met beperkt verkeer volstaat het. Eenvoudig te vervangen
 * door DeepL/LibreTranslate door alleen deze functie aan te passen.
 */
const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

const cache = new Map();
const TTL = 24 * 60 * 60 * 1000;

/** Splitst tekst in stukken onder de lengtelimiet, op zin-/regelgrenzen. */
function chunk(text, max = 1800) {
  const parts = [];
  let buf = '';
  for (const piece of text.split(/(?<=[.!?。])\s+|\n+/)) {
    if ((buf + ' ' + piece).length > max) {
      if (buf) parts.push(buf);
      buf = piece.length > max ? piece.slice(0, max) : piece;
    } else {
      buf = buf ? buf + ' ' + piece : piece;
    }
  }
  if (buf) parts.push(buf);
  return parts.length ? parts : [text];
}

export async function translate(text, to = 'nl', from = 'auto') {
  const clean = (text || '').trim();
  if (!clean) return { text: '', detected: null };
  const key = `${from}|${to}|${clean}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;

  let detected = null;
  const out = [];
  for (const part of chunk(clean)) {
    const url = `${ENDPOINT}?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(part)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`Vertaling ${res.status}`);
    const d = await res.json();
    if (Array.isArray(d?.[0])) out.push(d[0].map((s) => (s && s[0]) || '').join(''));
    detected = detected || d?.[2] || null;
  }
  const v = { text: out.join(' ').trim(), detected };
  cache.set(key, { t: Date.now(), v });
  return v;
}

/** Vertaalt de thema-blokken van een advies naar het doel (standaard NL). */
export async function translateBlocks(themes, to = 'nl', from = 'auto') {
  return Promise.all(
    (themes || []).map(async (b) => {
      const [h, t] = await Promise.all([
        b.heading ? translate(b.heading, to, from).then((r) => r.text).catch(() => b.heading) : Promise.resolve(b.heading),
        b.text ? translate(b.text, to, from).then((r) => r.text).catch(() => b.text) : Promise.resolve(b.text),
      ]);
      return { ...b, headingNl: h, textNl: t };
    })
  );
}
