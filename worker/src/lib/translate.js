/**
 * Vertaling, server-side in de Worker (geen CORS-/keyproblemen; resultaten
 * cachebaar). Twee backends met een vaste voorrang:
 *
 *   1. Google (primair) — het gratis, niet-officiële Google-endpoint. Geen key,
 *      goede kwaliteit voor alle 17 brontalen, maar het rate-limit't onder druk
 *      (429) → dan vielen stukken voorheen onvertaald terug op de brontekst.
 *   2. MyMemory (vangnet) — een gratis, keyloze vertaal-API (een ándere engine
 *      dan Google, dus hij helpt juist wanneer Google beknot raakt). Wordt
 *      alleen aangesproken als Google faalt; zo blijft de kwaliteit standaard
 *      die van Google, maar krijg je toch een vertaling i.p.v. brontekst als
 *      Google het laat afweten. Geen account nodig; een optionele
 *      MYMEMORY_EMAIL-secret verhoogt alleen de gratis daglimiet.
 *
 * De rest van de pijplijn (chunking, batching, retry, concurrency-limiet)
 * is backend-onafhankelijk.
 */
const GOOGLE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const MYMEMORY_ENDPOINT = 'https://api.mymemory.translated.net/get';

// Optioneel: e-mail voor MyMemory (verhoogt de gratis daglimiet van ~5k naar
// ~50k woorden/dag). Zonder werkt het vangnet anoniem gewoon door.
let MYMEMORY_EMAIL = null;

/**
 * Leest optionele vertaal-config uit de environment. Op dit moment alleen
 * MYMEMORY_EMAIL (om de gratis MyMemory-daglimiet te verhogen). Aanroepen
 * vanuit index.js (Worker-env) en de snapshot-scripts (process.env).
 */
export function configureTranslator(env = {}) {
  MYMEMORY_EMAIL = env.MYMEMORY_EMAIL || null;
  return activeTranslator();
}

/** Welke keten nu actief is — voor diagnose/tests. */
export function activeTranslator() { return 'google→mymemory'; }

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

/** Eén Google-call (één tekstdeel) → {text, detected}. Werpt Error met .status
 *  bij een HTTP-fout zodat de retry-laag 429/5xx herkent. */
async function callGoogle(part, to, from) {
  const url = `${GOOGLE_ENDPOINT}?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(part)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) { const e = new Error(`Vertaling ${res.status}`); e.status = res.status; throw e; }
  const d = await res.json();
  const text = Array.isArray(d?.[0]) ? d[0].map((s) => (s && s[0]) || '').join('') : '';
  return { text, detected: d?.[2] || null };
}

// MyMemory begrenst één query op ~500 tekens, dus het vangnet hakt een deel
// intern nog in kleinere segmenten (op zin-/spatiegrenzen).
const MM_MAX = 450;
// Foutmeldingen die MyMemory soms mét HTTP 200 in het tekstveld teruggeeft
// (dagquotum op, ongeldige taal, …) — die tellen als een mislukte call.
const MM_ERROR = /MYMEMORY WARNING|YOU USED ALL|QUERY LENGTH LIMIT|INVALID (?:LANGUAGE|EMAIL|SOURCE|TARGET)|PLEASE SELECT/i;

function mmSubchunks(text) {
  const out = [];
  let buf = '';
  for (const piece of String(text).split(/(?<=[.!?。])\s+|\s+/)) {
    if ((buf ? buf.length + 1 + piece.length : piece.length) > MM_MAX) {
      if (buf) out.push(buf);
      buf = piece.length > MM_MAX ? piece.slice(0, MM_MAX) : piece;
    } else buf = buf ? `${buf} ${piece}` : piece;
  }
  if (buf) out.push(buf);
  return out.length ? out : [String(text).slice(0, MM_MAX)];
}

/** Vangnet: MyMemory (gratis, keyloos). Vereist een concrete brontaal (kent
 *  geen auto-detectie); bij 'auto'/leeg faalt hij bewust zodat de vertaling
 *  netjes op de brontekst terugvalt i.p.v. een verkeerd taalpaar te gokken. */
async function callMyMemory(part, to, from) {
  const src = String(from || '').toLowerCase();
  if (!src || src === 'auto') { const e = new Error('MyMemory vereist een brontaal'); e.status = 400; throw e; }
  const out = [];
  for (const seg of mmSubchunks(part)) {
    const url = `${MYMEMORY_ENDPOINT}?q=${encodeURIComponent(seg)}&langpair=${encodeURIComponent(src)}|${encodeURIComponent(to)}`
      + (MYMEMORY_EMAIL ? `&de=${encodeURIComponent(MYMEMORY_EMAIL)}` : '');
    const res = await fetch(url, { headers: { 'User-Agent': 'ReisadviezenBuddy/1.0' } });
    if (!res.ok) { const e = new Error(`MyMemory ${res.status}`); e.status = res.status; throw e; }
    const d = await res.json();
    const t = d?.responseData?.translatedText;
    const status = Number(d?.responseStatus) || 0;
    // Quotum-/foutmeldingen (403) tellen als niet-herbruikbaar: niet opnieuw
    // proberen (429/5xx wél), want een dagquotum lost een retry niet op.
    if (status !== 200 || !t || MM_ERROR.test(t)) { const e = new Error('MyMemory: geen bruikbare vertaling'); e.status = 403; throw e; }
    out.push(t);
  }
  return { text: out.join(' '), detected: src };
}

/** Voert één call uit met retries bij 429/5xx (rate-limit/transiënt). */
async function withRetries(call, tries = 3) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await limited(call);
    } catch (e) {
      const status = e?.status || 0;
      if (attempt === tries || (status !== 429 && status < 500)) throw e;
      // Korte, oplopende pauze; het wachtrij-slot komt tijdens de pauze vrij
      // zodat andere bronnen ondertussen door kunnen.
      await sleep(300 * attempt + Math.random() * 200);
    }
  }
  throw new Error('Vertaling: geen resultaat');
}

/** Eén tekstdeel vertalen: Google eerst, en pas als Google het écht laat
 *  afweten (na retries) het MyMemory-vangnet. Falen beide, dan werpen we de
 *  oorspronkelijke Google-fout zodat de aanroeper het als 'onvertaald' afhandelt. */
async function translateOnce(part, to, from) {
  try {
    return await withRetries(() => callGoogle(part, to, from));
  } catch (googleErr) {
    try {
      return await withRetries(() => callMyMemory(part, to, from), 2);
    } catch {
      throw googleErr;
    }
  }
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
