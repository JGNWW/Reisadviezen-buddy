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
async function fetchForeign(iso, sources) {
  const proxy = getProxy();
  if (!proxy || !sources.length) return null;
  const url = `${proxy}/advisory/${iso}?sources=${sources.join(',')}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Proxy gaf ${r.status}`);
  return r.json();
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

// ---- Globale data ---------------------------------------------------------
let COUNTRIES = [];
let THEMES_META = [];
let THEME_ORDER = new Map();
let THEME_BY_ID = new Map();

function resolveCountry(query) {
  if (!query) return null;
  const q = query.trim(), upper = q.toUpperCase();
  let c = COUNTRIES.find((x) => x.iso3 === upper); if (c) return c;
  const nq = norm(q);
  c = COUNTRIES.find((x) => (x.key || '').toLowerCase() === q.toLowerCase()); if (c) return c;
  c = COUNTRIES.find((x) => norm(x.nl) === nq || norm(x.en) === nq); if (c) return c;
  c = COUNTRIES.find((x) => norm(x.nl).startsWith(nq) || norm(x.en).startsWith(nq)); if (c) return c;
  return COUNTRIES.find((x) => norm(x.nl).includes(nq) || norm(x.en).includes(nq)) || null;
}

// ==========================================================================
// Tabs + settings
// ==========================================================================
function activateTab(view) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
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

  const toggles = $('#source-toggles');
  (CFG.SOURCES || []).forEach((s) => {
    const on = s.default !== false;
    const label = el('label', { class: 'chip-toggle' + (on ? ' on' : '') },
      el('input', { type: 'checkbox', value: s.id, ...(on ? { checked: 'checked' } : {}) }),
      `${s.flag || ''} ${s.label}`);
    label.querySelector('input').addEventListener('change', (e) => label.classList.toggle('on', e.target.checked));
    toggles.append(label);
  });

  if (meta?.builtAt) {
    $('#build-meta').textContent =
      `NL-data bijgewerkt op ${new Date(meta.builtAt).toLocaleString('nl-NL')} · ${meta.countries} landen · buitenlandse data live`;
  }
  if (!getProxy()) {
    $('#build-meta').textContent += ' · ⚠️ proxy niet ingesteld (klik ⚙)';
  }

  buildDirectory();
}

// ==========================================================================
// VERGELIJKEN
// ==========================================================================
$('#compare-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#country-input').value.trim();
  const selected = $$('#source-toggles input:checked').map((i) => i.value);
  const status = $('#compare-status'), result = $('#compare-result');
  if (!input) return;
  const country = resolveCountry(input);
  if (!country) { status.className = 'status error'; status.textContent = `Land “${input}” niet gevonden.`; result.innerHTML = ''; return; }

  status.className = 'status';
  status.innerHTML = `<span class="spinner"></span>Reisadvies laden voor ${esc(country.nl)}…`;
  result.innerHTML = '';
  try {
    const staticData = await loadJSON(`compare/${country.iso3}.json`);
    let foreign = { sources: [], notice: null };
    if (selected.length) {
      if (!getProxy()) {
        foreign.notice = 'Stel de proxy in (⚙ rechtsboven) om buitenlandse reisadviezen te vergelijken.';
      } else {
        status.innerHTML = `<span class="spinner"></span>Buitenlandse adviezen live ophalen…`;
        try {
          const res = await fetchForeign(country.iso3, selected);
          foreign.sources = res?.sources || [];
        } catch (err) {
          foreign.notice = 'Kon de proxy niet bereiken: ' + err.message;
        }
      }
    }
    status.textContent = '';
    renderComparison(staticData, foreign, result);
  } catch (err) {
    status.className = 'status error'; status.textContent = err.message;
  }
});

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
  const forIdx = foreignSources.map((f) => ({ source: f.source, label: f.sourceLabel, flag: f.flag, idx: indexByTheme(f.themes) }));

  const ids = new Set([...nlIdx.keys()]);
  forIdx.forEach((f) => f.idx.forEach((_, k) => ids.add(k)));
  const ordered = [...ids].filter((id) => id !== '_other')
    .sort((a, b) => (THEME_ORDER.get(a) ?? 99) - (THEME_ORDER.get(b) ?? 99));
  if (ids.has('_other')) ordered.push('_other');

  const themes = [], missingFromNl = [];
  for (const id of ordered) {
    const meta = id === '_other' ? { id, label: 'Overige / niet ingedeeld', group: 'Overig' } : THEME_BY_ID.get(id);
    const nlBlocks = nlIdx.get(id) || [];
    const foreign = {};
    let foreignHasIt = false;
    for (const f of forIdx) {
      const blocks = f.idx.get(id) || [];
      foreign[f.source] = { label: f.label, flag: f.flag, blocks };
      if (blocks.length) foreignHasIt = true;
    }
    themes.push({ theme: meta, nl: nlBlocks, foreign, nlHasIt: nlBlocks.length > 0, foreignHasIt });
    if (id !== '_other' && nlBlocks.length === 0 && foreignHasIt) missingFromNl.push({ theme: meta, foreign });
  }
  return { themes, missingFromNl };
}

function colorBadge(color) {
  if (!color) return el('span', { class: 'empty-col' }, 'geen kleurcode');
  return el('span', { class: `color-badge c-${color}` }, el('span', { class: 'dot' }), COLOR_LABELS[color] || color);
}

function renderComparison(staticData, foreign, root) {
  const nl = staticData.nl;
  const okSources = (foreign.sources || []).filter((s) => !s.unavailable && !s.error && s.themes);
  const problems = (foreign.sources || []).filter((s) => s.unavailable || s.error);
  const frag = document.createDocumentFragment();

  frag.append(el('div', { class: 'result-head' },
    el('h2', {}, staticData.country.nl),
    el('p', { class: 'meta' }, nl.modificationDate || `Laatst gewijzigd: ${(nl.lastModified || '').slice(0, 10)}`)));

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
  const chipRow = el('div', { class: 'chip-row' });
  chips.forEach((c) => chipRow.append(el('span', { class: 'div-chip' },
    el('span', { class: `dot c-${c.color || 'none'}` }), ` ${c.label}: `, el('strong', {}, c.color ? COLOR_LABELS[c.color] : '—'))));
  divWrap.append(chipRow);
  frag.append(divWrap);

  // ---- Kleurcode-kaarten ----
  const colorsGrid = el('div', { class: 'colors-grid' });
  const nlCard = el('div', { class: 'panel color-card' }, el('h3', {}, '🇳🇱 NederlandWereldwijd'),
    colorBadge(nlColor), nlColor ? el('div', { class: 'color-note' }, COLOR_MEANING[nlColor]) : null);
  if (nl.colors?.colors?.length) {
    const ul = el('ul', { class: 'color-contexts' });
    nl.colors.colors.forEach((c) => ul.append(el('li', {}, el('strong', {}, `${COLOR_LABELS[c.color]}: `), c.context)));
    nlCard.append(ul);
  }
  colorsGrid.append(nlCard);
  okSources.forEach((s) => {
    colorsGrid.append(el('div', { class: 'panel color-card' },
      el('h3', {}, `${s.flag || ''} ${s.sourceLabel}`),
      el('span', {}, colorBadge(s.color), el('span', { class: 'approx-tag', title: 'Vertaald naar de Nederlandse kleurenschaal' }, 'benadering')),
      s.levelLabel ? el('div', { class: 'color-note' }, `Origineel: ${s.levelLabel}`) : null,
      el('div', { class: 'color-note' }, el('a', { href: s.url, target: '_blank', rel: 'noopener' }, 'Bekijk origineel reisadvies →'))));
  });
  frag.append(el('h3', { class: 'section-title' }, 'Kleurcodes'), colorsGrid);

  // ---- Kaarten (NL hotlink + buitenland op klik via proxy) ----
  const mapsGrid = el('div', { class: 'maps-grid' });
  mapsGrid.append(el('figure', { class: 'map-box' },
    el('img', { src: nl.maps.standard, alt: `Kaart ${staticData.country.nl}`,
      onerror: function () { this.replaceWith(el('div', { class: 'map-missing' }, 'Kaart niet beschikbaar.')); } }),
    el('figcaption', {}, '🇳🇱 NederlandWereldwijd')));
  okSources.forEach((s) => {
    if (s.mapProxy && getProxy()) {
      const box = el('figure', { class: 'map-box' });
      const btn = el('button', { class: 'btn map-load', type: 'button' }, `${s.flag || ''} Kaart ${s.sourceLabel} laden`);
      btn.addEventListener('click', () => {
        btn.replaceWith(el('img', { src: getProxy() + s.mapProxy, alt: `Kaart ${s.sourceLabel}`,
          onerror: function () { this.replaceWith(el('div', { class: 'map-missing' }, 'Kaart kon niet geladen worden.')); } }));
      });
      box.append(btn, el('figcaption', {}, `${s.flag || ''} ${s.sourceLabel}`));
      mapsGrid.append(box);
    } else {
      mapsGrid.append(el('figure', { class: 'map-box' },
        el('div', { class: 'map-missing' }, `${s.flag || ''} ${s.sourceLabel} publiceert geen losse kaart. `,
          el('a', { href: s.url, target: '_blank', rel: 'noopener' }, 'Bronpagina →'))));
    }
  });
  frag.append(el('h3', { class: 'section-title' }, 'Kaarten'), mapsGrid);

  // ---- Notices ----
  if (foreign.notice) frag.append(el('div', { class: 'callout', style: 'background:#eef4fb;border-left-color:var(--nl-blue)' },
    el('p', { style: 'margin:0' }, foreign.notice)));
  if (problems.length) frag.append(el('div', { class: 'callout', style: 'background:#f6f8fa;border-left-color:var(--muted)' },
    el('p', { style: 'margin:0' }, 'Geen advies via: ' + problems.map((p) => p.label || p.source).join(', ') + '.')));

  // ---- Vergelijking per thema ----
  const cmp = buildComparison(nl, okSources);
  if (cmp.missingFromNl.length) {
    const ul = el('ul');
    cmp.missingFromNl.forEach((m) => {
      const srcs = Object.values(m.foreign).filter((v) => v.blocks?.length).map((v) => v.label);
      ul.append(el('li', {}, el('strong', {}, m.theme.label), ' ', el('span', { class: 'src' }, `— wel behandeld door ${srcs.join(', ')}`)));
    });
    frag.append(el('div', { class: 'callout' }, el('h3', {}, '💡 Thema’s die andere landen wél noemen en NederlandWereldwijd niet'), ul));
  }

  frag.append(el('h3', { class: 'section-title' }, 'Vergelijking per thema'));
  const foreignCols = okSources.map((f) => ({ id: f.source, label: f.sourceLabel, flag: f.flag }));
  let lastGroup = null;
  cmp.themes.forEach((t) => {
    const g = t.theme.group || 'Overig';
    if (g !== lastGroup) { frag.append(el('div', { class: 'theme-group-label' }, g)); lastGroup = g; }
    frag.append(renderThemeCard(t, foreignCols));
  });

  root.append(frag);
}

function renderBlocks(blocks) {
  if (!blocks || !blocks.length) return null;
  const wrap = el('div');
  blocks.forEach((b) => wrap.append(el('div', { class: 'block' },
    b.heading ? el('div', { class: 'block-heading' }, b.heading) : null,
    b.category && b.category !== b.heading ? el('div', { class: 'block-cat' }, b.category) : null,
    el('div', { class: 'rich', html: b.html || esc(b.text || '') }))));
  return wrap;
}

function renderThemeCard(t, foreignCols) {
  let badge;
  if (t.nlHasIt && t.foreignHasIt) badge = el('span', { class: 'badge both' }, 'beide');
  else if (t.nlHasIt) badge = el('span', { class: 'badge nl-only' }, 'alleen NL');
  else badge = el('span', { class: 'badge foreign-only' }, 'ontbreekt bij NL');

  const details = el('details', { class: 'panel theme-card', ...(t.foreignHasIt && !t.nlHasIt ? { open: 'open' } : {}) });
  details.append(el('summary', {}, t.theme.label, badge));
  const nCols = 1 + foreignCols.length;
  const cols = el('div', { class: 'compare-cols cols-' + Math.min(nCols, 5) });
  const nlCol = el('div', { class: 'compare-col' }, el('h4', {}, '🇳🇱 NederlandWereldwijd'));
  nlCol.append(t.nlHasIt ? renderBlocks(t.nl) : el('div', { class: 'empty-col' }, 'Niet apart behandeld.'));
  cols.append(nlCol);
  foreignCols.forEach((fc) => {
    const entry = t.foreign[fc.id] || { blocks: [] };
    const col = el('div', { class: 'compare-col' }, el('h4', {}, `${fc.flag || ''} ${fc.label}`));
    col.append(entry.blocks?.length ? renderBlocks(entry.blocks) : el('div', { class: 'empty-col' }, 'Niet apart behandeld.'));
    cols.append(col);
  });
  details.append(cols);
  return details;
}

// ==========================================================================
// LANDENOVERZICHT
// ==========================================================================
let DIRECTORY = [];
async function buildDirectory() {
  try { DIRECTORY = await loadJSON('directory.json'); } catch { DIRECTORY = []; }
  const legend = $('#dir-legend');
  ['groen', 'geel', 'oranje', 'rood'].forEach((c) =>
    legend.append(el('span', { class: 'legend-item' }, el('span', { class: `dot c-${c}` }), COLOR_LABELS[c])));
  renderDirectory('');
  $('#dir-filter').addEventListener('input', (e) => renderDirectory(e.target.value));
}
function renderDirectory(filter) {
  const grid = $('#directory-grid');
  grid.innerHTML = '';
  const nq = norm(filter);
  const items = DIRECTORY.filter((c) => !nq || norm(c.nl).includes(nq));
  items.forEach((c) => {
    const card = el('button', { class: 'dir-card', type: 'button', title: 'Vergelijk ' + c.nl },
      el('span', { class: `dot c-${c.color || 'none'}` }), el('span', { class: 'dir-name' }, c.nl));
    card.addEventListener('click', () => {
      activateTab('compare');
      $('#country-input').value = c.nl;
      $('#compare-form').requestSubmit();
    });
    grid.append(card);
  });
  if (!items.length) grid.append(el('p', { class: 'empty-col' }, 'Geen landen gevonden.'));
}

// ==========================================================================
// ZOEKEN
// ==========================================================================
const scopeHints = {
  nl: 'Doorzoekt alle Nederlandse reisadviezen. Toont per land waar iets over je zoekwoord staat.',
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
function searchForeignAdvisory(res, term) {
  const t = term.toLowerCase(), out = [];
  for (const s of (res.sources || [])) {
    if (s.unavailable || s.error || !s.themes) continue;
    const matches = [];
    for (const b of s.themes) if (b.text && b.text.toLowerCase().includes(t))
      matches.push({ category: b.category, heading: b.heading, theme: b.themeId ? (THEME_BY_ID.get(b.themeId)?.label || null) : null, snippet: snippetAround(b.text, term) });
    if (matches.length) out.push({ iso3: res.country.iso3, name: `${s.flag || ''} ${s.sourceLabel}`, url: s.url, matches, matchCount: matches.length });
  }
  return out;
}

$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#search-input').value.trim();
  const scope = $('#search-scope').value;
  const countryInput = $('#search-country').value.trim();
  const status = $('#search-status'), result = $('#search-result');
  if (!q) return;
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
      const res = await fetchForeign(country.iso3, selected);
      out.foreign = res ? searchForeignAdvisory(res, q) : [];
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

// ---- Init -----------------------------------------------------------------
bootstrap().catch((e) => {
  $('#compare-status').className = 'status error';
  $('#compare-status').textContent = 'Kan gegevens niet laden: ' + e.message;
});
