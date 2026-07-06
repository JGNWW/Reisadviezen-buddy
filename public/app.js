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

// Toon buitenlandse teksten in het origineel (true) of vertaald naar NL (false).
let SHOW_ORIGINAL = false;
let LAST_COMPARE = null;

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

function colorBadge(color, opts = {}) {
  const { uncertain, hasRegionalWarnings, regionalMaxLevel, explanation } = opts;
  const badges = [];
  if (uncertain) {
    badges.push(el('span', {
      class: 'color-badge c-uncertain',
      title: explanation || 'Niveau kon niet betrouwbaar worden vastgesteld — geen gok gedaan.',
    }, el('span', { class: 'dot' }), 'Onzeker'));
  } else if (!color) {
    badges.push(el('span', { class: 'empty-col' }, 'geen kleurcode'));
  } else {
    badges.push(el('span', { class: `color-badge c-${color}` }, el('span', { class: 'dot' }), COLOR_LABELS[color] || color));
  }
  if (hasRegionalWarnings) {
    const rColor = ['', 'groen', 'geel', 'oranje', 'rood'][regionalMaxLevel] || null;
    badges.push(el('span', {
      class: 'regional-flag',
      title: explanation || `Regionale waarschuwing gevonden (max. niveau: ${rColor || 'onbekend'}) — het landelijke niveau geldt niet overal.`,
    }, `⚠ regionaal: ${rColor ? COLOR_LABELS[rColor] : '?'}`));
  }
  return el('span', { class: 'badge-stack' }, ...badges);
}

/** Compacte, scanbare tabel: één rij per bron (i.p.v. een kaartengrid). */
function renderSummaryTable(nl, okSources) {
  const table = el('table', { class: 'summary-table' });
  const thead = el('thead', {}, el('tr', {},
    el('th', {}, 'Bron'), el('th', {}, 'Kleurcode'), el('th', {}, 'Origineel niveau'),
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
    el('td', {}, colorBadge(nl.colors?.overall)),
    el('td', { class: 'muted' }, '—'),
    el('td', { class: 'muted' }, nl.modificationDate ? nl.modificationDate.split('|')[0].replace('Laatst gewijzigd op:', '').trim() : fmtDateShort(nl.lastModified)),
    el('td', {}, el('a', { href: nl.url, target: '_blank', rel: 'noopener' }, 'origineel →'))));

  okSources.forEach((s) => {
    tbody.append(el('tr', {},
      el('td', {}, `${s.flag || ''} ${s.sourceLabel}`),
      el('td', {}, colorBadge(s.color, {
        uncertain: s.assessmentStatus === 'uncertain',
        hasRegionalWarnings: s.hasRegionalWarnings,
        regionalMaxLevel: s.regionalMaxLevel,
        explanation: s.levelLabel,
      }), ' ', el('span', { class: 'approx-tag', title: 'Vertaald naar de Nederlandse kleurenschaal' }, 'benadering')),
      el('td', { class: 'muted' }, s.levelLabel || '—'),
      el('td', { class: 'muted' }, fmtDateShort(s.lastModified)),
      el('td', {}, el('a', { href: s.url, target: '_blank', rel: 'noopener' }, 'origineel →'))));
  });
  table.append(tbody);
  return table;
}

function renderComparison(staticData, foreign, root) {
  LAST_COMPARE = { staticData, foreign, root };
  root.innerHTML = '';
  const nl = staticData.nl;
  const okSources = (foreign.sources || []).filter((s) => !s.unavailable && !s.error && s.themes);
  const problems = (foreign.sources || []).filter((s) => s.unavailable || s.error);
  const hasTranslated = okSources.some((s) => s.translated);
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

  // ---- Samenvattingstabel (kleurcode + niveau + datum + link per bron) ----
  frag.append(el('h3', { class: 'section-title' }, 'Kleurcodes op een rij'), renderSummaryTable(nl, okSources));
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

  const themeHead = el('div', { class: 'theme-head-row' }, el('h3', { class: 'section-title', style: 'flex:1;margin:0;border:none' }, 'Vergelijking per thema'));
  if (hasTranslated) {
    themeHead.append(el('button', {
      class: 'btn toggle-lang', type: 'button',
      onclick: () => { SHOW_ORIGINAL = !SHOW_ORIGINAL; renderComparison(LAST_COMPARE.staticData, LAST_COMPARE.foreign, LAST_COMPARE.root); },
    }, SHOW_ORIGINAL ? '🌐 Toon vertaald (Nederlands)' : '🌐 Toon origineel'));
  }
  frag.append(themeHead);
  const foreignCols = okSources.map((f) => ({ id: f.source, label: f.sourceLabel, flag: f.flag }));
  let lastGroup = null;
  cmp.themes.forEach((t) => {
    const g = t.theme.group || 'Overig';
    if (g !== lastGroup) { frag.append(el('div', { class: 'theme-group-label' }, g)); lastGroup = g; }
    frag.append(renderThemeCard(t, foreignCols));
  });

  root.append(frag);
}

const SNIPPET_MAXLEN = 320;

/**
 * Rendert thema-blokken. Lange blokken worden standaard ingekort tot een
 * scanbaar fragment met een "Lees volledige tekst"-knop — dit voorkomt de
 * "muur van tekst" die ontstaat als N bronnen elk hun volledige, vaak
 * uitgebreide, brontekst tonen.
 */
function renderBlocks(blocks, foreign = false) {
  if (!blocks || !blocks.length) return null;
  const wrap = el('div');
  blocks.forEach((b) => {
    // Voor buitenlandse (vertaalde) blokken: standaard NL, of origineel bij toggle.
    const useNl = foreign && !SHOW_ORIGINAL && (b.textNl || b.headingNl);
    const heading = useNl && b.headingNl ? b.headingNl : b.heading;
    const fullText = useNl && b.textNl ? b.textNl : (b.text || '');
    const fullHtml = useNl && b.textNl ? null : (b.html || null);

    const blockEl = el('div', { class: 'block' },
      heading ? el('div', { class: 'block-heading' }, heading) : null,
      b.category && b.category !== heading ? el('div', { class: 'block-cat' }, b.category) : null);

    if (fullText.length > SNIPPET_MAXLEN) {
      let expanded = false;
      const shortNode = el('div', { class: 'rich' }, fullText.slice(0, SNIPPET_MAXLEN).trim() + '…');
      const fullNode = el('div', { class: 'rich', html: fullHtml || esc(fullText) });
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
      blockEl.append(el('div', { class: 'rich', html: fullHtml || esc(fullText) }));
    }
    wrap.append(blockEl);
  });
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
  const cols = el('div', { class: 'compare-cols cols-' + Math.min(nCols, 6) });
  const nlCol = el('div', { class: 'compare-col' }, el('h4', {}, '🇳🇱 NederlandWereldwijd'));
  nlCol.append(t.nlHasIt ? renderBlocks(t.nl) : el('div', { class: 'empty-col' }, 'Niet apart behandeld.'));
  cols.append(nlCol);
  foreignCols.forEach((fc) => {
    const entry = t.foreign[fc.id] || { blocks: [] };
    const col = el('div', { class: 'compare-col' }, el('h4', {}, `${fc.flag || ''} ${fc.label}`));
    col.append(entry.blocks?.length ? renderBlocks(entry.blocks, true) : el('div', { class: 'empty-col' }, 'Niet apart behandeld.'));
    cols.append(col);
  });
  details.append(cols);
  return details;
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
  return $$('#source-toggles input:checked').map((i) => i.value);
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
