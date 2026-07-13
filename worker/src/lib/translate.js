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

// Scheidingsteken tussen gebatchte tekstdelen — getest dat dit de vertaling
// (spaties/regeleinden rond de scheiding daargelaten) intact doorstaat.
const PART_DELIM = '\n@@@\n';
const MAX_BATCH = 1500; // ruim onder Googles limiet; houdt elke batch tot doorgaans 1 fetch beperkt

/**
 * Vertaalt de thema-blokken van een advies naar het doel (standaard NL).
 *
 * Batcht alle heading/text-velden van een bron in zo min mogelijk
 * translate()-aanroepen (dus fetch-calls), i.p.v. 2 losse calls per thema.
 * Bronnen met veel secties (bijv. 50+ thema's) liepen anders tegen de
 * sub-request-limiet van Cloudflare Workers aan — de vertaling faalde dan
 * stil (catch → originele tekst) zodra dat plafond werd overschreden.
 */
export async function translateBlocks(themes, to = 'nl', from = 'auto') {
  const list = themes || [];
  if (!list.length) return list;

  const jobs = []; // { i, field } — volgorde komt overeen met `texts`
  const texts = [];
  list.forEach((b, i) => {
    if (b.heading) { jobs.push({ i, field: 'headingNl' }); texts.push(b.heading.replaceAll('@@@', '@ @ @')); }
    if (b.text) { jobs.push({ i, field: 'textNl' }); texts.push(b.text.replaceAll('@@@', '@ @ @')); }
  });
  if (!texts.length) return list.map((b) => ({ ...b }));

  // Groepeer in batches die (met scheidingstekens) onder de lengtelimiet
  // blijven, zodat elke batch met doorgaans één fetch wordt afgehandeld.
  const batches = [];
  let cur = [];
  let curLen = 0;
  for (const t of texts) {
    const len = t.length + PART_DELIM.length;
    if (cur.length && curLen + len > MAX_BATCH) { batches.push(cur); cur = []; curLen = 0; }
    cur.push(t);
    curLen += len;
  }
  if (cur.length) batches.push(cur);

  // Batches parallel afvuren: het subrequest-plafond geldt voor het tótale
  // aantal fetches per invocatie, niet voor de gelijktijdigheid — dus dit
  // blijft ruim binnen de limiet én is vele malen sneller dan sequentieel.
  const batchResults = await Promise.all(batches.map(async (batch) => {
    try {
      const { text } = await translate(batch.join(PART_DELIM), to, from);
      const pieces = text.split('@@@').map((p) => p.trim());
      // Aantal delen moet exact kloppen; anders (zeldzaam, bijv. bij een
      // vertaalfout) originele tekst behouden i.p.v. alles te verschuiven.
      return pieces.length === batch.length ? pieces : batch;
    } catch {
      return batch;
    }
  }));
  const translatedParts = batchResults.flat();

  const out = list.map((b) => ({ ...b }));
  jobs.forEach((job, idx) => { out[job.i][job.field] = translatedParts[idx]; });
  return out;
}
