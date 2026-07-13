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

// Taal waarin buitenlandse teksten worden getoond:
//   'nl'   → vertaald naar Nederlands (Engelse bronnen blijven Engels)
//   'en'   → vertaald naar Engels (Engelse bronnen blijven origineel)
//   'orig' → onvertaald, in de brontaal
// Sleutel bewust hernoemd (v2): de standaardtaal wijzigde van 'nl' naar
// 'orig', en zonder nieuwe sleutel zou een eerder opgeslagen voorkeur (bijv.
// 'nl' of 'en' uit vóór deze wijziging) die nieuwe standaard overschaduwen.
let COMPARE_LANG = localStorage.getItem('compareLangV2') || 'orig';
// Matrix-weergave: 'compact' (cellen ingeklapt tot ±4 regels) of 'volledig'.
let MATRIX_DENSITY = localStorage.getItem('matrixDensity') || 'compact';
// Verborgen thema-rijen in de matrix (punt 17), gedeeld over alle landen.
let HIDDEN_THEMES = new Set((() => { try { return JSON.parse(localStorage.getItem('hiddenThemes')) || []; } catch { return []; } })());
const saveHiddenThemes = () => localStorage.setItem('hiddenThemes', JSON.stringify([...HIDDEN_THEMES]));
// Actief matrix-termfilter (gezet door een gazetteer-chip): toont alleen de
// passages die deze term noemen, over alle bronkolommen. { label, term, re }.
let MATRIX_FILTER = null;
let LAST_COMPARE = null;
// Vooringevulde term voor de onderwerp-zoeker (gezet door de indexzoeker en
// de gazetteer-chips; wordt na de eerstvolgende vergelijking uitgevoerd).
let PENDING_TOPIC = null;

// ---- Bronselectie (gedeeld tussen Vergelijken en Wat ontbreekt) -----------
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
  updateUrl({
    land: LAST_COMPARE?.country?.iso3 || null,
    bronnen: cur === defaultSourceIds().join(',') ? null : cur,
    taal: COMPARE_LANG === 'nl' ? null : COMPARE_LANG,
  }, push);
}

/** Leest taal/bronnen uit de URL in de globale staat (vóór de UI-opbouw). */
function initFromUrl() {
  const sp = new URLSearchParams(location.search);
  const taal = sp.get('taal');
  if (['nl', 'en', 'orig'].includes(taal)) COMPARE_LANG = taal;
  const bronnen = sp.get('bronnen');
  if (bronnen != null) {
    const ids = bronnen.split(',').map((s) => s.trim()).filter((id) => allSourceIds().includes(id));
    if (ids.length) SELECTED_SOURCES = ids;
  }
}

/** Past tab + land uit de URL toe (ná de UI-opbouw); start zo nodig de vergelijking. */
function activateFromUrl() {
  const sp = new URLSearchParams(location.search);
  const tab = sp.get('tab');
  if (tab && $(`.tab[data-view="${tab}"]`)) activateTab(tab);
  // ?vs=A,B opent direct de twee-landen-vergelijking (feature 1).
  const vs = sp.get('vs');
  if (vs) {
    const [a, b] = vs.split(',').map((x) => resolveCountry(x.trim()));
    if (a && b) {
      $('#vs-field').hidden = false;
      $('#vs-toggle').textContent = '× Tweede land sluiten';
      $('#country-input').value = a.nl;
      $('#country-input-b').value = b.nl;
      runVersus(a, b, orderedSelected(), COMPARE_LANG);
      return;
    }
  }
  // ?briefing=watchlist opent de bundel-ochtendbriefing over de volglijst.
  if (sp.get('briefing') === 'watchlist') { openWatchlistBriefing(); return; }
  // ?briefing=ISO opent na het laden direct de briefing (punt 15).
  const briefing = sp.get('briefing');
  const land = briefing || sp.get('land');
  if (land) {
    const c = resolveCountry(land);
    if (c) {
      if (briefing) PENDING_BRIEFING = c.iso3;
      $('#country-input').value = c.nl;
      runComparison(c, orderedSelected(), COMPARE_LANG);
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
async function fetchForeign(iso, sources, translate = 'nl') {
  const proxy = getProxy();
  if (!proxy || !sources.length) return null;
  let url = `${proxy}/advisory/${iso}?sources=${sources.join(',')}`;
  if (translate) url += `&translate=${translate}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Proxy gaf ${r.status}`);
  return r.json();
}
async function translateText(q, to, from = 'auto') {
  const proxy = getProxy();
  if (!proxy) return q;
  try {
    const r = await fetch(`${proxy}/translate?to=${to}&from=${from}&q=${encodeURIComponent(q)}`);
    const d = await r.json();
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

/** Haalt (indien de proxy het levert) humanitaire context op en vult het slot. */
async function loadContext(iso3, slot) {
  const proxy = getProxy();
  if (!proxy) return;
  try {
    const r = await fetch(`${proxy}/context/${iso3}`);
    const d = await r.json();
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
  setupLangSeg();
  setupCountryCombo();

  if (meta?.builtAt) {
    $('#build-meta').textContent =
      `NL-data bijgewerkt op ${new Date(meta.builtAt).toLocaleString('nl-NL')} · ${meta.countries} landen · buitenlandse data live`;
  }
  if (!getProxy()) {
    $('#build-meta').textContent += ' · ⚠️ proxy niet ingesteld (klik ⚙)';
  }

  loadWatchlistFromUrl();
  // Await zodat deeplinks (?briefing=watchlist) de offline data al hebben.
  await Promise.all([buildChanges(), buildWorklist(), loadSeasons()]);
  updateWatchUI();
  activateFromUrl();
}

// Terug/vooruit in de browser: staat uit de URL opnieuw toepassen.
window.addEventListener('popstate', () => {
  initFromUrl();
  $$('#lang-seg button').forEach((b) => b.classList.toggle('on', b.dataset.lang === COMPARE_LANG));
  renderSourcePicker();
  const sp = new URLSearchParams(location.search);
  const tab = sp.get('tab') || 'compare';
  if ($(`.tab[data-view="${tab}"]`)) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === tab));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${tab}`));
  }
  const land = sp.get('land');
  const c = land ? resolveCountry(land) : null;
  if (c && LAST_COMPARE?.country?.iso3 !== c.iso3) {
    $('#country-input').value = c.nl;
    runComparison(c, orderedSelected(), COMPARE_LANG);
  }
});

// ==========================================================================
// Bronselectie-UI: chips (met vlag + ×) + "Bron toevoegen"-dropdown.
// Zelfde geselecteerde bronnen worden gebruikt door Vergelijken én Wat ontbreekt.
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
  renderSourcePicker();
}

function renderSourcePicker() {
  const chips = $('#source-chips');
  if (!chips) return;
  chips.innerHTML = '';
  const sel = orderedSelected();
  if (!sel.length) {
    chips.append(el('span', { class: 'hint', style: 'margin:0' }, 'Geen bronnen gekozen — voeg er minstens één toe.'));
  }
  sel.forEach((id) => {
    const m = sourceMeta(id);
    if (!m) return;
    const x = el('button', { type: 'button', class: 'chip-x', title: 'Verwijderen', 'aria-label': `${m.label} verwijderen` }, '×');
    x.addEventListener('click', () => removeSource(id));
    chips.append(el('span', { class: 'src-chip' }, el('span', { class: 'fl' }, m.flag || ''), ` ${m.label} `, x));
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
    const item = el('div', { class: 'menu-item', role: 'button', tabindex: '0' }, el('span', { class: 'fl' }, m.flag || ''), ` ${m.label}`);
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
  if (LAST_COMPARE) runComparison(LAST_COMPARE.country, orderedSelected(), COMPARE_LANG);
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

// ---- Volglijst (feature 2): persoonlijk, in localStorage; deelbaar via link/export ----
let WATCHLIST = new Set((() => { try { return JSON.parse(localStorage.getItem('watchlist')) || []; } catch { return []; } })());
const saveWatchlist = () => localStorage.setItem('watchlist', JSON.stringify([...WATCHLIST]));
const isWatched = (iso3) => WATCHLIST.has(iso3);
function toggleWatch(iso3) {
  if (WATCHLIST.has(iso3)) WATCHLIST.delete(iso3); else WATCHLIST.add(iso3);
  saveWatchlist();
  updateWatchUI();
}
/** Volglijst in config-onafhankelijke, gesorteerde vorm (op NL-naam). */
const watchlistItems = () => [...WATCHLIST]
  .map((iso3) => COUNTRIES.find((c) => c.iso3 === iso3)).filter(Boolean)
  .sort((a, b) => a.nl.localeCompare(b.nl, 'nl'));

/** Werkt alle zichtbare volglijst-affordances bij (oog-knop, balk, filters). */
function updateWatchUI() {
  const eye = $('#watch-btn');
  if (eye && LAST_COMPARE) {
    const on = isWatched(LAST_COMPARE.country.iso3);
    eye.classList.toggle('on', on);
    eye.textContent = on ? '👁 Op volglijst' : '👁 Volgen';
  }
  renderWatchBar();
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
  const render = () => {
    const q = input.value.trim();
    list.innerHTML = '';
    active = -1;
    let items;
    if (!q) {
      const recent = recentCountries().map((iso) => COUNTRIES.find((c) => c.iso3 === iso)).filter(Boolean);
      if (!recent.length) { close(); return; }
      list.append(el('li', { class: 'combo-group' }, 'Recent vergeleken'));
      items = recent.map((c) => ({ c }));
    } else {
      items = countrySuggestions(q);
      if (!items.length) { close(); return; }
    }
    items.forEach(({ c, why }, i) => {
      const li = el('li', {
        class: 'combo-item', role: 'option', id: `combo-opt-${i}`,
      }, el('span', { class: 'fl' }, countryFlag(c.iso2)), ` ${c.nl}`,
        why === 'lijkt op' ? el('span', { class: 'combo-why' }, 'bedoelde je?') : null);
      // mousedown i.p.v. click: gaat vóór de blur van het input-veld.
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(c); });
      li.dataset.iso3 = c.iso3;
      list.append(li);
    });
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
  const pick = (c) => {
    input.value = c.nl;
    close();
    $('#compare-form').requestSubmit();
  };

  input.addEventListener('input', render);
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

// ---- Taalkeuze (Nederlands · English · Origineel) -------------------------
function setupLangSeg() {
  const seg = $('#lang-seg');
  if (!seg) return;
  $$('#lang-seg button').forEach((b) => b.classList.toggle('on', b.dataset.lang === COMPARE_LANG));
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-lang]');
    if (!b) return;
    setCompareLang(b.dataset.lang);
  });
}
function setCompareLang(lang) {
  if (lang === COMPARE_LANG) return;
  const prev = COMPARE_LANG;
  COMPARE_LANG = lang;
  localStorage.setItem('compareLangV2', lang);
  $$('#lang-seg button').forEach((b) => b.classList.toggle('on', b.dataset.lang === lang));
  syncUrl();
  if (!LAST_COMPARE) return;
  // Alleen 'en' gebruikt een andere vertaalophaling; nl↔orig delen dezelfde data.
  if ((lang === 'en') !== (prev === 'en')) {
    runComparison(LAST_COMPARE.country, LAST_COMPARE.sources, lang);
  } else {
    LAST_COMPARE.lang = lang;
    renderComparison(LAST_COMPARE.staticData, LAST_COMPARE.foreign, $('#compare-result'));
  }
}

// ==========================================================================
// VERGELIJKEN
// ==========================================================================
// Tweede-land-invoer tonen/verbergen (feature 1: A ↔ B).
$('#vs-toggle').addEventListener('click', () => {
  const f = $('#vs-field');
  f.hidden = !f.hidden;
  $('#vs-toggle').textContent = f.hidden ? '⇄ Twee landen vergelijken' : '× Tweede land sluiten';
  if (f.hidden) $('#country-input-b').value = '';
  else $('#country-input-b').focus();
});

$('#compare-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#country-input').value.trim();
  const status = $('#compare-status'), result = $('#compare-result');
  if (!input) return;
  const country = resolveCountry(input);
  if (!country) { status.className = 'status error'; status.textContent = `Land “${input}” niet gevonden.`; result.innerHTML = ''; return; }
  // Tweede land ingevuld → A-vs-B-modus.
  const inputB = !$('#vs-field').hidden ? $('#country-input-b').value.trim() : '';
  if (inputB) {
    const countryB = resolveCountry(inputB);
    if (!countryB) { status.className = 'status error'; status.textContent = `Land “${inputB}” niet gevonden.`; result.innerHTML = ''; return; }
    if (countryB.iso3 === country.iso3) { status.className = 'status error'; status.textContent = 'Kies twee verschillende landen.'; return; }
    runVersus(country, countryB, orderedSelected(), COMPARE_LANG);
    return;
  }
  runComparison(country, orderedSelected(), COMPARE_LANG);
});

/** Haalt de statische NL-data + (live) buitenlandse bronnen voor één land op. */
async function fetchCountry(country, sources, lang) {
  const staticData = await loadJSON(`compare/${country.iso3}.json`);
  const foreign = { sources: [], notice: null };
  if (sources.length && getProxy()) {
    try {
      const res = await fetchForeign(country.iso3, sources, lang === 'en' ? 'en' : 'nl');
      foreign.sources = res?.sources || [];
    } catch (err) { foreign.notice = 'Kon de proxy niet bereiken: ' + err.message; }
  } else if (sources.length) {
    foreign.notice = 'Stel de proxy in (⚙ rechtsboven) om buitenlandse reisadviezen te vergelijken.';
  }
  return { staticData, foreign };
}

async function runComparison(country, sources, lang) {
  // Nieuwe (her)ophaling: een eventueel termfilter hoort bij het vorige land.
  if (!LAST_COMPARE || LAST_COMPARE.country?.iso3 !== country.iso3) MATRIX_FILTER = null;
  const status = $('#compare-status'), result = $('#compare-result');
  status.className = 'status';
  status.innerHTML = `<span class="spinner"></span>Reisadvies laden voor ${esc(country.nl)}…`;
  try {
    const { staticData, foreign } = await fetchCountry(country, sources, lang);
    status.textContent = '';
    LAST_COMPARE = { country, sources, lang, staticData, foreign };
    pushRecentCountry(country.iso3);
    // Ander land dan de URL nu toont = nieuwe history-entry (terug-knop
    // werkt); zelfde land (herladen/taalwissel/bron erbij) = vervangen.
    const urlLand = new URLSearchParams(location.search).get('land');
    syncUrl(urlLand !== country.iso3);
    renderComparison(staticData, foreign, result);
  } catch (err) {
    status.className = 'status error'; status.textContent = err.message;
  }
}

// ==========================================================================
// TWEE LANDEN VERGELIJKEN (feature 1): kleurcode per bron A ↔ B met verschil.
// ==========================================================================
async function runVersus(a, b, sources, lang) {
  const status = $('#compare-status'), result = $('#compare-result');
  status.className = 'status';
  status.innerHTML = `<span class="spinner"></span>${esc(a.nl)} ↔ ${esc(b.nl)} laden…`;
  try {
    const [da, db] = await Promise.all([fetchCountry(a, sources, lang), fetchCountry(b, sources, lang)]);
    status.textContent = '';
    updateUrl({ vs: `${a.iso3},${b.iso3}`, land: null }, true);
    renderVersus(a, b, da, db, result);
  } catch (err) {
    status.className = 'status error'; status.textContent = err.message;
  }
}

function renderVersus(a, b, da, db, root) {
  root.innerHTML = '';
  const frag = document.createDocumentFragment();
  const okA = new Map((da.foreign.sources || []).filter((s) => !s.unavailable && !s.error).map((s) => [s.source, s]));
  const okB = new Map((db.foreign.sources || []).filter((s) => !s.unavailable && !s.error).map((s) => [s.source, s]));
  const fa = countryFlagByIso3(a.iso3), fb = countryFlagByIso3(b.iso3);

  frag.append(el('div', { class: 'result-head' },
    el('div', { class: 'result-head-main' },
      el('h2', {}, `${fa ? fa + ' ' : ''}${a.nl}  ↔  ${fb ? fb + ' ' : ''}${b.nl}`),
      el('p', { class: 'meta' }, 'Welk land beoordeelt elke bron als veiliger? Lager niveau = veiliger.'))));

  // Verdict op basis van bronnen die beide landen beoordelen.
  let aSafer = 0, bSafer = 0, equal = 0;
  const rows = [];
  // NL-rij.
  const nlA = COLOR_LEVEL[da.staticData.nl.colors?.overall], nlB = COLOR_LEVEL[db.staticData.nl.colors?.overall];
  rows.push({ label: '🇳🇱 NederlandWereldwijd', ca: da.staticData.nl.colors?.overall, cb: db.staticData.nl.colors?.overall, la: nlA, lb: nlB });
  (CFG.SOURCES || []).forEach((meta) => {
    const sa = okA.get(meta.id), sb = okB.get(meta.id);
    if (!sa && !sb) return;
    rows.push({ label: `${meta.flag || ''} ${meta.label}`, ca: sa?.color, cb: sb?.color, la: sa?.level, lb: sb?.level, ua: sa?.assessmentStatus === 'uncertain', ub: sb?.assessmentStatus === 'uncertain' });
  });
  rows.forEach((r) => {
    if (r.la != null && r.lb != null) { if (r.la < r.lb) aSafer++; else if (r.lb < r.la) bSafer++; else equal++; }
  });

  const beoordeeld = aSafer + bSafer + equal;
  const winner = aSafer > bSafer ? a : bSafer > aSafer ? b : null;
  const verdict = el('div', { class: 'divergence ' + (aSafer && bSafer ? 'some' : 'none') });
  verdict.append(el('h3', {}, winner
    ? `➡️ Volgens ${Math.max(aSafer, bSafer)} van ${beoordeeld} beoordelende bron${beoordeeld === 1 ? '' : 'nen'} is ${winner === a ? a.nl : b.nl} veiliger`
    : !beoordeeld ? 'Geen enkele bron beoordeelt beide landen'
    : (aSafer === 0 && bSafer === 0) ? 'Beide landen krijgen dezelfde kleurcode van elke beoordelende bron'
    : 'De bronnen zijn verdeeld over welk land veiliger is'));
  verdict.append(el('p', { class: 'consensus-line' },
    `${fa} ${a.nl} veiliger: ${aSafer} · ${fb} ${b.nl} veiliger: ${bSafer} · gelijk: ${equal}`));
  frag.append(verdict);

  // Kleurcode-tabel A ↔ B per bron.
  const table = el('table', { class: 'summary-table' });
  table.append(el('thead', {}, el('tr', {},
    el('th', {}, 'Bron'), el('th', {}, `${fa} ${a.nl}`), el('th', {}, `${fb} ${b.nl}`), el('th', {}, 'Veiliger'))));
  const tbody = el('tbody');
  rows.forEach((r) => {
    let cmp;
    if (r.la == null || r.lb == null) cmp = el('span', { class: 'muted' }, '—');
    else if (r.la < r.lb) cmp = el('span', { class: 'delta looser' }, `${fa} ${a.nl}`);
    else if (r.lb < r.la) cmp = el('span', { class: 'delta looser' }, `${fb} ${b.nl}`);
    else cmp = el('span', { class: 'delta same' }, 'gelijk');
    tbody.append(el('tr', {},
      el('td', {}, r.label),
      el('td', {}, r.ua ? colorCode({ uncertain: true }) : colorCode({ predominant: r.ca })),
      el('td', {}, r.ub ? colorCode({ uncertain: true }) : colorCode({ predominant: r.cb })),
      el('td', {}, cmp)));
  });
  table.append(tbody);
  frag.append(el('h3', { class: 'section-title' }, 'Kleurcode per bron'), table);
  frag.append(el('p', { class: 'hint' }, 'Buitenlandse kleurcodes zijn een benadering op de Nederlandse schaal. Bronnen die maar één van beide landen beoordelen, tellen niet mee in het oordeel.'));

  const openSingle = (c) => {
    if (!$('#vs-field').hidden) $('#vs-toggle').click(); // verbergt B + wist het veld
    $('#country-input').value = c.nl;
    $('#compare-form').requestSubmit();
  };
  const oa = el('button', { class: 'btn', type: 'button' }, `Volledige vergelijking ${a.nl} →`);
  oa.addEventListener('click', () => openSingle(a));
  const ob = el('button', { class: 'btn', type: 'button' }, `Volledige vergelijking ${b.nl} →`);
  ob.addEventListener('click', () => openSingle(b));
  frag.append(el('div', { class: 'briefing-actions' }, oa, ob));

  root.append(frag);
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

  const themes = [], missingFromNl = [], onlyNl = [];
  for (const id of ordered) {
    const meta = id === '_other' ? { id, label: 'Overige / niet ingedeeld', group: 'Overig' } : THEME_BY_ID.get(id);
    const nlBlocks = nlIdx.get(id) || [];
    const foreign = {};
    let foreignHasIt = false;
    for (const f of forIdx) {
      const blocks = f.idx.get(id) || [];
      foreign[f.source] = { label: f.label, flag: f.flag, url: f.url, blocks };
      if (blocks.length) foreignHasIt = true;
    }
    themes.push({ theme: meta, nl: nlBlocks, foreign, nlHasIt: nlBlocks.length > 0, foreignHasIt });
    if (id !== '_other' && nlBlocks.length === 0 && foreignHasIt) missingFromNl.push({ theme: meta, foreign });
    if (id !== '_other' && nlBlocks.length > 0 && !foreignHasIt && forIdx.length) onlyNl.push({ theme: meta, nl: nlBlocks });
  }
  return { themes, missingFromNl, onlyNl };
}

const colorSquare = (color, cls = '') => el('span', { class: `sq c-${color || 'none'}${cls ? ' ' + cls : ''}` });

/** Inline gekleurde pil (bijv. voor de internationale-consensusregel). */
function colorBadge(color, opts = {}) {
  const { uncertain, explanation } = opts;
  if (uncertain) {
    return el('span', {
      class: 'color-badge c-uncertain',
      title: explanation || 'Niveau kon niet betrouwbaar worden vastgesteld — geen gok gedaan.',
    }, colorSquare('onzeker'), 'Onzeker');
  }
  if (!color) return el('span', { class: 'empty-col' }, 'geen kleurcode');
  return el('span', { class: `color-badge c-${color}` }, colorSquare(color), COLOR_LABELS[color] || color);
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
function colorCode({ predominant, uncertain, explanation, extras = [] }) {
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
  explanation: s.levelLabel,
  extras: regionalExtraColors(s),
});

/** Tekstversie van een kleurcode, voor export naar klembord/CSV. */
function colorTextFor(color, extras = [], uncertain = false) {
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
    colorTextFor(s.color, regionalExtraColors(s), s.assessmentStatus === 'uncertain') + ' (benadering)',
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
function renderSummaryTable(nl, okSources) {
  const table = el('table', { class: 'summary-table' });
  const COLS = 6;
  const thead = el('thead', {}, el('tr', {},
    el('th', {}, 'Bron'), el('th', {}, 'Kleurcode'), el('th', {}, 'Regionaal'), el('th', {}, 'Origineel niveau'),
    el('th', {}, 'Bijgewerkt'), el('th', {}, '')));
  table.append(thead);
  const tbody = el('tbody');

  const fmtDateShort = (s) => {
    if (!s) return '—';
    const d = new Date(s);
    return isNaN(d) ? String(s).slice(0, 10) : d.toLocaleDateString('nl-NL');
  };

  tbody.append(el('tr', {},
    el('td', {}, '🇳🇱 NederlandWereldwijd'),
    el('td', {}, colorCode({ predominant: nl.colors?.overall, extras: nlExtraColors(nl) })),
    el('td', { class: 'muted' }, '—'),
    el('td', { class: 'muted' }, '—'),
    el('td', { class: 'muted' }, nl.modificationDate ? nl.modificationDate.split('|')[0].replace('Laatst gewijzigd op:', '').trim() : fmtDateShort(nl.lastModified)),
    el('td', {}, el('a', { href: nl.url, target: '_blank', rel: 'noopener' }, 'origineel →'))));

  okSources.forEach((s) => {
    const rColor = ['', 'groen', 'geel', 'oranje', 'rood'][s.regionalMaxLevel] || null;
    const count = s.regionalBreakdown?.length || 0;

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
        el('td', { class: 'muted' }, fmtDateShort(s.lastModified)),
        el('td', {}, el('a', { href: s.url, target: '_blank', rel: 'noopener' }, 'origineel →'))));
      tbody.append(detailRow);
    } else {
      tbody.append(el('tr', {},
        el('td', {}, `${s.flag || ''} ${s.sourceLabel}`),
        el('td', {}, sourceColorCode(s),
          ' ', el('span', { class: 'approx-tag', title: 'Vertaald naar de Nederlandse kleurenschaal' }, 'benadering')),
        el('td', { class: 'muted' }, '—'),
        el('td', { class: 'muted' }, s.levelLabel || '—'),
        el('td', { class: 'muted' }, fmtDateShort(s.lastModified)),
        el('td', {}, el('a', { href: s.url, target: '_blank', rel: 'noopener' }, 'origineel →'))));
    }
  });
  table.append(tbody);
  return table;
}

/**
 * Onderwerp-zoeker binnen één vergelijking: typ een term (bijv. "ebola") en
 * zie per bron — NL én alle buitenlandse — de passages waarin die voorkomt.
 * Bronnen die het onderwerp NIET noemen krijgen expliciet een kaart: juist
 * die afwezigheid is redactioneel interessant. Nederlandse termen worden
 * automatisch ook in het Engels/Frans/Spaans gezocht (via het bestaande
 * vertaal-endpoint); alle bronteksten zijn al binnen, dus het zoeken zelf
 * kost geen extra proxy-aanroepen.
 */
/**
 * Text-Fragment-deeplink: opent de bronpagina met de passage geel gemarkeerd
 * (URL-fragment #:~:text=, ondersteund door Edge/Chrome). Het fragment moet
 * letterlijk op de pagina staan — daarom nemen we ±6 woorden uit de
 * ORIGINELE (onvertaalde) tekst, beginnend bij het gevonden zoekwoord.
 */
function fragmentUrl(baseUrl, text, term) {
  if (!baseUrl || !text || !term) return null;
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return null;
  let start = idx;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  const words = text.slice(start).split(/\s+/).slice(0, 6).join(' ')
    .replace(/[)\]}"'.,;:!?]+$/, '');
  if (words.length < 4) return null;
  // '-' heeft binnen text-directives een eigen betekenis: extra escapen.
  const enc = encodeURIComponent(words).replace(/-/g, '%2D');
  return `${baseUrl.split('#')[0]}#:~:text=${enc}`;
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
          // #:~:text=-fragment moet letterlijk op de bronpagina staan.
          let frag = null;
          if (b.text) {
            const low = b.text.toLowerCase();
            const ov = variantList.find((vv) => low.includes(vv));
            if (ov) frag = { text: b.text, term: ov };
          }
          matches.push({ heading: hit.heading, html: highlight(snippetAround(hit.text, hit.variant), hit.variant), frag });
        }
      }
      return matches;
    };

    const cards = el('div', { class: 'topic-cards' });
    const renderCard = (label, url, matches) => {
      const card = el('div', { class: 'topic-card' + (matches.length ? '' : ' no-mention') });
      card.append(el('h4', {}, label, ' ',
        matches.length
          ? el('span', { class: 'count-pill' }, String(matches.length))
          : el('span', { class: 'no-mention-tag' }, `noemt "${terms.join(', ')}" niet`)));
      matches.slice(0, 5).forEach((m) => {
        const fragHref = m.frag ? fragmentUrl(url, m.frag.text, m.frag.term) : null;
        card.append(el('div', { class: 'topic-match' },
          el('div', { class: 'block-cat' }, m.heading || '',
            fragHref ? el('a', {
              href: fragHref, target: '_blank', rel: 'noopener', class: 'frag-link',
              title: 'Opent de bronpagina met deze passage geel gemarkeerd (Edge/Chrome). Staat de passage op een subpagina, dan opent de hoofdpagina zonder markering.',
            }, '🔗 toon op bronpagina') : null),
          el('p', { class: 'snippet', html: m.html })));
      });
      if (matches.length > 5) card.append(el('p', { class: 'hint', style: 'margin:4px 0 0' }, `+ ${matches.length - 5} meer passage(s) — zie het origineel.`));
      if (url) card.append(el('p', { style: 'margin:6px 0 0' }, el('a', { href: url, target: '_blank', rel: 'noopener' }, 'origineel →')));
      cards.append(card);
    };

    renderCard('🇳🇱 NederlandWereldwijd', nl.url, findMatches(nl.themes));
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
    renderComparison(LAST_COMPARE.staticData, LAST_COMPARE.foreign, $('#compare-result'));
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
  const watchOn = isWatched(staticData.country.iso3);
  const watchBtn = el('button', { type: 'button', id: 'watch-btn', class: 'btn watch-btn' + (watchOn ? ' on' : ''), title: 'Zet dit land op je persoonlijke volglijst (blijft in deze browser bewaard).' }, watchOn ? '👁 Op volglijst' : '👁 Volgen');
  watchBtn.addEventListener('click', () => toggleWatch(staticData.country.iso3));
  frag.append(el('div', { class: 'result-head' },
    el('div', { class: 'result-head-main' },
      el('h2', {}, cflag ? `${cflag} ${staticData.country.nl}` : staticData.country.nl),
      el('p', { class: 'meta' }, nl.modificationDate || `Laatst gewijzigd: ${(nl.lastModified || '').slice(0, 10)}`)),
    el('div', { class: 'result-head-actions' }, watchBtn, briefingBtn)));

  // ---- Divergentie-highlight ----
  const nlColor = nl.colors?.overall || null;
  const chips = [{ label: '🇳🇱 NederlandWereldwijd', color: nlColor, level: COLOR_LEVEL[nlColor] || null }];
  okSources.forEach((s) => chips.push({ label: `${s.flag || ''} ${s.sourceLabel}`, color: s.color, level: s.level, url: s.url }));
  const levels = chips.map((c) => c.level).filter((l) => l != null);
  const distinctColors = new Set(chips.map((c) => c.color).filter(Boolean));
  const spread = levels.length ? Math.max(...levels) - Math.min(...levels) : 0;

  const divWrap = el('div', { class: 'divergence ' + (spread >= 2 ? 'high' : distinctColors.size > 1 ? 'some' : 'none') });
  divWrap.append(el('h3', {}, spread >= 2 ? '⚠️ Landen verschillen sterk in kleurcode'
    : distinctColors.size > 1 ? 'Landen verschillen licht in kleurcode' : 'Landen zijn het eens over de kleurcode'));

  // ---- Internationale consensus (mediaan van de betrouwbaar beoordeelde
  // buitenlandse bronnen, NL zelf telt hier niet mee) ----
  const consensusLevels = okSources
    .filter((s) => s.level != null && s.assessmentStatus !== 'uncertain')
    .map((s) => s.level)
    .sort((a, b) => a - b);
  if (consensusLevels.length) {
    const mid = Math.floor(consensusLevels.length / 2);
    const consensusLevel = consensusLevels.length % 2
      ? consensusLevels[mid]
      : Math.round((consensusLevels[mid - 1] + consensusLevels[mid]) / 2);
    const consensusColor = LEVEL_COLORS[consensusLevel];
    divWrap.append(el('p', { class: 'consensus-line' },
      '🌍 Internationale consensus: ',
      colorBadge(consensusColor),
      ` (mediaan van ${consensusLevels.length} bron${consensusLevels.length === 1 ? '' : 'nen'}, NL niet meegeteld)`));
  }

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

  // ---- Samenvattingstabel (kleurcode + niveau + datum + link per bron) ----
  const copyBtn = el('button', { class: 'btn', type: 'button', title: 'Kopieert de kleurcode-tabel als opgemaakte tabel — plakt netjes in Word/Outlook.' }, '📋 Kopieer als tabel');
  copyBtn.addEventListener('click', () => copySummaryTable(staticData, nl, okSources, copyBtn));
  const printBtn = el('button', {
    class: 'btn', type: 'button', onclick: () => window.print(),
    title: 'Print of bewaar als PDF: een compacte samenvatting (kleurcodes + afwijkingen, zonder de matrix).',
  }, '🖨 Print / PDF');
  frag.append(el('div', { class: 'theme-head-row' },
    el('h3', { class: 'section-title', style: 'flex:1;margin:0;border:none' }, 'Kleurcodes op een rij'),
    copyBtn, printBtn));
  frag.append(el('p', { class: 'print-note' },
    `Reisadviezen-buddy · afgedrukt op ${new Date().toLocaleString('nl-NL')} · ${location.href}`));
  frag.append(renderSummaryTable(nl, okSources));
  if (nl.colors?.colors?.length > 1) {
    const ul = el('ul', { class: 'color-contexts' });
    nl.colors.colors.forEach((c) => ul.append(el('li', {}, el('strong', {}, `${COLOR_LABELS[c.color]}: `), c.context)));
    frag.append(el('div', { class: 'panel', style: 'padding:12px 16px;margin-bottom:22px' },
      el('div', { class: 'block-cat', style: 'margin-bottom:4px' }, '🇳🇱 Kleurcode geldt per regio:'), ul));
  }

  // ---- Notices ----
  if (foreign.notice) frag.append(el('div', { class: 'callout', style: 'background:#eef4fb;border-left-color:var(--nl-blue)' },
    el('p', { style: 'margin:0' }, foreign.notice)));
  if (problems.length) frag.append(el('div', { class: 'callout', style: 'background:#f6f8fa;border-left-color:var(--muted)' },
    el('p', { style: 'margin:0' }, 'Geen advies via: ' + problems.map((p) => p.label || p.source).join(', ') + '.')));

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
        renderComparison(LAST_COMPARE.staticData, LAST_COMPARE.foreign, $('#compare-result'));
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

  // ---- Vergelijking per thema ----
  const cmp = buildComparison(nl, okSources);
  if (cmp.missingFromNl.length) {
    const gapBtn = el('button', { class: 'btn primary', type: 'button', onclick: () => {
      activateTab('gaps'); activateGapMode('single');
      $('#gap-country-input').value = staticData.country.nl;
      renderGapSingle(staticData.country, nl, okSources, $('#gap-single-result'));
      $('#gap-single-status').textContent = '';
    } }, 'Bekijk volledig overzicht →');
    frag.append(el('div', { class: 'callout' },
      el('h3', {}, `💡 ${cmp.missingFromNl.length} thema${cmp.missingFromNl.length === 1 ? '' : "'s"} die andere landen wél noemen en NederlandWereldwijd niet`),
      el('p', { style: 'margin:0 0 10px' }, cmp.missingFromNl.slice(0, 4).map((m) => m.theme.label).join(', ') + (cmp.missingFromNl.length > 4 ? ', …' : '')),
      gapBtn));
  }

  const densitySeg = el('span', { class: 'seg', role: 'group', 'aria-label': 'Matrix-weergave' });
  [['compact', 'Compact'], ['volledig', 'Volledig']].forEach(([val, label]) => {
    const b = el('button', { type: 'button', class: MATRIX_DENSITY === val ? 'on' : '' }, label);
    b.addEventListener('click', () => {
      if (MATRIX_DENSITY === val) return;
      MATRIX_DENSITY = val;
      localStorage.setItem('matrixDensity', val);
      if (LAST_COMPARE) renderComparison(LAST_COMPARE.staticData, LAST_COMPARE.foreign, $('#compare-result'));
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
    const chip = el('button', { type: 'button', class: 'theme-chip' + (on ? ' on' : ''), 'aria-pressed': String(on) }, t.theme.label);
    chip.addEventListener('click', () => {
      if (HIDDEN_THEMES.has(t.theme.id)) HIDDEN_THEMES.delete(t.theme.id); else HIDDEN_THEMES.add(t.theme.id);
      saveHiddenThemes();
      renderComparison(LAST_COMPARE.staticData, LAST_COMPARE.foreign, $('#compare-result'));
    });
    themeChips.append(chip);
  });
  if (themeIds.some((id) => HIDDEN_THEMES.has(id))) {
    const reset = el('button', { type: 'button', class: 'btn-link', style: 'margin-left:4px' }, 'alle tonen');
    reset.addEventListener('click', () => {
      themeIds.forEach((id) => HIDDEN_THEMES.delete(id));
      saveHiddenThemes();
      renderComparison(LAST_COMPARE.staticData, LAST_COMPARE.foreign, $('#compare-result'));
    });
    themeChips.append(reset);
  }
  frag.append(themeChips);

  // Termfilter actief (via een gazetteer-chip): toon een wisbalk.
  if (MATRIX_FILTER) {
    const clear = el('button', { type: 'button', class: 'btn-link' }, '× filter wissen');
    clear.addEventListener('click', () => {
      MATRIX_FILTER = null;
      renderComparison(LAST_COMPARE.staticData, LAST_COMPARE.foreign, $('#compare-result'));
    });
    frag.append(el('div', { class: 'matrix-filter-bar' },
      el('span', {}, '🔎 Matrix gefilterd op term: ', el('strong', {}, MATRIX_FILTER.label),
        ' — alleen passages die dit noemen worden getoond.'),
      clear));
  }

  frag.append(renderMatrix(cmp, nl, okSources));
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

/** Voegt per daadwerkelijk afgekapte matrixcel een uitklap-knop toe. */
function initMatrixClamp(root) {
  root.querySelectorAll('.matrix .cell.txt:not(.empty)').forEach((cell) => {
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
function renderMatrix(cmp, nl, okSources) {
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
    grid.append(el('div', { class: 'cell rowlabel' }, t.theme.label));
    grid.append(cellFor(nlBlocks, false, anyContent, re));
    fBlocks.forEach((b) => grid.append(cellFor(b, true, anyContent, re)));
    grid.append(el('div', { class: 'cell addcol' }));
  });

  return el('div', { class: 'matrix' }, grid);
}

/** Eén matrix-cel: thema-blokken of een (eventueel gemarkeerde) leegte. */
function cellFor(blocks, foreign, anyContent, mark) {
  if (blocks && blocks.length) {
    // 'plain': altijd platte tekst → één uniform lettertype in alle cellen.
    // Compact: volledige tekst renderen maar visueel afkappen (cellclamp);
    // de per-blok "Lees volledige tekst"-knoppen zouden daar dubbelop zijn.
    if (MATRIX_DENSITY === 'compact') {
      return el('div', { class: 'cell txt' },
        el('div', { class: 'cellclamp' }, renderBlocks(blocks, foreign, { full: true, plain: true, mark })));
    }
    return el('div', { class: 'cell txt' }, renderBlocks(blocks, foreign, { plain: true, mark }));
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
  const { full = false, plain = false, mark = null } = opts;
  if (!blocks || !blocks.length) return null;
  // Bij een actief termfilter tonen we de volledige (gemarkeerde) tekst, niet
  // een afgekapt fragment — anders valt de treffer soms buiten beeld.
  const noTrunc = full || !!mark;
  const wrap = el('div');
  blocks.forEach((b) => {
    // Vertaalde weergave (NL of EN) tenzij de taalkeuze op 'Origineel' staat.
    const useTranslated = foreign && COMPARE_LANG !== 'orig' && (b.textNl || b.headingNl);
    const heading = useTranslated && b.headingNl ? b.headingNl : b.heading;
    const fullText = useTranslated && b.textNl ? b.textNl : (b.text || '');
    // In 'plain'-modus (matrix) nooit de rijke bron-HTML injecteren: platte,
    // ge-escapete tekst geeft één uniform lettertype in alle cellen.
    const fullHtml = plain ? null : (useTranslated && b.textNl ? null : (b.html || null));

    const blockEl = el('div', { class: 'block' },
      heading ? el('div', { class: 'block-heading' }, heading) : null,
      b.category && b.category !== heading ? el('div', { class: 'block-cat' }, b.category) : null);

    if (!noTrunc && fullText.length > SNIPPET_MAXLEN) {
      let expanded = false;
      const shortNode = el('div', { class: 'rich' }, fullText.slice(0, SNIPPET_MAXLEN).trim() + '…');
      const fullNode = el('div', { class: 'rich', html: fullHtml || markText(fullText, mark) });
      fullNode.hidden = true;
      const toggle = el('button', { class: 'btn-link', type: 'button' }, `Lees volledige tekst (${fullText.length} tekens) →`);
      toggle.addEventListener('click', () => {
        expanded = !expanded;
        shortNode.hidden = expanded;
        fullNode.hidden = !expanded;
        toggle.textContent = expanded ? '▲ Inklappen' : `Lees volledige tekst (${fullText.length} tekens) →`;
      });
      blockEl.append(shortNode, fullNode, toggle);
    } else {
      blockEl.append(el('div', { class: 'rich', html: fullHtml || markText(fullText, mark) }));
    }
    wrap.append(blockEl);
  });
  return wrap;
}

// ==========================================================================
// WAT ONTBREEKT — gap-analyse: losstaand van "Vergelijken" (dat de volledige
// brontekst per thema naast elkaar toont), focust dit uitsluitend op de
// thema's die andere landen wél behandelen en NederlandWereldwijd niet — en
// omgekeerd. Gebruikt dezelfde regelgebaseerde vergelijking (buildComparison),
// geen AI: puur aggregatie over reeds opgehaalde data.
// ==========================================================================
function activateGapMode(mode) {
  $$('.subtab').forEach((t) => t.classList.toggle('active', t.dataset.gapmode === mode));
  $('#gap-single').classList.toggle('active', mode === 'single');
  $('#gap-multi').classList.toggle('active', mode === 'multi');
}
$$('.subtab').forEach((t) => t.addEventListener('click', () => activateGapMode(t.dataset.gapmode)));

function selectedSources() {
  return orderedSelected();
}

function renderGapSingle(country, nl, okSources, root) {
  root.innerHTML = '';
  const frag = document.createDocumentFragment();
  const cmp = buildComparison(nl, okSources);
  const totalThemes = cmp.themes.filter((t) => t.theme.id !== '_other').length;

  frag.append(el('div', { class: 'result-head' },
    el('h2', {}, country.nl || country),
    el('p', { class: 'meta' },
      `${cmp.missingFromNl.length} van ${totalThemes} thema's ontbreken bij NederlandWereldwijd, vergeleken met ${okSources.length} bron${okSources.length === 1 ? '' : 'nen'}.`)));

  if (!cmp.missingFromNl.length) {
    frag.append(el('div', { class: 'callout', style: 'background:#eaf4ea;border-left-color:var(--groen)' },
      el('p', { style: 'margin:0' }, '✅ Geen ontbrekende thema’s gevonden bij de gekozen bronnen.')));
  } else {
    let lastGroup = null;
    cmp.missingFromNl.forEach((m) => {
      const g = m.theme.group || 'Overig';
      if (g !== lastGroup) { frag.append(el('div', { class: 'theme-group-label' }, g)); lastGroup = g; }
      const details = el('details', { class: 'panel theme-card', open: 'open' });
      details.append(el('summary', {}, m.theme.label, el('span', { class: 'badge foreign-only' }, 'ontbreekt bij NL')));
      const body = el('div', { class: 'gap-body' });
      Object.values(m.foreign).filter((v) => v.blocks?.length).forEach((v) => {
        body.append(el('div', { class: 'block' },
          el('div', { class: 'block-heading' }, `${v.flag || ''} ${v.label}`),
          renderBlocks(v.blocks, true),
          v.url ? el('div', { class: 'color-note' }, el('a', { href: v.url, target: '_blank', rel: 'noopener' }, 'Bekijk bron →')) : null));
      });
      details.append(body);
      frag.append(details);
    });
  }

  if (cmp.onlyNl.length) {
    const det = el('details', { class: 'panel theme-card' });
    det.append(el('summary', {}, `Andersom: ${cmp.onlyNl.length} thema${cmp.onlyNl.length === 1 ? '' : "'s"} die alleen NederlandWereldwijd behandelt`));
    const body = el('div', { class: 'gap-body' });
    cmp.onlyNl.forEach((o) => body.append(el('div', { class: 'block' }, el('div', { class: 'block-heading' }, o.theme.label), renderBlocks(o.nl))));
    det.append(body);
    frag.append(det);
  }
  root.append(frag);
}

$('#gap-single-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#gap-country-input').value.trim();
  const status = $('#gap-single-status'), result = $('#gap-single-result');
  if (!input) return;
  const country = resolveCountry(input);
  if (!country) { status.className = 'status error'; status.textContent = `Land “${input}” niet gevonden.`; result.innerHTML = ''; return; }
  const selected = selectedSources();
  if (!selected.length) { status.className = 'status error'; status.textContent = 'Kies minstens één bron bij "Vergelijken".'; result.innerHTML = ''; return; }
  if (!getProxy()) { status.className = 'status error'; status.textContent = 'Stel de proxy in (⚙) om buitenlandse bronnen te vergelijken.'; result.innerHTML = ''; return; }

  status.className = 'status'; status.innerHTML = `<span class="spinner"></span>Analyseren voor ${esc(country.nl)}…`; result.innerHTML = '';
  try {
    const [staticData, res] = await Promise.all([
      loadJSON(`compare/${country.iso3}.json`),
      fetchForeign(country.iso3, selected),
    ]);
    const okSources = (res?.sources || []).filter((s) => !s.unavailable && !s.error && s.themes);
    status.textContent = '';
    renderGapSingle(country, staticData.nl, okSources, result);
  } catch (err) { status.className = 'status error'; status.textContent = err.message; }
});

// ---- Meerdere landen (trends) ----
let GAP_MULTI = [];
function renderGapMultiChips() {
  const wrap = $('#gap-multi-chips');
  wrap.innerHTML = '';
  GAP_MULTI.forEach((c) => {
    const rm = el('button', { type: 'button', class: 'chip-remove' }, '×');
    rm.addEventListener('click', () => { GAP_MULTI = GAP_MULTI.filter((x) => x.iso3 !== c.iso3); renderGapMultiChips(); });
    wrap.append(el('span', { class: 'chip' }, c.nl, rm));
  });
}
$('#gap-multi-add').addEventListener('click', () => {
  const input = $('#gap-multi-input');
  const country = resolveCountry(input.value.trim());
  if (!country || GAP_MULTI.find((c) => c.iso3 === country.iso3)) { input.value = ''; return; }
  GAP_MULTI.push(country);
  input.value = '';
  renderGapMultiChips();
});

$('#gap-multi-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('#gap-multi-status'), result = $('#gap-multi-result');
  if (GAP_MULTI.length < 2) { status.className = 'status error'; status.textContent = 'Voeg minstens 2 landen toe.'; result.innerHTML = ''; return; }
  const selected = selectedSources();
  if (!selected.length) { status.className = 'status error'; status.textContent = 'Kies minstens één bron bij "Vergelijken".'; return; }
  if (!getProxy()) { status.className = 'status error'; status.textContent = 'Stel de proxy in (⚙).'; return; }

  status.className = 'status'; result.innerHTML = '';
  const themeCounts = new Map();
  let done = 0;
  for (const country of GAP_MULTI) {
    status.innerHTML = `<span class="spinner"></span>Analyseren… (${done + 1}/${GAP_MULTI.length}: ${esc(country.nl)})`;
    try {
      const [staticData, res] = await Promise.all([
        loadJSON(`compare/${country.iso3}.json`),
        fetchForeign(country.iso3, selected),
      ]);
      const okSources = (res?.sources || []).filter((s) => !s.unavailable && !s.error && s.themes);
      const cmp = buildComparison(staticData.nl, okSources);
      cmp.missingFromNl.forEach((m) => {
        if (!themeCounts.has(m.theme.id)) themeCounts.set(m.theme.id, { theme: m.theme, count: 0, countries: [] });
        const entry = themeCounts.get(m.theme.id);
        entry.count++;
        entry.countries.push(country.nl);
      });
    } catch { /* land overslaan bij fout, doorgaan met de rest */ }
    done++;
  }
  status.textContent = `Klaar: ${done} van ${GAP_MULTI.length} landen geanalyseerd.`;
  renderGapMultiResult([...themeCounts.values()].sort((a, b) => b.count - a.count), done, result);
});

function renderGapMultiResult(rows, total, root) {
  root.innerHTML = '';
  if (!rows.length) { root.append(el('p', { class: 'empty-col' }, 'Geen structurele hiaten gevonden in de gekozen landen.')); return; }
  const table = el('table', { class: 'summary-table' });
  table.append(el('thead', {}, el('tr', {}, el('th', {}, 'Thema'), el('th', {}, 'Ontbreekt bij NL in'), el('th', {}, 'Voorbeeldlanden'))));
  const tbody = el('tbody');
  rows.forEach((r) => {
    const pct = Math.round((r.count / total) * 100);
    tbody.append(el('tr', {},
      el('td', {}, r.theme.label),
      el('td', {}, el('div', { class: 'gap-bar-wrap' }, el('div', { class: 'gap-bar', style: `width:${pct}%` }), el('span', {}, `${r.count}/${total} (${pct}%)`))),
      el('td', { class: 'muted' }, r.countries.slice(0, 5).join(', ') + (r.countries.length > 5 ? ', …' : ''))));
  });
  table.append(tbody);
  root.append(table);
}

// ==========================================================================
// WERKLIJST — divergentie tussen NL en de internationale consensus, uit de
// dagelijkse snapshot (docs/data/divergence.json, gegenereerd door de build).
// ==========================================================================
let WORKLIST = null;
let AGES = null;
let WORKLIST_MODE = 'divergentie';

const INTRO = {
  divergentie: 'Waar wijkt het <strong>Nederlandse</strong> reisadvies af van de <strong>internationale consensus</strong> (mediaan van de buitenlandse bronnen, laatste snapshot)? Gesorteerd op grootte van de afwijking. Alleen landen met minstens 3 betrouwbaar beoordeelde bronnen tellen mee; een afwijking is niet per se fout, maar wel het bekijken waard.',
  actualiteit: 'Hoe <strong>actueel</strong> is elk Nederlands reisadvies vergeleken met de buitenlandse bronnen? Gesorteerd op achterstand: bovenaan de landen waar buitenlandse bronnen ná NederlandWereldwijd zijn bijgewerkt — kandidaten voor herbeoordeling.',
};

const countryRegion = (iso3) => COUNTRIES.find((c) => c.iso3 === iso3)?.region || null;

async function buildWorklist() {
  const status = $('#worklist-status');
  try {
    WORKLIST = await loadJSON('divergence.json');
  } catch {
    WORKLIST = null;
  }
  try { AGES = await loadJSON('advisory-ages.json'); } catch { AGES = null; }
  if (!WORKLIST && !AGES) {
    status.textContent = 'Nog geen gegevens — deze verschijnen na de eerstvolgende dagelijkse snapshot + site-build.';
    return;
  }

  // Regio-dropdown vullen (punt 13).
  const regions = [...new Set(COUNTRIES.map((c) => c.region).filter(Boolean))].sort();
  const regionSel = $('#worklist-region');
  regions.forEach((r) => regionSel.append(el('option', { value: r }, r)));

  $('#worklist-filter').addEventListener('change', renderWorklistView);
  $('#worklist-watch').addEventListener('change', renderWorklistView);
  regionSel.addEventListener('change', renderWorklistView);
  renderWatchBar();
  $('#worklist-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b || b.dataset.mode === WORKLIST_MODE) return;
    WORKLIST_MODE = b.dataset.mode;
    $$('#worklist-mode button').forEach((x) => x.classList.toggle('on', x.dataset.mode === WORKLIST_MODE));
    $('#worklist-intro').innerHTML = INTRO[WORKLIST_MODE];
    $('#worklist-filter-wrap').hidden = WORKLIST_MODE !== 'divergentie';
    renderWorklistView();
  });
  renderWorklistView();
}

function renderWorklistView() {
  if (WORKLIST_MODE === 'actualiteit') renderAges();
  else renderWorklist();
}

/** Vorige werklijst-stand van deze gebruiker (voor "NIEUW sinds je vorige bezoek"). */
function worklistSeen() {
  try { return JSON.parse(localStorage.getItem('worklistSeen')) || null; } catch { return null; }
}

function renderWorklist() {
  const root = $('#worklist-result');
  const status = $('#worklist-status');
  root.innerHTML = '';
  if (!WORKLIST?.items) { status.textContent = 'Nog geen divergentie-gegevens beschikbaar.'; return; }
  status.textContent = WORKLIST.generatedAt
    ? `Berekend op ${new Date(WORKLIST.generatedAt).toLocaleString('nl-NL')} · ${WORKLIST.items.length} landen met ≥3 betrouwbare bronnen.`
    : '';
  const onlyDiff = $('#worklist-filter').value === 'diff';
  const region = $('#worklist-region').value;
  const onlyWatch = $('#worklist-watch')?.checked;
  const items = WORKLIST.items
    .filter((i) => !onlyDiff || i.delta !== 0)
    .filter((i) => !region || countryRegion(i.iso3) === region)
    .filter((i) => !onlyWatch || WATCHLIST.has(i.iso3));

  // Delta t.o.v. het vorige bezoek van deze redacteur (localStorage).
  const seen = worklistSeen();
  const prevDeltas = seen?.deltas || null;
  const isNew = (i) => prevDeltas && i.delta !== 0 && !(prevDeltas[i.iso3] && prevDeltas[i.iso3] !== 0);
  const resolved = prevDeltas
    ? Object.entries(prevDeltas)
        .filter(([iso, d]) => d !== 0 && !WORKLIST.items.some((i) => i.iso3 === iso && i.delta !== 0))
        .map(([iso]) => WORKLIST.items.find((i) => i.iso3 === iso)?.nl || COUNTRIES.find((c) => c.iso3 === iso)?.nl || iso)
    : [];

  if (!items.length) {
    root.append(el('p', { class: 'empty-col' }, 'Geen afwijkingen: NL zit overal op de internationale consensus. 🎉'));
  } else {
    const srcMeta = new Map((CFG.SOURCES || []).map((s) => [s.id, s]));
    const table = el('table', { class: 'summary-table' });
    const COLS = 5;
    table.append(el('thead', {}, el('tr', {},
      el('th', {}, 'Land'), el('th', {}, 'NL'), el('th', {}, 'Consensus'),
      el('th', {}, 'Verschil'), el('th', {}, 'Bronnen'))));
    const tbody = el('tbody');
    items.forEach((i) => {
      const flag = countryFlagByIso3(i.iso3);
      const landBtn = el('button', { type: 'button', class: 'btn-link worklist-country' }, `${flag ? flag + ' ' : ''}${i.nl}`);
      landBtn.addEventListener('click', () => {
        activateTab('compare');
        $('#country-input').value = i.nl;
        $('#compare-form').requestSubmit();
      });

      let verdict;
      if (i.delta === 0) verdict = el('span', { class: 'delta same' }, 'gelijk');
      else if (i.delta > 0) verdict = el('span', { class: 'delta stricter' }, `NL strenger (+${i.delta})`);
      else verdict = el('span', { class: 'delta looser' }, `NL soepeler (−${Math.abs(i.delta)})`);

      // Per-bron mini-vierkantjes; klik op de rij-uitklap toont de citaten.
      const srcCell = el('span', { class: 'kc' });
      Object.entries(i.perSource).forEach(([sid, lvl]) => {
        const m = srcMeta.get(sid);
        srcCell.append(el('span', {
          class: `sq mini c-${LEVEL_COLORS[lvl]}`,
          title: `${m?.label || sid}: ${COLOR_LABELS[LEVEL_COLORS[lvl]]}`,
        }));
      });

      const landCell = el('td', {}, landBtn);
      if (isNew(i)) landCell.append(' ', el('span', { class: 'new-badge', title: 'Nieuw afwijkend sinds je vorige bezoek aan deze lijst.' }, 'NIEUW'));

      // Uitklap met het letterlijke niveau-citaat per bron (uit de snapshot).
      const hasQuotes = i.quotes && Object.keys(i.quotes).length;
      const srcTd = el('td', {}, srcCell, el('span', { class: 'muted', style: 'margin-left:8px' }, `${i.nSources}`));
      const row = el('tr', {},
        landCell,
        el('td', {}, colorCode({ predominant: i.nlColor })),
        el('td', {}, colorCode({ predominant: i.consensusColor })),
        el('td', {}, verdict),
        srcTd);
      tbody.append(row);
      if (hasQuotes) {
        const detail = el('tr', { class: 'regional-detail-row', hidden: true },
          el('td', { colspan: COLS },
            el('div', { class: 'worklist-quotes' },
              ...Object.entries(i.quotes).map(([sid, q]) => {
                const m = srcMeta.get(sid);
                const lvl = i.perSource[sid];
                return el('p', { class: 'worklist-quote' },
                  colorSquare(LEVEL_COLORS[lvl] || 'none', 'mini'),
                  el('strong', {}, ` ${m?.flag || ''} ${m?.label || sid}: `), `“${q}”`);
              }))));
        const toggle = el('button', { type: 'button', class: 'btn-link', style: 'margin-left:8px;font-size:12.5px' }, 'citaten ▸');
        toggle.addEventListener('click', () => {
          detail.hidden = !detail.hidden;
          toggle.textContent = detail.hidden ? 'citaten ▸' : 'citaten ▾';
        });
        srcTd.append(toggle);
        tbody.append(detail);
      }
    });
    table.append(tbody);
    root.append(table);
  }

  if (resolved.length) {
    root.append(el('p', { class: 'hint', style: 'margin-top:12px' },
      `✅ Sinds je vorige bezoek van de afwijkingenlijst af: ${resolved.join(', ')}.`));
  }

  // Huidige stand opslaan als "gezien" voor de volgende keer.
  localStorage.setItem('worklistSeen', JSON.stringify({
    generatedAt: WORKLIST.generatedAt || null,
    deltas: Object.fromEntries(WORKLIST.items.map((i) => [i.iso3, i.delta])),
  }));
}

/** Actualiteitsoverzicht (punt 7): NL-bijwerkdatum vs recentste bron-update. */
function renderAges() {
  const root = $('#worklist-result');
  const status = $('#worklist-status');
  root.innerHTML = '';
  if (!AGES?.items) { status.textContent = 'Nog geen actualiteitsgegevens (de snapshot met bron-datums moet nog draaien).'; return; }
  status.textContent = `Bijgewerkt op ${new Date(AGES.generatedAt).toLocaleString('nl-NL')} · NL-datum vs recentste bron-update per land.`;

  const region = $('#worklist-region').value;
  const onlyWatch = $('#worklist-watch')?.checked;
  const items = AGES.items
    .filter((i) => !region || countryRegion(i.iso3) === region)
    .filter((i) => !onlyWatch || WATCHLIST.has(i.iso3));
  const fmt = (s) => (s ? new Date(s).toLocaleDateString('nl-NL') : '—');

  const table = el('table', { class: 'summary-table' });
  table.append(el('thead', {}, el('tr', {},
    el('th', {}, 'Land'), el('th', {}, 'NL bijgewerkt'), el('th', {}, 'Recentste bron'),
    el('th', {}, 'Achterstand'), el('th', {}, 'NL-leeftijd'))));
  const tbody = el('tbody');
  items.forEach((i) => {
    const flag = countryFlagByIso3(i.iso3);
    const landBtn = el('button', { type: 'button', class: 'btn-link worklist-country' }, `${flag ? flag + ' ' : ''}${i.nl}`);
    landBtn.addEventListener('click', () => {
      activateTab('compare');
      $('#country-input').value = i.nl;
      $('#compare-form').requestSubmit();
    });

    // Achterstand: bron recenter dan NL. Rood ≥ 60 dagen, oranje ≥ 21.
    let behind;
    if (i.behindDays == null) behind = el('span', { class: 'muted' }, '—');
    else if (i.behindDays <= 0) behind = el('span', { class: 'delta same' }, 'NL is bij');
    else {
      const cls = i.behindDays >= 60 ? 'stricter' : i.behindDays >= 21 ? 'looser' : 'same';
      behind = el('span', { class: `delta ${cls}` }, `+${i.behindDays} dgn`);
    }
    const ageCls = i.nlAgeDays != null && i.nlAgeDays > 365 ? 'muted warn-age' : 'muted';
    tbody.append(el('tr', {},
      el('td', {}, colorSquare(i.nlColor || 'none', 'mini'), ' ', landBtn),
      el('td', { class: 'muted' }, fmt(i.nlDate)),
      el('td', { class: 'muted' }, i.latestForeign ? `${fmt(i.latestForeign)} · ${i.nForeign} bron${i.nForeign === 1 ? '' : 'nen'}` : '—'),
      el('td', {}, behind),
      el('td', { class: ageCls }, i.nlAgeDays != null ? `${i.nlAgeDays} dgn` : '—')));
  });
  table.append(tbody);
  root.append(el('p', { class: 'hint', style: 'margin-top:0' },
    'Achterstand = dagen dat de recentste buitenlandse bron ná NederlandWereldwijd is bijgewerkt. Oranje ≥ 21 dagen, rood ≥ 60 dagen.'),
    table);
}

// ==========================================================================
// VOLGLIJST-balk, deel-link, export/import en bundel-ochtendbriefing (feature 2)
// ==========================================================================
function renderWatchBar() {
  const bar = $('#watch-bar');
  if (!bar) return;
  bar.hidden = false;
  bar.innerHTML = '';
  const items = watchlistItems();
  const left = el('div', { class: 'watch-left' }, el('strong', {}, `👁 Volglijst (${items.length})`));
  if (!items.length) {
    left.append(el('span', { class: 'hint', style: 'margin:0 0 0 10px' }, 'leeg — gebruik "👁 Volgen" bij een land, of importeer een gedeelde lijst →'));
  } else {
    const chips = el('span', { class: 'watch-chips' });
    items.forEach((c) => {
      const chip = el('button', { type: 'button', class: 'watch-chip', title: 'Open ' + c.nl }, `${countryFlag(c.iso2)} ${c.nl}`);
      chip.addEventListener('click', () => { activateTab('compare'); $('#country-input').value = c.nl; $('#compare-form').requestSubmit(); });
      const x = el('span', { class: 'watch-chip-x', title: 'Van volglijst halen' }, '×');
      x.addEventListener('click', (e) => { e.stopPropagation(); toggleWatch(c.iso3); });
      chip.append(' ', x);
      chips.append(chip);
    });
    left.append(chips);
  }
  const actions = el('div', { class: 'watch-actions' });
  if (items.length) {
    const brief = el('button', { type: 'button', class: 'btn' }, '🗓 Ochtendbriefing');
    brief.addEventListener('click', openWatchlistBriefing);
    const share = el('button', { type: 'button', class: 'btn' }, '🔗 Deel lijst');
    share.addEventListener('click', () => shareWatchlist(share));
    const exp = el('button', { type: 'button', class: 'btn' }, '⬇ Export');
    exp.addEventListener('click', exportWatchlist);
    actions.append(brief, share, exp);
  }
  const imp = el('label', { class: 'btn', style: 'cursor:pointer' }, '⬆ Import',
    el('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: importWatchlist }));
  actions.append(imp);
  bar.append(left, actions);
}

function shareWatchlist(btn) {
  const url = `${location.origin}${location.pathname}?tab=worklist&volglijst=${[...WATCHLIST].join(',')}`;
  navigator.clipboard.writeText(url).then(() => {
    const orig = btn.textContent; btn.textContent = '✓ Link gekopieerd';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  }).catch(() => { prompt('Kopieer de deellink:', url); });
}

function exportWatchlist() {
  const blob = new Blob([JSON.stringify({ watchlist: [...WATCHLIST], exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: 'reisadviezen-volglijst.json' });
  document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
}

function importWatchlist(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const d = JSON.parse(reader.result);
      const ids = (Array.isArray(d) ? d : d.watchlist || []).filter((iso) => COUNTRIES.some((c) => c.iso3 === iso));
      if (!ids.length) throw new Error('geen geldige landen');
      WATCHLIST = new Set(ids);
      saveWatchlist();
      updateWatchUI();
      renderWorklistView();
    } catch { alert('Kon de volglijst niet lezen (verwacht een geëxporteerd volglijst-bestand).'); }
    e.target.value = '';
  };
  reader.readAsText(file);
}

/** Laadt een gedeelde volglijst uit ?volglijst=ISO,ISO (vervangt de huidige). */
function loadWatchlistFromUrl() {
  const raw = new URLSearchParams(location.search).get('volglijst');
  if (raw == null) return;
  const ids = raw.split(',').map((s) => s.trim().toUpperCase()).filter((iso) => COUNTRIES.some((c) => c.iso3 === iso));
  if (ids.length) { WATCHLIST = new Set(ids); saveWatchlist(); }
}

function openWatchlistBriefing() {
  const items = watchlistItems();
  if (!items.length) return;
  activateTab('compare');
  const root = $('#compare-result');
  root.innerHTML = '';
  $('#compare-status').textContent = '';
  updateUrl({ briefing: 'watchlist', land: null, vs: null }, true);
  root.append(renderWatchlistBriefing(items));
  window.scrollTo({ top: 0 });
}

/** Bundel-ochtendbriefing over de hele volglijst, uit offline data (snel + printbaar). */
function renderWatchlistBriefing(items) {
  const wrap = el('div', { class: 'briefing' });
  const back = el('button', { type: 'button', class: 'btn' }, '← Terug naar werklijst');
  back.addEventListener('click', () => { updateUrl({ briefing: null }, true); activateTab('worklist'); });
  const printB = el('button', { type: 'button', class: 'btn', onclick: () => window.print() }, '🖨 Print');
  wrap.append(el('div', { class: 'briefing-actions' }, back, printB));
  wrap.append(el('div', { class: 'briefing-head' },
    el('h2', {}, `🗓 Ochtendbriefing — volglijst (${items.length} landen)`),
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
    open.addEventListener('click', () => { activateTab('compare'); $('#country-input').value = c.nl; $('#compare-form').requestSubmit(); });
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
  const items = (RECENT_CHANGES || []).filter(
    (c) => (!sourceFilter || c.source === sourceFilter) && inPeriod(c.date) && (!onlyWatch || WATCHLIST.has(c.iso3))
  );

  // Door de bron zelf gemelde updatedatums in de periode — ook voor updates
  // van vóór de start van onze monitoring (details zijn er dan niet, maar
  // "dit land is toen bijgewerkt" wel). Land+bron-combinaties die hierboven
  // al als gedetecteerde wijziging staan, worden overgeslagen.
  const covered = new Set(items.map((c) => `${c.iso3}|${c.source}`));
  const srcMeta = new Map((CFG.SOURCES || []).map((s) => [s.id, s]));
  const reported = [];
  for (const [iso3, perSource] of Object.entries(SOURCE_DATES || {})) {
    if (onlyWatch && !WATCHLIST.has(iso3)) continue;
    for (const [sid, date] of Object.entries(perSource)) {
      if (sourceFilter && sid !== sourceFilter) continue;
      if (!inPeriod(date) || covered.has(`${iso3}|${sid}`)) continue;
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
      `Geen wijzigingen of door de bron gemelde updates gevonden tussen ${new Date(from).toLocaleDateString('nl-NL')} en ${new Date(to).toLocaleDateString('nl-NL')}.`));
    return;
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
    if (c.countryNl) row.querySelector('.change-country').addEventListener('click', () => {
      activateTab('compare');
      $('#country-input').value = c.countryNl;
      $('#compare-form').requestSubmit();
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
        activateTab('compare');
        $('#country-input').value = r.countryNl;
        $('#compare-form').requestSubmit();
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
        activateTab('compare');
        $('#country-input').value = r.country.nl;
        $('#compare-form').requestSubmit();
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
  details.append(el('summary', {},
    el('span', {}, r.color ? el('span', { class: `dot c-${r.color}`, title: COLOR_LABELS[r.color] }) : '', ' ' + r.name),
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
      el('span', {}, c.color ? el('span', { class: `dot c-${c.color}` }) : '', ' ' + c.name),
      el('span', { class: 'count-pill', style: 'margin-left:auto' }, `oudste: ${fmtDate(c.oldest)}`),
      el('a', { href: c.url, target: '_blank', rel: 'noopener', style: 'margin-left:10px;font-weight:400;font-size:13px', onclick: (e) => e.stopPropagation() }, 'origineel →')));
    c.hits.forEach((h) => details.append(el('div', { class: 'match' },
      el('div', { class: 'm-head' }, el('strong', {}, fmtDate(h.date)), ` · ${ageText(h.date, today)}`, h.uncertain ? el('span', { class: 'm-theme' }, 'geen jaartal — aanname huidig jaar') : null, ' · ', h.heading),
      el('div', { class: 'snippet', html: highlight(h.snippet, h.raw) }))));
    frag.append(details);
  });
  root.append(frag);
}

// ---- Init -----------------------------------------------------------------
bootstrap().catch((e) => {
  $('#compare-status').className = 'status error';
  $('#compare-status').textContent = 'Kan gegevens niet laden: ' + e.message;
});
