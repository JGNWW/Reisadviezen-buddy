/**
 * Vertaling, server-side in de Worker (geen CORS-/keyproblemen; resultaten
 * cachebaar). Er zijn drie inwisselbare backends; de keuze gebeurt puur via
 * environment-secrets (configureTranslator), zonder codewijziging:
 *
 *   • google  (standaard) — het gratis, niet-officiële Google-endpoint. Geen
 *     key, goede kwaliteit voor alle 17 brontalen, maar het rate-limit't onder
 *     druk (429) → onvertaalde stukken. Prima voor licht redactioneel verkeer.
 *   • deepl   — zet DEEPL_KEY (gratis tier: 500k tekens/maand). Beste kwaliteit
 *     + betrouwbaar; dekt en/de/fr/es/it/da/fi/ja/ko/nb. Aanbevolen upgrade.
 *   • libre   — zet LIBRETRANSLATE_URL (+ optioneel LIBRETRANSLATE_KEY) naar een
 *     (zelf-gehoste) LibreTranslate. Betrouwbaar als je 'm zelf draait, maar de
 *     vertaalkwaliteit ligt merkbaar lager, vooral voor de Noordse/Aziatische
 *     talen — alleen zinvol als je de betrouwbaarheid boven kwaliteit stelt.
 *
 * De rest van de pijplijn (chunking, batching, retry, concurrency-limiet)
 * blijft identiek ongeacht de backend.
 */
const GOOGLE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

// Actieve backend (module-scope = per Worker-invocatie / per script-run).
let PROVIDER = 'google';
let DEEPL = { key: null, url: 'https://api-free.deepl.com/v2/translate' };
let LIBRE = { url: null, key: null };

/**
 * Kiest de vertaalbackend op basis van environment-secrets. Volgorde:
 * DEEPL_KEY > LIBRETRANSLATE_URL > (standaard) google. Aanroepen vanuit
 * index.js (Worker-env) en de snapshot-scripts (process.env).
 */
export function configureTranslator(env = {}) {
  if (env.DEEPL_KEY) {
    PROVIDER = 'deepl';
    DEEPL = { key: env.DEEPL_KEY, url: env.DEEPL_URL || 'https://api-free.deepl.com/v2/translate' };
  } else if (env.LIBRETRANSLATE_URL) {
    PROVIDER = 'libre';
    LIBRE = { url: String(env.LIBRETRANSLATE_URL).replace(/\/+$/, ''), key: env.LIBRETRANSLATE_KEY || null };
  } else {
    PROVIDER = 'google';
  }
  return PROVIDER;
}

/** Welke backend nu actief is — voor diagnose/tests. */
export function activeTranslator() { return PROVIDER; }

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gedeelde limiter: begrenst het aantal gelijktijdige uitgaande vertaalcalls
// over ALLE bronnen van één /advisory-aanroep heen (module-scope = gedeeld
// binnen dezelfde Worker-invocatie). Zonder dit kan een bron met veel secties
// (bijv. 57 thema's) haar fetches in één vloedgolf afvuren en zo een kleinere
// bron (bijv. 7 thema's) volledig verdringen — die bleef dan onvertaald,
// terwijl de grote bron gedeeltelijk wél lukte. Met een gedeelde FIFO-wachtrij
// krijgt elke bron eerlijk om de beurt een slot.
const MAX_CONCURRENT_TRANSLATIONS = 5;
let activeTranslations = 0;
const translationQueue = [];
function runQueued() {
  if (activeTranslations >= MAX_CONCURRENT_TRANSLATIONS || !translationQueue.length) return;
  activeTranslations++;
  const { fn, resolve, reject } = translationQueue.shift();
  fn().then(resolve, reject).finally(() => { activeTranslations--; runQueued(); });
}
function limited(fn) {
  return new Promise((resolve, reject) => { translationQueue.push({ fn, resolve, reject }); runQueued(); });
}

// DeepL-taalcode: hoofdletters; Noors (no) → Bokmål (NB); Engels als DOELtaal
// wil een variant (EN-GB), als brontaal volstaat EN.
function deeplLang(code, isTarget = false) {
  const c = String(code || '').toLowerCase();
  if (c === 'no' || c === 'nb') return 'NB';
  if (c === 'en' && isTarget) return 'EN-GB';
  return c.toUpperCase();
}

/** Eén vertaalcall (één tekstdeel) → {text, detected}. Werpt een Error met
 *  .status bij een HTTP-fout, zodat de retry-laag 429/5xx kan herkennen. */
async function callProvider(part, to, from) {
  if (PROVIDER === 'deepl') {
    const body = new URLSearchParams();
    body.set('text', part);
    body.set('target_lang', deeplLang(to, true));
    if (from && from !== 'auto') body.set('source_lang', deeplLang(from));
    const res = await fetch(DEEPL.url, {
      method: 'POST',
      headers: { Authorization: `DeepL-Auth-Key ${DEEPL.key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) { const e = new Error(`DeepL ${res.status}`); e.status = res.status; throw e; }
    const d = await res.json();
    const t = d?.translations?.[0];
    return { text: t?.text || '', detected: (t?.detected_source_language || '').toLowerCase() || null };
  }
  if (PROVIDER === 'libre') {
    const res = await fetch(`${LIBRE.url}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: part, source: from === 'auto' ? 'auto' : from, target: to, format: 'text', ...(LIBRE.key ? { api_key: LIBRE.key } : {}) }),
    });
    if (!res.ok) { const e = new Error(`LibreTranslate ${res.status}`); e.status = res.status; throw e; }
    const d = await res.json();
    return { text: d?.translatedText || '', detected: d?.detectedLanguage?.language || null };
  }
  // google (standaard, geen key)
  const url = `${GOOGLE_ENDPOINT}?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(part)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) { const e = new Error(`Vertaling ${res.status}`); e.status = res.status; throw e; }
  const d = await res.json();
  const text = Array.isArray(d?.[0]) ? d[0].map((s) => (s && s[0]) || '').join('') : '';
  return { text, detected: d?.[2] || null };
}

/** Eén vertaalcall met retries bij 429/5xx (rate-limit/transiënt), backend-agnostisch. */
async function translateOnce(part, to, from, tries = 3) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await limited(() => callProvider(part, to, from));
    } catch (e) {
      const status = e?.status || 0;
      if (attempt === tries || (status !== 429 && status < 500)) throw e;
      // Rate-limit/transiënt: korte, oplopende pauze; het wachtrij-slot komt
      // tijdens deze pauze vrij zodat andere bronnen ondertussen door kunnen.
      await sleep(300 * attempt + Math.random() * 200);
    }
  }
  throw new Error('Vertaling: geen resultaat');
}

export async function translate(text, to = 'nl', from = 'auto') {
  const clean = (text || '').trim();
  if (!clean) return { text: '', detected: null };
  const key = `${PROVIDER}|${from}|${to}|${clean}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;

  let detected = null;
  const out = [];
  for (const part of chunk(clean)) {
    const { text: t, detected: dd } = await translateOnce(part, to, from);
    out.push(t);
    detected = detected || dd || null;
  }
  const v = { text: out.join(' ').trim(), detected };
  cache.set(key, { t: Date.now(), v });
  return v;
}

// Scheidingsteken tussen gebatchte tekstdelen — getest dat dit de vertaling
// (spaties/regeleinden rond de scheiding daargelaten) intact doorstaat, maar
// niet gegarandeerd bij elke inhoud/taalcombinatie (zie translateParts).
const PART_DELIM = '\n@@@\n';
const MAX_BATCH = 1500; // ruim onder Googles limiet; houdt elke batch tot doorgaans 1 fetch beperkt

/**
 * Vertaalt een array tekstdelen. Batcht agressief (één call voor meerdere
 * delen) voor snelheid en om Cloudflare Workers' sub-request-limiet niet te
 * raken — maar als het scheidingsteken niet exact standhoudt (zeldzaam, maar
 * gebeurt bij sommige taal-/inhoudscombinaties) bisecteert dit i.p.v. de hele
 * batch stilzwijgend als "vertaald" door te laten met de originele tekst. Een
 * los item dat blijft mislukken (bijv. door aanhoudende rate-limits) levert
 * `null` op, zodat de aanroeper dat eerlijk als "niet vertaald" kan behandelen
 * in plaats van een valse succesmelding met ongewijzigde brontekst.
 */
async function translateParts(parts, to, from) {
  if (!parts.length) return [];
  if (parts.length === 1) {
    try {
      const { text } = await translate(parts[0], to, from);
      return [text];
    } catch {
      return [null];
    }
  }
  let text;
  try {
    ({ text } = await translate(parts.join(PART_DELIM), to, from));
  } catch {
    // Harde fout (bijv. een aanhoudende rate-limit of een uitgeputte
    // sub-request-limiet): NIET verder bisecteren. Meerdere bronnen delen
    // hetzelfde sub-request-budget per Worker-invocatie — als er hier al
    // geen response komt, verbruikt méér proberen alleen budget dat een
    // andere bron nog nodig heeft. Dit blok blijft onvertaald.
    return parts.map(() => null);
  }
  const pieces = text.split('@@@').map((p) => p.trim());
  if (pieces.length === parts.length) return pieces;
  // Alleen bij een structurele mismatch (scheidingsteken niet exact
  // teruggevonden in een overigens geslaagde respons) bisecteren — dat
  // isoleert het specifieke probleemitem zonder de rest van de batch te
  // laten mislukken.
  const mid = Math.ceil(parts.length / 2);
  const [left, right] = await Promise.all([
    translateParts(parts.slice(0, mid), to, from),
    translateParts(parts.slice(mid), to, from),
  ]);
  return [...left, ...right];
}

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
  const batchResults = await Promise.all(batches.map((batch) => translateParts(batch, to, from)));
  const translatedParts = batchResults.flat();

  const out = list.map((b) => ({ ...b }));
  jobs.forEach((job, idx) => {
    // null (mislukte vertaling van dit specifieke veld) bewust NIET zetten:
    // dan valt de weergave terug op de originele tekst mét die herkenbaar als
    // onvertaald, i.p.v. een vals "vertaald" veld met ongewijzigde brontekst.
    if (translatedParts[idx] != null) out[job.i][job.field] = translatedParts[idx];
  });
  return out;
}
