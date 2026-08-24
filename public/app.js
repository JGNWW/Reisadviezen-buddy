'use strict';

// ==========================================================================
// Reisadviezen-buddy — frontend.
// NL-data komt statisch uit ./data; buitenlandse adviezen + kaarten komen live
// van de proxy (Cloudflare Worker). Vergelijken + divergentie + zoeken gebeuren
// in de browser.
// ==========================================================================

const CFG = window.REISADVIEZEN_CONFIG || { PROXY: '', SOURCES: [] };
const DATA = 'data';

// ---- DOM-helpers ----------------------------------------------------------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const COLOR_LABELS = { groen: 'Groen', geel: 'Geel', oranje: 'Oranje', rood: 'Rood' };
const COLOR_MEANING = {
  groen: 'Geen bijzondere veiligheidsrisico’s',
  geel: 'Let op: bijzondere veiligheidsrisico’s',
  oranje: 'Reis alleen als het noodzakelijk is',
  rood: 'Niet reizen',
};
const COLOR_LEVEL = { groen: 1, geel: 2, oranje: 3, rood: 4 };
const LEVEL_COLORS = ['', 'groen', 'geel', 'oranje', 'rood'];

// Bronteksten staan altijd in de originele taal. De keuze "vertaal alles in
// één keer" is eruit: die haalde bij elke vergelijking honderden fragmenten
// door het vertaal-endpoint, wat traag was en regelmatig half mislukte. In
// plaats daarvan zit er bij elk fragment een 🇳🇱/🇬🇧-knopje dat alleen dát
// fragment vertaalt, op het moment dat je het nodig hebt.
// Matrix-weergave: 'compact' (cellen ingeklapt tot ±4 regels) of 'volledig'.
let MATRIX_DENSITY = localStorage.getItem('matrixDensity') || 'compact';
// Verborgen thema-rijen in de matrix (punt 17), gedeeld over alle landen.
let HIDDEN_THEMES = new Set((() => { try { return JSON.parse(localStorage.getItem('hiddenThemes')) || []; } catch { return []; } })());
const saveHiddenThemes = () => localStorage.setItem('hiddenThemes', JSON.stringify([...HIDDEN_THEMES]));
// Actief matrix-termfilter (gezet door een gazetteer-chip): toont alleen de
// passages die deze term noemen, over alle bronkolommen. { label, term, re }.
let MATRIX_FILTER = null;
// De data van het land dat nu open staat (het actieve landtabblad). Alles wat
// over "dit land" gaat — briefing, volgknop, ?land= in de URL — leest hier.
let LAST_COMPARE = null;
// Vergelijkselectie: één land = het scherm zoals het altijd was, meerdere
// landen = kleurcodematrix + landentabs boven datzelfde schema.
let COMPARE_COUNTRIES = [];          // gekozen landen (de chips), in volgorde
let COMPARE_RESULTS = new Map();     // iso3 → { country, staticData, foreign }
let COMPARE_SOURCES = [];            // bronnen van de laatste ophaling
let COMPARE_ACTIVE = null;           // iso3 van het open landtabblad
// Naam van de groep waaruit deze selectie komt (alleen in dit tabblad, niet in
// de URL). Wijkt de selectie ervan af, dan kun je die groep bijwerken in plaats
// van een bijna-identieke tweede groep te maken.
let ACTIVE_GROUP = null;
// Vooringevulde term voor de onderwerp-zoeker (gezet door de indexzoeker en
// de gazetteer-chips; wordt na de eerstvolgende vergelijking uitgevoerd).
let PENDING_TOPIC = null;

// ---- Bronselectie -----------------------------------------------------------
const allSourceIds = () => (CFG.SOURCES || []).map((s) => s.id);
const sourceMeta = (id) => (CFG.SOURCES || []).find((s) => s.id === id) || null;
function loadSelectedSources() {
  try {
    const saved = JSON.parse(localStorage.getItem('selectedSources'));
    if (Array.isArray(saved)) {
      const valid = saved.filter((id) => allSourceIds().includes(id));
      if (valid.length) return valid;
    }
  } catch { /* val terug op standaard */ }
  return (CFG.SOURCES || []).filter((s) => s.default !== false).map((s) => s.id);
}
let SELECTED_SOURCES = loadSelectedSources();
const saveSelectedSources = () => localStorage.setItem('selectedSources', JSON.stringify(SELECTED_SOURCES));
// Bronnen in de vaste config-volgorde (chips/kolommen blijven zo stabiel).
const orderedSelected = () => allSourceIds().filter((id) => SELECTED_SOURCES.includes(id));

/** Landvlag-emoji uit een ISO-2-code (regional indicator symbols). */
function countryFlag(iso2) {
  if (!iso2 || iso2.length !== 2) return '';
  return String.fromCodePoint(...[...iso2.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

// ---- Vlag-afbeeldingen (flagify) -------------------------------------------
// Emoji-vlaggen renderen op Windows als kale letterparen. In de hele app staan
// vlaggen (landen én bronnen) als emoji in de tekst; deze laag vervangt ze bij
// het renderen automatisch door lokaal meegeleverde afbeeldingen
// (flags/{iso2}.png). Laadt een afbeelding niet, dan komt de emoji terug —
// nooit een kapot icoontje. title-attributen (tooltips) blijven emoji.
const FLAG_SPLIT = /(\p{RI}\p{RI})/gu;

function flagImgFor(emoji) {
  const iso2 = [...emoji].map((ch) => String.fromCharCode(ch.codePointAt(0) - 0x1f1e6 + 97)).join('');
  const img = el('img', { class: 'flag-img', src: `flags/${iso2}.png`, alt: '', loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(document.createTextNode(emoji)), { once: true });
  return img;
}

/**
 * Landmerk voor een resultaatrij: de vlag van het land, met het kleurbolletje
 * als terugval.
 *
 * In een lijst van landen herken je een land sneller aan zijn vlag dan aan een
 * bolletje dat voor elk groen advies precies hetzelfde is. De kleurcode gaat
 * niet verloren: die blijft als tooltip beschikbaar.
 *
 * Landen zonder iso2 in de landendata houden het bolletje — dan is er geen
 * vlagafbeelding en is een bolletje beter dan een kapot icoontje.
 */
function landMerk(iso3, color) {
  const iso2 = COUNTRIES.find((x) => x.iso3 === iso3)?.iso2;
  const merk = iso2 ? flagImgFor(countryFlag(iso2)) : (color ? el('span', { class: `dot c-${color}` }) : null);
  if (merk && color) merk.title = COLOR_LABELS[color];
  return merk;
}

function flagifyNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const parts = node.nodeValue.split(FLAG_SPLIT);
    if (parts.length < 2) return;
    const frag = document.createDocumentFragment();
    parts.forEach((p, i) => { if (p) frag.append(i % 2 ? flagImgFor(p) : document.createTextNode(p)); });
    node.replaceWith(frag);
  } else if (node.nodeType === Node.ELEMENT_NODE
    && !/^(SCRIPT|STYLE|TEXTAREA|INPUT|SELECT|IMG)$/.test(node.tagName)
    && !node.closest('[data-no-flagify]')) {
    for (const child of [...node.childNodes]) flagifyNode(child);
  }
}

(function initFlagify() {
  const start = () => {
    flagifyNode(document.body);
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) flagifyNode(n);
    }).observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();

/** Vlaggetje ín het landinvoerveld zodra er een geldig land staat. */
function setComboFlag(country) {
  const input = $('#country-input');
  const wrap = input?.closest('.combo');
  if (!wrap) return;
  let img = $('.combo-input-flag', wrap);
  if (!country?.iso2) { img?.remove(); input.classList.remove('has-flag'); return; }
  if (!img) {
    img = el('img', { class: 'flag-img combo-input-flag', alt: '' });
    img.addEventListener('error', () => { img.remove(); input.classList.remove('has-flag'); });
    wrap.append(img);
  }
  img.src = `flags/${country.iso2.toLowerCase()}.png`;
  input.classList.add('has-flag');
}

// ---- URL-state: deelbare links ---------------------------------------------
// land/bronnen/taal/tab staan in de URL zodat een vergelijking te bookmarken
// en door te sturen is. Bestaande parameters (zoals ?proxy=) blijven staan.
function updateUrl(patch, push = false) {
  const sp = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === '') sp.delete(k); else sp.set(k, v);
  }
  const qs = sp.toString();
  try { history[push ? 'pushState' : 'replaceState'](null, '', location.pathname + (qs ? `?${qs}` : '')); } catch { /* bijv. file:// */ }
}

const defaultSourceIds = () => (CFG.SOURCES || []).filter((s) => s.default !== false).map((s) => s.id);

/** Schrijft de huidige vergelijkingsstaat naar de URL (default-waarden blijven weg). */
function syncUrl(push = false) {
  const cur = orderedSelected().join(',');
  // Eén land blijft ?land= (korte, herkenbare deellink); meerdere landen
  // krijgen ?landen= met het open tabblad in ?tabland=.
  const sel = COMPARE_COUNTRIES.map((c) => c.iso3);
  updateUrl({
    land: sel.length === 1 ? sel[0] : null,
    landen: sel.length > 1 ? sel.join(',') : null,
    tabland: sel.length > 1 && COMPARE_ACTIVE && COMPARE_ACTIVE !== sel[0] ? COMPARE_ACTIVE : null,
    vs: null,
    bronnen: cur === defaultSourceIds().join(',') ? null : cur,
    // Alleen in de link zetten als hij aanstaat: een deellink hoort de
    // weergave mee te nemen, maar de standaard hoort niet in de URL.
    regio: REGIO_KLEUREN ? '1' : null,
    taal: null, // bestaat niet meer; wist hem uit oudere deellinks
  }, push);
}

/** Leest taal/bronnen uit de URL in de globale staat (vóór de UI-opbouw). */
function initFromUrl() {
  const sp = new URLSearchParams(location.search);
  const bronnen = sp.get('bronnen');
  if (bronnen != null) {
    const ids = bronnen.split(',').map((s) => s.trim()).filter((id) => allSourceIds().includes(id));
    if (ids.length) SELECTED_SOURCES = ids;
  }
  // Een deellink mag de weergave meebrengen; wat er niet in staat, blijft de
  // eigen (bewaarde) voorkeur.
  const regio = sp.get('regio');
  if (regio != null) REGIO_KLEUREN = regio === '1';
}

/** Past tab + land uit de URL toe (ná de UI-opbouw); start zo nodig de vergelijking. */
function activateFromUrl() {
  const sp = new URLSearchParams(location.search);
  // 'worklist' is de oude naam van het favorietentabblad — oude deellinks
  // horen niet stilletjes op Vergelijken uit te komen.
  const tab = sp.get('tab') === 'worklist' ? 'favorieten' : sp.get('tab');
  if (tab && $(`.tab[data-view="${tab}"]`)) activateTab(tab);
  // ?briefing=favorieten opent de bundel-ochtendbriefing over alle favorieten.
  if (['favorieten', 'watchlist'].includes(sp.get('briefing'))) { openFavoritesBriefing(); return; }
  // ?briefing=ISO opent na het laden direct de briefing (punt 15).
  const briefing = sp.get('briefing');
  // ?landen=A,B,C is de meerlandenselectie; ?land= en het oudere ?vs=A,B
  // blijven werken zodat bestaande deellinks niet breken.
  const raw = briefing || sp.get('landen') || sp.get('land') || sp.get('vs');
  if (raw) {
    const gekozen = raw.split(',').map((x) => resolveCountry(x.trim())).filter(Boolean)
      .slice(0, MAX_COMPARE_COUNTRIES);
    if (gekozen.length) {
      if (briefing) PENDING_BRIEFING = gekozen[0].iso3;
      COMPARE_COUNTRIES = gekozen;
      const tabland = resolveCountry(sp.get('tabland') || '');
      COMPARE_ACTIVE = (tabland && gekozen.some((c) => c.iso3 === tabland.iso3) ? tabland : gekozen[0]).iso3;
      renderCompareChips();
      runCompare();
    }
  }
}

// ---- Proxy-configuratie ---------------------------------------------------
function getProxy() {
  const qs = new URLSearchParams(location.search).get('proxy');
  if (qs) return qs.replace(/\/+$/, '');
  const ls = localStorage.getItem('proxyBase');
  if (ls) return ls.replace(/\/+$/, '');
  return (CFG.PROXY || '').replace(/\/+$/, '');
}
function setProxy(url) {
  const clean = (url || '').trim().replace(/\/+$/, '');
  if (clean) localStorage.setItem('proxyBase', clean);
  else localStorage.removeItem('proxyBase');
}

// ---- Robuuste proxy-fetch met retry + publieke fallback -------------------
// "Failed to fetch" op de Worker is meestal een tijdelijke hapering of een
// trage zware-landenrequest, geen echte storing. Daarom: eerst de directe
// route (met retry + backoff), en pas als díé volhardend faalt een publieke
// CORS-proxy die dezelfde Worker-URL doorgeeft — dat helpt wanneer juist het
// netwerk/PoP van de bezoeker de workers.dev-host even niet bereikt. De
// publieke proxies zijn traag en onbetrouwbaar voor grote payloads, dus
// uitsluitend laatste redmiddel met een strak tijdslimiet.
const PUBLIC_PROXIES = [
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
];
let workingPublic = 0; // welke publieke fallback het laatst lukte (volgorde-tiebreak)
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fetchWithTimeout(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { signal: ac.signal }).finally(() => clearTimeout(t));
}

/**
 * Haalt een pad op via de proxy en geeft de geparste JSON terug. Probeert
 * routes op volgorde (laatst-werkende eerst); per route retries met backoff.
 * Gooit pas als álle routes falen.
 */
async function proxyJson(path, { directTimeout = 25000, publicTimeout = 10000 } = {}) {
  const proxy = getProxy();
  if (!proxy) throw new Error('geen proxy ingesteld');
  const target = `${proxy}${path}`;
  // Direct staat áltijd voorop — de publieke fallback is puur noodhulp en mag
  // ons niet vastpinnen zodra de Worker weer bereikbaar is. Onder de publieke
  // proxies staat de laatst-gelukte vooraan.
  const publicOrder = PUBLIC_PROXIES.map((_, i) => i)
    .sort((a, b) => (a === workingPublic ? -1 : b === workingPublic ? 1 : 0));
  const routes = [-1, ...publicOrder];
  let lastErr;
  for (const route of routes) {
    const url = route === -1 ? target : PUBLIC_PROXIES[route](target);
    const timeout = route === -1 ? directTimeout : publicTimeout;
    const maxAttempts = route === -1 ? 3 : 1; // direct 3x, publiek 1x
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt) await _sleep(600 * 2 ** (attempt - 1)); // 0,6s · 1,2s
      try {
        const r = await fetchWithTimeout(url, timeout);
        if (!r.ok) {
          lastErr = new Error(`Proxy gaf ${r.status}`);
          // 5xx/408/429 = tijdelijk → opnieuw/volgende route; anders stoppen.
          if (r.status >= 500 || r.status === 408 || r.status === 429) continue;
          throw lastErr;
        }
        const data = await r.json();
        if (route >= 0) workingPublic = route; // welke fallback werkte
        return data;
      } catch (e) {
        lastErr = e;
        if (e.name === 'SyntaxError') break; // ongeldige JSON van deze route → volgende
      }
    }
  }
  throw lastErr || new Error('proxy onbereikbaar');
}

// ---- Datalaag -------------------------------------------------------------
const _cache = new Map();
async function loadJSON(path) {
  if (_cache.has(path)) return _cache.get(path);
  const p = fetch(`${DATA}/${path}`).then((r) => {
    if (!r.ok) throw new Error(`Kan ${path} niet laden (${r.status})`);
    return r.json();
  });
  _cache.set(path, p);
  return p.catch((e) => { _cache.delete(path); throw e; });
}
// De 6-uurlijkse snapshot-CI schrijft per land het laatste volledige advies
// naar worker/data/latest/ in de (publieke) repo. De Worker gebruikt dat al als
// vangnet pér bron — maar dat vangnet zit ín de Worker: valt een hele
// Worker-aanroep om (503/timeout), dan verdwijnen álle bronnen uit die batch
// zonder ooit bij hun snapshot te komen. Daarom kan de frontend hetzelfde
// bestand rechtstreeks lezen; raw.githubusercontent stuurt CORS: *.
const SNAPSHOT_BASE = 'https://raw.githubusercontent.com/JGNWW/Reisadviezen-buddy/main/worker/data/latest';

/** Leest de opgeslagen snapshot van dit land en levert de gevraagde bronnen op
 *  in hetzelfde formaat als de Worker, met stale-markering (📸-badge). */
async function snapshotSources(iso, ids) {
  if (!ids.length) return [];
  try {
    const r = await fetchWithTimeout(`${SNAPSHOT_BASE}/${iso}.json`, 12000);
    if (!r.ok) return [];
    const d = await r.json();
    return ids
      .map((id) => {
        const e = d?.sources?.[id];
        if (!e?.themes?.length) return null;
        return {
          ...e,
          stale: true,
          snapshotDate: d.fetchedAt?.[id] || null,
          mapProxy: e.hasMap ? `/map/${id}/${iso}` : null,
        };
      })
      .filter(Boolean);
  } catch { return []; }
}

async function fetchForeign(iso, sources, translate = 'nl') {
  const proxy = getProxy();
  if (!proxy || !sources.length) return null;
  const q = translate ? `&translate=${translate}` : '';
  const call = (ids) => proxyJson(`/advisory/${iso}?sources=${ids.join(',')}${q}`);

  const bySource = new Map();
  let firstRes = null, firstErr = null;
  // allSettled i.p.v. all: een enkele hapering mag niet de héle vergelijking
  // wegvagen — de bronnen die wél lukten tonen we, de rest halen we hieronder
  // alsnog op.
  const collect = (settled) => {
    for (const s of settled) {
      if (s.status === 'rejected') { firstErr = firstErr || s.reason; continue; }
      firstRes = firstRes || s.value;
      for (const src of s.value?.sources || []) bySource.set(src.source, src);
    }
  };

  // Ronde 1: eén Worker-aanroep met álle (17) bronnen overschrijdt bij
  // inhoudsrijke landen het subrequest-/CPU-budget van Cloudflare (503).
  // Splits daarom in batches van maximaal 8 bronnen — de volgorde van
  // `sources` blijft leidend voor de weergave.
  const BATCH = 8;
  const batches = [];
  for (let i = 0; i < sources.length; i += BATCH) batches.push(sources.slice(i, i + BATCH));
  collect(await Promise.allSettled(batches.map(call)));

  // Ronde 2: lukte er minstens één batch, dan léeft de Worker en was de
  // gesneuvelde batch simpelweg te zwaar (de trage bronnen zitten bij elkaar
  // in de lijst, dus één batch nam er in één klap acht mee). Haal die bronnen
  // los op: elke aanroep krijgt zo zijn eigen budget én komt daarmee alsnog
  // bij het snapshot-vangnet ín de Worker — inclusief vertaling.
  let missing = sources.filter((id) => !bySource.has(id));
  if (missing.length && bySource.size) {
    collect(await Promise.allSettled(missing.map((id) => call([id]))));
    missing = sources.filter((id) => !bySource.has(id));
  }

  // Ronde 3: nog steeds niets binnen → de Worker is voor deze bronnen
  // onbereikbaar. Lees het opgeslagen snapshot dan rechtstreeks uit de repo,
  // zodat een bron nooit zomaar uit de vergelijking verdwijnt.
  if (missing.length) {
    for (const s of await snapshotSources(iso, missing)) bySource.set(s.source, s);
    missing = sources.filter((id) => !bySource.has(id));
  }

  if (!bySource.size) throw firstErr || new Error('proxy onbereikbaar');

  const got = sources.map((id) => bySource.get(id)).filter(Boolean);
  const merged = { country: { iso3: iso }, ...(firstRes || {}), sources: got };
  // Melding als een bron zelfs na de losse poging én het snapshot ontbreekt.
  if (missing.length) merged.partialNotice = missing;
  return merged;
}
async function translateText(q, to, from = 'auto') {
  if (!getProxy()) return q;
  try {
    const d = await proxyJson(`/translate?to=${to}&from=${from}&q=${encodeURIComponent(q)}`);
    return d.text || q;
  } catch { return q; }
}

// ---- Seizoenskalender + humanitaire context -------------------------------
let SEASONS = [];
async function loadSeasons() {
  try { SEASONS = (await loadJSON('seasons.json')).seasons || []; } catch { SEASONS = []; }
}
/** Seizoenen die deze maand actief zijn voor een land. */
function activeSeasons(iso3) {
  const m = new Date().getMonth() + 1;
  return (SEASONS || []).filter((s) => s.iso3?.includes(iso3) && s.months?.includes(m));
}

/**
 * Lokaal nieuws (top-3 meest gelezen lokale bronnen, laatste 30 dagen),
 * ingedeeld op de reisadvies-categorieën. Alleen voor landen met een
 * gecureerde bronnenlijst; anders blijft het slot leeg.
 */
async function loadLocalNews(iso3, slot) {
  if (!getProxy()) return;
  try {
    const d = await proxyJson(`/news/${iso3}?translate=nl`);
    const cats = d.available ? Object.entries(d.categories || {}) : [];
    if (!cats.length) return;
    const total = cats.reduce((n, [, c]) => n + c.items.length, 0);
    const box = el('details', { class: 'news-box' });
    const nflag = countryFlagByIso3(iso3);
    box.append(el('summary', {},
      `📰 ${nflag ? nflag + ' ' : ''}Lokaal nieuws (${d.days || 30} dagen) — ${total} bericht${total === 1 ? '' : 'en'} `,
      el('span', { class: 'news-srcs' }, `· ${(d.sources || []).join(' · ')}`)));
    for (const [, c] of cats) {
      const wrap = el('div', { class: 'news-cat' });
      wrap.append(el('h4', {}, `${c.icon || ''} ${c.label}`,
        el('span', { class: 'news-count' }, ` ${c.items.length}`)));
      for (const it of c.items) {
        const row = el('div', { class: 'news-row' },
          el('span', { class: 'news-date' }, it.date ? new Date(it.date).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }) : '—'),
          el('div', { class: 'news-main' },
            el('a', { href: it.link || '#', target: '_blank', rel: 'noopener' }, it.title),
            it.titleNl ? el('div', { class: 'news-nl' }, it.titleNl) : null,
            el('div', { class: 'news-meta' },
              el('span', { class: 'news-outlet' }, it.outlet),
              it.multi ? el('span', {
                class: 'news-multi',
                title: it.alsoAt?.length ? `Ook gebracht door: ${it.alsoAt.join(', ')}` : 'Door meerdere van de drie bronnen gebracht',
              }, '🔁 meerdere bronnen') : null)));
        wrap.append(row);
      }
      box.append(wrap);
    }
    // Twijfelgevallen: de kop wijst op een ánder land (of noemt dit land niet
    // terwijl het uit gemengde, wereldwijde media komt). Niet weggegooid maar
    // ingeklapt onderaan — liever zelf beoordelen dan stil iets missen.
    if (d.demoted?.length) {
      const sub = el('details', { class: 'news-demoted' });
      sub.append(el('summary', {}, `🌍 Mogelijk niet over dit land (${d.demoted.length})`));
      sub.append(el('p', { class: 'news-demoted-note' },
        'Deze koppen wijzen op een ander land, of noemen dit land niet. Ze staan hier apart zodat je zelf kunt beoordelen of ze toch relevant zijn.'));
      for (const it of d.demoted) {
        sub.append(el('div', { class: 'news-row' },
          el('span', { class: 'news-date' }, it.date ? new Date(it.date).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }) : '—'),
          el('div', { class: 'news-main' },
            el('a', { href: it.link || '#', target: '_blank', rel: 'noopener' }, it.title),
            it.titleNl ? el('div', { class: 'news-nl' }, it.titleNl) : null,
            el('div', { class: 'news-meta' },
              el('span', { class: 'news-outlet' }, it.outlet),
              it.cat ? el('span', { class: 'news-demoted-cat' }, it.cat) : null))));
      }
      box.append(sub);
    }

    box.append(el('p', { class: 'news-foot' },
      d.mixed
        ? 'Voor dit land is (nog) geen gecureerde top-3 van lokale bronnen; getoond wordt reisadvies-relevant nieuws over het land uit alle door Google News geïndexeerde media. 🔁 markeert nieuws dat meerdere media brengen. NL-vertaling is automatisch; koppen linken naar het bronartikel.'
        : 'Automatisch ingedeeld op reisadvies-categorieën; 🔁 markeert nieuws dat meerdere van de drie bronnen brengen. NL-vertaling is automatisch; koppen linken naar het bronartikel.'));
    slot.append(box);
  } catch { /* stil: nieuws is optioneel */ }
}

/** Haalt (indien de proxy het levert) humanitaire context op en vult het slot. */
async function loadContext(iso3, slot) {
  if (!getProxy()) return;
  try {
    const d = await proxyJson(`/context/${iso3}`);
    if (!d.available || !d.items?.length) return;
    const box = el('details', { class: 'context-box' });
    box.append(el('summary', {}, `🕊️ Humanitaire context (ReliefWeb) — ${d.items.length} recente melding${d.items.length === 1 ? '' : 'en'}`));
    const ul = el('ul', { class: 'context-list' });
    d.items.forEach((it) => ul.append(el('li', {},
      it.date ? el('span', { class: 'context-date' }, it.date + ' · ') : null,
      el('a', { href: it.url, target: '_blank', rel: 'noopener' }, it.name),
      it.status && it.status !== 'past' ? el('span', { class: 'context-status' }, ` (${it.status})`) : null)));
    box.append(ul);
    slot.append(box);
  } catch { /* stil: context is optioneel */ }
}

// ---- Tekst-helpers --------------------------------------------------------
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
/**
 * Vertaalvlaggetjes bij één zoekfragment onder "Wat zegt elke bron over…".
 *
 * Dezelfde werking als bij de themavergelijking: 🇳🇱 zet dit fragment om naar
 * het Nederlands, 🇬🇧 naar het Engels, en nogmaals klikken zet de brontekst
 * terug. Bewust per fragment — bij zeventien bronnen zou een knop per kaart
 * alsnog tientallen vertaalverzoeken tegelijk afvuren, en juist dat was de
 * oorzaak van de haperingen waarom de globale taalkeuze eruit is gegaan.
 *
 * De treffer wordt na het vertalen opnieuw gemarkeerd waar dat kan: de
 * gezochte term staat er soms letterlijk in (dezelfde taal), soms niet meer
 * (dan blijft de tekst gewoon onopgemaakt).
 */
function snippetVertaalKnoppen(m, kopEl, tekstEl) {
  const origKop = m.heading || '';
  let taal = 'orig';
  const knop = (vlag, naam, titel) =>
    el('button', { class: 'snip-flag', type: 'button', 'aria-label': titel, title: titel }, vlag);
  const nlBtn = knop('🇳🇱', 'nl', 'Vertaal dit fragment naar het Nederlands');
  const enBtn = knop('🇬🇧', 'en', 'Vertaal dit fragment naar het Engels (English)');
  const setActive = () => {
    nlBtn.classList.toggle('active', taal === 'nl');
    enBtn.classList.toggle('active', taal === 'en');
  };

  // De kop bestaat uit tekst + eventueel de "toon op bronpagina"-link; alleen
  // het eerste tekstknooppunt vervangen, anders verdwijnt die link.
  const zetKop = (t) => {
    const eerste = [...kopEl.childNodes].find((n) => n.nodeType === 3);
    if (eerste) eerste.nodeValue = t; else kopEl.prepend(document.createTextNode(t));
  };
  const zetTekst = (t) => { tekstEl.innerHTML = highlight(t, m.variant); };

  const terug = () => { taal = 'orig'; zetKop(origKop); tekstEl.innerHTML = m.html; setActive(); };

  async function naar(lang, btn) {
    if (taal === lang) { terug(); return; }
    if (!getProxy()) return; // zonder proxy geen live vertaling
    btn.classList.add('loading');
    nlBtn.disabled = enBtn.disabled = true;
    try {
      const [tTekst, tKop] = await Promise.all([
        translateText(m.snippet, lang, 'auto'),
        origKop ? translateText(origKop, lang, 'auto') : Promise.resolve(''),
      ]);
      taal = lang;
      if (tKop) zetKop(tKop);
      zetTekst(tTekst || m.snippet);
      setActive();
    } finally {
      btn.classList.remove('loading');
      nlBtn.disabled = enBtn.disabled = false;
    }
  }
  nlBtn.addEventListener('click', () => naar('nl', nlBtn));
  enBtn.addEventListener('click', () => naar('en', enBtn));
  return el('span', { class: 'snip-flags topic-flags' }, nlBtn, enBtn);
}

function snippetAround(text, term, radius = 160) {
  if (!text) return '';
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return text.slice(0, radius * 2).trim() + (text.length > radius * 2 ? '…' : '');
  const start = Math.max(0, idx - radius), end = Math.min(text.length, idx + term.length + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}
function highlight(text, term) {
  if (!term) return esc(text);
  const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return esc(text).replace(re, '<mark>$1</mark>');
}
/** Escapet tekst en markeert (optioneel) de treffers van een RegExp met <mark>. */
function markText(text, re) {
  const e = esc(text || '');
  if (!re) return e;
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  return e.replace(g, (m) => `<mark>${m}</mark>`);
}
/** Filtert blokken op die welke een RegExp noemen (heading/tekst/vertaling). */
function blocksMatching(blocks, re) {
  if (!blocks || !blocks.length) return null;
  const m = blocks.filter((b) => re.test(`${b.heading || ''} ${b.text || ''} ${b.headingNl || ''} ${b.textNl || ''}`));
  return m.length ? m : null;
}

// ---- Globale data ---------------------------------------------------------
let COUNTRIES = [];
let THEMES_META = [];
let THEME_ORDER = new Map();
let THEME_BY_ID = new Map();

// Icoontje bij een thema. Staat in de taxonomie zelf (themes.json), zodat
// scherm, pdf en excel hetzelfde plaatje pakken. Draait themes.json nog van
// vóór de icoontjes, dan valt het stil terug op niets — een lege span in
// plaats van een vraagteken.
// Twee verschillende "rest"-bakjes, dus twee verschillende plaatjes: 'Overig'
// is advies dat er wél staat maar in geen enkel thema valt, '_onbekend' is een
// wijziging waarvan we de categorie niet weten. Hetzelfde icoon voor allebei
// suggereert dat het hetzelfde is.
const OVERIG_ICON = '🧩';
const ONBEKEND_ICON = '🗂️';
const themeIcon = (id) => (id === '_other' ? OVERIG_ICON : id === '_onbekend' ? ONBEKEND_ICON : THEME_BY_ID.get(id)?.icon || '');
const iconEl = (id) => el('span', { class: 'cat-ico', 'aria-hidden': 'true' }, themeIcon(id));

// Gangbare benamingen die niet (of net anders) in de officiële namen zitten.
const COUNTRY_ALIASES = {
  vs: 'USA', usa: 'USA', amerika: 'USA', 'verenigde staten': 'USA',
  vk: 'GBR', engeland: 'GBR', 'groot brittannie': 'GBR', uk: 'GBR',
  birma: 'MMR', ivoorkust: 'CIV', vae: 'ARE', emiraten: 'ARE', dubai: 'ARE',
  congo: 'COD', 'congo kinshasa': 'COD', 'congo brazzaville': 'COG',
  tsjechie: 'CZE', 'tsjechische republiek': 'CZE', perzie: 'IRN',
  holland: 'NLD', kaapverdie: 'CPV', 'oost timor': 'TLS', swaziland: 'SWZ',
  'noord macedonie': 'MKD', macedonie: 'MKD', 'wit rusland': 'BLR',
  'palestijnse gebieden': 'PSE', palestina: 'PSE', 'vaticaanstad': 'VAT',
};

/** Dice-coëfficiënt op bigrammen — vangt typefouten ("Oekraine", "Filippijnen"). */
function diceSimilarity(a, b) {
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const ga = grams(a), gb = grams(b);
  let overlap = 0;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) || 0);
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

function resolveCountry(query) {
  if (!query) return null;
  const q = query.trim(), upper = q.toUpperCase();
  let c = COUNTRIES.find((x) => x.iso3 === upper); if (c) return c;
  const nq = norm(q).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const alias = COUNTRY_ALIASES[nq];
  if (alias) { c = COUNTRIES.find((x) => x.iso3 === alias); if (c) return c; }
  c = COUNTRIES.find((x) => (x.key || '').toLowerCase() === q.toLowerCase()); if (c) return c;
  c = COUNTRIES.find((x) => norm(x.nl) === nq || norm(x.en) === nq); if (c) return c;
  c = COUNTRIES.find((x) => norm(x.nl).startsWith(nq) || norm(x.en).startsWith(nq)); if (c) return c;
  c = COUNTRIES.find((x) => norm(x.nl).includes(nq) || norm(x.en).includes(nq)); if (c) return c;
  // Typefout-tolerantie: beste bigram-overeenkomst boven de drempel.
  let best = null, bestScore = 0.55;
  for (const x of COUNTRIES) {
    const score = Math.max(diceSimilarity(nq, norm(x.nl)), diceSimilarity(nq, norm(x.en)));
    if (score > bestScore) { best = x; bestScore = score; }
  }
  return best;
}

// ==========================================================================
// Tabs + settings
// ==========================================================================
function activateTab(view) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  updateUrl({ tab: view === 'compare' ? null : view });
  // De favorietenlijst kan zijn gewijzigd terwijl het tabblad dicht stond
  // (ster gezet bij een land, lijst geïmporteerd) — altijd vers tonen.
  if (view === 'favorieten') { renderFavorites(); renderGroups(); }
}
$$('.tab').forEach((t) => t.addEventListener('click', () => activateTab(t.dataset.view)));

$('#settings-btn').addEventListener('click', () => {
  const p = $('#settings-panel');
  p.hidden = !p.hidden;
  if (!p.hidden) $('#proxy-input').value = getProxy();
});
$('#proxy-save').addEventListener('click', () => {
  setProxy($('#proxy-input').value);
  $('#proxy-status').textContent = getProxy() ? `Opgeslagen: ${getProxy()}` : 'Proxy gewist — alleen NL-data.';
});
$('#proxy-test').addEventListener('click', async () => {
  const s = $('#proxy-status');
  const base = ($('#proxy-input').value || '').trim().replace(/\/+$/, '');
  if (!base) { s.textContent = 'Vul eerst een URL in.'; return; }
  s.textContent = 'Testen…';
  try {
    const r = await fetch(`${base}/health`);
    const d = await r.json();
    s.textContent = d.ok ? `✅ Proxy werkt: ${d.sources.join(', ')} · ${d.countries} landen.` : '⚠️ Onverwacht antwoord.';
  } catch (e) { s.textContent = '❌ Kan proxy niet bereiken: ' + e.message; }
});

// ==========================================================================
// Bootstrap
// ==========================================================================
async function bootstrap() {
  const [countries, themes, meta] = await Promise.all([
    loadJSON('countries.json'),
    loadJSON('themes.json'),
    loadJSON('meta.json').catch(() => null),
  ]);
  COUNTRIES = countries;
  THEMES_META = themes;
  themes.forEach((t, i) => { THEME_ORDER.set(t.id, i); THEME_BY_ID.set(t.id, t); });

  const list = $('#country-list');
  countries.forEach((c) => list.append(el('option', { value: c.nl })));

  initFromUrl();
  setupSourcePicker();
  setupCountryCombo();

  if (meta?.builtAt) {
    $('#build-meta').textContent =
      `NL-data bijgewerkt op ${new Date(meta.builtAt).toLocaleString('nl-NL')} · ${meta.countries} landen · buitenlandse data live`;
  }
  if (!getProxy()) {
    $('#build-meta').textContent += ' · ⚠️ proxy niet ingesteld (klik ⚙)';
  }

  loadFavoritesFromUrl();
  setupCompareSelection();
  // Await zodat deeplinks (?briefing=favorieten) de offline data al hebben.
  await Promise.all([buildChanges(), buildFavorites(), loadSeasons()]);
  updateFavoriteUI();
  activateFromUrl();
}

// Terug/vooruit in de browser: staat uit de URL opnieuw toepassen.
window.addEventListener('popstate', () => {
  initFromUrl();
  renderSourcePicker();
  const sp = new URLSearchParams(location.search);
  const tab = (sp.get('tab') === 'worklist' ? 'favorieten' : sp.get('tab')) || 'compare';
  if ($(`.tab[data-view="${tab}"]`)) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === tab));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${tab}`));
  }
  const raw = sp.get('landen') || sp.get('land') || sp.get('vs');
  const gekozen = (raw || '').split(',').map((x) => resolveCountry(x.trim())).filter(Boolean);
  if (gekozen.length && gekozen.map((c) => c.iso3).join(',') !== COMPARE_COUNTRIES.map((c) => c.iso3).join(',')) {
    COMPARE_COUNTRIES = gekozen.slice(0, MAX_COMPARE_COUNTRIES);
    COMPARE_ACTIVE = COMPARE_COUNTRIES[0].iso3;
    renderCompareChips();
    runCompare();
  }
});

// ==========================================================================
// Bronselectie-UI: chips (met vlag + ×) + "Bron toevoegen"-dropdown.
// De gekozen bronnen gelden voor de hele tool (vergelijking én uitdraai).
// ==========================================================================
function setupSourcePicker() {
  const addBtn = $('#source-add .btn-drop');
  const menu = $('#source-menu');
  const closeMenu = () => { menu.hidden = true; addBtn.setAttribute('aria-expanded', 'false'); };
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    if (open) renderSourceMenu();
    menu.hidden = !open;
    addBtn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => { if (!$('#source-add').contains(e.target)) closeMenu(); });
  $('#source-select-all')?.addEventListener('click', selectAllSources);
  $('#source-select-none')?.addEventListener('click', deselectAllSources);
  renderSourcePicker();
}

/** Selecteert in één klik alle beschikbare bronnen (i.p.v. ze stuk voor stuk toe te voegen). */
function selectAllSources() {
  SELECTED_SOURCES = allSourceIds();
  saveSelectedSources();
  renderSourcePicker();
  syncUrl();
  rerunLastCompare();
}
/** Verwijdert in één klik alle geselecteerde bronnen. */
function deselectAllSources() {
  if (!SELECTED_SOURCES.length) return;
  SELECTED_SOURCES = [];
  saveSelectedSources();
  renderSourcePicker();
  syncUrl();
  rerunLastCompare();
}

function renderSourcePicker() {
  const chips = $('#source-chips');
  if (!chips) return;
  chips.innerHTML = '';
  const sel = orderedSelected();
  const total = allSourceIds().length;
  const selectAllBtn = $('#source-select-all');
  const selectNoneBtn = $('#source-select-none');
  if (selectAllBtn) selectAllBtn.disabled = sel.length >= total;
  if (selectNoneBtn) selectNoneBtn.disabled = !sel.length;
  if (!sel.length) {
    chips.append(el('span', { class: 'hint', style: 'margin:0' }, 'Geen bronnen gekozen — voeg er minstens één toe.'));
  }
  sel.forEach((id) => {
    const m = sourceMeta(id);
    if (!m) return;
    const x = el('button', { type: 'button', class: 'chip-x', title: 'Verwijderen', 'aria-label': `${m.label} verwijderen` }, '×');
    x.addEventListener('click', () => removeSource(id));
    const chip = el('span', { class: 'src-chip' + (m.blocked ? ' geblokkeerd' : '') },
      el('span', { class: 'fl' }, m.flag || ''), ` ${m.label} `);
    // Meteen zichtbaar dat deze bron structureel niets oplevert, in plaats van
    // dat pas per land te ontdekken.
    if (m.blocked) chip.append(el('span', { class: 'chip-blok', title: m.blockedNote || 'Deze bron blokkeert geautomatiseerd ophalen.' }, '⊘ '));
    chip.append(x);
    chips.append(chip);
  });
  renderSourceMenu();
}

function renderSourceMenu() {
  const menu = $('#source-menu');
  if (!menu) return;
  menu.innerHTML = '';
  const avail = allSourceIds().filter((id) => !SELECTED_SOURCES.includes(id));
  if (!avail.length) { menu.append(el('div', { class: 'menu-empty' }, 'Alle bronnen zijn toegevoegd.')); return; }
  avail.forEach((id) => {
    const m = sourceMeta(id);
    const item = el('div', { class: 'menu-item' + (m.blocked ? ' geblokkeerd' : ''), role: 'button', tabindex: '0' },
      el('span', { class: 'fl' }, m.flag || ''), ` ${m.label}`);
    if (m.blocked) item.append(el('span', { class: 'menu-blok', title: m.blockedNote || '' }, ' ⊘ blokkeert ophalen'));
    const pick = () => { addSource(id); menu.hidden = true; $('#source-add .btn-drop').setAttribute('aria-expanded', 'false'); };
    item.addEventListener('click', pick);
    item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    menu.append(item);
  });
}

/** Voegt een bron toe en herlaadt de lopende vergelijking (indien getoond). */
function addSource(id) {
  if (SELECTED_SOURCES.includes(id)) return;
  SELECTED_SOURCES.push(id);
  saveSelectedSources();
  renderSourcePicker();
  syncUrl();
  rerunLastCompare();
}
function removeSource(id) {
  if (!SELECTED_SOURCES.includes(id)) return;
  SELECTED_SOURCES = SELECTED_SOURCES.filter((s) => s !== id);
  saveSelectedSources();
  renderSourcePicker();
  syncUrl();
  rerunLastCompare();
}
function rerunLastCompare() {
  if (COMPARE_RESULTS.size) runCompare();
}

// ==========================================================================
// Land-combobox: vlaggen, aliassen, typefout-tolerantie en recente landen.
// Toegankelijk (role=combobox/listbox, pijltjes/Enter/Escape).
// ==========================================================================
const recentCountries = () => { try { return JSON.parse(localStorage.getItem('recentCountries')) || []; } catch { return []; } };
function pushRecentCountry(iso3) {
  const list = [iso3, ...recentCountries().filter((i) => i !== iso3)].slice(0, 6);
  localStorage.setItem('recentCountries', JSON.stringify(list));
}

// ---- Favorieten: persoonlijk, in localStorage; deelbaar via link/export ------
// Heette eerder "volglijst" met een oogknop. Dat suggereerde dat er iets
// gevolgd of gemeld werd; in werkelijkheid is het een lijstje dat je zelf
// samenstelt. De opslagsleutel blijft 'watchlist', zodat bestaande lijsten
// gewoon blijven staan.
let FAVORITES = new Set((() => { try { return JSON.parse(localStorage.getItem('watchlist')) || []; } catch { return []; } })());
const saveFavorites = () => localStorage.setItem('watchlist', JSON.stringify([...FAVORITES]));
const isFavorite = (iso3) => FAVORITES.has(iso3);
function toggleFavorite(iso3) {
  if (FAVORITES.has(iso3)) FAVORITES.delete(iso3); else FAVORITES.add(iso3);
  saveFavorites();
  updateFavoriteUI();
}
/** Favorieten in config-onafhankelijke, gesorteerde vorm (op NL-naam). */
const favoriteItems = () => [...FAVORITES]
  .map((iso3) => COUNTRIES.find((c) => c.iso3 === iso3)).filter(Boolean)
  .sort((a, b) => a.nl.localeCompare(b.nl, 'nl'));

/** Werkt alle zichtbare favoriet-affordances bij (sterknop, lijst). */
function updateFavoriteUI() {
  const star = $('#fav-btn');
  if (star && LAST_COMPARE) {
    const on = isFavorite(LAST_COMPARE.country.iso3);
    star.classList.toggle('on', on);
    star.innerHTML = '';
    star.append(el('span', { class: 'star' }, on ? '★' : '☆'), ' Favoriet');
  }
  renderFavorites();
}

/** Topkandidaten voor de combobox: alias > prefix > bevat > bigram-score. */
function countrySuggestions(q, max = 8) {
  const nq = norm(q).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!nq) return [];
  const seen = new Set();
  const out = [];
  const add = (c, why) => { if (c && !seen.has(c.iso3) && out.length < max) { seen.add(c.iso3); out.push({ c, why }); } };
  const alias = COUNTRY_ALIASES[nq];
  if (alias) add(COUNTRIES.find((x) => x.iso3 === alias), 'alias');
  for (const x of COUNTRIES) if (norm(x.nl).startsWith(nq)) add(x, 'prefix');
  for (const x of COUNTRIES) if (norm(x.en).startsWith(nq)) add(x, 'prefix-en');
  for (const x of COUNTRIES) if (norm(x.nl).includes(nq) || norm(x.en).includes(nq)) add(x, 'bevat');
  if (out.length < max) {
    const scored = COUNTRIES
      .filter((x) => !seen.has(x.iso3))
      .map((x) => ({ x, s: Math.max(diceSimilarity(nq, norm(x.nl)), diceSimilarity(nq, norm(x.en))) }))
      .filter((r) => r.s >= 0.45)
      .sort((a, b) => b.s - a.s);
    for (const r of scored) add(r.x, 'lijkt op');
  }
  return out;
}

function setupCountryCombo() {
  const input = $('#country-input');
  const list = $('#country-listbox');
  if (!input || !list) return;
  let active = -1;

  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };

  // Kopje in de lijst, met eventueel een actie rechts ("beheren…").
  const groupHead = (label, action) => {
    const li = el('li', { class: 'combo-group' }, el('span', {}, label));
    if (action) li.append(action);
    return li;
  };
  // Regel die in één klik een hele set landen neerzet (groep of favorieten).
  // `icon` is een element (vlaggenstapel) of een teken (★).
  const bulkItem = (icon, label, countries, i, groep = null) => {
    const li = el('li', { class: 'combo-item combo-bulk', role: 'option', id: `combo-opt-${i}` },
      typeof icon === 'string' ? el('span', { class: 'combo-icon' }, icon) : icon, ` ${label}`,
      el('span', { class: 'combo-count' }, `${countries.length} land${countries.length === 1 ? '' : 'en'}`));
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      input.value = ''; setComboFlag(null); close();
      // Een groep openen vervangt de selectie — dat is wat "deze groep
      // vergelijken" betekent. Losse favorieten vullen juist aan.
      if (groep) {
        COMPARE_COUNTRIES = countries.slice(0, MAX_COMPARE_COUNTRIES);
        ACTIVE_GROUP = groep;
        renderCompareChips();
      } else {
        countries.forEach(addCompareCountry);
      }
      input.focus();
    });
    return li;
  };

  const MAX_FAV_IN_LIST = 5; // meer favorieten maken de lijst onoverzichtelijk

  const render = () => {
    const q = input.value.trim();
    list.innerHTML = '';
    active = -1;
    let n = 0;
    const landItem = (c, why) => {
      const li = el('li', { class: 'combo-item', role: 'option', id: `combo-opt-${n++}` },
        el('span', { class: 'fl' }, countryFlag(c.iso2)), ` ${c.nl}`,
        isFavorite(c.iso3) ? el('span', { class: 'combo-star' }, '★') : null,
        why === 'lijkt op' ? el('span', { class: 'combo-why' }, 'bedoelde je?') : null);
      // mousedown i.p.v. click: gaat vóór de blur van het input-veld.
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(c); });
      li.dataset.iso3 = c.iso3;
      return li;
    };

    if (q) {
      const items = countrySuggestions(q);
      if (!items.length) { close(); return; }
      items.forEach(({ c, why }) => list.append(landItem(c, why)));
    } else {
      // Leeg veld: eerst je eigen ingangen (groepen, favorieten), dan recent.
      const groups = loadGroups();
      const namen = Object.keys(groups).sort();
      if (namen.length) {
        const beheer = el('a', { href: '#', class: 'combo-manage' }, 'alle groepen beheren →');
        beheer.addEventListener('mousedown', (e) => { e.preventDefault(); close(); activateTab('favorieten'); });
        list.append(groupHead('Groepen', beheer));
        namen.forEach((naam) => {
          const landen = groups[naam].map((iso) => COUNTRIES.find((c) => c.iso3 === iso)).filter(Boolean);
          if (landen.length) list.append(bulkItem(groupStack(groups[naam]), naam, landen, n++, naam));
        });
      }
      const favs = favoriteItems();
      if (favs.length) {
        const alle = el('a', { href: '#', class: 'combo-manage' }, 'alle favorieten →');
        alle.addEventListener('mousedown', (e) => { e.preventDefault(); close(); activateTab('favorieten'); });
        list.append(groupHead('Favorieten', favs.length > MAX_FAV_IN_LIST ? alle : null));
        list.append(bulkItem('★', 'Alle favorieten', favs, n++));
        favs.slice(0, MAX_FAV_IN_LIST).forEach((c) => list.append(landItem(c)));
      }
      const recent = recentCountries().map((iso) => COUNTRIES.find((c) => c.iso3 === iso)).filter(Boolean);
      if (recent.length) {
        list.append(groupHead('Recent vergeleken'));
        recent.forEach((c) => list.append(landItem(c)));
      }
      if (!list.childNodes.length) { close(); return; }
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };
  const options = () => $$('.combo-item', list);
  const highlight = (idx) => {
    const opts = options();
    if (!opts.length) return;
    active = (idx + opts.length) % opts.length;
    opts.forEach((o, i) => o.classList.toggle('active', i === active));
    input.setAttribute('aria-activedescendant', opts[active].id);
    opts[active].scrollIntoView({ block: 'nearest' });
  };
  // Kiezen = als chip toevoegen. Er wordt bewust nog niets opgehaald: dat
  // gebeurt pas bij een klik op Vergelijken, ook bij één land.
  const pick = (c) => {
    input.value = '';
    setComboFlag(null);
    close();
    addCompareCountry(c);
    input.focus();
  };

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    setComboFlag(COUNTRIES.find((c) => c.nl.toLowerCase() === q));
    render();
  });
  input.addEventListener('focus', render);
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (list.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { render(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active - 1); }
    else if (e.key === 'Enter' && !list.hidden && active >= 0) {
      e.preventDefault();
      const iso = options()[active]?.dataset.iso3;
      const c = COUNTRIES.find((x) => x.iso3 === iso);
      if (c) pick(c);
    } else if (e.key === 'Escape') close();
  });
}

// ==========================================================================
// VERGELIJKEN
// ==========================================================================
// ---- Landselectie: chips, opgeslagen groepen, volglijst -------------------
const MAX_COMPARE_COUNTRIES = 20;
const GROUPS_KEY = 'exportGroups'; // bestaande sleutel: eerder bewaarde groepen blijven werken
const loadGroups = () => { try { return JSON.parse(localStorage.getItem(GROUPS_KEY)) || {}; } catch { return {}; } };
const saveGroups = (g) => localStorage.setItem(GROUPS_KEY, JSON.stringify(g));

function compareStatus(msg, cls = '') {
  const s = $('#compare-status');
  s.className = 'status' + (cls ? ' ' + cls : '');
  s.textContent = msg;
}

/** Voegt een land toe aan de selectie. Haalt bewust niets op — dat gebeurt pas
 *  bij een klik op Vergelijken, ook bij één land. */
function addCompareCountry(c) {
  if (!c) return;
  if (COMPARE_COUNTRIES.some((x) => x.iso3 === c.iso3)) return;
  if (COMPARE_COUNTRIES.length >= MAX_COMPARE_COUNTRIES) {
    compareStatus(`Maximaal ${MAX_COMPARE_COUNTRIES} landen tegelijk — haal er eerst een weg.`, 'error');
    return;
  }
  COMPARE_COUNTRIES.push(c);
  renderCompareChips();
}

function removeCompareCountry(iso3) {
  COMPARE_COUNTRIES = COMPARE_COUNTRIES.filter((x) => x.iso3 !== iso3);
  COMPARE_RESULTS.delete(iso3);
  renderCompareChips();
  // Al opgehaalde landen blijven staan; alleen het weggehaalde verdwijnt.
  if (COMPARE_RESULTS.size) {
    if (COMPARE_ACTIVE === iso3) COMPARE_ACTIVE = COMPARE_COUNTRIES.find((c) => COMPARE_RESULTS.has(c.iso3))?.iso3 || null;
    renderCompareView();
  } else {
    COMPARE_ACTIVE = null; LAST_COMPARE = null;
    $('#compare-result').innerHTML = '';
  }
}

/** Wijkt de huidige selectie af van de groep waaruit hij komt? */
function groupChanged() {
  if (!ACTIVE_GROUP) return false;
  const bewaard = loadGroups()[ACTIVE_GROUP];
  if (!bewaard) return false;
  return COMPARE_COUNTRIES.map((c) => c.iso3).join(',') !== bewaard.join(',');
}

function renderCompareChips() {
  const wrap = $('#compare-chips');
  wrap.innerHTML = '';
  const n = COMPARE_COUNTRIES.length;
  if (!n) ACTIVE_GROUP = null;
  const groups = loadGroups();
  if (ACTIVE_GROUP && !groups[ACTIVE_GROUP]) ACTIVE_GROUP = null;
  const gewijzigd = groupChanged();

  // Komt deze selectie uit een groep? Dat links vermelden, zodat de knoppen
  // rechts ("bijwerken") ergens op slaan.
  if (ACTIVE_GROUP) {
    wrap.append(el('span', { class: 'chip-group' },
      groupStack(groups[ACTIVE_GROUP]), 'Groep ', el('strong', {}, ACTIVE_GROUP),
      gewijzigd ? el('span', { class: 'chip-group-dirty' }, ' · gewijzigd') : null));
    wrap.append(el('span', { class: 'chip-sep' }));
  }

  COMPARE_COUNTRIES.forEach((c) => {
    const rm = el('button', { type: 'button', class: 'chip-x', title: `${c.nl} verwijderen`, 'aria-label': `${c.nl} verwijderen` }, '✕');
    rm.addEventListener('click', () => removeCompareCountry(c.iso3));
    wrap.append(el('span', { class: 'chip' }, `${countryFlag(c.iso2)} ${c.nl}`, rm));
  });

  // Bewaren verschijnt pas als er iets te bewaren valt: bij één land is een
  // groep zinloos, en een ongewijzigd geladen groep hoeft niet opnieuw.
  if (n > 1 && (!ACTIVE_GROUP || gewijzigd)) {
    wrap.append(el('span', { class: 'chip-sep' }));
    if (gewijzigd) {
      const bij = el('button', { type: 'button', class: 'btn chip-update' }, `💾 ${ACTIVE_GROUP} bijwerken`);
      bij.addEventListener('click', () => {
        const g = loadGroups();
        g[ACTIVE_GROUP] = COMPARE_COUNTRIES.map((c) => c.iso3);
        saveGroups(g);
        compareStatus(`Groep “${ACTIVE_GROUP}” bijgewerkt (${g[ACTIVE_GROUP].length} landen).`, 'ok');
        renderCompareChips();
        renderGroups();
      });
      wrap.append(bij);
    }
    const save = el('button', { type: 'button', class: 'btn chip-save' },
      gewijzigd ? 'Bewaar als nieuwe groep…' : `💾 Bewaar deze ${n} als groep`);
    save.addEventListener('click', toggleSavePanel);
    wrap.append(save);
  }

  $('#compare-fetchnote').hidden = n === 0;
  renderSavePanel(false);
  const btn = $('#compare-form button[type="submit"]');
  if (btn) btn.textContent = n > 1 ? `Vergelijken (${n} landen)` : 'Vergelijken';
}

let SAVE_PANEL_OPEN = false;
const toggleSavePanel = () => renderSavePanel(!SAVE_PANEL_OPEN);

/**
 * Bewaarpaneel in het scherm zelf in plaats van een prompt-venster: een
 * naamveld plus de bestaande groepen, die je rechtstreeks kunt overschrijven —
 * met het verschil erbij, zodat je nooit ongemerkt een grotere groep wist.
 */
function renderSavePanel(open) {
  const host = $('#compare-savepanel');
  if (!host) return;
  SAVE_PANEL_OPEN = !!open && COMPARE_COUNTRIES.length > 1;
  host.innerHTML = '';
  host.hidden = !SAVE_PANEL_OPEN;
  if (!SAVE_PANEL_OPEN) return;

  const isos = COMPARE_COUNTRIES.map((c) => c.iso3);
  const groups = loadGroups();
  const bewaar = (naam) => {
    const g = loadGroups();
    g[naam] = [...isos];
    saveGroups(g);
    ACTIVE_GROUP = naam;
    compareStatus(`Groep “${naam}” bewaard — je vindt hem terug in het landenveld en op Favorieten.`, 'ok');
    renderCompareChips();
    renderGroups();
  };

  const input = el('input', { autocomplete: 'off', placeholder: 'Naam van de groep', value: ACTIVE_GROUP || '' });
  const bewaarUitVeld = () => {
    const naam = input.value.trim();
    if (!naam) return;
    if (groups[naam] && !confirm(`Groep “${naam}” bestaat al (${groups[naam].length} landen). Overschrijven met deze ${isos.length}?`)) return;
    bewaar(naam);
  };
  const ok = el('button', { type: 'button', class: 'btn primary' }, 'Bewaren');
  ok.addEventListener('click', bewaarUitVeld);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); bewaarUitVeld(); } });
  const annuleer = el('button', { type: 'button', class: 'btn' }, 'Annuleren');
  annuleer.addEventListener('click', () => renderSavePanel(false));

  const paneel = el('div', { class: 'savepanel' },
    el('h6', {}, `Deze ${isos.length} landen bewaren`),
    el('div', { class: 'saverow' }, input, ok, annuleer));

  const namen = Object.keys(groups).sort((a, b) => a.localeCompare(b, 'nl'));
  if (namen.length) {
    const ow = el('div', { class: 'overwrite' }, el('p', { class: 'ow-title' }, 'Of werk een bestaande groep bij'));
    namen.forEach((naam) => {
      const oud = groups[naam].length;
      const knop = el('button', { type: 'button', class: 'btn' + (oud > isos.length ? ' warn' : '') }, 'Overschrijven');
      knop.addEventListener('click', () => bewaar(naam));
      ow.append(el('div', { class: 'ow-row' },
        groupStack(groups[naam]), el('span', { class: 'ow-name' }, naam),
        el('span', { class: 'ow-delta' }, `${oud} → ${isos.length} land${isos.length === 1 ? '' : 'en'}`), knop));
    });
    paneel.append(ow);
  }
  host.append(paneel);
  input.focus();
}

function setupCompareSelection() {
  renderCompareChips();
}

$('#compare-form').addEventListener('submit', (e) => {
  e.preventDefault();
  // Iets ingetypt maar nog niet als chip toegevoegd? Dat alsnog meenemen —
  // anders lijkt Enter niets te doen.
  const typed = $('#country-input').value.trim();
  if (typed) {
    const c = resolveCountry(typed);
    if (!c) { compareStatus(`Land “${typed}” niet gevonden.`, 'error'); return; }
    $('#country-input').value = '';
    addCompareCountry(c);
  }
  runCompare();
});

/** Opent één land in de vergelijker (vanuit werklijst, zoeken, wijzigingen…):
 *  vervangt de selectie en haalt meteen op. */
function openCompareFor(country) {
  if (!country) return;
  activateTab('compare');
  COMPARE_COUNTRIES = [country];
  COMPARE_RESULTS = new Map();
  COMPARE_ACTIVE = country.iso3;
  renderCompareChips();
  runCompare();
}

/** Haalt de statische NL-data + (live) buitenlandse bronnen voor één land op.
 *  Bewust ZONDER vertaling: bronteksten komen in de originele taal binnen en
 *  worden per fragment vertaald met de vlagknopjes. Scheelt bij 17 bronnen
 *  honderden vertaalverzoeken per land — de bron van de meeste haperingen. */
async function fetchCountry(country, sources) {
  const staticData = await loadJSON(`compare/${country.iso3}.json`);
  const foreign = { sources: [], notice: null };
  if (sources.length && getProxy()) {
    try {
      const res = await fetchForeign(country.iso3, sources, '');
      foreign.sources = res?.sources || [];
      // Deel van de bronnen kwam deze keer niet binnen (tijdelijke hapering)?
      // Toon de rest gewoon en meld welke ontbreken — geen lege tabel meer.
      if (res?.partialNotice?.length) {
        const namen = res.partialNotice.map((id) => sourceMeta(id)?.label || id).join(', ');
        foreign.notice = `Een deel van de bronnen was niet bereikbaar én heeft geen opgeslagen snapshot om op terug te vallen (${namen}). De overige staan hieronder — probeer het zo nog eens voor de rest.`;
      }
    } catch (err) {
      foreign.notice = 'De buitenlandse bronnen waren even niet bereikbaar (' + err.message + '). Dit is meestal tijdelijk — probeer het over een paar seconden opnieuw.';
    }
  } else if (sources.length) {
    foreign.notice = 'Stel de proxy in (⚙ rechtsboven) om buitenlandse reisadviezen te vergelijken.';
  }
  return { staticData, foreign };
}

/** Zorgt dat de door-de-bron-gemelde updatedatums (source-dates.json) geladen
 *  zijn — gebruikt als terugval voor de "Bijgewerkt"-kolom in de vergelijker. */
async function ensureSourceDates() {
  if (SOURCE_DATES) return;
  try { SOURCE_DATES = (await loadJSON('source-dates.json')).dates || {}; }
  catch { SOURCE_DATES = {}; }
}

/** Zorgt dat de recente-wijzigingen-data (recent-changes.json) geladen is —
 *  gebruikt voor de "Laatste wijziging"-kolom in de vergelijker (dezelfde
 *  data als het tabje Recente wijzigingen, hier per land+bron uitgefilterd). */
async function ensureRecentChanges() {
  if (RECENT_CHANGES) return;
  try { RECENT_CHANGES = (await loadJSON('recent-changes.json')).changes || []; }
  catch { RECENT_CHANGES = []; }
}

/**
 * Haalt alle gekozen landen op en toont het resultaat. Eén land = precies het
 * scherm van hiervoor; meer landen = kleurcodematrix + landentabs boven dat
 * scherm. Landen worden na elkaar opgehaald (met voortgang) zodat een falend
 * land de rest niet meesleept.
 */
let COMPARE_BUSY = false;
async function runCompare() {
  if (COMPARE_BUSY) return;
  const list = [...COMPARE_COUNTRIES];
  if (!list.length) return compareStatus('Kies eerst minstens één land.', 'error');
  const sources = orderedSelected();
  // Andere landenselectie? Dan hoort een eventueel termfilter bij het vorige
  // resultaat en gaat het weg.
  const key = list.map((c) => c.iso3).join(',');
  if (key !== [...COMPARE_RESULTS.keys()].join(',')) MATRIX_FILTER = null;

  COMPARE_BUSY = true;
  const btn = $('#compare-form button[type="submit"]');
  if (btn) btn.disabled = true;
  const status = $('#compare-status');
  const results = new Map();
  const failed = [];
  try {
    await Promise.all([ensureSourceDates(), ensureRecentChanges()]);
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      status.className = 'status';
      status.innerHTML = `<span class="spinner"></span>Reisadvies laden voor ${esc(c.nl)}…`
        + (list.length > 1 ? ` <span class="muted">(${i + 1}/${list.length})</span>` : '');
      try {
        const { staticData, foreign } = await fetchCountry(c, sources);
        results.set(c.iso3, { country: c, staticData, foreign });
        pushRecentCountry(c.iso3);
      } catch (err) {
        failed.push(`${c.nl} (${err.message})`);
      }
    }
    if (!results.size) {
      compareStatus(`Ophalen mislukt: ${failed.join(' · ')}`, 'error');
      return;
    }
    COMPARE_RESULTS = results;
    COMPARE_SOURCES = sources;
    if (!COMPARE_ACTIVE || !results.has(COMPARE_ACTIVE)) COMPARE_ACTIVE = [...results.keys()][0];
    setComboFlag(results.get(COMPARE_ACTIVE).country);
    compareStatus(failed.length ? `Niet gelukt voor ${failed.join(' · ')} — de rest staat hieronder.` : '', failed.length ? 'error' : '');
    // Andere selectie dan de URL nu toont = nieuwe history-entry (terug-knop
    // werkt); dezelfde (herladen, taalwissel, bron erbij) = vervangen.
    const urlSel = new URLSearchParams(location.search).get('landen') || new URLSearchParams(location.search).get('land');
    syncUrl(urlSel !== key);
    renderCompareView();
  } finally {
    COMPARE_BUSY = false;
    if (btn) btn.disabled = false;
  }
}

/**
 * Tekent het hele resultaatgebied opnieuw. Alles wat de weergave verandert
 * (thema's tonen/verbergen, compact/volledig, termfilter, ander landtabblad)
 * loopt hierlangs — zo blijven matrix, tabs en schema altijd bij elkaar.
 */
function renderCompareView() {
  const root = $('#compare-result');
  root.innerHTML = '';
  const shown = COMPARE_COUNTRIES.filter((c) => COMPARE_RESULTS.has(c.iso3));
  if (!shown.length) return;
  const multi = shown.length > 1;

  if (multi) {
    root.append(renderOverviewBlock(shown));
    root.append(renderCountryTabs(shown));
  }

  const detail = el('div', { id: 'compare-detail' });
  root.append(detail);
  const active = COMPARE_RESULTS.get(COMPARE_ACTIVE);
  if (active) {
    LAST_COMPARE = { country: active.country, sources: COMPARE_SOURCES, staticData: active.staticData, foreign: active.foreign };
    renderComparison(active.staticData, active.foreign, detail);
  }
  root.append(renderExportBar(shown));
}

/** Landentabs — één per vergeleken land, direct boven het bestaande schema. */
function renderCountryTabs(shown) {
  const nav = el('div', { class: 'country-tabs', role: 'tablist', 'aria-label': 'Vergeleken landen' });
  shown.forEach((c) => {
    const r = COMPARE_RESULTS.get(c.iso3);
    const color = r?.staticData?.nl?.colors?.overall || null;
    const on = c.iso3 === COMPARE_ACTIVE;
    const tab = el('button', {
      type: 'button', role: 'tab', 'aria-selected': String(on),
      class: 'country-tab' + (on ? ' on' : ''),
      title: `Toon de volledige vergelijking voor ${c.nl}`
        + (color ? ` (NederlandWereldwijd: ${COLOR_LABELS[color]})` : ''),
    }, `${countryFlag(c.iso2)} ${c.nl}`);
    tab.addEventListener('click', () => {
      if (COMPARE_ACTIVE === c.iso3) return;
      COMPARE_ACTIVE = c.iso3;
      MATRIX_FILTER = null; // filter hoorde bij het vorige land
      setComboFlag(c);
      syncUrl();
      renderCompareView();
      $('#compare-detail')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    });
    nav.append(tab);
  });
  return el('div', { class: 'country-tabs-wrap' },
    el('p', { class: 'hint', style: 'margin:0 0 6px' }, 'Kies een land voor de volledige vergelijking per thema:'),
    nav);
}

/** Groepeert thema-blokken per canoniek thema-id. */
function indexByTheme(themes) {
  const m = new Map();
  for (const b of themes || []) {
    const k = b.themeId || '_other';
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(b);
  }
  return m;
}

function buildComparison(nl, foreignSources) {
  const nlIdx = indexByTheme(nl.themes);
  const forIdx = foreignSources.map((f) => ({ source: f.source, label: f.sourceLabel, flag: f.flag, url: f.url, idx: indexByTheme(f.themes) }));

  const ids = new Set([...nlIdx.keys()]);
  forIdx.forEach((f) => f.idx.forEach((_, k) => ids.add(k)));
  const ordered = [...ids].filter((id) => id !== '_other')
    .sort((a, b) => (THEME_ORDER.get(a) ?? 99) - (THEME_ORDER.get(b) ?? 99));
  if (ids.has('_other')) ordered.push('_other');

  const themes = [];
  for (const id of ordered) {
    const meta = id === '_other' ? { id, label: 'Overig', group: 'Overig' } : THEME_BY_ID.get(id);
    const nlBlocks = nlIdx.get(id) || [];
    const foreign = {};
    let foreignHasIt = false;
    for (const f of forIdx) {
      const blocks = f.idx.get(id) || [];
      foreign[f.source] = { label: f.label, flag: f.flag, url: f.url, blocks };
      if (blocks.length) foreignHasIt = true;
    }
    themes.push({ theme: meta, nl: nlBlocks, foreign, nlHasIt: nlBlocks.length > 0, foreignHasIt });
  }
  return { themes };
}

// ==========================================================================
// "Laatste wijziging" (per bron, in de vergelijker): koppelt recent
// gedetecteerde tekstwijzigingen (recent-changes.json — dezelfde data als het
// tabje Recente wijzigingen) aan het thema waar de toegevoegde tekst nu in de
// matrix staat, zodat een klik precies naar die cel kan springen.
//
// Vast tijdvenster i.p.v. "sinds de vorige snapshot": veel landen worden niet
// elke keer opnieuw bekeken, dus "vorige snapshot" kan weken/maanden terug
// liggen. In plaats daarvan: alles wat in de afgelopen CHANGE_WINDOW_DAYS is
// gedetecteerd telt als "recent". Is dezelfde sectie binnen dat venster
// meermaals gewijzigd, dan telt alleen de nieuwste wijziging — een latere
// update vervangt de vorige in de lijst, in plaats van dat beide blijven staan.
// ==========================================================================
const CHANGE_WINDOW_DAYS = 14;
const MAX_CHANGE_ITEMS = 6; // per bron; ruim genoeg voor de praktijk, voorkomt een oneindige lijst
const normChangeText = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Stabiele DOM-id voor de matrixcel van (bron, thema) — gedeeld tussen de
 *  "Laatste wijziging"-links (renderSummaryTable) en de matrix zelf (renderMatrix). */
function matrixCellId(sourceId, themeId) {
  return `mxcell-${sourceId}-${themeId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * Map<sourceId, Array<{date, kind, heading, sentence, targetId}>> — per
 * geselecteerde bron de wijzigingen voor DIT land binnen de afgelopen
 * CHANGE_WINDOW_DAYS dagen, nieuwste eerst en gededupliceerd per sectie
 * (heading): is dezelfde sectie meermaals gewijzigd binnen het venster, dan
 * blijft alleen de nieuwste wijziging over. `targetId` is de matrixcel-id
 * waar die zin nu staat (null als de tekst niet (meer) terug te vinden is,
 * bijv. na vertaling).
 */
function resolveRecentChanges(iso3, okSources, cmp) {
  const out = new Map();
  const cutoff = new Date(Date.now() - CHANGE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const findThemeId = (sourceId, original) => {
    const needle = normChangeText(original).slice(0, 60);
    if (!needle) return null;
    for (const t of cmp.themes) {
      const blocks = t.foreign[sourceId]?.blocks;
      if (!blocks) continue;
      if (blocks.some((b) => normChangeText(b.text).includes(needle) || normChangeText(b.textNl).includes(needle))) return t.theme.id;
    }
    return null;
  };
  for (const s of okSources) {
    const entries = (RECENT_CHANGES || []).filter(
      (c) => c.iso3 === iso3 && c.source === s.source && c.kind === 'update' && c.sections?.length && c.date >= cutoff
    );
    const items = [];
    for (const c of entries) {
      for (const sec of c.sections) {
        const originals = sec.added || [];
        const displayed = sec.addedNl?.length === originals.length ? sec.addedNl : originals;
        originals.forEach((original, i) => {
          if (!original) return;
          items.push({ date: c.date, kind: c.kind, heading: sec.heading, sentence: displayed[i] || original, original });
        });
      }
    }
    if (!items.length) continue;

    // Per sectie (heading) alleen de nieuwste wijziging bewaren — een latere
    // update aan diezelfde sectie vervangt de vorige i.p.v. beide te tonen.
    const latestByHeading = new Map();
    for (const it of items) {
      const key = normChangeText(it.heading);
      const cur = latestByHeading.get(key);
      if (!cur || it.date > cur[0].date) latestByHeading.set(key, [it]);
      else if (it.date === cur[0].date) cur.push(it);
    }
    const deduped = [...latestByHeading.values()].flat();
    deduped.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const capped = deduped.slice(0, MAX_CHANGE_ITEMS);
    capped.forEach((it) => {
      // Het thema waar de gewijzigde zin nu onder valt: bepaalt zowel de
      // sprong naar de juiste matrixcel als de categorie waarop je groepeert.
      const themeId = findThemeId(s.source, it.original);
      it.themeId = themeId || null;
      it.targetId = themeId ? matrixCellId(s.source, themeId) : null;
    });
    out.set(s.source, capped);
  }
  return out;
}

/** Springt naar de matrixcel van een recent toegevoegde zin en markeert die
 *  kort (de cel zelf heeft al een blijvende rand — zie renderMatrix). Kon
 *  geen exacte cel worden bepaald (bijv. de tekst staat er vertaald), dan
 *  scrollt hij alsnog netjes naar de matrix in plaats van niets te doen. */
function jumpToMatrixCell(targetId) {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const target = targetId ? document.getElementById(targetId) : null;
  if (!target) {
    $('#compare-result .matrix')?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    return;
  }
  // Compacte weergave klapt lange cellen visueel in — eerst uitklappen zodat
  // de gemarkeerde tekst niet achter de afkapping verdwijnt.
  if (MATRIX_DENSITY === 'compact' && !target.classList.contains('open')) {
    target.classList.add('open');
    const more = target.querySelector('.cell-more');
    if (more) more.textContent = '▴ Inklappen';
  }
  target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
  target.classList.add('flash');
  setTimeout(() => target.classList.remove('flash'), 2400);
}

const colorSquare = (color, cls = '') => el('span', { class: `sq c-${color || 'none'}${cls ? ' ' + cls : ''}` });

/**
 * Beeldmerk van NederlandWereldwijd, als vector zodat het scherp blijft op elk
 * formaat en meeprint in de PDF. Nagetekend, geen officieel bestand: is het
 * echte logo beschikbaar, dan hoeft alleen deze functie te wijzigen.
 */
function nwwMark(size = 15) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'NederlandWereldwijd');
  svg.setAttribute('class', 'nww-mark');
  // Onder ±20 px vallen de dunne lijnen weg; dan een eenvoudiger tekening.
  const klein = size < 20;
  svg.innerHTML = '<rect width="64" height="64" fill="#0b78c4"/>'
    + `<g fill="none" stroke="#fff" stroke-width="${klein ? 4.5 : 3}" stroke-linecap="round">`
    + `<circle cx="32" cy="32" r="${klein ? 21 : 21.5}"/>`
    + `<ellipse cx="32" cy="32" rx="10.5" ry="${klein ? 21 : 21.5}"/><path d="M11 32 H53"/>`
    + (klein ? '' : '<path d="M21.5 22 L32 32 L42.5 45"/>')
    + '</g><g fill="#fff">'
    + (klein
      ? '<circle cx="32" cy="11" r="6.5"/><circle cx="21" cy="22" r="5.5"/><circle cx="43" cy="45" r="5.5"/>'
      : '<circle cx="32" cy="10.5" r="5.4"/><circle cx="21.5" cy="22" r="4.8"/><circle cx="42.5" cy="45" r="4.8"/>'
        + '<circle cx="32" cy="32" r="3.4"/><circle cx="53" cy="32" r="3.6"/><circle cx="14" cy="41" r="3.4"/>')
    + '</g>';
  return svg;
}

/**
 * Waar staat Nederland ten opzichte van de rest? Vier even brede vakjes met
 * daarin hoeveel bronnen die kleurcode hanteren; daarboven een wijzer bij de
 * Nederlandse kleur, eronder een wijzer bij de mediaan. Verdeling en consensus
 * in één beeld — vandaar dat de losse regel "Landen zijn het eens over de
 * kleurcode" hier niet meer nodig is.
 */
function renderConsensusBlock(nlColor, okSources) {
  const cells = okSources.map((s) => ({
    status: s.assessmentStatus === 'uncertain' ? 'uncertain' : s.assessmentStatus === 'none' ? 'none' : 'ok',
    color: s.color || null,
    level: s.level != null ? s.level : null,
  }));
  const dist = ExportModel.distribution(cells);
  const mediaan = ExportModel.medianLevel(cells);
  if (mediaan == null) return null; // geen enkele bron geeft een kleurcode
  const nlLevel = COLOR_LEVEL[nlColor] || null;
  const vs = ExportModel.versusNl(cells, nlLevel);
  // Vier gelijke vakken; het midden van vak n ligt op (n - 0.5) / 4.
  const pos = (lvl) => `${((lvl - 0.5) / 4) * 100}%`;

  const wrap = el('div', { class: 'consensus' });
  wrap.append(el('h3', {}, 'Waar staat Nederland ten opzichte van de rest?'));

  const boven = el('div', { class: 'cons-pins' });
  if (nlLevel) {
    boven.append(el('span', { class: 'cons-pin', style: `left:${pos(nlLevel)}` },
      el('span', { class: 'cons-lbl' }, nwwMark(15), 'NederlandWereldwijd')));
  }
  wrap.append(boven);

  const rij = el('div', { class: 'cons-cells' });
  const labels = el('div', { class: 'cons-labels' });
  ['groen', 'geel', 'oranje', 'rood'].forEach((k) => {
    rij.append(el('span', { class: `cons-cell c-${k}`, title: `${dist[k]} bron${dist[k] === 1 ? '' : 'nen'} op ${k}` }, String(dist[k])));
    labels.append(el('span', {}, k));
  });
  wrap.append(rij, labels);

  const onder = el('div', { class: 'cons-pins under' });
  onder.append(el('span', { class: 'cons-pin world', style: `left:${pos(mediaan)}` },
    el('span', { class: 'cons-lbl' }, '🌍 Mediaan')));
  wrap.append(onder);

  // De pijlpunten staan vast op het midden van hun vak; alleen de labels
  // mogen opschuiven als ze anders buiten het kader vallen. "Nederland-
  // Wereldwijd" is bijna drie keer zo breed als "Mediaan", en toen label en
  // pijl nog één blok waren, duwde dat brede label de pijl uit het midden —
  // waardoor twee wijzers op dezelfde kleur niet naar elkaar wezen.
  requestAnimationFrame(() => {
    const kader = wrap.getBoundingClientRect();
    wrap.querySelectorAll('.cons-lbl').forEach((lbl) => {
      lbl.style.transform = 'translateX(-50%)';
      const r = lbl.getBoundingClientRect();
      const teVer = Math.max(0, kader.left + 2 - r.left) - Math.max(0, r.right - (kader.right - 2));
      if (teVer) lbl.style.transform = `translateX(calc(-50% + ${Math.round(teVer)}px))`;
    });
  });

  const zin = [];
  if (nlLevel) {
    zin.push(el('strong', {}, String(vs.strenger)), ` bron${vs.strenger === 1 ? '' : 'nen'} ${vs.strenger === 1 ? 'is' : 'zijn'} strenger dan Nederland, `,
      el('strong', {}, String(vs.milder)), ' milder, ', el('strong', {}, String(vs.gelijk)), ` ${vs.gelijk === 1 ? 'zit' : 'zitten'} gelijk.`);
  } else {
    zin.push('NederlandWereldwijd geeft voor dit land geen kleurcode, dus er valt niets te vergelijken.');
  }
  if (dist.geen) zin.push(` ${dist.geen} bron${dist.geen === 1 ? '' : 'nen'} ${dist.geen === 1 ? 'geeft' : 'geven'} geen kleurcode of ${dist.geen === 1 ? 'was' : 'waren'} niet op te halen.`);
  wrap.append(el('p', { class: 'cons-note' }, zin));
  return wrap;
}

/**
 * Regionale extra-kleuren van een bron: de kleuren die alleen regionaal
 * voorkomen en afwijken van het landelijke niveau, gesorteerd van zwaar naar
 * licht. Alleen getoond als de bron expliciet regionale afwijkingen meldt.
 */
function regionalExtraColors(s) {
  if (!s.hasRegionalWarnings) return [];
  const nat = s.level || COLOR_LEVEL[s.color] || 0;
  const levels = new Set();
  if (s.regionalBreakdown?.length) {
    s.regionalBreakdown.forEach((r) => { if (r.level && r.level !== nat) levels.add(r.level); });
  } else if (s.regionalMaxLevel && s.regionalMaxLevel !== nat) {
    levels.add(s.regionalMaxLevel);
  }
  return [...levels].sort((a, b) => b - a).map((l) => LEVEL_COLORS[l]).filter(Boolean);
}

/**
 * Rijk kleurcode-icoon: de overwegende (landelijke) kleur groot met naam,
 * gevolgd door eventuele regionale extra-kleuren klein ("ook regionaal").
 * spec = { predominant, uncertain, explanation, extras }
 */
function colorCode({ predominant, uncertain, none, explanation, extras = [] }) {
  // 'none' is iets anders dan 'onzeker': de bron publiceert aantoonbaar geen
  // kleurcode (FCDO kent er geen en geeft bij landen zonder waarschuwing niets
  // uit). Dat als groen tonen zou een oordeel suggereren dat de bron niet
  // geeft, dus melden we het gewoon.
  if (none) {
    return el('span', { class: 'kc kc-none' },
      el('span', { class: 'prim', title: explanation || 'Deze bron publiceert geen kleurcode voor dit land.' },
        'Kleurcode ontbreekt'));
  }
  if (uncertain) {
    return el('span', { class: 'kc' },
      el('span', { class: 'prim', title: explanation || 'Niveau kon niet betrouwbaar worden vastgesteld — geen gok gedaan.' },
        colorSquare('onzeker'), 'Onzeker'));
  }
  if (!predominant) return el('span', { class: 'empty-col' }, 'geen kleurcode');
  const kc = el('span', { class: 'kc' },
    el('span', { class: 'prim' }, colorSquare(predominant), COLOR_LABELS[predominant] || predominant));
  if (extras.length) {
    const also = el('span', { class: 'also', title: 'Kleuren die alleen regionaal voorkomen' }, 'ook regionaal:');
    extras.forEach((c) => also.append(colorSquare(c, 'mini')));
    kc.append(also);
  }
  return kc;
}

/** Kleurcode-cel voor een buitenlandse bron (inclusief onzeker + regionaal). */
const sourceColorCode = (s) => colorCode({
  predominant: s.color,
  uncertain: s.assessmentStatus === 'uncertain',
  none: s.assessmentStatus === 'none',
  explanation: s.assessmentStatus === 'none' ? s.explanation || s.levelLabel : s.levelLabel,
  extras: regionalExtraColors(s),
});

/** Tekstversie van een kleurcode, voor export naar klembord/CSV. */
function colorTextFor(color, extras = [], uncertain = false, none = false) {
  if (none) return 'Kleurcode ontbreekt';
  if (uncertain) return 'Onzeker';
  if (!color) return '—';
  let t = COLOR_LABELS[color] || color;
  if (extras.length) t += ` (ook regionaal: ${extras.map((c) => (COLOR_LABELS[c] || c).toLowerCase()).join(', ')})`;
  return t;
}

/**
 * Kopieert de kleurcode-samenvatting als opgemaakte HTML-tabel (plakt netjes
 * in Word/Outlook) met platte tekst als terugval.
 */
async function copySummaryTable(staticData, nl, okSources, btn) {
  const fmt = (s) => { if (!s) return '—'; const d = new Date(s); return isNaN(d) ? String(s).slice(0, 10) : d.toLocaleDateString('nl-NL'); };
  const rows = [['Bron', 'Kleurcode', 'Origineel niveau', 'Bijgewerkt', 'Link']];
  rows.push(['NederlandWereldwijd', colorTextFor(nl.colors?.overall, nlExtraColors(nl)), '—',
    nl.modificationDate ? nl.modificationDate.split('|')[0].replace('Laatst gewijzigd op:', '').trim() : fmt(nl.lastModified), nl.url || '']);
  okSources.forEach((s) => rows.push([
    s.sourceLabel,
    s.assessmentStatus === 'none'
      ? colorTextFor(null, [], false, true)
      : colorTextFor(s.color, regionalExtraColors(s), s.assessmentStatus === 'uncertain') + ' (benadering)',
    s.levelLabel || '—', fmt(s.lastModified), s.url || '',
  ]));
  const title = `Reisadvies ${staticData.country.nl} — kleurcodes per bron (${new Date().toLocaleDateString('nl-NL')})`;
  const html = `<h3>${esc(title)}</h3>` +
    '<table border="1" cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:13px">' +
    rows.map((r, i) => `<tr>${r.map((c) => (i === 0 ? `<th align="left">${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('') +
    '</table>';
  const text = title + '\n' + rows.map((r) => r.join('\t')).join('\n');
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    })]);
  } catch {
    try { await navigator.clipboard.writeText(text); } catch { btn.textContent = '⚠ Kopiëren mislukt'; return; }
  }
  const orig = btn.textContent;
  btn.textContent = '✓ Gekopieerd';
  setTimeout(() => { btn.textContent = orig; }, 2000);
}

/** Regionale extra-kleuren van het NL-advies (kleuren per regio, uit open data). */
function nlExtraColors(nl) {
  const overall = nl.colors?.overall;
  const list = nl.colors?.colors || [];
  const levels = new Set();
  list.forEach((c) => { const lv = COLOR_LEVEL[c.color]; if (lv && c.color !== overall) levels.add(lv); });
  return [...levels].sort((a, b) => b - a).map((l) => LEVEL_COLORS[l]).filter(Boolean);
}

/** Groepeert regionale vermeldingen per niveau, hoogste niveau eerst. */
function renderRegionalDetail(s) {
  const wrap = el('div', { class: 'regional-detail' });
  wrap.append(el('p', { class: 'regional-caveat' },
    '⚠ Dit zijn expliciet gevonden regionale vermeldingen uit de brontekst — geen volledige geografische classificatie. ',
    'Niet-genoemde gebieden zijn niet automatisch veilig.'));

  const items = s.regionalBreakdown || [];
  if (!items.length) {
    wrap.append(el('p', { class: 'muted', style: 'margin:6px 0 0' },
      `${s.sourceLabel} meldt regionale afwijkingen, maar er konden geen specifieke gebieden uit de brontekst worden geëxtraheerd.`));
    return wrap;
  }

  [4, 3, 2, 1].forEach((lvl) => {
    const group = items.filter((r) => r.level === lvl);
    if (!group.length) return;
    const color = ['', 'groen', 'geel', 'oranje', 'rood'][lvl];
    const box = el('div', { class: `regional-group c-${color}` });
    box.append(el('h5', {}, COLOR_LABELS[color]));
    const ul = el('ul');
    group.forEach((r) => {
      const li = el('li', {},
        el('span', { class: 'regional-name' }, r.region),
        r.confidence !== 'high' ? el('span', { class: 'regional-confidence', title: 'Extractie op basis van vrije tekst, minder zeker' }, ` (${r.confidence === 'low' ? 'lage' : 'gemiddelde'} zekerheid)`) : null,
      );
      if (r.excerpt) li.title = r.excerpt;
      ul.append(li);
    });
    box.append(ul);
    wrap.append(box);
  });
  return wrap;
}

/** Compacte, scanbare tabel: één rij per bron (i.p.v. een kaartengrid). */
function renderSummaryTable(nl, okSources, naSources = [], iso3 = null, changesBySource = null) {
  const table = el('table', { class: 'summary-table' });
  const COLS = 7;
  const thead = el('thead', {}, el('tr', {},
    el('th', {}, 'Bron'), el('th', {}, 'Kleurcode'), el('th', {}, 'Regionaal'), el('th', {}, 'Origineel niveau'),
    el('th', {}, 'Bijgewerkt'),
    el('th', { title: `Wijzigingen gedetecteerd in de afgelopen ${CHANGE_WINDOW_DAYS} dagen — ongeacht wanneer dit land voor het laatst bekeken is.` }, 'Laatste wijziging'),
    el('th', {}, '')));
  table.append(thead);
  const tbody = el('tbody');

  const fmtDateShort = (s) => {
    if (!s) return '—';
    const d = new Date(s);
    return isNaN(d) ? String(s).slice(0, 10) : d.toLocaleDateString('nl-NL');
  };

  // "Bijgewerkt"-cel: de datum waarop de bron dit advies voor het laatst heeft
  // aangepast. Geeft de live/snapshot-ophaling die niet terug, dan vallen we
  // terug op de door de bron zelf gemelde datum (source-dates.json), die per
  // land per bron bewaard blijft — zo staat er veel vaker een echte datum.
  const dateCell = (s) => {
    const reported = iso3 && SOURCE_DATES ? SOURCE_DATES[iso3]?.[s.source] : null;
    const shown = s.lastModified || reported || null;
    const cell = el('td', { class: 'muted' }, fmtDateShort(shown));
    if (!s.lastModified && reported) cell.title = 'Laatst bijgewerkt volgens de bron zelf.';
    if (s.stale) cell.append(' ', el('span', {
      class: 'stale-tag',
      title: `Live ophalen lukte niet; dit is de laatst opgeslagen versie (snapshot van ${fmtDateShort(s.snapshotDate) || 'onbekende datum'}).`,
    }, `📸 snapshot ${fmtDateShort(s.snapshotDate)}`));
    // Kleur afgeleid uit de officiële zonekaart van de bron (preciezer dan
    // tekst-parsing) — zichtbaar gemarkeerd zodat de redacteur de herkomst kent.
    if (s.colorSource === 'kaart') cell.append(' ', el('span', {
      class: 'map-tag',
      title: `Kleurcode afgeleid uit de officiële zonekaart van de bron${s.mapColorDate ? ` (bemonsterd ${fmtDateShort(s.mapColorDate)})` : ''}.`,
    }, '🗺️ kaart'));
    return cell;
  };

  tbody.append(el('tr', {},
    el('td', {}, '🇳🇱 NederlandWereldwijd'),
    el('td', {}, colorCode({ predominant: nl.colors?.overall, extras: nlExtraColors(nl) })),
    el('td', { class: 'muted' }, '—'),
    el('td', { class: 'muted' }, '—'),
    el('td', { class: 'muted' }, nl.modificationDate ? nl.modificationDate.split('|')[0].replace('Laatst gewijzigd op:', '').trim() : fmtDateShort(nl.lastModified)),
    el('td', { class: 'muted' }, '—'),
    el('td', {}, el('a', { href: nl.url, target: '_blank', rel: 'noopener' }, 'origineel →'))));

  // Kaart-affordance: bronnen mét een zonekaart (bijv. VK/FCDO, Frankrijk)
  // krijgen een "🗺️ kaart"-knop die de kaart inline toont. Laadt de kaart niet
  // (ontbreekt/HTTP-fout), dan tonen we expliciet "Kaart ontbreekt" — de rest
  // van de vergelijking (tekst, kleur) blijft gewoon staan.
  const proxyBase = getProxy();
  const mapAff = (s) => {
    if (!s.hasMap || !s.mapProxy || !proxyBase) return null;
    const cell = el('td', { colspan: COLS });
    const detailRow = el('tr', { class: 'map-detail-row', hidden: true }, cell);
    let loaded = false;
    const btn = el('button', { type: 'button', class: 'btn-link map-toggle', title: 'Officiële zonekaart van de bron' }, '🗺️ kaart ▸');
    btn.addEventListener('click', () => {
      detailRow.hidden = !detailRow.hidden;
      btn.textContent = `🗺️ kaart ${detailRow.hidden ? '▸' : '▾'}`;
      if (!loaded) {
        loaded = true;
        const img = el('img', { class: 'source-map', alt: `Zonekaart ${s.sourceLabel}`, loading: 'lazy' });
        img.addEventListener('error', () => img.replaceWith(el('span', { class: 'map-missing' }, '🗺️ Kaart ontbreekt')), { once: true });
        img.src = `${proxyBase}${s.mapProxy}`;
        cell.append(img);
      }
    });
    return { btn, detailRow };
  };
  const actionsCell = (s, m) => el('td', {},
    el('a', { href: s.url, target: '_blank', rel: 'noopener' }, 'origineel →'),
    m ? [' · ', m.btn] : null);

  // "Laatste wijziging"-cel: alleen gevuld als de bron in de afgelopen
  // CHANGE_WINDOW_DAYS dagen daadwerkelijk iets heeft toegevoegd voor dit
  // land — exact dezelfde data als het tabje Recente wijzigingen, maar op een
  // vast tijdvenster i.p.v. "sinds de vorige snapshot" (veel landen worden
  // niet elke keer opnieuw bekeken). Is dezelfde sectie binnen dat venster
  // meermaals gewijzigd, dan staat hier alleen de nieuwste wijziging — zie
  // resolveRecentChanges. Eén wijziging: het citaat staat direct in de cel.
  // Meerdere (verschillende secties): onder een uitklapper (zelfde
  // <details>-patroon als de gewijzigde secties in dat tabje). Elk citaat
  // springt naar de bijbehorende cel in de matrix.
  const wijzigingItem = (it) => {
    const q = it.sentence.length > 160 ? it.sentence.slice(0, 160).trim() + '…' : it.sentence;
    return el('div', { class: 'wijziging-item' },
      el('span', { class: 'wijziging-kind' }, `${CHANGE_KIND_LABEL[it.kind] || it.kind} · ${fmtDateShort(it.date)}`),
      el('button', { type: 'button', class: 'wijziging-quote', onclick: () => jumpToMatrixCell(it.targetId) },
        `“${q}” — bekijk in matrix ↓`));
  };
  const wijzigingCell = (s) => {
    const items = changesBySource?.get(s.source);
    if (!items || !items.length) return el('td', { class: 'muted' }, '—');
    if (items.length === 1) return el('td', {}, wijzigingItem(items[0]));
    return el('td', {}, el('details', { class: 'wijziging-details' },
      el('summary', {}, `${items.length} wijzigingen in de afgelopen ${CHANGE_WINDOW_DAYS} dagen`),
      items.map(wijzigingItem)));
  };

  okSources.forEach((s) => {
    const rColor = ['', 'groen', 'geel', 'oranje', 'rood'][s.regionalMaxLevel] || null;
    const count = s.regionalBreakdown?.length || 0;
    const m = mapAff(s);

    let regionalCell;
    if (s.hasRegionalWarnings) {
      const detailRow = el('tr', { class: 'regional-detail-row', hidden: true },
        el('td', { colspan: COLS }, renderRegionalDetail(s)));
      const btn = el('button', { type: 'button', class: 'btn-link regional-toggle' },
        `⚠ ${count ? `${count} afwijking${count === 1 ? '' : 'en'}` : 'gemeld'} · hoogste: ${rColor ? COLOR_LABELS[rColor] : '?'} ▸`);
      btn.addEventListener('click', () => {
        detailRow.hidden = !detailRow.hidden;
        btn.textContent = btn.textContent.replace(/[▸▾]$/, detailRow.hidden ? '▸' : '▾');
      });
      regionalCell = el('td', {}, btn);
      tbody.append(el('tr', {},
        el('td', {}, `${s.flag || ''} ${s.sourceLabel}`),
        el('td', {}, sourceColorCode(s),
          ' ', el('span', { class: 'approx-tag', title: 'Vertaald naar de Nederlandse kleurenschaal' }, 'benadering')),
        regionalCell,
        el('td', { class: 'muted' }, s.levelLabel || '—'),
        dateCell(s),
        wijzigingCell(s),
        actionsCell(s, m)));
      tbody.append(detailRow);
      if (m) tbody.append(m.detailRow);
    } else {
      tbody.append(el('tr', {},
        el('td', {}, `${s.flag || ''} ${s.sourceLabel}`),
        el('td', {}, sourceColorCode(s),
          ' ', el('span', { class: 'approx-tag', title: 'Vertaald naar de Nederlandse kleurenschaal' }, 'benadering')),
        el('td', { class: 'muted' }, '—'),
        el('td', { class: 'muted' }, s.levelLabel || '—'),
        dateCell(s),
        wijzigingCell(s),
        actionsCell(s, m)));
      if (m) tbody.append(m.detailRow);
    }
  });

  // Bronnen die deze keer geen (automatisch leesbaar) advies gaven: niet
  // verbergen, maar eerlijk tonen met een klik-link zodat de redacteur die
  // ene bron zelf kan nakijken. Voorkomt dat een blokkade als "geen risico"
  // (of stilte) wordt gelezen.
  naSources.forEach((s) => {
    // Onderscheid maken tussen "deze keer niet gelukt" en "deze bron weert
    // geautomatiseerd ophalen". Dat tweede blijft morgen ook zo; het als
    // hapering tonen wekt de indruk dat het aan ons ligt en dat het de
    // volgende keer wel lukt.
    const tekst = s.blocked
      ? 'deze bron blokkeert geautomatiseerd ophalen — alleen handmatig bij de bron te lezen'
      : 'niet automatisch beschikbaar — controleer bij de bron zelf';
    tbody.append(el('tr', { class: 'na-row' + (s.blocked ? ' geblokkeerd' : '') },
      el('td', {}, `${s.flag || SOURCE_FLAG[s.source] || ''} ${s.label || s.sourceLabel || s.source}`),
      el('td', { class: 'muted', colspan: 5 }, s.blocked ? el('span', { title: s.error || '' }, '⊘ ', tekst) : tekst),
      el('td', {}, s.url
        ? el('a', { href: s.url, target: '_blank', rel: 'noopener' }, 'bron →')
        : el('span', { class: 'muted' }, '—'))));
  });

  table.append(tbody);
  return table;
}
const SOURCE_FLAG = { uk: '🇬🇧', us: '🇺🇸', ca: '🇨🇦', ie: '🇮🇪', fr: '🇫🇷', au: '🇦🇺', es: '🇪🇸', de: '🇩🇪', nz: '🇳🇿', dk: '🇩🇰', jp: '🇯🇵', it: '🇮🇹', fi: '🇫🇮', kr: '🇰🇷', no: '🇳🇴', at: '🇦🇹', ch: '🇨🇭' };

/**
 * Onderwerp-zoeker binnen één vergelijking: typ een term (bijv. "ebola") en
 * zie per bron — NL én alle buitenlandse — de passages waarin die voorkomt.
 * Bronnen die het onderwerp NIET noemen krijgen expliciet een kaart: juist
 * die afwezigheid is redactioneel interessant. Nederlandse termen worden
 * automatisch ook in het Engels/Frans/Spaans gezocht (via het bestaande
 * vertaal-endpoint); alle bronteksten zijn al binnen, dus het zoeken zelf
 * kost geen extra proxy-aanroepen.
 */
// '-' escapen (%2D): een koppelteken heeft binnen text-directives een eigen
// betekenis (prefix-/suffix-scheider), dus mag niet onge-escaped voorkomen.
const encFrag = (s) => encodeURIComponent((s || '').trim()).replace(/-/g, '%2D');

/**
 * Voegt een ":~:text="-fragment toe aan een URL en BEHOUDT daarbij een
 * bestaand element-anker (bijv. #weather). Sommige bronnen (nieuwe
 * travel.state.gov) zetten elk onderwerp in een tab die pas zichtbaar wordt
 * als dat anker in de hash staat — zonder het anker landt de highlight op een
 * verborgen paneel. Vorm: <pad>#<anker>:~:text=…  (anker mag leeg zijn).
 */
function withTextDirective(baseUrl, directive) {
  const [path, anchor = ''] = String(baseUrl).split('#');
  if (!directive) return baseUrl;
  return `${path}#${anchor}:~:text=${directive}`;
}

/**
 * Bouwt een text-directive die de HELE passage markeert i.p.v. alleen de
 * eerste paar woorden: bij langere tekst de vorm `text=beginwoorden,eindwoorden`
 * (markeert alles ertussen), bij korte tekst de tekst in z'n geheel. De tekst
 * moet letterlijk (op witruimte na) op de bronpagina staan, dus we gebruiken
 * altijd de ORIGINELE (onvertaalde) brontekst.
 */
function textDirectiveForPassage(text) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (clean.length < 4) return null;
  const stripEnd = (s) => s.replace(/[)\]}"'.,;:!?]+$/, '');
  const words = clean.split(' ');
  if (words.length <= 12) {
    const whole = stripEnd(clean);
    return whole.length >= 4 ? encFrag(whole) : null;
  }
  const startText = words.slice(0, 6).join(' ');
  const endText = stripEnd(words.slice(-6).join(' '));
  return endText.length >= 3 ? `${encFrag(startText)},${encFrag(endText)}` : encFrag(startText);
}

/**
 * Deeplink voor een heel matrixblok: markeert de volledige passage op de
 * bronpagina. Behoudt het sectie-anker uit block.url (indien aanwezig) zodat
 * bij tab-bronnen de juiste tab opent.
 */
function blockFragmentUrl(baseUrl, block) {
  if (!baseUrl) return null;
  const dir = block?.text ? textDirectiveForPassage(block.text) : null;
  return withTextDirective(baseUrl, dir);
}

/**
 * Deeplink voor de onderwerp-zoeker: markeert de hele ZIN waarin de zoekterm
 * valt (niet alleen een paar losse woorden). Behoudt een bestaand anker.
 */
function fragmentUrl(baseUrl, text, term) {
  if (!baseUrl || !text || !term) return null;
  const clean = text.replace(/\s+/g, ' ').trim();
  const ti = clean.toLowerCase().indexOf(term.toLowerCase());
  if (ti === -1) return null;
  // Zinsgrenzen rond de treffer opzoeken.
  let s = ti;
  while (s > 0 && !/[.!?]/.test(clean[s - 1])) s--;
  let e = ti + term.length;
  while (e < clean.length && !/[.!?]/.test(clean[e])) e++;
  const dir = textDirectiveForPassage(clean.slice(s, e));
  return dir ? withTextDirective(baseUrl, dir) : null;
}

function renderTopicSearch(nl, okSources) {
  const wrap = el('div', { class: 'topic-search' });
  const input = el('input', { type: 'text', placeholder: 'Bijv. ebola, verkiezingen, gele koorts…', autocomplete: 'off' });
  const btn = el('button', { class: 'btn primary', type: 'submit' }, 'Zoek bij alle bronnen');
  const form = el('form', { class: 'panel controls topic-form' },
    el('div', { class: 'field grow' },
      el('label', {}, 'Zoek een onderwerp in dit advies bij alle bronnen'), input),
    btn);
  const status = el('p', { class: 'hint', style: 'margin:6px 2px' });
  const result = el('div', { class: 'topic-result' });
  wrap.append(el('h3', { class: 'section-title' }, 'Wat zegt elke bron over…'), form, status, result);

  // Welke doeltalen zijn relevant voor de geladen bronnen?
  const langs = [...new Set(okSources.map((s) => s.lang || 'en'))].filter((l) => l !== 'nl');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const terms = input.value.split(',').map((t) => t.trim()).filter(Boolean);
    result.innerHTML = '';
    if (!terms.length) { status.textContent = ''; return; }

    // Vertaal elke term naar de brontalen; behoud ook de letterlijke invoer.
    status.textContent = 'Termen vertalen…';
    const variants = new Set(terms.map((t) => t.toLowerCase()));
    if (getProxy()) {
      for (const term of terms) {
        for (const lang of langs) {
          const tr = await translateText(term, lang, 'nl');
          if (tr) variants.add(tr.toLowerCase());
        }
      }
    }
    const variantList = [...variants];
    status.textContent = `Gezocht op: ${variantList.join(' · ')}`;

    const findMatches = (blocks) => {
      const matches = [];
      for (const b of blocks || []) {
        // Zoek in origineel én (indien aanwezig) de NL-vertaling.
        const fields = [
          { text: b.textNl, heading: b.headingNl || b.heading },
          { text: b.text, heading: b.heading },
        ].filter((f) => f.text);
        let hit = null;
        for (const f of fields) {
          const low = f.text.toLowerCase();
          const v = variantList.find((vv) => low.includes(vv));
          if (v) { hit = { ...f, variant: v }; break; }
        }
        if (hit) {
          // Voor de deeplink de treffer in de ORIGINELE tekst zoeken: het
          // #:~:text=-fragment moet letterlijk op de bronpagina staan. b.url
          // (indien aanwezig) is de sub-pagina waar dít blok daadwerkelijk
          // staat — sommige bronnen verdelen één advies over meerdere
          // sub-pagina's, met alleen het eerste onderdeel op de hoofd-URL.
          let frag = null;
          if (b.text) {
            const low = b.text.toLowerCase();
            const ov = variantList.find((vv) => low.includes(vv));
            if (ov) frag = { text: b.text, term: ov, url: b.url };
          }
          // Naast de opgemaakte HTML ook de kale tekst bewaren: die is nodig
          // om dit fragment te kunnen vertalen (en om de treffer daarna
          // opnieuw te markeren).
          const kaal = snippetAround(hit.text, hit.variant);
          matches.push({ heading: hit.heading, snippet: kaal, variant: hit.variant, html: highlight(kaal, hit.variant), frag });
        }
      }
      return matches;
    };

    const cards = el('div', { class: 'topic-cards' });
    // `foreign` false voor de NL-kaart: daar valt niets te vertalen.
    const renderCard = (label, url, matches, foreign = true) => {
      const card = el('div', { class: 'topic-card' + (matches.length ? '' : ' no-mention') });
      card.append(el('h4', {}, label, ' ',
        matches.length
          ? el('span', { class: 'count-pill' }, String(matches.length))
          : el('span', { class: 'no-mention-tag' }, `noemt "${terms.join(', ')}" niet`)));
      matches.slice(0, 5).forEach((m) => {
        const fragHref = m.frag ? fragmentUrl(m.frag.url || url, m.frag.text, m.frag.term) : null;
        const kop = el('div', { class: 'block-cat' }, m.heading || '',
          fragHref ? el('a', {
            href: fragHref, target: '_blank', rel: 'noopener', class: 'frag-link',
            title: 'Opent de bronpagina met deze passage geel gemarkeerd (Edge/Chrome).',
          }, '🔗 toon op bronpagina') : null);
        const tekst = el('p', { class: 'snippet', html: m.html });
        const rij = el('div', { class: 'topic-match' }, kop, tekst);

        // Vertaalvlaggetjes per fragment, net als in de themavergelijking:
        // 🇳🇱 naar het Nederlands, 🇬🇧 naar het Engels, nogmaals klikken zet de
        // brontekst terug. Per fragment en niet per kaart, want dat is de
        // hoeveelheid waar je hem daadwerkelijk om vraagt.
        if (foreign && m.snippet) {
          rij.append(snippetVertaalKnoppen(m, kop, tekst));
        }
        card.append(rij);
      });
      if (matches.length > 5) card.append(el('p', { class: 'hint', style: 'margin:4px 0 0' }, `+ ${matches.length - 5} meer passage(s) — zie het origineel.`));
      if (url) card.append(el('p', { style: 'margin:6px 0 0' }, el('a', { href: url, target: '_blank', rel: 'noopener' }, 'origineel →')));
      cards.append(card);
    };

    renderCard('🇳🇱 NederlandWereldwijd', nl.url, findMatches(nl.themes), false);
    okSources.forEach((s) => renderCard(`${s.flag || ''} ${s.sourceLabel}`, s.url, findMatches(s.themes)));
    result.append(cards);
  });

  // Vooringevulde term (vanuit de indexzoeker of een gazetteer-chip):
  // automatisch invullen en uitvoeren zodra de vergelijking geladen is.
  if (PENDING_TOPIC) {
    input.value = PENDING_TOPIC;
    PENDING_TOPIC = null;
    setTimeout(() => { form.requestSubmit(); wrap.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 150);
  }

  return wrap;
}

const countryFlagByIso3 = (iso3) => {
  const c = COUNTRIES.find((x) => x.iso3 === iso3);
  return c?.iso2 ? countryFlag(c.iso2) : '';
};

/** Internationale consensus (mediaan van betrouwbaar beoordeelde bronnen). */
function consensusColorOf(okSources) {
  const levels = okSources.filter((s) => s.level != null && s.assessmentStatus !== 'uncertain').map((s) => s.level).sort((a, b) => a - b);
  if (!levels.length) return null;
  const mid = Math.floor(levels.length / 2);
  const lvl = levels.length % 2 ? levels[mid] : Math.round((levels[mid - 1] + levels[mid]) / 2);
  return { level: lvl, color: LEVEL_COLORS[lvl], n: levels.length };
}

// ==========================================================================
// BRIEFING-MODUS (punt 15): compacte één-scherm-samenvatting per land,
// printbaar en deelbaar (?briefing=ISO). Hergebruikt de al opgehaalde data.
// ==========================================================================
let PENDING_BRIEFING = null;

function openBriefing() {
  if (!LAST_COMPARE) return;
  const root = $('#compare-result');
  root.innerHTML = '';
  root.append(renderBriefing(LAST_COMPARE.staticData, LAST_COMPARE.foreign));
  updateUrl({ briefing: LAST_COMPARE.staticData.country.iso3 }, true);
  window.scrollTo({ top: 0 });
}

function renderBriefing(staticData, foreign) {
  const nl = staticData.nl;
  const iso3 = staticData.country.iso3;
  const okSources = (foreign.sources || []).filter((s) => !s.unavailable && !s.error && s.themes);
  const wrap = el('div', { class: 'briefing' });
  const srcMeta = new Map((CFG.SOURCES || []).map((s) => [s.id, s]));

  const back = el('button', { type: 'button', class: 'btn' }, '← Volledige vergelijking');
  back.addEventListener('click', () => {
    updateUrl({ briefing: null }, true);
    renderCompareView();
    window.scrollTo({ top: 0 });
  });
  const printB = el('button', { type: 'button', class: 'btn', onclick: () => window.print() }, '🖨 Print');
  wrap.append(el('div', { class: 'briefing-actions' }, back, printB));

  const cflag = countryFlagByIso3(iso3);
  wrap.append(el('div', { class: 'briefing-head' },
    el('h2', {}, `${cflag ? cflag + ' ' : ''}${staticData.country.nl}`),
    el('p', { class: 'muted' }, `Briefing · ${new Date().toLocaleString('nl-NL')} · ${location.href}`)));

  const cons = consensusColorOf(okSources);
  const kc = el('div', { class: 'briefing-colors' });
  kc.append(el('span', { class: 'briefing-color' }, colorCode({ predominant: nl.colors?.overall, extras: nlExtraColors(nl) }), el('span', { class: 'briefing-color-lbl' }, 'NederlandWereldwijd')));
  if (cons) kc.append(el('span', { class: 'briefing-color' }, colorCode({ predominant: cons.color }), el('span', { class: 'briefing-color-lbl' }, `consensus (${cons.n})`)));
  const colBlock = el('div', { class: 'briefing-block' }, el('h3', {}, 'Kleurcodes'), kc);
  if (okSources.length) {
    const srcLine = el('div', { class: 'kc', style: 'margin-top:8px' });
    okSources.forEach((s) => srcLine.append(el('span', { class: 'sq mini c-' + (s.color || 'none'), title: `${s.sourceLabel}: ${s.color ? COLOR_LABELS[s.color] : 'onzeker'}` })));
    colBlock.append(srcLine);
  }
  wrap.append(colBlock);

  const seasons = activeSeasons(iso3);
  if (seasons.length) wrap.append(el('div', { class: 'briefing-block' },
    el('h3', {}, 'Seizoen'),
    ...seasons.map((s) => el('p', { class: 'briefing-line' }, `${s.emoji || '🌦️'} ${s.naam} — ${s.hazard}${s.piek ? ` (piek ${s.piek})` : ''}`))));

  const gaps = okSources.length ? gazetteerGaps(nl, okSources) : [];
  if (gaps.length) wrap.append(el('div', { class: 'briefing-block' },
    el('h3', {}, `Bronnen noemen, NL niet (${gaps.length})`),
    el('p', { class: 'briefing-line' }, gaps.slice(0, 10).map((x) => `${x.g.cat} ${x.g.nl}`).join(' · ') + (gaps.length > 10 ? ' …' : ''))));

  const wk = daysAgo(7);
  const recent = (RECENT_CHANGES || []).filter((c) => c.iso3 === iso3 && c.date >= wk && c.kind !== 'bulk');
  if (recent.length) wrap.append(el('div', { class: 'briefing-block' },
    el('h3', {}, `Recente wijzigingen (7 dagen, ${recent.length})`),
    ...recent.slice(0, 8).map((c) => el('p', { class: 'briefing-line' },
      `${c.flag || ''} ${srcMeta.get(c.source)?.label || c.sourceLabel}: `, c.updateNoteNl || c.updateNote || c.description))));

  return wrap;
}

// ==========================================================================
// Gazetteer: concrete risico-onderwerpen die buitenlandse bronnen noemen en
// het NL-advies niet. Regelgebaseerd (geen AI): een vaste lijst hoge-precisie
// concepten met meertalige herkenningspatronen (en/fr/es/de/da + nl). De
// NL-term wordt gebruikt om de onderwerp-zoeker voor in te vullen.
// ==========================================================================
const GAZETTEER = [
  // Ziektes
  { cat: '🦠', nl: 'dengue (knokkelkoorts)', term: 'dengue', re: /dengue|knokkelkoorts/i },
  { cat: '🦠', nl: 'malaria', term: 'malaria', re: /malaria|paludisme/i },
  { cat: '🦠', nl: 'zika', term: 'zika', re: /\bzika/i },
  { cat: '🦠', nl: 'chikungunya', term: 'chikungunya', re: /chikungunya/i },
  { cat: '🦠', nl: 'rabiës (hondsdolheid)', term: 'hondsdolheid', re: /rabi[eë]s|\brabies\b|hondsdolheid|tollwut|la rage\b|\brabia\b/i },
  { cat: '🦠', nl: 'cholera', term: 'cholera', re: /cholera|c[oó]lera/i },
  { cat: '🦠', nl: 'tyfus', term: 'tyfus', re: /tyfus|typhoid|typho[iï]de|tifoidea/i },
  { cat: '🦠', nl: 'gele koorts', term: 'gele koorts', re: /gele koorts|yellow fever|fi[eè]vre jaune|fiebre amarilla|gelbfieber|gul feber/i },
  { cat: '🦠', nl: 'hepatitis', term: 'hepatitis', re: /hepatitis|h[eé]patite/i },
  { cat: '🦠', nl: 'ebola', term: 'ebola', re: /ebola/i },
  { cat: '🦠', nl: 'mpox (apenpokken)', term: 'mpox', re: /\bmpox|monkeypox|apenpokken/i },
  { cat: '🦠', nl: 'polio', term: 'polio', re: /\bpolio/i },
  { cat: '🦠', nl: 'mazelen', term: 'mazelen', re: /mazelen|measles|rougeole|sarampi[oó]n|masern|mæslinger/i },
  { cat: '🦠', nl: 'meningitis', term: 'meningitis', re: /meningitis|m[eé]ningite/i },
  { cat: '🦠', nl: 'bilharzia (schistosomiasis)', term: 'bilharzia', re: /schistosom|bilharzi/i },
  { cat: '🦠', nl: 'leptospirose', term: 'leptospirose', re: /leptospir/i },
  { cat: '🦠', nl: 'tekenencefalitis (TBE)', term: 'tekenencefalitis', re: /tekenencefalitis|tick-?borne encephalitis|\btbe\b|fsme/i },
  { cat: '🦠', nl: 'japanse encefalitis', term: 'japanse encefalitis', re: /japanse encefalitis|japanese encephalitis|enc[eé]phalite japonaise|japanische enzephalitis/i },
  { cat: '🦠', nl: 'hoogteziekte', term: 'hoogteziekte', re: /hoogteziekte|altitude sickness|acute mountain sickness|mal (aigu )?des montagnes|mal de altura|h[oö]henkrankheit|højdesyge/i },
  { cat: '🦠', nl: 'methanolvergiftiging', term: 'methanol', re: /methanol/i },
  { cat: '🦠', nl: 'vogelgriep', term: 'vogelgriep', re: /vogelgriep|avian influenza|bird flu|grippe aviaire|gripe aviar|vogelgrippe|fugleinfluenza/i },
  // Natuur
  { cat: '🌋', nl: 'aardbevingen', term: 'aardbeving', re: /aardbeving|earthquake|s[eé]isme|terremoto|erdbeben|jordskælv/i },
  { cat: '🌋', nl: 'tsunami', term: 'tsunami', re: /tsunami/i },
  { cat: '🌋', nl: 'orkanen/tyfonen', term: 'orkaan', re: /orkaan|hurricane|cycloon|cyclone|typhoon|tyfoon|hurac[aá]n|taifun|wirbelsturm/i },
  { cat: '🌋', nl: 'overstromingen', term: 'overstroming', re: /overstroming|flood|inondation|inundaci|hochwasser|überschwemmung|oversvømmelse/i },
  { cat: '🌋', nl: 'vulkanen', term: 'vulkaan', re: /vulka|volcan/i },
  { cat: '🌋', nl: 'bos-/natuurbranden', term: 'bosbrand', re: /bosbrand|natuurbrand|wildfire|bushfire|forest fire|feux? de for[eê]t|incendio forestal|waldbr[aä]nd|skovbrand/i },
  { cat: '🌋', nl: 'lawines', term: 'lawine', re: /lawine|avalanche|\balud\b/i },
  { cat: '🌋', nl: 'muistromen (rip currents)', term: 'muistromen', re: /muistrom|rip ?currents?|rip ?tides?/i },
  // Veiligheid
  { cat: '⚠️', nl: 'ontvoering', term: 'ontvoering', re: /ontvoering|kidnap|enl[eè]vement|secuestro|entf[uü]hrung|bortførelse/i },
  { cat: '⚠️', nl: 'piraterij', term: 'piraterij', re: /piraterij|piracy|piraterie|pirater[ií]a/i },
  { cat: '⚠️', nl: 'landmijnen/explosieven', term: 'landmijnen', re: /landmijn|land ?mines?|mines terrestres|minas terrestres|landminen|landminer|unexploded ordnance/i },
  { cat: '⚠️', nl: 'avondklok', term: 'avondklok', re: /avondklok|curfew|couvre-feu|toque de queda|ausgangssperre|udgangsforbud/i },
  { cat: '⚠️', nl: 'noodtoestand', term: 'noodtoestand', re: /noodtoestand|state of emergency|[eé]tat d'urgence|estado de (emergencia|excepci[oó]n)|ausnahmezustand|undtagelsestilstand/i },
  { cat: '⚠️', nl: 'carjacking', term: 'carjacking', re: /carjack/i },
  { cat: '⚠️', nl: 'drogering (spiked drinks)', term: 'drogering', re: /drink spiking|spiked (drink|food)|scopolamine/i },
  { cat: '⚠️', nl: 'drones (aanvallen/regels)', term: 'drones', re: /\bdrones?\b/i },
  // Wetgeving & cultuur
  { cat: '⚖️', nl: 'doodstraf', term: 'doodstraf', re: /doodstraf|death penalty|peine de mort|pena de muerte|todesstrafe|dødsstraf/i },
  { cat: '⚖️', nl: 'LHBTIQ+-situatie', term: 'homoseksualiteit', re: /lhbti|lgbt|same-?sex|homoseksualiteit|homosexual|homosexuel|homosexualidad|gleichgeschlechtlich/i },
  { cat: '⚖️', nl: 'ramadan', term: 'ramadan', re: /ramadan/i },
  { cat: '⚖️', nl: 'e-sigaret/vapen (verboden?)', term: 'e-sigaret', re: /e-?sigaret|e-?cigarette|vaping|\bvapes?\b|cigarrillo electr[oó]nico|e-?zigarette/i },
  { cat: '⚖️', nl: 'godslastering (blasfemie)', term: 'godslastering', re: /godslastering|blasphemy|blasph[eè]me|blasfemia|blasphemie/i },
  { cat: '⚖️', nl: 'majesteitsschennis', term: 'majesteitsschennis', re: /majesteitsschennis|l[eè]se-?majest[eé]|lese majesty|majest[æe]tsfornærmelse/i },
  { cat: '⚖️', nl: 'kledingvoorschriften', term: 'kledingvoorschriften', re: /dress ?code|kledingvoorschrift|tenue vestimentaire|c[oó]digo de vestimenta|kleiderordnung/i },
  // Dieren
  { cat: '🐊', nl: 'krokodillen', term: 'krokodillen', re: /krokodil|crocodile|cocodrilo/i },
  { cat: '🐊', nl: 'haaien', term: 'haaien', re: /haaien|\bsharks?\b|requins?|tiburon/i },
  { cat: '🐊', nl: 'kwallen', term: 'kwallen', re: /kwallen|jellyfish|m[eé]duses?|quallen|vandmænd/i },
  { cat: '🐊', nl: 'slangenbeten', term: 'slangenbeten', re: /slangenbe(et|ten)|snake ?bites?|gifslangen|morsure de serpent|mordedura de serpiente|schlangenbis|slangebid/i },
  { cat: '🐊', nl: 'straathonden', term: 'straathonden', re: /straathonden|stray dogs|chiens errants|perros callejeros|streunende hunde/i },
];

/** Onderwerpen die minstens één bron noemt maar het NL-advies niet. */
function gazetteerGaps(nl, okSources) {
  const nlText = (nl.themes || []).map((t) => t.text || '').join(' ');
  const perSource = okSources.map((s) => ({
    s,
    text: (s.themes || []).map((t) => `${t.text || ''} ${t.textNl || ''}`).join(' '),
  }));
  const out = [];
  for (const g of GAZETTEER) {
    if (g.re.test(nlText)) continue;
    const srcs = perSource.filter((p) => g.re.test(p.text)).map((p) => p.s);
    if (srcs.length) out.push({ g, srcs });
  }
  out.sort((a, b) => b.srcs.length - a.srcs.length || a.g.nl.localeCompare(b.g.nl, 'nl'));
  return out;
}

function renderComparison(staticData, foreign, root) {
  root.innerHTML = '';
  const nl = staticData.nl;
  const okSources = (foreign.sources || []).filter((s) => !s.unavailable && !s.error && s.themes);
  const problems = (foreign.sources || []).filter((s) => s.unavailable || s.error);
  const frag = document.createDocumentFragment();

  const cflag = countryFlagByIso3(staticData.country.iso3);
  const briefingBtn = el('button', { type: 'button', class: 'btn briefing-btn', title: 'Compacte één-scherm-samenvatting voor het ochtendoverleg — printbaar en deelbaar.' }, '📋 Briefing');
  briefingBtn.addEventListener('click', openBriefing);
  const favOn = isFavorite(staticData.country.iso3);
  const favBtn = el('button', {
    type: 'button', id: 'fav-btn', class: 'btn fav-btn' + (favOn ? ' on' : ''),
    title: 'Zet dit land bij je favorieten (blijft in deze browser bewaard).',
  }, el('span', { class: 'star' }, favOn ? '★' : '☆'), ' Favoriet');
  favBtn.addEventListener('click', () => toggleFavorite(staticData.country.iso3));
  frag.append(el('div', { class: 'result-head' },
    el('div', { class: 'result-head-main' },
      el('h2', {}, cflag ? `${cflag} ${staticData.country.nl}` : staticData.country.nl),
      el('p', { class: 'meta' }, nl.modificationDate || `Laatst gewijzigd: ${(nl.lastModified || '').slice(0, 10)}`)),
    el('div', { class: 'result-head-actions' }, favBtn, briefingBtn)));

  // ---- Divergentie-highlight ----
  const nlColor = nl.colors?.overall || null;
  const chips = [{ label: '🇳🇱 NederlandWereldwijd', color: nlColor, level: COLOR_LEVEL[nlColor] || null }];
  okSources.forEach((s) => chips.push({ label: `${s.flag || ''} ${s.sourceLabel}`, color: s.color, level: s.level, url: s.url }));
  const levels = chips.map((c) => c.level).filter((l) => l != null);
  const distinctColors = new Set(chips.map((c) => c.color).filter(Boolean));
  const spread = levels.length ? Math.max(...levels) - Math.min(...levels) : 0;

  const divWrap = el('div', { class: 'divergence ' + (spread >= 2 ? 'high' : distinctColors.size > 1 ? 'some' : 'none') });

  // Verdeling over de kleurcodes + de mediaan, met Nederland ernaast. Dit
  // verving de losse kop ("Landen zijn het eens over de kleurcode") en de
  // consensusregel met het gekleurde blokje: die informatie staat nu in de
  // vakjes zelf, en het blokje viel weg tegen de gekleurde achtergrond.
  const cons = renderConsensusBlock(nlColor, okSources);
  if (cons) divWrap.append(cons);

  const chipRow = el('div', { class: 'chip-row' });
  chips.forEach((c) => chipRow.append(el('span', { class: 'div-chip' },
    colorSquare(c.color, 'mini'), ` ${c.label}: `, el('strong', {}, c.color ? COLOR_LABELS[c.color] : '—'))));
  divWrap.append(chipRow);
  frag.append(divWrap);

  // ---- Seizoenskalender: actief natuurrisico voor dit land (punt 9) ----
  const seasons = activeSeasons(staticData.country.iso3);
  seasons.forEach((s) => frag.append(el('div', { class: 'season-banner' },
    el('span', { class: 'season-emoji' }, s.emoji || '🌦️'),
    el('div', {},
      el('strong', {}, `${s.naam} loopt nu`),
      el('span', {}, ` — verhoogd risico op ${s.hazard}${s.piek ? ` (piek ${s.piek})` : ''}. Houd rekening met verstoringen en volg lokale waarschuwingen.`)))));

  // ---- Humanitaire context via ReliefWeb (punt 3, alleen als proxy dit levert) ----
  const contextSlot = el('div');
  frag.append(contextSlot);
  loadContext(staticData.country.iso3, contextSlot);

  // ---- Lokaal nieuws uit de top-3 lokale bronnen (30 dagen) ----
  const newsSlot = el('div');
  frag.append(newsSlot);
  loadLocalNews(staticData.country.iso3, newsSlot);

  // ---- Samenvattingstabel (kleurcode + niveau + datum + link per bron) ----
  const copyBtn = el('button', { class: 'btn', type: 'button', title: 'Kopieert de kleurcode-tabel als opgemaakte tabel — plakt netjes in Word/Outlook.' }, '📋 Kopieer als tabel');
  copyBtn.addEventListener('click', () => copySummaryTable(staticData, nl, okSources, copyBtn));
  // Printen/exporteren zit nu onderin in de uitdraaibalk — hier alleen nog het
  // kopiëren naar Word/Outlook, dat bij déze tabel hoort.
  frag.append(el('div', { class: 'theme-head-row' },
    el('h3', { class: 'section-title', style: 'flex:1;margin:0;border:none' }, 'Kleurcodes op een rij'),
    copyBtn));
  frag.append(el('p', { class: 'print-note' },
    `Reisadviezen-buddy · afgedrukt op ${new Date().toLocaleString('nl-NL')} · ${location.href}`));
  // cmp (thema's × bronnen) wordt hier al opgebouwd — niet pas verderop bij de
  // matrix — omdat de "Laatste wijziging"-kolom in de tabel eronder al moet
  // weten in welk thema een recent toegevoegde zin nu staat (voor de
  // spring-naar-matrix-link).
  const cmp = buildComparison(nl, okSources);
  const changesBySource = resolveRecentChanges(staticData.country.iso3, okSources, cmp);
  frag.append(renderSummaryTable(nl, okSources, problems, staticData.country.iso3, changesBySource));
  if (nl.colors?.colors?.length > 1) {
    const ul = el('ul', { class: 'color-contexts' });
    nl.colors.colors.forEach((c) => ul.append(el('li', {}, el('strong', {}, `${COLOR_LABELS[c.color]}: `), c.context)));
    frag.append(el('div', { class: 'panel', style: 'padding:12px 16px;margin-bottom:22px' },
      el('div', { class: 'block-cat', style: 'margin-bottom:4px' }, '🇳🇱 Kleurcode geldt per regio:'), ul));
  }

  // ---- Notices ----
  if (foreign.notice) frag.append(el('div', { class: 'callout', style: 'background:#eef4fb;border-left-color:var(--nl-blue)' },
    el('p', { style: 'margin:0' }, foreign.notice)));
  // (Bronnen zonder automatisch advies staan nu als eigen 'n.b.'-rij mét
  // klik-link in de tabel hierboven — geen aparte tekstmelding meer nodig.)

  // Bronnen die live niet lukten maar via het snapshot-vangnet tonen: eerlijk
  // melden dat dit de laatst opgeslagen versie is, niet de live pagina.
  const staleSources = okSources.filter((s) => s.stale);
  if (staleSources.length) frag.append(el('div', { class: 'callout', style: 'background:#fdf6ec;border-left-color:#c77d00' },
    el('p', { style: 'margin:0' }, '📸 Live ophalen lukte niet voor ' +
      staleSources.map((s) => `${s.flag || ''} ${s.sourceLabel} (snapshot ${s.snapshotDate ? new Date(s.snapshotDate).toLocaleDateString('nl-NL') : 'onbekend'})`).join(', ') +
      ' — getoond wordt de laatst opgeslagen versie uit de 6-uurlijkse snapshot.')));

  // ---- Onderwerp-zoeker: wat zegt elke bron over X? ----
  const topicWrap = renderTopicSearch(nl, okSources);

  // ---- Gazetteer: concrete onderwerpen die bronnen wél noemen en NL niet ----
  const gaps = okSources.length ? gazetteerGaps(nl, okSources) : [];
  if (gaps.length) {
    const chipsWrap = el('div', { class: 'gaz-chips' });
    const renderChip = ({ g, srcs }) => {
      const chip = el('button', { type: 'button', class: 'gaz-chip', title: `Genoemd door: ${srcs.map((s) => s.sourceLabel).join(', ')} — klik om alleen deze term in de matrix te tonen.` },
        `${g.cat} ${g.nl} `, el('span', { class: 'gaz-srcs' }, srcs.map((s) => s.flag || '').join('')));
      chip.addEventListener('click', () => {
        // Filter de matrix op deze term: alleen passages die de term noemen,
        // over alle bronkolommen, met de term gemarkeerd.
        MATRIX_FILTER = { label: `${g.cat} ${g.nl}`, term: g.term, re: g.re };
        renderCompareView();
        requestAnimationFrame(() => {
          const m = $('#compare-result .matrix');
          if (m) m.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
      return chip;
    };
    const MAXCHIPS = 12;
    gaps.slice(0, MAXCHIPS).forEach((x) => chipsWrap.append(renderChip(x)));
    if (gaps.length > MAXCHIPS) {
      const more = el('button', { type: 'button', class: 'btn-link' }, `+ ${gaps.length - MAXCHIPS} meer`);
      more.addEventListener('click', () => { more.remove(); gaps.slice(MAXCHIPS).forEach((x) => chipsWrap.append(renderChip(x))); });
      chipsWrap.append(more);
    }
    frag.append(el('div', { class: 'callout gaz-callout' },
      el('h3', {}, `🔎 ${gaps.length} concrete onderwerp${gaps.length === 1 ? '' : 'en'} die bronnen wél noemen en NederlandWereldwijd niet`),
      el('p', { class: 'hint', style: 'margin:2px 0 10px' },
        'Regelgebaseerde controle op een vaste lijst risico-onderwerpen (ziektes, natuurgevaren, wetgeving…) — klik op een onderwerp om de passages per bron te zien. Afwezigheid bij NL is niet per definitie een omissie, maar wel het nakijken waard.'),
      chipsWrap));
  }

  frag.append(topicWrap);

  // (Het blok "N thema's die andere landen wél noemen en NederlandWereldwijd
  // niet" stond hier. Dat was dubbelop met de gazetteer-callout hierboven, die
  // hetzelfde zegt maar concreter — met de onderwerpen zelf in plaats van de
  // themanamen.)

  // ---- Wat er recent veranderde, per bron (uitklapbaar) ----
  frag.append(renderRecentChangesBlock(changesBySource, okSources));

  const densitySeg = el('span', { class: 'seg', role: 'group', 'aria-label': 'Matrix-weergave' });
  [['compact', 'Compact'], ['volledig', 'Volledig']].forEach(([val, label]) => {
    const b = el('button', { type: 'button', class: MATRIX_DENSITY === val ? 'on' : '' }, label);
    b.addEventListener('click', () => {
      if (MATRIX_DENSITY === val) return;
      MATRIX_DENSITY = val;
      localStorage.setItem('matrixDensity', val);
      if (LAST_COMPARE) renderCompareView();
    });
    densitySeg.append(b);
  });
  frag.append(el('div', { class: 'theme-head-row' },
    el('h3', { class: 'section-title', style: 'flex:1;margin:0;border:none' }, 'Vergelijking per thema — naast elkaar'),
    el('span', { class: 'hint', style: 'margin:0' }, 'Weergave:'), densitySeg));

  // Thema-personalisatie (punt 17): chips om rijen te tonen/verbergen.
  const themeIds = cmp.themes.map((t) => t.theme.id);
  const themeChips = el('div', { class: 'theme-toggle-chips' });
  themeChips.append(el('span', { class: 'hint', style: 'margin:0 4px 0 0' }, 'Thema’s:'));
  cmp.themes.forEach((t) => {
    const on = !HIDDEN_THEMES.has(t.theme.id);
    const chip = el('button', { type: 'button', class: 'theme-chip' + (on ? ' on' : ''), 'aria-pressed': String(on) },
      iconEl(t.theme.id), t.theme.label);
    chip.addEventListener('click', () => {
      if (HIDDEN_THEMES.has(t.theme.id)) HIDDEN_THEMES.delete(t.theme.id); else HIDDEN_THEMES.add(t.theme.id);
      saveHiddenThemes();
      renderCompareView();
    });
    themeChips.append(chip);
  });
  if (themeIds.some((id) => HIDDEN_THEMES.has(id))) {
    const reset = el('button', { type: 'button', class: 'btn-link', style: 'margin-left:4px' }, 'alle tonen');
    reset.addEventListener('click', () => {
      themeIds.forEach((id) => HIDDEN_THEMES.delete(id));
      saveHiddenThemes();
      renderCompareView();
    });
    themeChips.append(reset);
  }
  frag.append(themeChips);

  // Termfilter actief (via een gazetteer-chip): toon een wisbalk.
  if (MATRIX_FILTER) {
    const clear = el('button', { type: 'button', class: 'btn-link' }, '× filter wissen');
    clear.addEventListener('click', () => {
      MATRIX_FILTER = null;
      renderCompareView();
    });
    frag.append(el('div', { class: 'matrix-filter-bar' },
      el('span', {}, '🔎 Matrix gefilterd op term: ', el('strong', {}, MATRIX_FILTER.label),
        ' — alleen passages die dit noemen worden getoond.'),
      clear));
  }

  frag.append(renderMatrix(cmp, nl, okSources, changesBySource));
  frag.append(el('p', { class: 'hint', style: 'margin-top:10px' },
    'De kolomkoppen en de themakolom blijven staan tijdens scrollen. Verwijder een bron met × in de kop; voeg er een toe met "+ Bron toevoegen". ',
    MATRIX_DENSITY === 'compact'
      ? 'Compact: elke cel toont de eerste regels — klap per cel uit met "▾ Toon alles". '
      : '',
    'Lege cel = die bron behandelt het thema niet apart (lichtgekleurd = de andere bronnen doen dat wél). Bij veel bronnen scrolt de matrix horizontaal.'));

  root.append(frag);
  // Compact: pas ná het renderen is meetbaar welke cellen echt afgekapt zijn —
  // alleen die krijgen een "Toon alles"-knop.
  if (MATRIX_DENSITY === 'compact') requestAnimationFrame(() => initMatrixClamp(root));
  // Deeplink ?briefing=ISO: meteen de briefing tonen na het laden.
  if (PENDING_BRIEFING === staticData.country.iso3) { PENDING_BRIEFING = null; openBriefing(); }
}

/**
 * Uitklapper boven de thema-vergelijking: wat heeft elke bron de afgelopen
 * CHANGE_WINDOW_DAYS dagen aan dít land veranderd? Dezelfde data als de
 * "Laatste wijziging"-kolom in de tabel erboven, maar hier op één plek bij
 * elkaar zodat je niet kolom voor kolom hoeft te kijken. Dichtgeklapt kost het
 * één regel; de kop noemt meteen welke bronnen iets veranderd hebben.
 *
 * Groeperen kan op bron ("wie heeft er iets gedaan?") of op categorie
 * ("waaraan is er gesleuteld?") — die tweede vraag is bij vier bronnen
 * meestal de eerste die je stelt.
 */
let CHANGES_GROUPBY = localStorage.getItem('changesGroupBy') === 'categorie' ? 'categorie' : 'bron';

function renderRecentChangesBlock(changesBySource, okSources) {
  const perSource = okSources
    .map((s) => ({ s, items: changesBySource?.get(s.source) || [] }))
    .filter((x) => x.items.length);
  if (!perSource.length) {
    return el('p', { class: 'hint', style: 'margin:18px 0 0' },
      `Geen van de getoonde bronnen heeft dit reisadvies in de afgelopen ${CHANGE_WINDOW_DAYS} dagen aangepast.`);
  }
  const totaal = perSource.reduce((n, x) => n + x.items.length, 0);
  const wrap = el('details', { class: 'changes-block' });
  wrap.append(el('summary', {},
    el('strong', {}, `🕔 ${totaal} wijziging${totaal === 1 ? '' : 'en'} in de afgelopen ${CHANGE_WINDOW_DAYS} dagen`),
    el('span', { class: 'changes-who' }, ' — ' + perSource.map((x) => `${x.s.flag || ''} ${SRC_SHORT[x.s.source] || x.s.source.toUpperCase()}`).join(' · '))));

  const fmt = (d) => { const x = new Date(d); return isNaN(x) ? String(d).slice(0, 10) : x.toLocaleDateString('nl-NL'); };
  const quote = (it) => {
    const q = it.sentence.length > 260 ? it.sentence.slice(0, 260).replace(/\s+\S*$/, '') + '…' : it.sentence;
    return el('button', { type: 'button', class: 'wijziging-quote', onclick: () => jumpToMatrixCell(it.targetId) },
      `“${q}” — bekijk in matrix ↓`);
  };

  // Groepeerkeuze; blijft staan voor het volgende land. Wisselen vervangt
  // alléén dit blok — het hele scherm hertekenen zou de uitklapper dichtslaan,
  // precies op het moment dat je erin aan het kijken bent.
  const seg = el('span', { class: 'seg' });
  [['bron', 'Bron'], ['categorie', 'Categorie']].forEach(([val, label]) => {
    const b = el('button', { type: 'button', class: CHANGES_GROUPBY === val ? 'on' : '' }, label);
    b.addEventListener('click', () => {
      if (CHANGES_GROUPBY === val) return;
      CHANGES_GROUPBY = val;
      localStorage.setItem('changesGroupBy', val);
      const vers = renderRecentChangesBlock(changesBySource, okSources);
      vers.open = wrap.open;
      wrap.replaceWith(vers);
    });
    seg.append(b);
  });
  wrap.append(el('div', { class: 'changes-toolbar' }, el('span', { class: 'hint', style: 'margin:0' }, 'Groepeer op:'), seg));

  if (CHANGES_GROUPBY === 'categorie') {
    // Per categorie: welke bronnen hebben er iets aan veranderd?
    const perThema = new Map();
    perSource.forEach(({ s, items }) => items.forEach((it) => {
      const key = it.themeId || '_onbekend';
      if (!perThema.has(key)) perThema.set(key, []);
      perThema.get(key).push({ s, it });
    }));
    // Vaste themavolgorde; "onbekend" onderaan.
    const keys = [...perThema.keys()].sort((a, b) =>
      (a === '_onbekend' ? 99 : THEME_ORDER.get(a) ?? 98) - (b === '_onbekend' ? 99 : THEME_ORDER.get(b) ?? 98));
    keys.forEach((key) => {
      const rijen = perThema.get(key);
      const bronnen = [...new Set(rijen.map((r) => SRC_SHORT[r.s.source] || r.s.source.toUpperCase()))];
      const box = el('div', { class: 'changes-src' });
      box.append(el('div', { class: 'changes-src-head' },
        el('span', { class: 'cat-name' }, iconEl(key),
          key === '_onbekend' ? 'Niet in een categorie te plaatsen' : (THEME_BY_ID.get(key)?.label || key)),
        el('span', { class: 'changes-src-note' }, `${rijen.length} wijziging${rijen.length === 1 ? '' : 'en'} · ${bronnen.join(', ')}`)));
      rijen.forEach(({ s, it }) => box.append(el('div', { class: 'changes-item' },
        el('span', { class: 'changes-date' }, fmt(it.date)),
        el('div', {},
          el('span', { class: 'changes-heading' }, `${s.flag || ''} ${s.sourceLabel}${it.heading ? ` · ${it.heading}` : ''}`),
          quote(it)))));
      wrap.append(box);
    });
    return wrap;
  }

  perSource.forEach(({ s, items }) => {
    const box = el('div', { class: 'changes-src' });
    box.append(el('div', { class: 'changes-src-head' },
      `${s.flag || ''} ${s.sourceLabel}`,
      el('a', { href: s.url, target: '_blank', rel: 'noopener', class: 'changes-src-link' }, 'origineel →')));
    items.forEach((it) => box.append(el('div', { class: 'changes-item' },
      el('span', { class: 'changes-date' }, fmt(it.date)),
      el('div', {},
        it.heading ? el('span', { class: 'changes-heading' }, it.heading) : null,
        it.themeId ? el('span', { class: 'cat-tag' }, iconEl(it.themeId), THEME_BY_ID.get(it.themeId)?.label || it.themeId) : null,
        quote(it)))));
    wrap.append(box);
  });
  return wrap;
}

/** Voegt per daadwerkelijk afgekapte matrixcel een uitklap-knop toe. Idempotent:
 *  slaat cellen over die al een knop hebben, zodat een dubbele aanroep (bijv.
 *  na een sprong-naar-cel die de cel al programmatisch opent) nooit een
 *  tweede "Toon alles"/"Inklappen" toevoegt. */
function initMatrixClamp(root) {
  root.querySelectorAll('.matrix .cell.txt:not(.empty)').forEach((cell) => {
    if (cell.querySelector('.cell-more')) return;
    const cl = cell.querySelector('.cellclamp');
    if (!cl || cl.scrollHeight <= cl.clientHeight + 6) return;
    const btn = el('button', { type: 'button', class: 'cell-more' }, '▾ Toon alles');
    btn.addEventListener('click', () => {
      const open = cell.classList.toggle('open');
      btn.textContent = open ? '▴ Inklappen' : '▾ Toon alles';
    });
    cell.append(btn);
  });
}

/**
 * Matrix-vergelijker: thema's (rijen) × bronnen (kolommen), met de kleurcode
 * als eerste rij. Kolomkoppen blijven sticky; een bron is per kolom te
 * verwijderen (×) of toe te voegen (+ Bron toevoegen). Veel bronnen → de matrix
 * scrolt horizontaal.
 */
function renderMatrix(cmp, nl, okSources, changesBySource = null) {
  // Cel-id's die een link uit de "Laatste wijziging"-kolom naar toe kan
  // springen — die cellen krijgen een blijvende markering + het NIEUW-label.
  const changeTargetIds = new Set();
  if (changesBySource) for (const items of changesBySource.values()) for (const it of items) if (it.targetId) changeTargetIds.add(it.targetId);

  const cols = [
    { id: '__nl', label: 'NederlandWereldwijd', flag: '🇳🇱', nl: true },
    ...okSources.map((s) => ({ id: s.source, label: s.sourceLabel, flag: s.flag, src: s })),
  ];
  const nCols = cols.length;
  const gridCols = `160px repeat(${nCols}, minmax(230px, 1fr)) 150px`;
  const minW = 160 + nCols * 230 + 150;
  const grid = el('div', { class: 'grid', style: `grid-template-columns:${gridCols};min-width:${minW}px` });

  // ---- Kolomkoppen ----
  grid.append(el('div', { class: 'cell head colhead corner' }, 'Thema'));
  cols.forEach((c) => {
    const head = el('div', { class: 'cell head colhead' + (c.nl ? ' nl' : '') });
    head.append(el('span', { class: 'src' }, el('span', { class: 'fl' }, c.flag || ''), ` ${c.label}`));
    if (!c.nl) {
      const x = el('button', { type: 'button', class: 'colx', title: `${c.label} verwijderen`, 'aria-label': `${c.label} verwijderen` }, '×');
      x.addEventListener('click', () => removeSource(c.id));
      head.append(x);
    }
    grid.append(head);
  });
  const addHead = el('div', { class: 'cell head addcol' });
  const addWrap = el('div', { class: 'adddrop matrix-add' });
  const addBtn = el('button', { type: 'button', class: 'btn-drop', 'aria-haspopup': 'true' }, '+ Bron toevoegen');
  const addMenu = el('div', { class: 'menu', hidden: true });
  addWrap.append(addBtn, addMenu);
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = addMenu.hidden;
    addMenu.innerHTML = '';
    const avail = allSourceIds().filter((id) => !SELECTED_SOURCES.includes(id));
    if (!avail.length) addMenu.append(el('div', { class: 'menu-empty' }, 'Alle bronnen toegevoegd.'));
    else avail.forEach((id) => {
      const m = sourceMeta(id);
      const item = el('div', { class: 'menu-item' }, el('span', { class: 'fl' }, m.flag || ''), ` ${m.label}`);
      item.addEventListener('click', () => addSource(id));
      addMenu.append(item);
    });
    addMenu.hidden = !open;
    // Sluit bij een klik buiten het menu; verwijder de listener meteen weer,
    // zodat herhaalde re-renders geen listeners opstapelen.
    if (open) {
      const off = (ev) => { if (!addWrap.contains(ev.target)) { addMenu.hidden = true; document.removeEventListener('click', off); } };
      setTimeout(() => document.addEventListener('click', off), 0);
    }
  });
  addHead.append(addWrap);
  grid.append(addHead);

  // ---- Rij: kleurcode ----
  grid.append(el('div', { class: 'cell rowlabel' }, 'Kleurcode'));
  grid.append(el('div', { class: 'cell kc-cell' + (nl.colors?.overall ? '' : ' empty') },
    colorCode({ predominant: nl.colors?.overall, extras: nlExtraColors(nl) })));
  okSources.forEach((s) => grid.append(el('div', { class: 'cell kc-cell' }, sourceColorCode(s))));
  grid.append(el('div', { class: 'cell addcol' }));

  // ---- Rijen: thema's (verborgen thema's overslaan, punt 17) ----
  const re = MATRIX_FILTER?.re || null;
  cmp.themes.filter((t) => !HIDDEN_THEMES.has(t.theme.id)).forEach((t) => {
    // Blokken per kolom bepalen — en bij een actief termfilter uitdunnen tot
    // alleen de passages die de term noemen.
    let nlBlocks = t.nlHasIt ? t.nl : null;
    const fBlocks = okSources.map((s) => (t.foreign[s.source]?.blocks?.length ? t.foreign[s.source].blocks : null));
    if (re) {
      nlBlocks = blocksMatching(nlBlocks, re);
      for (let i = 0; i < fBlocks.length; i++) fBlocks[i] = blocksMatching(fBlocks[i], re);
      // Geen enkele kolom noemt de term in dit thema → rij overslaan.
      if (!nlBlocks && fBlocks.every((b) => !b)) return;
    }
    const anyContent = re ? true : (t.nlHasIt || t.foreignHasIt);
    grid.append(el('div', { class: 'cell rowlabel' }, iconEl(t.theme.id), t.theme.label));
    grid.append(cellFor(nlBlocks, false, anyContent, re, nl.url));
    fBlocks.forEach((b, i) => {
      const cellId = matrixCellId(okSources[i].source, t.theme.id);
      const isChanged = changeTargetIds.has(cellId);
      grid.append(cellFor(b, true, anyContent, re, okSources[i].url, isChanged ? cellId : null, isChanged));
    });
    grid.append(el('div', { class: 'cell addcol' }));
  });

  return el('div', { class: 'matrix' }, grid);
}

/**
 * Eén matrix-cel: thema-blokken of een (eventueel gemarkeerde) leegte.
 * `cellId`/`isChanged`: gezet wanneer deze cel het doel is van een
 * "Laatste wijziging"-link in de samenvattingstabel — krijgt een blijvende
 * markering + label, en het id waar die link naartoe springt.
 */
function cellFor(blocks, foreign, anyContent, mark, sourceUrl, cellId, isChanged) {
  if (blocks && blocks.length) {
    const attrs = cellId ? { id: cellId } : {};
    const cls = 'cell txt' + (isChanged ? ' has-recent-change' : '');
    const newTag = isChanged ? el('span', { class: 'new-tag' }, 'RECENTELIJK GEÜPDATET') : null;
    // 'plain': altijd platte tekst → één uniform lettertype in alle cellen.
    // Compact: volledige tekst renderen maar visueel afkappen (cellclamp);
    // de per-blok "Lees volledige tekst"-knoppen zouden daar dubbelop zijn.
    if (MATRIX_DENSITY === 'compact') {
      return el('div', { class: cls, ...attrs },
        newTag,
        el('div', { class: 'cellclamp' }, renderBlocks(blocks, foreign, { full: true, plain: true, mark, sourceUrl })));
    }
    return el('div', { class: cls, ...attrs }, newTag, renderBlocks(blocks, foreign, { plain: true, mark, sourceUrl }));
  }
  // Leeg terwijl andere bronnen het thema wél behandelen = opvallend hiaat.
  return el('div', { class: 'cell txt empty' + (anyContent ? ' miss' : '') },
    MATRIX_FILTER ? '— term niet genoemd' : '— niet apart vermeld');
}

const SNIPPET_MAXLEN = 320;

/**
 * Rendert thema-blokken. Lange blokken worden standaard ingekort tot een
 * scanbaar fragment met een "Lees volledige tekst"-knop — dit voorkomt de
 * "muur van tekst" die ontstaat als N bronnen elk hun volledige, vaak
 * uitgebreide, brontekst tonen.
 */
function renderBlocks(blocks, foreign = false, opts = {}) {
  const { full = false, plain = false, mark = null, sourceUrl = null } = opts;
  if (!blocks || !blocks.length) return null;
  // Bij een actief termfilter tonen we de volledige (gemarkeerde) tekst, niet
  // een afgekapt fragment — anders valt de treffer soms buiten beeld.
  const noTrunc = full || !!mark;
  const wrap = el('div');
  blocks.forEach((b) => {
    // Altijd de originele brontekst: vertalen doe je per fragment met de
    // vlagknopjes hieronder.
    const origHeading = b.heading || '';
    const heading = origHeading;
    const origText = b.text || '';
    const fullText = origText;
    // In 'plain'-modus (matrix) nooit de rijke bron-HTML injecteren: platte,
    // ge-escapete tekst geeft één uniform lettertype in alle cellen.
    const origHtml = plain ? null : (b.html || null);
    const fullHtml = origHtml;

    const headingEl = heading ? el('div', { class: 'block-heading' }, heading) : null;
    const blockEl = el('div', { class: 'block' },
      headingEl,
      b.category && b.category !== heading ? el('div', { class: 'block-cat' }, b.category) : null);

    // Tekst in een eigen host zodat de per-blok vertaalknoppen hem in-place
    // kunnen vervangen (met behoud van de "Lees volledige tekst"-inkorting).
    const textHost = el('div', { class: 'block-text' });
    function renderText(text, html) {
      textHost.textContent = '';
      if (!noTrunc && text.length > SNIPPET_MAXLEN) {
        let expanded = false;
        const shortNode = el('div', { class: 'rich' }, text.slice(0, SNIPPET_MAXLEN).trim() + '…');
        const fullNode = el('div', { class: 'rich', html: html || markText(text, mark) });
        fullNode.hidden = true;
        const toggle = el('button', { class: 'btn-link', type: 'button' }, `Lees volledige tekst (${text.length} tekens) →`);
        toggle.addEventListener('click', () => {
          expanded = !expanded;
          shortNode.hidden = expanded;
          fullNode.hidden = !expanded;
          toggle.textContent = expanded ? '▲ Inklappen' : `Lees volledige tekst (${text.length} tekens) →`;
        });
        textHost.append(shortNode, fullNode, toggle);
      } else {
        textHost.append(el('div', { class: 'rich', html: html || markText(text, mark) }));
      }
    }
    renderText(fullText, fullHtml);
    blockEl.append(textHost);

    // Actiebalk onder de tekst: bron-deeplink + (voor buitenlandse blokken)
    // vertaalvlaggetjes. Ná de tekst, niet ervóór — een link/knoppenrij boven
    // de tekst verdrong anders leestekst in de ingeklapte matrixweergave
    // (cellclamp knipt op vaste hoogte af).
    const actions = el('div', { class: 'block-actions' });

    // Deeplink naar de exacte passage op de bronpagina (Text-Fragment,
    // Edge/Chrome); zonder geschikte ankertekst valt terug op de kale
    // bron-URL, zodat er altijd een link is.
    // b.url (indien aanwezig) is de URL van de sub-pagina waar dít blok
    // daadwerkelijk staat — sommige bronnen (bijv. GOV.UK) verdelen één
    // advies over meerdere sub-pagina's; de algemene bron-URL bevat dan
    // alleen het eerste onderdeel.
    const blockUrl = b.url || sourceUrl;
    if (blockUrl) {
      const frag = blockFragmentUrl(blockUrl, b) || blockUrl;
      // Bronnen met een sectie-anker (#…) verstoppen elk onderwerp in een
      // JS-tab die pas uitklapt bij een klik (bijv. travel.state.gov): daar
      // scrolt de link naar het juiste onderwerp-tabblad, maar de gele
      // markering kan niet oplichten zolang het paneel dicht is. Zeg dat
      // eerlijk in de tooltip i.p.v. een markering te beloven die uitblijft.
      const isTabAnchored = blockUrl.includes('#');
      actions.append(el('a', {
        href: frag, target: '_blank', rel: 'noopener', class: 'frag-link block-frag-link',
        title: isTabAnchored
          ? 'Opent de bron bij dit onderwerp — klik het onderwerp-tabblad aan om het uit te klappen.'
          : 'Opent de bronpagina met deze passage geel gemarkeerd (Edge/Chrome).',
      }, '🔗 bekijk in bron'));
    }

    // Vertaalvlaggetjes: alleen voor buitenlandse blokken (er is dan een
    // bron-/vreemde tekst om te vertalen). 🇳🇱 vertaalt dit fragment naar het
    // Nederlands, 🇬🇧 naar het Engels; nogmaals klikken zet het terug op de
    // originele brontekst. Dit is sinds het weghalen van de globale taalkeuze
    // de enige manier om te vertalen — precies één fragment tegelijk, dus geen
    // massale vertaalronde die halverwege strandt.
    if (foreign && (origText || origHeading)) {
      let snipLang = 'orig';
      const nlBtn = el('button', { class: 'snip-flag', type: 'button', 'aria-label': 'Vertaal dit fragment naar het Nederlands', title: 'Vertaal dit fragment naar het Nederlands' }, '🇳🇱');
      const enBtn = el('button', { class: 'snip-flag', type: 'button', 'aria-label': 'Vertaal dit fragment naar het Engels', title: 'Vertaal dit fragment naar het Engels (English)' }, '🇬🇧');
      const setActive = () => {
        nlBtn.classList.toggle('active', snipLang === 'nl');
        enBtn.classList.toggle('active', snipLang === 'en');
      };
      setActive();

      const restoreOrig = () => {
        snipLang = 'orig';
        if (headingEl) headingEl.textContent = origHeading;
        renderText(origText, origHtml);
        setActive();
      };

      async function toTranslated(lang, btn) {
        if (snipLang === lang) { restoreOrig(); return; }
        // Staat er toevallig al een vertaling klaar (uit een snapshot), dan
        // die gebruiken — scheelt een netwerkronde.
        if (lang === 'nl' && b.textNl) {
          snipLang = lang;
          if (headingEl && b.headingNl) headingEl.textContent = b.headingNl;
          renderText(b.textNl, null);
          setActive();
          return;
        }
        if (!getProxy()) return; // zonder proxy geen live vertaling mogelijk
        btn.classList.add('loading');
        nlBtn.disabled = enBtn.disabled = true;
        try {
          const [tText, tHead] = await Promise.all([
            origText ? translateText(origText, lang, 'auto') : Promise.resolve(''),
            origHeading ? translateText(origHeading, lang, 'auto') : Promise.resolve(''),
          ]);
          snipLang = lang;
          if (headingEl && tHead) headingEl.textContent = tHead;
          renderText(tText || origText, null);
          setActive();
        } finally {
          btn.classList.remove('loading');
          nlBtn.disabled = enBtn.disabled = false;
        }
      }
      nlBtn.addEventListener('click', () => toTranslated('nl', nlBtn));
      enBtn.addEventListener('click', () => toTranslated('en', enBtn));
      actions.append(el('span', { class: 'snip-flags' }, nlBtn, enBtn));
    }

    if (actions.childNodes.length) blockEl.append(actions);
    wrap.append(blockEl);
  });
  return wrap;
}

// ==========================================================================
// FAVORIETEN — het tabblad met je eigen landenlijst.
//
// Verving de Werklijst: die rangschikte alle 226 landen op afwijking t.o.v. de
// internationale consensus. Die rangschikking is niet weg, maar leeft nu als
// sorteervolgorde binnen je favorieten (divergence.json / advisory-ages.json
// uit de dagelijkse snapshot). Klikken opent een land; aanvinken verzamelt er
// meerdere en zet ze in één keer in de vergelijker.
// ==========================================================================
let WORKLIST = null;   // divergence.json — voor de sortering "Afwijking"
let AGES = null;       // advisory-ages.json — voor de sortering "Achterstand"
let FAV_SELECTED = new Set();

const countryRegion = (iso3) => COUNTRIES.find((c) => c.iso3 === iso3)?.region || null;
// De landenlijst gebruikt de Engelse werelddeelnamen (UN-indeling).
const REGION_NL = { Africa: 'Afrika', Asia: 'Azië', Americas: 'Amerika', Europe: 'Europa', Oceania: 'Oceanië' };
const regionLabel = (iso3) => { const r = countryRegion(iso3); return r ? (REGION_NL[r] || r) : ''; };

async function buildFavorites() {
  try { WORKLIST = await loadJSON('divergence.json'); } catch { WORKLIST = null; }
  try { AGES = await loadJSON('advisory-ages.json'); } catch { AGES = null; }

  $('#fav-sort').addEventListener('change', renderFavorites);
  $('#fav-all').addEventListener('click', () => {
    favoriteItems().forEach((c) => FAV_SELECTED.add(c.iso3));
    renderFavorites();
  });
  $('#fav-none').addEventListener('click', () => { FAV_SELECTED.clear(); renderFavorites(); });
  $('#fav-compare').addEventListener('click', () => {
    const gekozen = favoriteItems().filter((c) => FAV_SELECTED.has(c.iso3)).slice(0, MAX_COMPARE_COUNTRIES);
    if (!gekozen.length) return;
    activateTab('compare');
    COMPARE_COUNTRIES = gekozen;
    COMPARE_RESULTS = new Map();
    COMPARE_ACTIVE = gekozen[0].iso3;
    renderCompareChips();
    runCompare();
  });
  $('#fav-briefing').addEventListener('click', openFavoritesBriefing);
  $('#fav-share').addEventListener('click', () => shareFavorites($('#fav-share')));
  $('#fav-export').addEventListener('click', exportFavorites);
  $('#fav-import').addEventListener('change', importFavorites);

  setupGroups();
  renderFavorites();
}

/** Sorteert de favorieten volgens de gekozen volgorde in de balk. */
function sortedFavorites() {
  const items = favoriteItems();
  const how = $('#fav-sort')?.value || 'alfabet';
  if (how === 'regio') {
    return [...items].sort((a, b) =>
      (countryRegion(a.iso3) || 'zzz').localeCompare(countryRegion(b.iso3) || 'zzz', 'nl') || a.nl.localeCompare(b.nl, 'nl'));
  }
  if (how === 'afwijking') {
    const d = new Map((WORKLIST?.items || []).map((i) => [i.iso3, Math.abs(i.delta || 0)]));
    return [...items].sort((a, b) => (d.get(b.iso3) ?? -1) - (d.get(a.iso3) ?? -1) || a.nl.localeCompare(b.nl, 'nl'));
  }
  if (how === 'achterstand') {
    const d = new Map((AGES?.items || []).map((i) => [i.iso3, i.behindDays ?? i.behind ?? 0]));
    return [...items].sort((a, b) => (d.get(b.iso3) ?? -1) - (d.get(a.iso3) ?? -1) || a.nl.localeCompare(b.nl, 'nl'));
  }
  return items;
}

/** Korte toelichting bij de gekozen sortering — anders is een volgorde die je
 *  niet kunt herleiden alleen maar verwarrend. */
function favSortNote(how, land) {
  if (how === 'afwijking') {
    const i = (WORKLIST?.items || []).find((x) => x.iso3 === land.iso3);
    if (!i || i.delta == null) return 'geen vergelijking';
    if (i.delta === 0) return 'gelijk aan de consensus';
    return i.delta > 0 ? `NL strenger (+${i.delta})` : `NL milder (${i.delta})`;
  }
  if (how === 'achterstand') {
    const i = (AGES?.items || []).find((x) => x.iso3 === land.iso3);
    const dagen = i?.behindDays ?? i?.behind;
    if (dagen == null) return '';
    return dagen > 0 ? `${dagen} dagen achter` : 'bij';
  }
  if (how === 'regio') return regionLabel(land.iso3);
  return '';
}

function renderFavorites() {
  const grid = $('#fav-grid');
  if (!grid) return;
  const items = sortedFavorites();
  const how = $('#fav-sort')?.value || 'alfabet';
  $('#fav-count').textContent = items.length ? `· ${items.length} land${items.length === 1 ? '' : 'en'}` : '';

  // Selectie die niet meer bestaat opruimen (land uit favorieten gehaald).
  [...FAV_SELECTED].forEach((iso) => { if (!FAVORITES.has(iso)) FAV_SELECTED.delete(iso); });
  const gekozen = FAV_SELECTED.size;
  const cmpBtn = $('#fav-compare');
  cmpBtn.disabled = gekozen === 0;
  cmpBtn.textContent = gekozen ? `Vergelijk ${gekozen} geselecteerde land${gekozen === 1 ? '' : 'en'} →` : 'Vergelijk geselecteerde landen →';
  // Bij een lege lijst hebben selecteren/delen/exporteren geen zin; importeren
  // juist wél — dat is dan de enige manier om er landen in te krijgen.
  ['fav-all', 'fav-none', 'fav-briefing', 'fav-share', 'fav-export', 'fav-compare']
    .forEach((id) => { const b = $('#' + id); if (b) b.hidden = !items.length; });
  const sortWrap = $('.fav-sort');
  if (sortWrap) sortWrap.hidden = items.length < 2;

  grid.innerHTML = '';
  if (!items.length) {
    grid.append(el('p', { class: 'hint', style: 'margin:0' },
      'Nog geen favorieten. Zet een ☆ bij een land in de vergelijker, of importeer een gedeelde lijst hierboven.'));
    return;
  }
  items.forEach((c) => {
    const sel = FAV_SELECTED.has(c.iso3);
    const box = el('button', {
      type: 'button', class: 'favbox' + (sel ? ' on' : ''),
      'aria-pressed': String(sel), 'aria-label': `${c.nl} selecteren om te vergelijken`,
    }, sel ? '✓' : '');
    box.addEventListener('click', (e) => {
      e.stopPropagation();
      if (sel) FAV_SELECTED.delete(c.iso3); else FAV_SELECTED.add(c.iso3);
      renderFavorites();
    });
    const naam = el('button', { type: 'button', class: 'favname', title: `Open ${c.nl} in de vergelijker` },
      `${countryFlag(c.iso2)} ${c.nl}`);
    naam.addEventListener('click', () => openCompareFor(c));
    const note = favSortNote(how, c);
    const ster = el('button', { type: 'button', class: 'favstar', title: `${c.nl} uit favorieten halen` }, '★');
    ster.addEventListener('click', (e) => { e.stopPropagation(); toggleFavorite(c.iso3); });
    grid.append(el('div', { class: 'favcard' + (sel ? ' sel' : '') },
      box, naam, note ? el('span', { class: 'favnote' }, note) : null, ster));
  });
}

// ==========================================================================
// GROEPEN — een set landen die je in één klik in de vergelijker zet.
//
// Beheren gebeurt hier, op het favorietentabblad: in de uitklaplijst van het
// landenveld ben je aan het typen, en één misklik zou daar je selectie kosten.
// Wijzigingen aan de landen van een groep worden pas opgeslagen als je op
// Opslaan klikt (GROUP_DRAFT houdt ze tot die tijd vast).
// ==========================================================================
let GROUP_OPEN = null;   // naam van de opengeklapte groep
let GROUP_DRAFT = null;  // { naam, isos: [...] } — nog niet opgeslagen wijzigingen

const groupNames = () => Object.keys(loadGroups()).sort((a, b) => a.localeCompare(b, 'nl'));
const groupCountries = (isos) => (isos || []).map((iso) => COUNTRIES.find((c) => c.iso3 === iso)).filter(Boolean);

/**
 * Vlaggenstapel: de eerste landen van een groep, licht overlappend. Zegt in
 * dezelfde beeldtaal als de rest van de lijst wat er in de groep zit — een
 * abstract icoontje doet dat niet.
 */
function groupStack(isos, max = 3) {
  const wrap = el('span', { class: 'gstack' });
  groupCountries(isos).slice(0, max).forEach((c) => wrap.append(el('span', {}, countryFlag(c.iso2))));
  if (!wrap.childNodes.length) wrap.append(el('span', { class: 'empty' }, '·'));
  return wrap;
}

function setGroupStatus(msg, cls = '') {
  const s = $('#group-status');
  if (!s) return;
  s.className = 'status' + (cls ? ' ' + cls : '');
  s.textContent = msg;
}

/** Zet de vergelijkselectie op de landen van een groep — vervangen, niet
 *  aanvullen: "een groep openen" betekent dat je met díe landen verdergaat. */
function compareGroup(naam) {
  const landen = groupCountries(loadGroups()[naam]).slice(0, MAX_COMPARE_COUNTRIES);
  if (!landen.length) return setGroupStatus(`Groep “${naam}” is leeg — voeg er eerst landen aan toe.`, 'error');
  activateTab('compare');
  COMPARE_COUNTRIES = landen;
  COMPARE_RESULTS = new Map();
  COMPARE_ACTIVE = landen[0].iso3;
  ACTIVE_GROUP = naam;
  renderCompareChips();
  runCompare();
}

function setupGroups() {
  const openRow = (row, input) => { row.hidden = false; input.value = ''; input.focus(); };

  // + Land toevoegen aan favorieten
  const favRow = $('#fav-add-row'), favInput = $('#fav-add-input');
  $('#fav-add-open').addEventListener('click', () => openRow(favRow, favInput));
  $('#fav-add-close').addEventListener('click', () => { favRow.hidden = true; });
  favRow.addEventListener('submit', (e) => {
    e.preventDefault();
    const c = resolveCountry(favInput.value.trim());
    if (!c) return setFavStatus(`Land “${favInput.value.trim()}” niet gevonden.`, 'error');
    if (FAVORITES.has(c.iso3)) setFavStatus(`${c.nl} stond er al bij.`, '');
    else { FAVORITES.add(c.iso3); saveFavorites(); setFavStatus(`${c.nl} toegevoegd aan je favorieten.`, 'ok'); }
    favInput.value = '';
    favInput.focus();
    renderFavorites();
  });

  // + Nieuwe groep
  const newRow = $('#group-new-row'), newName = $('#group-new-name');
  $('#group-new-open').addEventListener('click', () => openRow(newRow, newName));
  $('#group-new-close').addEventListener('click', () => { newRow.hidden = true; setGroupStatus(''); });
  newRow.addEventListener('submit', (e) => {
    e.preventDefault();
    const naam = newName.value.trim();
    if (!naam) return;
    const groups = loadGroups();
    if (groups[naam]) return setGroupStatus(`Er is al een groep “${naam}”.`, 'error');
    groups[naam] = [];
    saveGroups(groups);
    newRow.hidden = true;
    GROUP_OPEN = naam;
    GROUP_DRAFT = { naam, isos: [] };
    setGroupStatus(`Groep “${naam}” aangemaakt — voeg er landen aan toe.`, 'ok');
    renderGroups();
  });

  renderGroups();
}

function setFavStatus(msg, cls = '') {
  const s = $('#fav-status');
  if (!s) return;
  s.className = 'status' + (cls ? ' ' + cls : '');
  s.textContent = msg;
}

/** Landen van de opengeklapte groep zoals ze nu op het scherm staan. */
const draftIsos = (naam) => (GROUP_DRAFT && GROUP_DRAFT.naam === naam ? GROUP_DRAFT.isos : loadGroups()[naam] || []);
const draftDirty = (naam) => {
  if (!GROUP_DRAFT || GROUP_DRAFT.naam !== naam) return false;
  return GROUP_DRAFT.isos.join(',') !== (loadGroups()[naam] || []).join(',');
};

function renderGroups() {
  const root = $('#group-list');
  if (!root) return;
  const groups = loadGroups();
  const namen = groupNames();
  $('#group-count').textContent = namen.length ? `· ${namen.length} groep${namen.length === 1 ? '' : 'en'}` : '';
  root.innerHTML = '';
  if (!namen.length) {
    root.append(el('p', { class: 'hint', style: 'margin:0;padding:12px' },
      'Nog geen groepen. Maak er hierboven een aan, of zet landen klaar in de vergelijker en klik daar op "Bewaar als groep".'));
    return;
  }

  namen.forEach((naam) => {
    const open = GROUP_OPEN === naam;
    const isos = open ? draftIsos(naam) : (groups[naam] || []);
    const row = el('div', { class: 'grouprow' });

    const caret = el('button', {
      type: 'button', class: 'gcaret', 'aria-expanded': String(open),
      title: open ? 'Inklappen' : `Toon de landen van ${naam}`,
    }, open ? '▾' : '▸');
    const naamBtn = el('button', { type: 'button', class: 'gname' }, naam);
    const toggle = () => {
      if (open && draftDirty(naam) && !confirm(`Je hebt “${naam}” aangepast maar niet opgeslagen. Wijzigingen weggooien?`)) return;
      GROUP_OPEN = open ? null : naam;
      GROUP_DRAFT = open ? null : { naam, isos: [...(groups[naam] || [])] };
      setGroupStatus('');
      renderGroups();
    };
    caret.addEventListener('click', toggle);
    naamBtn.addEventListener('click', toggle);

    const cmp = el('button', { type: 'button', class: 'btn primary gbtn' }, 'Vergelijken →');
    cmp.addEventListener('click', () => compareGroup(naam));
    const ren = el('button', { type: 'button', class: 'btn gbtn' }, 'Hernoemen');
    ren.addEventListener('click', () => {
      const nieuw = prompt(`Nieuwe naam voor “${naam}”:`, naam);
      if (!nieuw || !nieuw.trim() || nieuw.trim() === naam) return;
      const g = loadGroups();
      if (g[nieuw.trim()]) return setGroupStatus(`Er is al een groep “${nieuw.trim()}”.`, 'error');
      g[nieuw.trim()] = g[naam];
      delete g[naam];
      saveGroups(g);
      if (GROUP_OPEN === naam) { GROUP_OPEN = nieuw.trim(); if (GROUP_DRAFT) GROUP_DRAFT.naam = nieuw.trim(); }
      if (ACTIVE_GROUP === naam) ACTIVE_GROUP = nieuw.trim();
      setGroupStatus(`Hernoemd naar “${nieuw.trim()}”.`, 'ok');
      renderGroups();
      renderCompareChips();
    });
    const del = el('button', { type: 'button', class: 'btn gbtn' }, 'Verwijderen');
    del.addEventListener('click', () => {
      if (!confirm(`Groep “${naam}” verwijderen? De landen zelf blijven gewoon bestaan.`)) return;
      const g = loadGroups();
      delete g[naam];
      saveGroups(g);
      if (GROUP_OPEN === naam) { GROUP_OPEN = null; GROUP_DRAFT = null; }
      if (ACTIVE_GROUP === naam) ACTIVE_GROUP = null;
      setGroupStatus(`Groep “${naam}” verwijderd.`, 'ok');
      renderGroups();
      renderCompareChips();
    });

    row.append(el('div', { class: 'grouphead' },
      caret, groupStack(isos), naamBtn,
      el('span', { class: 'gcount' }, `${isos.length} land${isos.length === 1 ? '' : 'en'}`),
      draftDirty(naam) ? el('span', { class: 'gdirty' }, 'niet opgeslagen') : null,
      el('span', { class: 'groupacts' }, cmp, ren, del)));

    if (open) row.append(renderGroupBody(naam, isos));
    root.append(row);
  });
}

/** Opengeklapte groep: de landen als chips, een invoerveld om er een toe te
 *  voegen, en pas onderaan Opslaan/Annuleren — wijzigen is hier expliciet. */
function renderGroupBody(naam, isos) {
  const body = el('div', { class: 'groupbody' });
  const chips = el('div', { class: 'memberchips' });
  if (!isos.length) chips.append(el('span', { class: 'hint', style: 'margin:0' }, 'Nog geen landen in deze groep.'));
  groupCountries(isos).forEach((c) => {
    const rm = el('button', { type: 'button', class: 'member-x', title: `${c.nl} uit deze groep halen` }, '✕');
    rm.addEventListener('click', () => {
      GROUP_DRAFT = { naam, isos: draftIsos(naam).filter((x) => x !== c.iso3) };
      renderGroups();
    });
    chips.append(el('span', { class: 'member' }, `${countryFlag(c.iso2)} ${c.nl}`, rm));
  });
  body.append(chips);

  const input = el('input', { list: 'country-list', autocomplete: 'off', placeholder: 'Typ een land…', 'aria-label': `Land toevoegen aan ${naam}` });
  const add = () => {
    const c = resolveCountry(input.value.trim());
    if (!c) return setGroupStatus(`Land “${input.value.trim()}” niet gevonden.`, 'error');
    const huidig = draftIsos(naam);
    if (huidig.includes(c.iso3)) { setGroupStatus(`${c.nl} zit al in deze groep.`, ''); input.value = ''; return; }
    GROUP_DRAFT = { naam, isos: [...huidig, c.iso3] };
    setGroupStatus('');
    renderGroups();
    // Na het opnieuw tekenen staat het veld er weer leeg bij — meteen door.
    requestAnimationFrame(() => $('#group-list .group-add input')?.focus());
  };
  const addBtn = el('button', { type: 'button', class: 'btn' }, '+ Toevoegen');
  addBtn.addEventListener('click', add);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  body.append(el('div', { class: 'group-add' }, input, addBtn));

  const dirty = draftDirty(naam);
  const save = el('button', { type: 'button', class: 'btn primary', disabled: dirty ? null : '' }, '💾 Opslaan');
  save.addEventListener('click', () => {
    const g = loadGroups();
    g[naam] = [...draftIsos(naam)];
    saveGroups(g);
    GROUP_DRAFT = { naam, isos: [...g[naam]] };
    setGroupStatus(`Groep “${naam}” opgeslagen (${g[naam].length} land${g[naam].length === 1 ? '' : 'en'}).`, 'ok');
    renderGroups();
  });
  const undo = el('button', { type: 'button', class: 'btn', disabled: dirty ? null : '' }, 'Annuleren');
  undo.addEventListener('click', () => {
    GROUP_DRAFT = { naam, isos: [...(loadGroups()[naam] || [])] };
    setGroupStatus('');
    renderGroups();
  });
  body.append(el('div', { class: 'group-save' }, save, undo,
    el('span', { class: 'hint', style: 'margin:0' },
      dirty ? 'Wijzigingen zijn nog niet opgeslagen.' : 'Landen toevoegen of weghalen; opslaan doe je hier.')));
  return body;
}

// ---- Delen, exporteren, importeren, briefing -------------------------------
function shareFavorites(btn) {
  const url = `${location.origin}${location.pathname}?tab=favorieten&favorieten=${[...FAVORITES].join(',')}`;
  navigator.clipboard.writeText(url).then(() => {
    const orig = btn.textContent; btn.textContent = '✓ Link gekopieerd';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  }).catch(() => { prompt('Kopieer de deellink:', url); });
}

function exportFavorites() {
  const blob = new Blob([JSON.stringify({ watchlist: [...FAVORITES], exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: 'reisadviezen-favorieten.json' });
  document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
}

function importFavorites(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const d = JSON.parse(reader.result);
      // 'watchlist' is de sleutel uit oudere exports — die blijven werken.
      const ids = (Array.isArray(d) ? d : d.favorieten || d.watchlist || []).filter((iso) => COUNTRIES.some((c) => c.iso3 === iso));
      if (!ids.length) throw new Error('geen geldige landen');
      FAVORITES = new Set(ids);
      saveFavorites();
      updateFavoriteUI();
    } catch { alert('Kon het bestand niet lezen (verwacht een geëxporteerde favorietenlijst).'); }
    e.target.value = '';
  };
  reader.readAsText(file);
}

/** Laadt een gedeelde lijst uit ?favorieten=ISO,ISO (vervangt de huidige).
 *  ?volglijst= blijft werken zodat oude deellinks niet breken. */
function loadFavoritesFromUrl() {
  const sp = new URLSearchParams(location.search);
  const raw = sp.get('favorieten') ?? sp.get('volglijst');
  if (raw == null) return;
  const ids = raw.split(',').map((s) => s.trim().toUpperCase()).filter((iso) => COUNTRIES.some((c) => c.iso3 === iso));
  if (ids.length) { FAVORITES = new Set(ids); saveFavorites(); }
}

function openFavoritesBriefing() {
  const items = favoriteItems();
  if (!items.length) return;
  activateTab('compare');
  const root = $('#compare-result');
  root.innerHTML = '';
  $('#compare-status').textContent = '';
  updateUrl({ briefing: 'favorieten', land: null, landen: null }, true);
  root.append(renderFavoritesBriefing(items));
  window.scrollTo({ top: 0 });
}

/** Bundel-ochtendbriefing over alle favorieten, uit offline data (snel + printbaar). */
function renderFavoritesBriefing(items) {
  const wrap = el('div', { class: 'briefing' });
  const back = el('button', { type: 'button', class: 'btn' }, '← Terug naar favorieten');
  back.addEventListener('click', () => { updateUrl({ briefing: null }, true); activateTab('favorieten'); });
  const printB = el('button', { type: 'button', class: 'btn', onclick: () => window.print() }, '🖨 Print');
  wrap.append(el('div', { class: 'briefing-actions' }, back, printB));
  wrap.append(el('div', { class: 'briefing-head' },
    el('h2', {}, `🗓 Ochtendbriefing — favorieten (${items.length} landen)`),
    el('p', { class: 'muted' }, `${new Date().toLocaleString('nl-NL')} · samengesteld uit de dagelijkse snapshot`)));
  const divMap = new Map((WORKLIST?.items || []).map((i) => [i.iso3, i]));
  const ageMap = new Map((AGES?.items || []).map((i) => [i.iso3, i]));
  const wk = daysAgo(7);
  const srcMeta = new Map((CFG.SOURCES || []).map((s) => [s.id, s]));

  items.forEach((c) => {
    const d = divMap.get(c.iso3), ag = ageMap.get(c.iso3);
    const nlColor = d?.nlColor || ag?.nlColor || null;
    const block = el('div', { class: 'briefing-block' });
    const head = el('h3', { style: 'font-size:15px;text-transform:none;color:#000' }, `${countryFlag(c.iso2)} ${c.nl}`);
    block.append(head);
    const colors = el('p', { class: 'briefing-line' }, 'NL: ', colorCode({ predominant: nlColor }));
    if (d?.consensusColor) colors.append('  ·  consensus: ', colorCode({ predominant: d.consensusColor }),
      d.delta ? el('span', { class: 'muted' }, ` (NL ${d.delta > 0 ? 'strenger' : 'soepeler'})`) : null);
    block.append(colors);
    activeSeasons(c.iso3).forEach((s) => block.append(el('p', { class: 'briefing-line' }, `${s.emoji || '🌦️'} ${s.naam} — ${s.hazard}`)));
    const recent = (RECENT_CHANGES || []).filter((x) => x.iso3 === c.iso3 && x.date >= wk && x.kind !== 'bulk');
    if (recent.length) block.append(el('p', { class: 'briefing-line' },
      `📝 ${recent.length} wijziging${recent.length === 1 ? '' : 'en'} (7 dgn): `,
      recent.slice(0, 3).map((x) => srcMeta.get(x.source)?.label || x.sourceLabel).join(', ')));
    const open = el('button', { type: 'button', class: 'btn-link', style: 'font-size:12.5px' }, 'volledige vergelijking →');
    open.addEventListener('click', () => openCompareFor(c));
    block.append(el('p', { style: 'margin:4px 0 0' }, open));
    wrap.append(block);
  });
  return wrap;
}

// ==========================================================================
// RECENTE WIJZIGINGEN (buitenlandse bronnen — niet NL, dat doet de redactie zelf)
// ==========================================================================
let RECENT_CHANGES = null;
let SOURCE_DATES = null; // { ISO3: { uk: 'yyyy-mm-dd', ... } } — door de bron gemeld
let LAST_CHANGES_RENDER = null; // laatst getoonde selectie, t.b.v. CSV-export
const CHANGE_KIND_LABEL = {
  update: '📝 advies bijgewerkt',
  up: '⬆ niveau omhoog', down: '⬇ niveau omlaag', status: '● status',
  'regional-new': '⚠ nieuwe regio', 'regional-up': '⬆ regio omhoog',
  'regional-down': '⬇ regio omlaag', 'regional-removed': '– regio vervallen',
  bulk: '⚙ bron-breed',
};

const isoDay = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => isoDay(new Date(Date.now() - n * 24 * 60 * 60 * 1000));

/** Huidige [van, tot]-periode (yyyy-mm-dd, beide inclusief) uit de UI. */
function changesPeriod() {
  const sel = $('#changes-period').value;
  if (sel !== 'custom') return [daysAgo(Number(sel)), isoDay(new Date())];
  const from = $('#changes-from').value || daysAgo(92);
  const to = $('#changes-to').value || isoDay(new Date());
  return from <= to ? [from, to] : [to, from];
}

async function buildChanges() {
  const status = $('#changes-status');
  try {
    const data = await loadJSON('recent-changes.json');
    RECENT_CHANGES = data.changes || [];
    status.textContent = data.generatedAt
      ? `Laatst gecontroleerd op ${new Date(data.generatedAt).toLocaleString('nl-NL')}.`
      : '';
  } catch {
    RECENT_CHANGES = [];
    status.textContent = 'Nog geen wijzigingsgeschiedenis beschikbaar (de eerste snapshot moet nog draaien).';
  }
  try {
    SOURCE_DATES = (await loadJSON('source-dates.json')).dates || {};
  } catch {
    SOURCE_DATES = {};
  }

  // Bron-filter: alle geconfigureerde bronnen (niet alleen die met wijzigingen).
  const filterSel = $('#changes-filter');
  (CFG.SOURCES || []).forEach((s) => filterSel.append(el('option', { value: s.id }, `${s.flag || ''} ${s.label}`)));

  // Categorie-filter: dezelfde canonieke thema's als in de vergelijking,
  // gegroepeerd zoals themes.json ze indeelt.
  const catSel = $('#changes-category');
  if (catSel && catSel.options.length === 1) {
    const perGroep = new Map();
    THEMES_META.forEach((t) => { if (!perGroep.has(t.group)) perGroep.set(t.group, []); perGroep.get(t.group).push(t); });
    for (const [groep, items] of perGroep) {
      const og = el('optgroup', { label: groep });
      items.forEach((t) => og.append(el('option', { value: t.id }, `${t.icon ? t.icon + ' ' : ''}${t.label}`)));
      catSel.append(og);
    }
    catSel.append(el('option', { value: '_onbekend' }, 'Categorie onbekend'));
  }

  // Land-filter (waaróver het advies gaat): een datalist met alle landnamen
  // voor autocomplete; de daadwerkelijke filtering (substring, diacriet-loos)
  // gebeurt in renderChanges zodat ook los typen ("ethio") werkt.
  const countryList = $('#changes-country-list');
  if (countryList && !countryList.childElementCount) {
    [...COUNTRIES].sort((a, b) => a.nl.localeCompare(b.nl, 'nl'))
      .forEach((c) => countryList.append(el('option', { value: c.nl })));
  }

  // Periode-kiezer: presets + eigen datums (kalender), max 92 dagen terug.
  const periodSel = $('#changes-period');
  const fromInput = $('#changes-from');
  const toInput = $('#changes-to');
  fromInput.min = daysAgo(92); fromInput.max = isoDay(new Date());
  toInput.min = daysAgo(92); toInput.max = isoDay(new Date());
  fromInput.value = daysAgo(1); toInput.value = isoDay(new Date());
  const rerender = () => renderChanges(filterSel.value, ...changesPeriod());
  periodSel.addEventListener('change', () => {
    const custom = periodSel.value === 'custom';
    $('#changes-from-wrap').hidden = !custom;
    $('#changes-to-wrap').hidden = !custom;
    rerender();
  });
  fromInput.addEventListener('change', rerender);
  toInput.addEventListener('change', rerender);
  filterSel.addEventListener('change', rerender);
  $('#changes-watch').addEventListener('change', rerender);
  $('#changes-country').addEventListener('input', rerender);
  $('#changes-category').addEventListener('change', rerender);

  // CSV-export van de op dat moment getoonde selectie (puntkomma's + BOM
  // zodat Nederlandstalig Excel het bestand direct goed opent).
  $('#changes-csv').addEventListener('click', () => {
    const d = LAST_CHANGES_RENDER;
    if (!d || (!d.items.length && !d.reported.length)) return;
    const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const plainKind = (k) => (CHANGE_KIND_LABEL[k] || k).replace(/^[^\p{L}]+/u, '');
    const lines = [['Datum', 'Bron', 'Land', 'Type', 'Omschrijving', 'Notitie van de bron'].map(q).join(';')];
    d.items.forEach((c) => lines.push([c.date, c.sourceLabel, c.countryNl || '(bron-breed)', plainKind(c.kind), c.description, c.updateNoteNl || c.updateNote || ''].map(q).join(';')));
    d.reported.forEach((r) => lines.push([r.date, r.label, r.countryNl, 'door bron gemelde update', 'Bron meldt: advies voor het laatst bijgewerkt op deze datum.', ''].map(q).join(';')));
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `reisadvies-wijzigingen_${d.from}_${d.to}.csv` });
    document.body.append(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
  });

  rerender();
}

function renderChanges(sourceFilter, from, to) {
  const root = $('#changes-result');
  root.innerHTML = '';

  const inPeriod = (d) => d && d >= from && d <= to;
  const onlyWatch = $('#changes-watch')?.checked;

  // Land-filter: het land wáárover het advies gaat (niet de bron). Diacriet-
  // loze substring, zodat "ethio"/"Ethiopië"/"Ethiopia"/"ETH" allemaal werken.
  const cq = norm(($('#changes-country')?.value || '').trim());
  const countryMatch = (iso3, countryNl) => {
    if (!cq) return true;
    if (!iso3) return false; // bron-brede (bulk) meldingen horen niet bij één land
    if (norm(countryNl).includes(cq) || norm(iso3).includes(cq)) return true;
    const c = COUNTRIES.find((x) => x.iso3 === iso3);
    return !!c && (norm(c.nl).includes(cq) || norm(c.en).includes(cq));
  };

  // Categorie-filter: een wijziging telt mee zodra één van de gewijzigde
  // secties in die categorie valt — een sectie kan er in meerdere vallen.
  const cat = $('#changes-category')?.value || '';
  const sectieCats = (sec) => (sec?.themeIds || []).filter((id) => THEME_BY_ID.has(id));
  const inCategory = (c) => {
    if (!cat) return true;
    const secties = c.sections || [];
    if (cat === '_onbekend') return !secties.length || secties.every((s) => !sectieCats(s).length);
    return secties.some((s) => sectieCats(s).includes(cat));
  };

  const items = (RECENT_CHANGES || []).filter(
    (c) => (!sourceFilter || c.source === sourceFilter) && inPeriod(c.date)
      && (!onlyWatch || FAVORITES.has(c.iso3)) && countryMatch(c.iso3, c.countryNl)
      && inCategory(c)
  );

  // Door de bron zelf gemelde updatedatums in de periode — ook voor updates
  // van vóór de start van onze monitoring (details zijn er dan niet, maar
  // "dit land is toen bijgewerkt" wel). Land+bron-combinaties die hierboven
  // al als gedetecteerde wijziging staan, worden overgeslagen.
  const covered = new Set(items.map((c) => `${c.iso3}|${c.source}`));
  const srcMeta = new Map((CFG.SOURCES || []).map((s) => [s.id, s]));
  const reported = [];
  for (const [iso3, perSource] of Object.entries(SOURCE_DATES || {})) {
    if (onlyWatch && !FAVORITES.has(iso3)) continue;
    if (!countryMatch(iso3, null)) continue;
    for (const [sid, date] of Object.entries(perSource)) {
      if (sourceFilter && sid !== sourceFilter) continue;
      // Bij een land-zoekopdracht is de vraag "wanneer heeft bron X dit land
      // vóór het laatst bijgewerkt?" — dan negeren we de ondergrens van de
      // periode (de laatste update kan maanden geleden zijn) en tonen we de
      // bewaarde datum ongeacht hoe oud. Zonder land-filter blijft de periode
      // gewoon gelden.
      const dateOk = cq ? (date && date <= to) : inPeriod(date);
      if (!dateOk || covered.has(`${iso3}|${sid}`)) continue;
      const country = COUNTRIES.find((c) => c.iso3 === iso3);
      const meta = srcMeta.get(sid);
      if (!country || !meta) continue;
      reported.push({ iso3, countryNl: country.nl, source: sid, label: meta.label, flag: meta.flag, date });
    }
  }
  reported.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.countryNl.localeCompare(b.countryNl, 'nl')));
  LAST_CHANGES_RENDER = { items, reported, from, to };

  if (!items.length && !reported.length) {
    root.append(el('p', { class: 'empty-col' },
      cq
        ? `Geen updates gevonden voor een land dat matcht met “${$('#changes-country').value.trim()}”.`
        : `Geen wijzigingen of door de bron gemelde updates gevonden tussen ${new Date(from).toLocaleDateString('nl-NL')} en ${new Date(to).toLocaleDateString('nl-NL')}.`));
    return;
  }

  // Bij een land-zoekopdracht: kop die duidelijk maakt dat je de laatste
  // update-datum per bron ziet voor dít land (over de hele bewaarperiode).
  if (cq) {
    root.append(el('p', { class: 'hint', style: 'margin-top:0' },
      'Je ziet per bron wanneer die het reisadvies voor dit land voor het laatst heeft bijgewerkt. ',
      'De onderste lijst toont de laatst bekende datum per bron, ongeacht de gekozen periode.'));
  }

  if (items.length) {
    root.append(el('h3', { class: 'section-title' }, `Gedetecteerde wijzigingen (${items.length})`));
  }
  let lastDate = null;
  items.forEach((c) => {
    if (c.date !== lastDate) {
      lastDate = c.date;
      root.append(el('h4', { class: 'change-date' }, new Date(c.date).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' })));
    }
    // Bulkmeldingen zijn bron-breed (geen land): geen doorklik, gedempte stijl.
    const who = c.countryNl
      ? el('button', { type: 'button', class: 'btn-link change-country' }, `${c.flag || ''} ${c.sourceLabel} — ${c.countryNl}`)
      : el('span', { class: 'change-country plain' }, `${c.flag || ''} ${c.sourceLabel}`);
    const row = el('div', { class: `change-row kind-${c.kind}` },
      el('span', { class: 'change-kind' }, CHANGE_KIND_LABEL[c.kind] || c.kind),
      who,
      el('p', { class: 'change-desc' }, c.description));

    // Waar gíng de wijziging over? De categorieën van alle gewijzigde secties,
    // ontdubbeld. Ouder dan de invoering van dit veld: geen gok, maar een
    // eerlijk "categorie onbekend".
    if (c.sections?.length) {
      const ids = [...new Set(c.sections.flatMap((s) => sectieCats(s)))];
      const tags = el('div', { class: 'change-cats' });
      if (ids.length) {
        ids.forEach((id) => tags.append(el('span', { class: 'cat-tag' }, iconEl(id), THEME_BY_ID.get(id).label)));
      } else {
        tags.append(el('span', { class: 'cat-tag unknown', title: 'Deze wijziging is vastgelegd voordat de categorie werd meegeschreven.' }, 'categorie onbekend'));
      }
      row.append(tags);
    }
    if (c.countryNl) row.querySelector('.change-country').addEventListener('click', () => {
      openCompareFor(resolveCountry(c.countryNl));
    });

    // De eigen wijzigingsnotitie van de bron (NL-vertaling indien beschikbaar).
    if (c.updateNote) {
      const note = el('blockquote', { class: 'change-note' }, c.updateNoteNl || c.updateNote);
      if (c.updateNoteNl) note.title = `Origineel: ${c.updateNote}`;
      row.append(note);
    }

    // Inhoudelijke details: welke secties, welke zinnen erbij kwamen.
    if (c.sections?.length) {
      const det = el('details', { class: 'change-sections' });
      const totalAdded = c.sections.reduce((n, s) => n + (s.added?.length || 0), 0);
      const totalRemoved = c.sections.reduce((n, s) => n + (s.removedCount || 0), 0);
      det.append(el('summary', {},
        `${c.sections.length} gewijzigde sectie${c.sections.length === 1 ? '' : 's'}` +
        (totalAdded ? ` · ${totalAdded} nieuwe/gewijzigde zin${totalAdded === 1 ? '' : 'nen'}` : '') +
        (totalRemoved ? ` · ${totalRemoved} verwijderd` : '')));
      c.sections.forEach((s) => {
        const box = el('div', { class: 'change-section' });
        box.append(el('h5', {},
          s.heading,
          ...sectieCats(s).map((id) => el('span', { class: 'cat-tag' }, iconEl(id), THEME_BY_ID.get(id).label)),
          s.isNew ? el('span', { class: 'sec-tag new' }, 'nieuwe sectie') : null,
          s.removed ? el('span', { class: 'sec-tag removed' }, 'sectie vervallen') : null));
        const shown = s.addedNl || s.added || [];
        shown.forEach((sentence, i) => {
          const p = el('p', { class: 'added-sentence' }, '+ ', sentence);
          if (s.addedNl && s.added?.[i]) p.title = `Origineel: ${s.added[i]}`;
          box.append(p);
        });
        if (s.removedCount && !s.removed) {
          box.append(el('p', { class: 'removed-note' },
            `– ${s.removedCount} zin${s.removedCount === 1 ? '' : 'nen'} verwijderd of gewijzigd (oude tekst niet bewaard — zie het origineel via de landvergelijking).`));
        }
        det.append(box);
      });
      row.append(det);
    }
    root.append(row);
  });

  // Door de bron gemelde updatedatums (zonder inhoudelijke details).
  if (reported.length) {
    root.append(el('h3', { class: 'section-title' }, `Door de bron gemelde updates (${reported.length})`));
    root.append(el('p', { class: 'hint', style: 'margin-top:0' },
      'De bron meldt zelf dat het advies op deze datum voor het laatst is bijgewerkt. ',
      'Inhoudelijke details (welke tekst gewijzigd is) zijn alleen beschikbaar voor wijzigingen die plaatsvonden ná de start van de dagelijkse monitoring.'));
    let lastRepDate = null;
    reported.forEach((r) => {
      if (r.date !== lastRepDate) {
        lastRepDate = r.date;
        root.append(el('h4', { class: 'change-date' }, new Date(r.date).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' })));
      }
      const row = el('div', { class: 'change-row kind-reported' },
        el('button', { type: 'button', class: 'btn-link change-country' }, `${r.flag || ''} ${r.label} — ${r.countryNl}`),
        el('p', { class: 'change-desc' }, 'Bron meldt: advies voor het laatst bijgewerkt op deze datum.'));
      row.querySelector('.change-country').addEventListener('click', () => {
        openCompareFor(resolveCountry(r.countryNl));
      });
      root.append(row);
    });
  }
}

// ==========================================================================
// ZOEKEN
// ==========================================================================
const scopeHints = {
  nl: 'Doorzoekt alle Nederlandse reisadviezen. Toont per land waar iets over je zoekwoord staat.',
  'foreign-all': 'Doorzoekt de trefwoordindex over álle buitenlandse adviezen (ververst per snapshot): welke landen noemen dit onderwerp? Je Nederlandse term wordt automatisch in alle brontalen gezocht.',
  foreign: 'Doorzoekt buitenlandse reisadviezen live via de proxy. Vul een land in en gebruik een Engelse term (bijv. "election").',
  both: 'Vergelijkt het Nederlandse en de buitenlandse reisadviezen van één land op je zoekwoord. Vul een land in.',
};
$('#search-scope').addEventListener('change', (e) => { $('#search-hint').textContent = scopeHints[e.target.value] || ''; });
$('#search-hint').textContent = scopeHints.nl;

function searchNlIndex(index, term, isoFilter) {
  const t = term.toLowerCase(), results = [];
  for (const entry of index) {
    if (isoFilter && entry.iso3 !== isoFilter) continue;
    const matches = [];
    for (const b of entry.blocks) if (b.text && b.text.toLowerCase().includes(t))
      matches.push({ category: b.category, heading: b.heading, theme: b.themeLabel, snippet: snippetAround(b.text, term) });
    const inSummary = entry.summaryText ? entry.summaryText.toLowerCase().includes(t) : false;
    if (matches.length || inSummary) results.push({
      iso3: entry.iso3, name: entry.name, url: entry.url, color: entry.color,
      inSummary, summarySnippet: inSummary ? snippetAround(entry.summaryText, term) : null,
      matches, matchCount: matches.length + (inSummary ? 1 : 0),
    });
  }
  results.sort((a, b) => b.matchCount - a.matchCount || a.name.localeCompare(b.name, 'nl'));
  return results;
}
function searchForeignAdvisory(res, qNl, qEn) {
  const tNl = qNl.toLowerCase(), tEn = (qEn || qNl).toLowerCase(), out = [];
  for (const s of (res.sources || [])) {
    if (s.unavailable || s.error || !s.themes) continue;
    const matches = [];
    for (const b of s.themes) {
      // Vertaalde (niet-Engelse) bron: zoek met de NL-term in de NL-tekst.
      // Engelse bron: zoek met de naar Engels vertaalde term in de originele tekst.
      const useNl = !!b.textNl;
      const hay = (useNl ? b.textNl : b.text) || '';
      const term = useNl ? tNl : tEn;
      if (hay.toLowerCase().includes(term)) {
        matches.push({
          category: b.category,
          heading: (useNl && b.headingNl) ? b.headingNl : b.heading,
          theme: b.themeId ? (THEME_BY_ID.get(b.themeId)?.label || null) : null,
          snippet: snippetAround(hay, useNl ? qNl : qEn),
        });
      }
    }
    if (matches.length) out.push({ iso3: res.country.iso3, name: `${s.flag || ''} ${s.sourceLabel}`, url: s.url, matches, matchCount: matches.length });
  }
  return out;
}

// ---- Trefwoordindex over alle buitenlandse adviezen -------------------------
// Zelfde normalisatie als de indexbouwer (snapshot-foreign.mjs): kleine
// letters, diakrieten weg, 4-24 letters, slot-s vouwen.
function indexQueryTerms(text) {
  const out = new Set();
  const clean = norm(text);
  for (let w of clean.split(/[^a-z]+/)) {
    if (w.length < 4 || w.length > 24) continue;
    if (w.length > 4 && w.endsWith('s')) w = w.slice(0, -1);
    out.add(w);
  }
  return out;
}

/** Zoekt de NL-term (plus vertalingen) in de offline index: iso3 -> gevonden varianten. */
async function searchForeignIndex(qNl, status) {
  const variants = new Set([qNl]);
  if (getProxy()) {
    status.innerHTML = `<span class="spinner"></span>Term vertalen naar de brontalen…`;
    for (const lang of ['en', 'fr', 'es', 'de', 'da']) {
      const t = await translateText(qNl, lang, 'nl');
      if (t) variants.add(t);
    }
  }
  const terms = new Set();
  for (const v of variants) for (const t of indexQueryTerms(v)) terms.add(t);
  if (!terms.size) return { hits: new Map(), terms: [], variants: [...variants], generatedAt: null };

  status.innerHTML = `<span class="spinner"></span>Index doorzoeken…`;
  const letters = [...new Set([...terms].map((t) => t[0]))];
  const shards = {};
  let generatedAt = null;
  await Promise.all(letters.map(async (l) => {
    try {
      const d = await loadJSON(`foreign-index/${l}.json`);
      shards[l] = d.terms || {};
      generatedAt = generatedAt || d.generatedAt || null;
    } catch { shards[l] = null; }
  }));
  if (letters.every((l) => shards[l] === null)) throw new Error('De trefwoordindex is er nog niet — die verschijnt na de eerstvolgende snapshot-run (elke 6 uur).');

  const hits = new Map(); // iso3 -> Set(term)
  for (const t of terms) {
    const posting = shards[t[0]]?.[t];
    if (!posting) continue;
    for (const iso of posting) {
      if (!hits.has(iso)) hits.set(iso, new Set());
      hits.get(iso).add(t);
    }
  }
  return { hits, terms: [...terms], variants: [...variants], generatedAt };
}

function renderForeignIndexResult(res, q, root) {
  const frag = document.createDocumentFragment();
  const rows = [...res.hits.entries()]
    .map(([iso3, terms]) => ({ iso3, terms: [...terms], country: COUNTRIES.find((c) => c.iso3 === iso3) }))
    .filter((r) => r.country)
    .sort((a, b) => b.terms.length - a.terms.length || a.country.nl.localeCompare(b.country.nl, 'nl'));

  frag.append(el('h3', { class: 'section-title' },
    `${rows.length} land${rows.length === 1 ? '' : 'en'} waar buitenlandse bronnen "${q}" noemen`));
  frag.append(el('p', { class: 'hint', style: 'margin-top:0' },
    `Gezocht op: ${res.variants.join(' · ')}${res.generatedAt ? ` · index van ${new Date(res.generatedAt).toLocaleString('nl-NL')}` : ''}. `,
    'Klik op een land om de vergelijking te openen met de onderwerp-zoeker vooringevuld — daar zie je de passages per bron.'));

  if (!rows.length) {
    frag.append(el('p', { class: 'empty-col' }, 'Geen landen gevonden. Tip: probeer een synoniem of de Engelse term.'));
    root.append(frag);
    return;
  }

  // Regiofilter (punt 13): alleen regio's die in de treffers voorkomen.
  const regions = [...new Set(rows.map((r) => r.country.region).filter(Boolean))].sort();
  const grid = el('div', { class: 'index-hits' });
  const drawGrid = (region) => {
    grid.innerHTML = '';
    const shown = rows.filter((r) => !region || r.country.region === region);
    shown.forEach((r) => {
      const btn = el('button', { type: 'button', class: 'index-hit' },
        el('span', { class: 'fl' }, countryFlag(r.country.iso2)),
        el('span', { class: 'index-hit-name' }, r.country.nl),
        el('span', { class: 'index-hit-terms' }, r.terms.join(', ')));
      btn.addEventListener('click', () => {
        PENDING_TOPIC = q;
        openCompareFor(r.country);
      });
      grid.append(btn);
    });
  };
  if (regions.length > 1) {
    const sel = el('select', { style: 'margin-bottom:12px' }, el('option', { value: '' }, `Alle regio's (${rows.length})`));
    regions.forEach((rg) => sel.append(el('option', { value: rg }, `${rg} (${rows.filter((r) => r.country.region === rg).length})`)));
    sel.addEventListener('change', () => drawGrid(sel.value));
    frag.append(sel);
  }
  drawGrid('');
  frag.append(grid);
  root.append(frag);
}

$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#search-input').value.trim();
  const scope = $('#search-scope').value;
  const countryInput = $('#search-country').value.trim();
  const status = $('#search-status'), result = $('#search-result');
  if (!q) return;

  if (scope === 'foreign-all') {
    status.className = 'status'; result.innerHTML = '';
    try {
      const res = await searchForeignIndex(q, status);
      status.textContent = '';
      renderForeignIndexResult(res, q, result);
    } catch (err) { status.className = 'status error'; status.textContent = err.message; }
    return;
  }
  let country = null;
  if (countryInput) { country = resolveCountry(countryInput); if (!country) { status.className = 'status error'; status.textContent = `Land “${countryInput}” niet gevonden.`; result.innerHTML = ''; return; } }

  status.className = 'status'; status.innerHTML = `<span class="spinner"></span>Zoeken naar “${esc(q)}”…`; result.innerHTML = '';
  try {
    const out = { query: q, scope };
    if (scope === 'nl' || scope === 'both') {
      const idx = await loadJSON('search/nl.json');
      out.nl = searchNlIndex(idx, q, country?.iso3 || null);
    }
    if (scope === 'foreign' || scope === 'both') {
      if (!country) throw new Error('Kies een land voor buitenlands zoeken (dit gebeurt live per land).');
      if (!getProxy()) throw new Error('Stel de proxy in (⚙) om buitenlands te zoeken.');
      const selected = (CFG.SOURCES || []).map((s) => s.id);
      // NL-term ook naar Engels vertalen zodat we in Engelstalige adviezen zoeken.
      const [res, qEn] = await Promise.all([
        fetchForeign(country.iso3, selected, 'nl'),
        translateText(q, 'en', 'nl'),
      ]);
      out.foreign = res ? searchForeignAdvisory(res, q, qEn) : [];
    }
    status.textContent = '';
    renderSearch(out, result, q);
  } catch (err) { status.className = 'status error'; status.textContent = err.message; }
});

function renderCountryResult(r, term) {
  const details = el('details', { class: 'panel result-country' });
  // Buitenlandse rijen dragen hun bronvlag al in de naam en hebben geen iso3
  // van een land in deze zin; landMerk valt daar vanzelf terug.
  details.append(el('summary', {},
    el('span', { class: 'result-name' }, landMerk(r.iso3, r.color), ' ' + r.name),
    el('span', { class: 'count-pill', style: 'margin-left:auto' }, `${r.matchCount}×`),
    el('a', { href: r.url, target: '_blank', rel: 'noopener', style: 'margin-left:10px;font-weight:400;font-size:13px', onclick: (ev) => ev.stopPropagation() }, 'origineel →')));
  if (r.inSummary && r.summarySnippet) details.append(el('div', { class: 'match' },
    el('div', { class: 'm-head' }, 'In het kort (samenvatting)'), el('div', { class: 'snippet', html: highlight(r.summarySnippet, term) })));
  (r.matches || []).forEach((m) => details.append(el('div', { class: 'match' },
    el('div', { class: 'm-head' }, m.category && m.category !== m.heading ? `${m.category} › ` : '', el('strong', {}, m.heading), m.theme ? el('span', { class: 'm-theme' }, m.theme) : null),
    el('div', { class: 'snippet', html: highlight(m.snippet, term) }))));
  return details;
}
function renderSearch(data, root, term) {
  const frag = document.createDocumentFragment();
  const hasNl = Array.isArray(data.nl), hasForeign = Array.isArray(data.foreign);
  if (hasNl && hasForeign) {
    const cols = el('div', { class: 'results-columns' });
    const left = el('div', {}, el('h3', { class: 'section-title' }, `🇳🇱 NederlandWereldwijd (${data.nl.length})`));
    if (!data.nl.length) left.append(el('p', { class: 'empty-col' }, 'Geen resultaten.'));
    data.nl.forEach((r) => left.append(renderCountryResult(r, term)));
    const right = el('div', {}, el('h3', { class: 'section-title' }, `🌍 Buitenland (${data.foreign.length})`));
    if (!data.foreign.length) right.append(el('p', { class: 'empty-col' }, 'Geen resultaten (probeer een Engelse term).'));
    data.foreign.forEach((r) => right.append(renderCountryResult(r, term)));
    cols.append(left, right); frag.append(cols);
  } else if (hasNl) {
    frag.append(el('h3', { class: 'section-title' }, `Gevonden in ${data.nl.length} Nederlands(e) reisadvies/reisadviezen`));
    if (!data.nl.length) frag.append(el('p', { class: 'empty-col' }, 'Geen resultaten.'));
    data.nl.forEach((r) => frag.append(renderCountryResult(r, term)));
  } else if (hasForeign) {
    frag.append(el('h3', { class: 'section-title' }, `Gevonden in ${data.foreign.length} buitenlands(e) reisadvies/reisadviezen`));
    if (!data.foreign.length) frag.append(el('p', { class: 'empty-col' }, 'Geen resultaten (probeer een Engelse term).'));
    data.foreign.forEach((r) => frag.append(renderCountryResult(r, term)));
  }
  root.append(frag);
}

// ==========================================================================
// DATUMSCANNER — vindt datums in de bodytekst die in het verleden liggen
// (mogelijk verouderde inhoud). De metadata (laatst gewijzigd/geldig op) zit
// niet in deze teksten en wordt zo dus niet meegenomen.
// ==========================================================================
const NL_MONTHS = { januari: 0, februari: 1, maart: 2, april: 3, mei: 4, juni: 5, juli: 6, augustus: 7, september: 8, oktober: 9, november: 10, december: 11 };
const MONTH_RE = 'januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december';
const MONTH_NAMES = Object.keys(NL_MONTHS);

function findPastDates(text, mode, today) {
  const found = [];
  const excludedBefore = /(gewijzigd|geldig op|bijgewerkt|gepubliceerd|laatst)/;
  const add = (idx, raw, date, uncertain) => {
    if (!date || isNaN(date) || date >= today) return;
    const before = text.slice(Math.max(0, idx - 28), idx).toLowerCase();
    if (excludedBefore.test(before)) return;
    found.push({ date, raw: raw.trim(), uncertain, snippet: snippetAround(text, raw.trim(), 90) });
  };
  let m;
  const r1 = new RegExp(`(\\d{1,2})\\s+(${MONTH_RE})\\s+(\\d{4})`, 'gi');
  while ((m = r1.exec(text))) add(m.index, m[0], new Date(+m[3], NL_MONTHS[m[2].toLowerCase()], +m[1]));
  const r2 = /(\d{1,2})[-/](\d{1,2})[-/](\d{4})/g;
  while ((m = r2.exec(text))) { const mo = +m[2]; if (mo >= 1 && mo <= 12) add(m.index, m[0], new Date(+m[3], mo - 1, +m[1])); }
  const r3 = new RegExp(`(?<![\\d]\\s)(${MONTH_RE})\\s+(\\d{4})`, 'gi');
  while ((m = r3.exec(text))) add(m.index, m[0], new Date(+m[2], NL_MONTHS[m[1].toLowerCase()] + 1, 0));
  if (mode === 'all') {
    const r4 = new RegExp(`(\\d{1,2})\\s+(${MONTH_RE})(?!\\s+\\d{4})`, 'gi');
    while ((m = r4.exec(text))) add(m.index, m[0] + ` ${today.getFullYear()}`, new Date(today.getFullYear(), NL_MONTHS[m[2].toLowerCase()], +m[1]), true);
  }
  return found;
}
function fmtDate(d) { return `${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`; }
function ageText(d, today) {
  const days = Math.round((today - d) / 86400000);
  if (days < 60) return `${days} dagen geleden`;
  const months = Math.round(days / 30.4);
  if (months < 24) return `${months} maanden geleden`;
  return `${(days / 365).toFixed(1)} jaar geleden`;
}

$('#datescan-run').addEventListener('click', async () => {
  const mode = $('#datescan-mode').value;
  const status = $('#datescan-status'), result = $('#datescan-result');
  status.className = 'status'; status.innerHTML = '<span class="spinner"></span>Scannen…'; result.innerHTML = '';
  try {
    const idx = await loadJSON('search/nl.json');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const countries = [];
    for (const entry of idx) {
      const hits = [];
      const scan = (text, heading) => {
        if (!text) return;
        for (const f of findPastDates(text, mode, today)) hits.push({ ...f, heading });
      };
      scan(entry.summaryText, 'In het kort');
      for (const b of entry.blocks) scan(b.text, b.heading);
      if (hits.length) {
        hits.sort((a, b) => a.date - b.date);
        // dedup op datum+snippet
        const seen = new Set();
        const uniq = hits.filter((h) => { const k = h.date.getTime() + h.snippet.slice(0, 30); if (seen.has(k)) return false; seen.add(k); return true; });
        countries.push({ iso3: entry.iso3, name: entry.name, url: entry.url, color: entry.color, hits: uniq, oldest: uniq[0].date });
      }
    }
    countries.sort((a, b) => a.oldest - b.oldest);
    status.textContent = `${countries.length} reisadviezen met datums uit het verleden (van ${idx.length} gescand).`;
    renderDateScan(countries, today, result);
  } catch (e) { status.className = 'status error'; status.textContent = e.message; }
});

function renderDateScan(countries, today, root) {
  const frag = document.createDocumentFragment();
  if (!countries.length) { frag.append(el('p', { class: 'empty-col' }, 'Geen datums uit het verleden gevonden.')); root.append(frag); return; }
  countries.forEach((c) => {
    const details = el('details', { class: 'panel result-country' });
    details.append(el('summary', {},
      el('span', { class: 'result-name' }, landMerk(c.iso3, c.color), ' ' + c.name),
      el('span', { class: 'count-pill', style: 'margin-left:auto' }, `oudste: ${fmtDate(c.oldest)}`),
      el('a', { href: c.url, target: '_blank', rel: 'noopener', style: 'margin-left:10px;font-weight:400;font-size:13px', onclick: (e) => e.stopPropagation() }, 'origineel →')));
    c.hits.forEach((h) => details.append(el('div', { class: 'match' },
      el('div', { class: 'm-head' }, el('strong', {}, fmtDate(h.date)), ` · ${ageText(h.date, today)}`, h.uncertain ? el('span', { class: 'm-theme' }, 'geen jaartal — aanname huidig jaar') : null, ' · ', h.heading),
      el('div', { class: 'snippet', html: highlight(h.snippet, h.raw) }))));
    frag.append(details);
  });
  root.append(frag);
}

// ==========================================================================
// UITDRAAI — het scherm dat je ziet, als Excel of als printklaar rapport.
//
// Zit onderaan het Vergelijken-tabblad (geen apart tabblad meer): de landen,
// bronnen, taal en thema-instellingen komen uit het scherm erboven, zodat de
// uitdraai per definitie hetzelfde toont als de vergelijking.
//
// De vorm van de bladen en pagina's zit in export-model.js — DOM-vrij en
// getest in worker/test/export-model.test.mjs.
// ==========================================================================
const CC_STYLE = { groen: 'cc_groen', geel: 'cc_geel', oranje: 'cc_oranje', rood: 'cc_rood' };
const CC_HEX = { groen: '#d7ecc6', geel: '#fbf3ba', oranje: '#f8ddb8', rood: '#f3c0c0' };
// Verzadigde kleurcodes (dezelfde als --groen/--geel/--oranje/--rood in de
// stylesheet). Nodig in de PDF, waar geen CSS-variabelen beschikbaar zijn: het
// regiostreepje moet zich van de lichte celtint kunnen onderscheiden.
const CC_VOL = { groen: '#39870c', geel: '#f9c710', oranje: '#e17000', rood: '#d52b1e' };
const SRC_SHORT = { uk: 'VK', us: 'VS', ca: 'CA', ie: 'IE', fr: 'FR', au: 'AU', es: 'ES', de: 'DE', nz: 'NZ', dk: 'DK', jp: 'JP', it: 'IT', fi: 'FI', kr: 'KR', no: 'NO', at: 'AT', ch: 'CH' };
const cleanText = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const shortFor = (id) => SRC_SHORT[id] || id.toUpperCase();
/** Kolomletter uit een 0-index (0→A, 26→AA) — met 17 bronnen loopt de
 *  overzichtstabel voorbij Z, waar String.fromCharCode zou ontsporen. */
function colName(n) {
  let out = '';
  n += 1;
  while (n > 0) { const m = (n - 1) % 26; out = String.fromCharCode(65 + m) + out; n = (n - m - 1) / 26; }
  return out;
}

// Wat gaat er mee in de uitdraai? Twee onafhankelijke vinkjes, bewaard zodat
// een redacteur ze niet elke sessie opnieuw hoeft te zetten.
let EXPORT_OPTS = (() => {
  try { return { colors: true, text: true, ...(JSON.parse(localStorage.getItem('exportOpts')) || {}) }; }
  catch { return { colors: true, text: true }; }
})();
const saveExportOpts = () => localStorage.setItem('exportOpts', JSON.stringify(EXPORT_OPTS));

// Toont het overzicht bij meerdere landen ook de regionale kleurcodes?
//
// Een landelijke kleurcode verbergt regelmatig het zwaarste deel van het
// advies: in een kwart van de bron-records ligt een gebied hoger dan het land,
// en in 17% zelfs twee niveaus of meer. Duitsland zet Burkina Faso landelijk op
// groen omdat de waarschuwing een Teilreisewarnung is — het regionale maximum
// is 4. Het driehoekje verklapte dát er iets was, maar niet hoe zwaar.
//
// Standaard uit: wie het overzicht kent, moet het niet ineens anders zien.
let REGIO_KLEUREN = localStorage.getItem('regioKleuren') === '1';
const saveRegioKleuren = () => localStorage.setItem('regioKleuren', REGIO_KLEUREN ? '1' : '0');

/** dd-mm-jjjj uit een ISO-datum of losse datumtekst; leeg blijft leeg. */
function fmtDay(s) {
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d) ? String(s).slice(0, 10) : d.toLocaleDateString('nl-NL');
}

/** NL-datum kort (dd-mm-jjjj) uit modificationDate of lastModified. */
function nlDateShort(nl) {
  const m = (nl.modificationDate || '').match(/(\d{2}-\d{2}-\d{4})/);
  if (m) return m[1];
  return fmtDay(nl.lastModified) || '—';
}

/** Heeft deze bron een gebied dat zwaarder is dan het landelijke niveau? (▲) */
function hasStricterRegion(s) {
  const nat = s.level || COLOR_LEVEL[s.color] || 0;
  return regionalExtraColors(s).some((c) => (COLOR_LEVEL[c] || 0) > nat);
}

/**
 * Zet het opgehaalde resultaat om in de platte dataset die export-model.js
 * verwacht. `withThemes` voegt de bronteksten per thema toe (alleen nodig voor
 * de uitdraai zelf, niet voor de kleurcodematrix op het scherm).
 */
function buildDataset({ withThemes = false } = {}) {
  const sources = COMPARE_SOURCES.map((id) => ({ id, label: sourceMeta(id)?.label || id, short: shortFor(id) }));
  const countries = [];
  for (const c of COMPARE_COUNTRIES) {
    const r = COMPARE_RESULTS.get(c.iso3);
    if (!r) continue;
    const nl = r.staticData.nl;
    const all = r.foreign.sources || [];
    const byId = new Map(all.map((s) => [s.source, s]));
    const srcRows = COMPARE_SOURCES.map((id) => {
      const s = byId.get(id);
      const meta = sourceMeta(id);
      const base = { id, label: meta?.label || id, short: shortFor(id) };
      // Structureel geblokkeerd is iets anders dan "deze keer niet gelukt":
      // Noorwegen zet op élk verzoek een Cloudflare-botcheck en komt er nooit
      // doorheen. Dat als 'na' tonen laat het op een hapering lijken.
      if (s?.blocked) return { ...base, status: 'blocked', url: s.url || '' };
      if (!s || s.unavailable || s.error) return { ...base, status: 'na' };
      return {
        ...base,
        label: s.sourceLabel || base.label,
        color: s.color || null,
        level: s.level != null ? s.level : (COLOR_LEVEL[s.color] || null),
        status: s.assessmentStatus === 'uncertain' ? 'uncertain'
          : s.assessmentStatus === 'none' ? 'none' : 'ok',
        levelLabel: s.levelLabel || '',
        extras: regionalExtraColors(s),
        regional: hasStricterRegion(s),
        date: fmtDay(s.lastModified) || fmtDay(SOURCE_DATES?.[c.iso3]?.[id]) || '',
        stale: !!s.stale,
        snapshotDate: fmtDay(s.snapshotDate),
        colorSource: s.colorSource || '',
        url: s.url || '',
      };
    });
    const nlExtras = nlExtraColors(nl);
    const nlLevel = COLOR_LEVEL[nl.colors?.overall] || null;
    const entry = {
      iso3: c.iso3, iso2: c.iso2, name: c.nl,
      nl: {
        color: nl.colors?.overall || null, level: nlLevel, extras: nlExtras,
        regional: nlExtras.some((x) => (COLOR_LEVEL[x] || 0) > (nlLevel || 0)),
        date: nlDateShort(nl), url: nl.url || '',
      },
      sources: srcRows,
      themes: [], changes: [],
    };
    if (withThemes) {
      const ok = all.filter((s) => !s.unavailable && !s.error && s.themes);
      entry.themes = filteredThemeContent(nl, ok, exportFilter());
      const cmp = buildComparison(nl, ok);
      const changes = resolveRecentChanges(c.iso3, ok, cmp);
      for (const [sid, items] of changes) {
        const meta = sourceMeta(sid);
        items.forEach((it) => entry.changes.push({
          label: meta?.label || sid, date: fmtDay(it.date), heading: it.heading, sentence: cleanText(it.sentence),
        }));
      }
      entry.changes.sort((a, b) => (a.date < b.date ? 1 : -1));
    }
    countries.push(entry);
  }
  return { sources, countries };
}

/** Het filter dat op het scherm actief is — dat gaat één-op-één mee in de
 *  uitdraai, zodat er nooit iets in staat wat je niet ziet (en omgekeerd). */
function exportFilter() {
  return { hidden: HIDDEN_THEMES, word: MATRIX_FILTER?.term || '' };
}

/** Levert per land de thema-inhoud: [{id, label, entries:[{sourceId,…,text}]}]. */
function filteredThemeContent(nl, foreign, { hidden, word } = {}) {
  const comp = buildComparison(nl, foreign.filter((s) => s.themes));
  const nlColor = nl.colors?.overall;
  const wq = word ? norm(word) : null;
  const pick = (fullText) => {
    if (!fullText) return null;
    if (wq && !norm(fullText).includes(wq)) return null;
    return wq ? snippetAround(fullText, word, 200) : fullText;
  };
  const out = [];
  for (const t of comp.themes) {
    if (t.theme.id === '_other') continue;
    if (hidden && hidden.has(t.theme.id)) continue;
    const entries = [];
    const nlText = pick(cleanText((t.nl || []).map((b) => b.text).join(' ')));
    if (nlText) entries.push({ sourceId: 'nl', label: 'NederlandWereldwijd', color: nlColor, level: COLOR_LEVEL[nlColor] || null, status: nlColor ? 'ok' : 'na', text: nlText, url: nl.url || '' });
    for (const [sid, f] of Object.entries(t.foreign)) {
      const txt = pick(cleanText((f.blocks || []).map((b) => b.text).join(' ')));
      if (!txt) continue;
      const s = foreign.find((x) => x.source === sid);
      entries.push({
        sourceId: sid, label: f.label, color: s?.color || null, level: s?.level != null ? s.level : (COLOR_LEVEL[s?.color] || null),
        status: s?.assessmentStatus === 'uncertain' ? 'uncertain' : s?.assessmentStatus === 'none' ? 'none' : 'ok',
        text: txt, url: s?.url || f.url || '',
      });
    }
    if (entries.length) out.push({ id: t.theme.id, label: t.theme.label, entries });
  }
  return out;
}

/**
 * Teken in een matrixcel — zonder het niveaucijfer.
 *
 * De celkleur zégt het niveau al; er dan óók nog een cijfer in zetten leest als
 * een tweede, andere maat en dat verwart meer dan het verheldert. Wat géén
 * kleur is houdt zijn teken wél: "de bron publiceert geen kleurcode" (—),
 * "niet vast te stellen" (?), "deze keer niet opgehaald" (·) en "deze bron
 * blokkeert geautomatiseerd ophalen" (⊘) zijn vier verschillende antwoorden,
 * en aan een leeg vakje zie je niet welk van de vier het is.
 */
function ovMark(c) {
  const teken = ExportModel.cellMark(c);
  return /^\d+$/.test(teken) ? '' : teken;
}

/** Rij van vijf telvakjes (groen · geel · oranje · rood · geen), in dezelfde
 *  stijl als de matrixcellen. Compact genoeg voor één tabelkolom. */
function distCells(dist, cls = 'tiny') {
  const wrap = el('span', {
    class: `dist-cells ${cls}`,
    title: `${dist.groen}× groen · ${dist.geel}× geel · ${dist.oranje}× oranje · ${dist.rood}× rood · `
      + `${dist.geen} zonder kleurcode of niet opgehaald`,
  });
  ['groen', 'geel', 'oranje', 'rood'].forEach((k) => wrap.append(
    el('span', { class: `dist-cell c-${k}${dist[k] ? '' : ' zero'}` }, String(dist[k]))));
  wrap.append(el('span', { class: 'dist-cell none' }, String(dist.geen)));
  return wrap;
}

// ---- Overzicht op het scherm: landen × bronnen ----------------------------
/**
 * De kleurcodematrix boven de landentabs. Toont per land de kleurcode per bron
 * en de grootste afwijking t.o.v. NederlandWereldwijd — dezelfde gegevens als
 * de uitdraai.
 *
 * Het regionale beeld kan op twee manieren: standaard een ▲ dat verklapt dát
 * een gebied zwaarder is, en met "Ook regionale kleurcodes" aan een streepje in
 * het vakje met de kleuren die alleen in delen van het land gelden. Die twee
 * sluiten elkaar uit — staat de streep er, dan voegt het driehoekje niets meer
 * toe.
 */
function renderOverviewBlock(shown) {
  const ds = buildDataset();
  const { body, tally } = ExportModel.overviewMatrix(ds);
  const wrap = el('div', { class: 'overview-block' });
  const regioBox = el('input', { type: 'checkbox', id: 'ov-regio-aan' });
  regioBox.checked = REGIO_KLEUREN;
  regioBox.addEventListener('change', () => {
    REGIO_KLEUREN = regioBox.checked;
    saveRegioKleuren();
    syncUrl();
    renderCompareView();
  });
  wrap.append(el('div', { class: 'theme-head-row' },
    el('h3', { class: 'section-title', style: 'flex:1;margin:0;border:none' },
      `Overzicht — kleurcodes van ${shown.length} landen naast elkaar`),
    el('label', {
      class: 'check-inline',
      title: 'Toont in elk vakje de kleuren die alleen in delen van het land gelden. '
        + 'Een landelijke kleurcode kan een zwaarder gebied verbergen.',
    }, regioBox, ' Ook regionale kleurcodes')));

  const table = el('table', { class: 'overview-matrix' });
  const head = el('tr', {}, el('th', { class: 'ov-land' }, 'Land'), el('th', { title: 'NederlandWereldwijd' }, 'NL'));
  ds.sources.forEach((s) => head.append(el('th', { title: s.label }, s.short)));
  head.append(el('th', { class: 'ov-dist' }, 'Verdeling'));
  head.append(el('th', { class: 'ov-dev' }, 'Grootste afwijking t.o.v. NL'));
  table.append(el('thead', {}, head));

  const tbody = el('tbody');
  const cell = (c) => {
    const extras = REGIO_KLEUREN ? (c.extras || []) : [];
    const td = el('td', {
      class: 'ov-cc' + (c.status === 'ok' && c.color ? ` c-${c.color}` : ' c-none'),
      title: `${c.label}: ${ExportModel.colorTextWithRegions(c)}`
        + (c.regional ? ' — een gebied is zwaarder dan het land' : ''),
    }, ovMark(c));
    // Zonder cijfer draagt de cel alleen nog kleur, en kleur is geen tekst:
    // voor een schermlezer (en voor wie de tabel kopieert) blijft de kleurcode
    // hier in woorden staan.
    if (!ovMark(c)) td.append(el('span', { class: 'enkel-lezen' }, ExportModel.colorTextWithRegions(c)));
    // Staan de regionale kleuren aan, dan is het driehoekje overbodig: de
    // streep zegt hetzelfde én hoeveel zwaarder. Staat de weergave uit, dan is
    // het driehoekje het enige signaal en blijft het staan.
    if (c.regional && !REGIO_KLEUREN) td.append(el('span', { class: 'ov-reg' }, '▲'));
    if (extras.length) {
      const balk = el('span', { class: 'ov-regiobalk' });
      extras.forEach((k) => balk.append(el('i', { class: `c-${k}` })));
      td.append(balk);
    }
    return td;
  };
  body.forEach((r) => {
    const open = el('button', { type: 'button', class: 'btn-link' }, `${countryFlagByIso3(r.iso3) || ''} ${r.country}`);
    open.addEventListener('click', () => {
      COMPARE_ACTIVE = r.iso3;
      MATRIX_FILTER = null;
      syncUrl();
      renderCompareView();
      $('#compare-detail')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    });
    tbody.append(el('tr', { class: r.iso3 === COMPARE_ACTIVE ? 'on' : '' },
      el('td', { class: 'ov-land' }, open),
      cell(r.nl), ...r.cells.map(cell),
      el('td', { class: 'ov-dist' }, distCells(r.dist)),
      el('td', { class: 'ov-dev' }, r.deviation)));
  });
  table.append(tbody);
  wrap.append(el('div', { class: 'overview-scroll' }, table));

  const telling = ['groen', 'geel', 'oranje', 'rood'].filter((k) => tally[k])
    .map((k) => `${tally[k]}× ${COLOR_LABELS[k].toLowerCase()}`).join(' · ');
  wrap.append(el('p', { class: 'hint', style: 'margin:8px 0 0' },
    'De kleur van het vakje is de kleurcode van die bron · ',
    REGIO_KLEUREN
      ? 'de streep in het vakje toont de kleuren die alleen in delen van het land gelden, zwaarste links · '
      : '▲ = een gebied binnen het land is zwaarder dan het landelijke niveau · ',
    '— = de bron publiceert geen kleurcode · ? = niet vast te stellen · · = deze keer niet opgehaald · ⊘ = deze bron blokkeert geautomatiseerd ophalen. ',
    'Verdeling = hoeveel bronnen die kleurcode hanteren, altijd in de volgorde ',
    distCells({ groen: 0, geel: 0, oranje: 0, rood: 0, geen: 0 }, 'tiny legend'),
    ' groen · geel · oranje · rood · geen.',
    telling ? ` NederlandWereldwijd: ${telling}.` : ''));
  return wrap;
}

// ---- Uitdraaibalk onderaan -------------------------------------------------
function renderExportBar(shown) {
  const bar = el('div', { class: 'exportbar' });
  bar.append(el('span', { class: 'exportbar-label' }, 'Uitdraai'));

  const checks = el('div', { class: 'exportbar-checks' });
  const mk = (key, label, title) => {
    const box = el('input', { type: 'checkbox', id: `exp-${key}` });
    box.checked = !!EXPORT_OPTS[key];
    box.addEventListener('change', () => {
      EXPORT_OPTS[key] = box.checked;
      saveExportOpts();
      updateBar();
    });
    return el('label', { class: 'check-inline', title }, box, ' ', label);
  };
  checks.append(
    mk('colors', 'Kleurcodes', 'Het overzicht met kleurcodes per land en bron, plus het blad met afwijkingen.'),
    mk('text', 'Wat bronnen zeggen', 'De bronteksten per thema. Uit = alleen kleurcodes, dus zonder landpagina’s.'));
  bar.append(checks);

  const xlsxBtn = el('button', { type: 'button', class: 'btn primary' }, '⬇ Excel (.xlsx)');
  const pdfBtn = el('button', { type: 'button', class: 'btn' }, '⬇ PDF (rapport)');
  const printBtn = el('button', { type: 'button', class: 'btn', title: 'Print het scherm zoals het nu is (compacte samenvatting, zonder de matrix).' }, '🖨 Printen');
  xlsxBtn.addEventListener('click', () => runUitdraai('xlsx'));
  pdfBtn.addEventListener('click', () => runUitdraai('pdf'));
  printBtn.addEventListener('click', () => window.print());
  bar.append(xlsxBtn, pdfBtn, printBtn);

  const note = el('span', { class: 'exportbar-note' });
  bar.append(note);

  const updateBar = () => {
    const niets = !EXPORT_OPTS.colors && !EXPORT_OPTS.text;
    xlsxBtn.disabled = pdfBtn.disabled = niets;
    const filters = [
      HIDDEN_THEMES.size ? `${HIDDEN_THEMES.size} thema’s verborgen` : null,
      MATRIX_FILTER ? `filter “${MATRIX_FILTER.label}”` : null,
    ].filter(Boolean);
    note.textContent = niets
      ? 'Kies minstens één onderdeel om uit te draaien.'
      : `${shown.length} land${shown.length === 1 ? '' : 'en'} · ${COMPARE_SOURCES.length} bronnen · brontaal${filters.length ? ' · ' + filters.join(' · ') : ''}`;
  };
  updateBar();
  bar.__update = updateBar; // zodat runUitdraai na afloop de juiste staat herstelt
  return bar;
}

function setExportStatus(msg, cls = '') {
  let s = $('#export-status');
  if (!s) {
    s = el('div', { id: 'export-status', class: 'status' });
    $('#compare-result .exportbar')?.after(s);
  }
  s.className = 'status' + (cls ? ' ' + cls : '');
  s.textContent = msg;
}

async function runUitdraai(kind) {
  if (!COMPARE_RESULTS.size) return;
  const buttons = $$('#compare-result .exportbar .btn');
  buttons.forEach((b) => { b.disabled = true; });
  setExportStatus('Uitdraai samenstellen…');
  try {
    // Even laten renderen: bij 15 landen kost het opbouwen van de teksten
    // merkbaar tijd en anders lijkt de knop niets te doen.
    await new Promise((r) => setTimeout(r, 0));
    const ds = buildDataset({ withThemes: EXPORT_OPTS.text });
    const built = kind === 'xlsx' ? buildExportXlsx(ds) : buildExportPdf(ds);
    if (built === 'empty') setExportStatus('Geen bronteksten gevonden voor dit filter — zet het themafilter uit of vink “Kleurcodes” aan.', 'error');
    else setExportStatus(kind === 'xlsx' ? 'Excel gedownload.'
      : 'Rapport klaar — de printdialoog staat open (kies “Opslaan als pdf”). Staat alles liggend? Zet in de dialoog “Lay-out” op Staand; de matrixpagina’s draaien dan vanzelf mee naar liggend.', 'ok');
  } catch (e) {
    setExportStatus('Uitdraai mislukt: ' + e.message, 'error');
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
    $('#compare-result .exportbar')?.__update?.();
  }
}

function downloadBlob(blob, name) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---- Excel ----------------------------------------------------------------
/** Bouwt en downloadt het Excel-bestand. Geeft 'empty' als er niets in komt. */
function buildExportXlsx(ds) {
  const stamp = new Date().toISOString().slice(0, 10);
  const sheets = [];
  const langLabel = 'Originele taal van de bron (op het scherm vertaal je per fragment)';

  // ---- Blad "Overzicht": landen × bronnen, breed en leesbaar ----
  if (EXPORT_OPTS.colors) {
    const { header, body } = ExportModel.overviewMatrix(ds);
    // In Excel juist wél vijf losse kolommen: daar wil je op kunnen filteren,
    // sorteren en draaien — op het scherm en in de PDF zijn het vijf vakjes.
    const kop = [...header.slice(0, -2), 'Groen', 'Geel', 'Oranje', 'Rood', 'Geen kleurcode', ...header.slice(-2)];
    const s = {
      name: 'Overzicht', freeze: 2, autofilter: 2,
      cols: [26, 16, ...ds.sources.map(() => 16), 9, 9, 9, 9, 15, 40, 14],
      merges: [`A1:${colName(kop.length - 1)}1`], rows: [],
    };
    s.rows.push([{ v: `Reisadviezen — vergelijking van ${ds.countries.length} land${ds.countries.length === 1 ? '' : 'en'} · ${stamp}`, t: 'title' }]);
    s.rows.push(kop.map((h) => ({ v: h, t: 'header' })));
    const cc = (c) => {
      // Met de regionale weergave aan komen de kleuren voluit in de cel; het
      // driehoekje is dan overbodig. Staat hij uit, dan blijft de uitdraai
      // precies zoals hij was.
      const txt = REGIO_KLEUREN
        ? ExportModel.colorTextWithRegions(c)
        : ExportModel.colorText(c) + (c.regional ? ' ▲' : '');
      return c.status === 'ok' && c.color ? { v: txt, t: CC_STYLE[c.color] } : { v: txt, t: 'plain' };
    };
    for (const r of body) {
      s.rows.push([{ v: r.country, t: 'country' }, cc(r.nl), ...r.cells.map(cc),
        { v: r.dist.groen, t: 'cc_groen' }, { v: r.dist.geel, t: 'cc_geel' },
        { v: r.dist.oranje, t: 'cc_oranje' }, { v: r.dist.rood, t: 'cc_rood' },
        { v: r.dist.geen, t: 'num' },
        { v: r.deviation, t: 'text' }, { v: r.date, t: 'num' }]);
    }
    sheets.push(s);
  }

  // ---- Blad "Per bron per thema": lang en filterbaar ----
  const long = EXPORT_OPTS.text ? ExportModel.longRows(ds) : [];
  if (EXPORT_OPTS.text && long.length) {
    const s = { name: 'Per bron per thema', freeze: 1, autofilter: 1, cols: [22, 30, 26, 9, 18, 96, 13, 16], rows: [] };
    s.rows.push(['Land', 'Bron', 'Thema', 'Niveau', 'Kleurcode', 'Wat de bron zegt', 'Bijgewerkt', 'Herkomst']
      .map((h) => ({ v: h, t: 'header' })));
    for (const r of long) {
      s.rows.push([
        { v: r.land, t: 'country' }, { v: r.bron, t: 'plain' }, { v: r.thema, t: 'plain' },
        // Echt numeriek: zo kun je erop sorteren en optellen.
        r.niveau != null ? { v: r.niveau, t: 'num' } : { v: '', t: 'num' },
        { v: r.kleur, t: r.niveau != null && CC_STYLE[LEVEL_COLORS[r.niveau]] ? CC_STYLE[LEVEL_COLORS[r.niveau]] : 'plain' },
        { v: r.tekst, t: 'text' }, { v: r.bijgewerkt, t: 'num' }, { v: r.herkomst, t: 'plain' },
      ]);
    }
    sheets.push(s);
  }

  // ---- Blad "Afwijkingen": de werklijst ----
  if (EXPORT_OPTS.colors) {
    const rows = ExportModel.divergenceRows(ds);
    const s = { name: 'Afwijkingen', freeze: 1, autofilter: 1, cols: [22, 30, 18, 20, 16, 10, 13, 16], rows: [] };
    s.rows.push(['Land', 'Bron', 'NederlandWereldwijd', 'Bron', 'Richting', 'Verschil', 'Bijgewerkt', 'Herkomst']
      .map((h) => ({ v: h, t: 'header' })));
    for (const r of rows) {
      s.rows.push([
        { v: r.land, t: 'country' }, { v: r.bron, t: 'plain' }, { v: r.nl, t: 'plain' }, { v: r.bronKleur, t: 'plain' },
        { v: r.richting, t: 'plain' }, r.verschil != null ? { v: r.verschil, t: 'num' } : { v: '', t: 'num' },
        { v: r.bijgewerkt, t: 'num' }, { v: r.herkomst, t: 'plain' },
      ]);
    }
    if (!rows.length) s.rows.push([{ v: 'Geen enkele bron wijkt af van NederlandWereldwijd.', t: 'text' }]);
    sheets.push(s);
  }

  if (!sheets.length) return 'empty';

  // ---- Blad "Verantwoording": waar komt dit vandaan? ----
  const s4 = { name: 'Verantwoording', cols: [30, 12, 12, 16, 16, 16], rows: [] };
  s4.rows.push([{ v: 'Over deze uitdraai', t: 'title' }]);
  s4.rows.push([{ v: 'Gemaakt op', t: 'country' }, { v: new Date().toLocaleString('nl-NL'), t: 'text' }]);
  s4.rows.push([{ v: 'Landen', t: 'country' }, { v: ds.countries.map((c) => c.name).join(', '), t: 'text' }]);
  s4.rows.push([{ v: 'Taal bronteksten', t: 'country' }, { v: langLabel, t: 'text' }]);
  if (HIDDEN_THEMES.size) s4.rows.push([{ v: 'Thema-filter', t: 'country' }, { v: `${HIDDEN_THEMES.size} thema’s verborgen op het scherm en dus ook hier`, t: 'text' }]);
  if (MATRIX_FILTER) s4.rows.push([{ v: 'Zoekwoord', t: 'country' }, { v: `${MATRIX_FILTER.label} (alleen passages met deze term)`, t: 'text' }]);
  s4.rows.push([{ v: 'Kleurcodes', t: 'country' }, { v: 'Groen = normale risico’s · Geel = let op · Oranje = niet-noodzakelijke reizen ontraden · Rood = niet reizen. “Kleurcode ontbreekt” betekent dat de bron er zelf geen publiceert; “onzeker” dat wij hem niet betrouwbaar konden vaststellen. Niveaus (1–4) komen van de bron.', t: 'text' }]);
  s4.rows.push([{ v: 'Vertaling', t: 'country' }, { v: 'Vertalingen zijn automatisch gemaakt; de originele tekst is leidend.', t: 'text' }]);
  s4.rows.push([{ v: '', t: 'plain' }]);
  s4.rows.push(['Bron', 'Live', 'Snapshot', 'Niet opgehaald', 'Geen kleurcode', 'Nieuwste datum'].map((h) => ({ v: h, t: 'header' })));
  for (const p of ExportModel.provenanceRows(ds)) {
    s4.rows.push([{ v: p.bron, t: 'plain' }, { v: p.live, t: 'num' }, { v: p.snapshot, t: 'num' },
      { v: p.nietOpgehaald, t: 'num' }, { v: p.geenKleurcode, t: 'num' }, { v: p.bijgewerkt, t: 'num' }]);
  }
  s4.rows.push([{ v: '', t: 'plain' }]);
  s4.rows.push([{ v: 'Een snapshot is de laatst opgeslagen versie: die bron was bij het samenstellen niet bereikbaar.', t: 'text' }]);
  s4.rows.push([{ v: '', t: 'plain' }]);
  s4.rows.push([{ v: 'Bron-URL’s per land', t: 'header' }, { v: '', t: 'header' }]);
  for (const c of ds.countries) {
    s4.rows.push([{ v: `${c.name} — NederlandWereldwijd`, t: 'country' }, { v: c.nl.url, t: 'text' }]);
    for (const s of c.sources) if (s.url) s4.rows.push([{ v: `${c.name} — ${s.label}`, t: 'plain' }, { v: s.url, t: 'text' }]);
  }
  sheets.push(s4);

  downloadBlob(buildXlsx(sheets), `Reisadviezen_uitdraai_${stamp}.xlsx`);
  return 'ok';
}

// ---- PDF (via de printdialoog) --------------------------------------------
/**
 * Bouwt een printbaar rapport in een verborgen container en opent de
 * printdialoog. Drie soorten pagina's: voorblad + kleurcodematrix liggend,
 * landpagina's staand (daar zijn citaten leesbaarder).
 *
 * De oriëntatie per pagina loopt via benoemde @page-regels; browsers die dat
 * niet kennen printen alles in de stand uit de printdialoog — minder mooi,
 * maar compleet.
 */
function buildExportPdf(ds) {
  const stamp = new Date().toLocaleDateString('nl-NL');
  const root = $('#export-print') || el('div', { id: 'export-print' });
  root.innerHTML = '';
  if (!root.parentNode) document.body.append(root);

  const langLabel = 'de originele taal van elke bron';
  const filterBits = [
    HIDDEN_THEMES.size ? `${HIDDEN_THEMES.size} thema’s verborgen` : null,
    MATRIX_FILTER ? `alleen passages met “${MATRIX_FILTER.label}”` : null,
  ].filter(Boolean).join(' · ') || 'alle thema’s';

  const pages = [];
  const page = (orient, ...kids) => {
    const p = el('section', { class: `exp-page exp-${orient}` }, el('div', { class: 'exp-body' }, ...kids));
    pages.push(p);
    return p;
  };
  const { body, tally } = ExportModel.overviewMatrix(ds);

  // ---- Voorblad ----
  if (EXPORT_OPTS.colors) {
    const cover = [];
    cover.push(el('h1', { class: 'exp-title' },
      `Reisadviezen — vergelijking van ${ds.countries.length} land${ds.countries.length === 1 ? '' : 'en'}`));
    cover.push(el('p', { class: 'exp-meta' },
      `NederlandWereldwijd naast ${ds.sources.length} buitenlandse bron${ds.sources.length === 1 ? '' : 'nen'} · ${stamp} · filter: ${filterBits}`,
      el('br'), `Bronteksten in ${langLabel} · samengesteld met Reisadviezen-buddy`));

    const tallyRow = el('div', { class: 'exp-tally' });
    ['groen', 'geel', 'oranje', 'rood'].forEach((k) => tallyRow.append(
      el('div', { class: `exp-tally-item c-${k}` }, el('b', {}, String(tally[k])), el('span', {}, COLOR_LABELS[k]))));
    if (tally.onbekend) tallyRow.append(el('div', { class: 'exp-tally-item c-none' }, el('b', {}, String(tally.onbekend)), el('span', {}, 'Geen code')));
    cover.push(el('p', { class: 'exp-sub' }, 'Landen per kleurcode van NederlandWereldwijd'), tallyRow);

    // Herkomst per bron: bij veel bronnen in twee kolommen naast elkaar, zodat
    // het voorblad op één vel blijft in plaats van door te lopen.
    const provRows = ExportModel.provenanceRows(ds);
    const provTable = (rows) => {
      const t = el('table', { class: 'exp-matrix' });
      t.append(el('tr', {}, el('th', {}, 'Bron'), el('th', {}, 'Live'), el('th', {}, 'Snapshot'),
        el('th', {}, 'Niet opgehaald'), el('th', {}, 'Nieuwste datum')));
      rows.forEach((p) => t.append(el('tr', {},
        el('td', {}, p.bron), el('td', { class: 'num' }, String(p.live)), el('td', { class: 'num' }, String(p.snapshot)),
        el('td', { class: 'num' }, String(p.nietOpgehaald)), el('td', { class: 'num' }, p.bijgewerkt || '—'))));
      return t;
    };
    const half = Math.ceil(provRows.length / 2);
    cover.push(el('p', { class: 'exp-sub' }, 'Herkomst per bron'));
    cover.push(provRows.length > 8
      ? el('div', { class: 'exp-cols' }, provTable(provRows.slice(0, half)), provTable(provRows.slice(half)))
      : provTable(provRows));
    cover.push(el('p', { class: 'exp-legend' },
      'Een snapshot is de laatst opgeslagen versie: die bron was bij het samenstellen niet bereikbaar. Citaten staan in de originele taal van de bron.'));
    page('land', ...cover);

    // ---- Kleurcodematrix ----
    const mx = [];
    mx.push(el('h2', { class: 'exp-h2' }, 'Kleurcodes per bron'));
    mx.push(el('p', { class: 'exp-meta' }, REGIO_KLEUREN
      ? 'De kleur van het vakje is de kleurcode van die bron · de streep erin toont de kleuren die alleen in delen van het land gelden, zwaarste links'
      : 'De kleur van het vakje is de kleurcode van die bron · ▲ = een gebied binnen het land is zwaarder dan het landelijke niveau'));
    const tbl = el('table', { class: 'exp-matrix compact' });
    const head = el('tr', {}, el('th', { class: 'exp-land' }, 'Land'), el('th', {}, 'NL'));
    ds.sources.forEach((s) => head.append(el('th', { title: s.label }, s.short)));
    head.append(el('th', { class: 'exp-dist' }, 'Verdeling'));
    head.append(el('th', { class: 'wide' }, 'Grootste afwijking t.o.v. NL'));
    tbl.append(head);
    const cc = (c) => {
      const extras = REGIO_KLEUREN ? (c.extras || []) : [];
      const td = el('td', {
        class: 'exp-ccbox',
        style: c.status === 'ok' && c.color ? `background:${CC_HEX[c.color]}` : '',
        title: ExportModel.colorTextWithRegions(c),
      }, ovMark(c) + (c.regional && !REGIO_KLEUREN ? '▲' : ''));
      if (extras.length) {
        const balk = el('span', { class: 'exp-regiobalk' });
        extras.forEach((k) => balk.append(el('i', { style: `background:${CC_VOL[k]}` })));
        td.append(balk);
      }
      return td;
    };
    const expDist = (d) => {
      const td = el('td', { class: 'exp-dist' });
      ['groen', 'geel', 'oranje', 'rood'].forEach((k) => td.append(
        el('span', { class: 'exp-dcell', style: `background:${CC_HEX[k]}` }, String(d[k]))));
      td.append(el('span', { class: 'exp-dcell none' }, String(d.geen)));
      return td;
    };
    body.forEach((r) => tbl.append(el('tr', {},
      el('td', { class: 'exp-country' }, r.country), cc(r.nl), ...r.cells.map(cc),
      expDist(r.dist), el('td', { class: 'exp-diff' }, r.deviation))));
    mx.push(tbl);
    mx.push(el('p', { class: 'exp-legend' },
      '— = de bron publiceert geen kleurcode voor dit land · ? = niet betrouwbaar vast te stellen · · = deze keer niet opgehaald · ⊘ = deze bron blokkeert geautomatiseerd ophalen. '
      + 'Verdeling = hoeveel bronnen die kleurcode hanteren, in de volgorde groen · geel · oranje · rood · geen. '
      + 'De bronnen staan voluit op het voorblad.'));
    page('land', ...mx);
  }

  // ---- Per land een staande pagina ----
  let anyContent = false;
  if (EXPORT_OPTS.text) {
    for (const c of ds.countries) {
      if (!c.themes.length) continue;
      anyContent = true;
      const kids = [];
      kids.push(el('h2', { class: 'exp-h2' }, c.name));
      kids.push(el('p', { class: 'exp-meta' },
        `NederlandWereldwijd: ${ExportModel.colorText({ status: c.nl.color ? 'ok' : 'na', color: c.nl.color })}`
        + (c.nl.color ? ` — ${COLOR_MEANING[c.nl.color]}` : '') + ` · bijgewerkt ${c.nl.date}`));

      const chipline = el('div', { class: 'exp-chipline' });
      c.sources.forEach((s) => {
        if (s.status === 'na') return;
        chipline.append(el('span', {
          class: 'exp-chip', style: s.status === 'ok' && s.color ? `background:${CC_HEX[s.color]}` : '',
          title: `${s.label}: ${ExportModel.colorText(s)}`,
        }, `${s.short} ${ExportModel.cellMark(s)}${s.regional ? ' ▲' : ''}`));
      });
      if (chipline.childNodes.length) kids.push(chipline);

      for (const t of c.themes) {
        kids.push(el('div', { class: 'exp-band' }, t.label));
        for (const e of t.entries) {
          const lvl = e.status === 'ok' && e.color
            ? ` — ${COLOR_LABELS[e.color]}${e.level ? ` (${e.level})` : ''}`
            : e.status === 'none' ? ' — kleurcode ontbreekt' : '';
          kids.push(el('p', { class: 'exp-quote' },
            el('b', {}, `${e.label}${lvl}`), ExportModel.clipSentences(e.text)));
        }
      }
      if (c.changes.length) {
        kids.push(el('div', { class: 'exp-band exp-band-change' }, 'Wat er veranderde',
          el('span', {}, ` · laatste ${CHANGE_WINDOW_DAYS} dagen`)));
        c.changes.slice(0, 6).forEach((ch) => kids.push(el('p', { class: 'exp-quote' },
          el('b', {}, `${ch.label}${ch.date ? ` — ${ch.date}` : ''}${ch.heading ? ` · ${ch.heading}` : ''}`),
          ExportModel.clipSentences(ch.sentence, 2, 320))));
      }
      page('port', ...kids);
    }
    if (!anyContent && !EXPORT_OPTS.colors) return 'empty';
  }

  // Voettekst per pagina: welk onderdeel, de datum en "n van m". Bewust in JS
  // geteld — CSS-paginatellers verschillen per browser.
  pages.forEach((p, i) => {
    const wat = p.querySelector('.exp-h2, .exp-title')?.textContent || 'Uitdraai';
    p.append(el('div', { class: 'exp-foot' },
      el('span', {}, wat), el('span', {}, stamp), el('span', {}, `${i + 1} van ${pages.length}`)));
    root.append(p);
  });

  document.body.classList.add('exp-printing');
  const cleanup = () => { document.body.classList.remove('exp-printing'); window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  setTimeout(() => window.print(), 150);
  return 'ok';
}

// ---- Init -----------------------------------------------------------------
bootstrap().catch((e) => {
  $('#compare-status').className = 'status error';
  $('#compare-status').textContent = 'Kan gegevens niet laden: ' + e.message;
});
