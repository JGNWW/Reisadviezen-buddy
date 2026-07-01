'use strict';

// ==========================================================================
// Reisadviezen-buddy — statische frontend.
// Leest voorgebouwde JSON uit ./data en doet vergelijken + zoeken in de browser.
// ==========================================================================

const DATA = 'data';

// ---- DOM-helpers ----------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
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
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const COLOR_LABELS = { groen: 'Groen', geel: 'Geel', oranje: 'Oranje', rood: 'Rood' };
const COLOR_MEANING = {
  groen: 'Geen bijzondere veiligheidsrisico’s',
  geel: 'Let op: bijzondere veiligheidsrisico’s',
  oranje: 'Reis alleen als het noodzakelijk is',
  rood: 'Niet reizen',
};

// ---- Datalaag (statische JSON) -------------------------------------------
const _cache = new Map();
async function loadJSON(path) {
  if (_cache.has(path)) return _cache.get(path);
  const p = fetch(`${DATA}/${path}`).then((res) => {
    if (!res.ok) throw new Error(`Kan ${path} niet laden (${res.status})`);
    return res.json();
  });
  _cache.set(path, p);
  return p.catch((e) => {
    _cache.delete(path);
    throw e;
  });
}

// ---- Tekst-helpers --------------------------------------------------------
const norm = (s) =>
  (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function snippetAround(text, term, radius = 160) {
  if (!text) return '';
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return text.slice(0, radius * 2).trim() + (text.length > radius * 2 ? '…' : '');
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + term.length + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

function highlight(text, term) {
  if (!term) return esc(text);
  const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return esc(text).replace(re, '<mark>$1</mark>');
}

// ---- Landresolutie (client) ----------------------------------------------
let COUNTRIES = [];
let SOURCES = [];

function resolveCountry(query) {
  if (!query) return null;
  const q = query.trim();
  const upper = q.toUpperCase();
  const byIso = COUNTRIES.find((c) => c.iso3 === upper);
  if (byIso) return byIso;
  const nq = norm(q);
  const byKey = COUNTRIES.find((c) => (c.key || '').toLowerCase() === q.toLowerCase());
  if (byKey) return byKey;
  let exact = COUNTRIES.find((c) => norm(c.nl) === nq || norm(c.en) === nq);
  if (exact) return exact;
  let starts = COUNTRIES.find((c) => norm(c.nl).startsWith(nq) || norm(c.en).startsWith(nq));
  if (starts) return starts;
  return COUNTRIES.find((c) => norm(c.nl).includes(nq) || norm(c.en).includes(nq)) || null;
}

// ---- Tabs -----------------------------------------------------------------
$$('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${t.dataset.view}`));
  })
);

// ---- Bootstrap ------------------------------------------------------------
async function bootstrap() {
  const [countries, sources, meta] = await Promise.all([
    loadJSON('countries.json'),
    loadJSON('sources.json'),
    loadJSON('meta.json').catch(() => null),
  ]);
  COUNTRIES = countries;
  SOURCES = sources;

  const list = $('#country-list');
  countries.forEach((c) => list.append(el('option', { value: c.nl })));

  const toggles = $('#source-toggles');
  sources.forEach((s, i) => {
    const label = el(
      'label',
      { class: 'chip-toggle' + (i === 0 ? ' on' : '') },
      el('input', { type: 'checkbox', value: s.id, ...(i === 0 ? { checked: 'checked' } : {}) }),
      `${s.flag || ''} ${s.label}`
    );
    label.querySelector('input').addEventListener('change', (e) =>
      label.classList.toggle('on', e.target.checked)
    );
    toggles.append(label);
  });

  if (meta?.builtAt) {
    $('#build-meta').textContent =
      `Data bijgewerkt op ${new Date(meta.builtAt).toLocaleString('nl-NL')} · ` +
      `${meta.countries} landen (${meta.withForeign} met buitenlands advies)`;
  }
}

// ==========================================================================
// VERGELIJKEN
// ==========================================================================
$('#compare-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#country-input').value.trim();
  const selected = $$('#source-toggles input:checked').map((i) => i.value);
  const status = $('#compare-status');
  const result = $('#compare-result');
  if (!input) return;

  const country = resolveCountry(input);
  if (!country) {
    status.className = 'status error';
    status.textContent = `Land “${input}” niet gevonden.`;
    result.innerHTML = '';
    return;
  }
  status.className = 'status';
  status.innerHTML = `<span class="spinner"></span>Reisadvies laden voor ${esc(country.nl)}…`;
  result.innerHTML = '';
  try {
    const data = await loadJSON(`compare/${country.iso3}.json`);
    status.textContent = '';
    renderComparison(data, selected, result);
  } catch (err) {
    status.className = 'status error';
    status.textContent = err.message;
  }
});

/** Filtert de voorgebouwde vergelijking op de geselecteerde bronnen en
 *  herberekent de afgeleide lijsten (ontbrekend / alleen NL). */
function deriveComparison(data, selected) {
  const foreignList = data.foreign.filter((f) => selected.includes(f.source));
  const activeIds = new Set(foreignList.map((f) => f.source));

  const colorForeign = data.colorComparison.foreign.filter((f) => activeIds.has(f.source));

  const themes = data.themeComparison.themes.map((t) => {
    const foreign = {};
    let foreignHasIt = false;
    for (const [sid, entry] of Object.entries(t.foreign)) {
      if (!activeIds.has(sid)) continue;
      foreign[sid] = entry;
      if (entry.blocks && entry.blocks.length) foreignHasIt = true;
    }
    return { ...t, foreign, foreignHasIt };
  });

  const missingFromNl = [];
  const onlyNl = [];
  for (const t of themes) {
    if (t.theme.id === '_other') continue;
    if (!t.nlHasIt && t.foreignHasIt) missingFromNl.push(t);
    if (t.nlHasIt && !t.foreignHasIt) onlyNl.push(t);
  }

  const unavailable = data.unavailable.filter((u) => selected.includes(u.source));
  return { foreignList, colorForeign, themes, missingFromNl, onlyNl, unavailable };
}

function colorBadge(color) {
  if (!color) return el('span', { class: 'empty-col' }, 'geen kleurcode gevonden');
  return el('span', { class: `color-badge c-${color}` }, el('span', { class: 'dot' }), COLOR_LABELS[color] || color);
}

function renderComparison(data, selected, root) {
  const nl = data.nl;
  const view = deriveComparison(data, selected);
  const frag = document.createDocumentFragment();

  frag.append(
    el(
      'div',
      { class: 'result-head' },
      el('h2', {}, data.country.nl),
      el('p', { class: 'meta' }, nl.modificationDate || `Laatst gewijzigd: ${(nl.lastModified || '').slice(0, 10)}`)
    )
  );

  if (view.unavailable.length) {
    frag.append(
      el(
        'div',
        { class: 'callout', style: 'background:#eef4fb;border-color:#b9d3ef;border-left-color:var(--nl-blue)' },
        el('h3', { style: 'color:var(--nl-blue)' }, 'ℹ️ Geen buitenlands advies beschikbaar'),
        el('p', { style: 'margin:0' },
          `Voor ${data.country.nl} is geen los reisadvies gevonden bij: ` +
            view.unavailable.map((u) => u.label).join(', ') + '.')
      )
    );
  }

  // Kleurcodes
  const colorsGrid = el('div', { class: 'colors-grid' });
  const cc = data.colorComparison;
  const nlCard = el(
    'div',
    { class: 'panel color-card' },
    el('h3', {}, '🇳🇱 NederlandWereldwijd'),
    colorBadge(cc.nl.overall),
    cc.nl.overall ? el('div', { class: 'color-note' }, COLOR_MEANING[cc.nl.overall]) : null
  );
  if (cc.nl.colors?.length) {
    const ul = el('ul', { class: 'color-contexts' });
    cc.nl.colors.forEach((c) => ul.append(el('li', {}, el('strong', {}, `${COLOR_LABELS[c.color]}: `), c.context)));
    nlCard.append(ul);
  }
  colorsGrid.append(nlCard);
  view.colorForeign.forEach((f) => {
    colorsGrid.append(
      el(
        'div',
        { class: 'panel color-card' },
        el('h3', {}, `${f.flag || ''} ${f.label}`),
        el('span', {}, colorBadge(f.mappedColor),
          el('span', { class: 'approx-tag', title: 'Vertaald naar de Nederlandse kleurenschaal' }, 'benadering')),
        el('div', { class: 'color-note' }, `Grondslag: ${f.basis}`),
        f.alertStatus?.length ? el('div', { class: 'color-note' }, `Waarschuwing: ${f.alertStatus.join(', ')}`) : null,
        el('div', { class: 'color-note' }, el('a', { href: f.url, target: '_blank', rel: 'noopener' }, 'Bekijk origineel reisadvies →'))
      )
    );
  });
  frag.append(el('h3', { class: 'section-title' }, 'Kleurcodes'), colorsGrid);

  // Kaarten (hotlink naar open data; cross-origin <img> werkt zonder CORS)
  const mapsGrid = el('div', { class: 'maps-grid' });
  mapsGrid.append(
    el('figure', { class: 'map-box' },
      el('img', { src: nl.maps.standard, alt: `Kaart reisadvies ${data.country.nl}`,
        onerror: function () { this.replaceWith(el('div', { class: 'map-missing' }, 'Kaart niet beschikbaar.')); } }),
      el('figcaption', {}, '🇳🇱 NederlandWereldwijd'))
  );
  view.foreignList.forEach((f) => {
    mapsGrid.append(
      el('figure', { class: 'map-box' },
        el('div', { class: 'map-missing' },
          `${f.flag || ''} ${f.sourceLabel} publiceert geen losse kaartafbeelding via de open data. `,
          el('a', { href: f.url, target: '_blank', rel: 'noopener' }, 'Bekijk de kaart op de bronpagina →')))
    );
  });
  frag.append(el('h3', { class: 'section-title' }, 'Kaarten'), mapsGrid);

  // Wat noemen andere landen wel en wij niet?
  if (view.missingFromNl.length) {
    const ul = el('ul');
    view.missingFromNl.forEach((t) => {
      const srcs = Object.values(t.foreign).filter((v) => v.blocks?.length).map((v) => v.label);
      ul.append(el('li', {}, el('strong', {}, t.theme.label), ' ', el('span', { class: 'src' }, `— wel behandeld door ${srcs.join(', ')}`)));
    });
    frag.append(el('div', { class: 'callout' },
      el('h3', {}, '💡 Thema’s die andere landen wél noemen en NederlandWereldwijd niet'), ul));
  }

  // Per thema
  frag.append(el('h3', { class: 'section-title' }, 'Vergelijking per thema'));
  const foreignSources = view.foreignList.map((f) => ({ id: f.source, label: f.sourceLabel, flag: f.flag }));
  let lastGroup = null;
  view.themes.forEach((t) => {
    const group = t.theme.group || 'Overig';
    if (group !== lastGroup) {
      frag.append(el('div', { class: 'theme-group-label' }, group));
      lastGroup = group;
    }
    frag.append(renderThemeCard(t, foreignSources));
  });

  root.append(frag);
}

function renderBlocks(blocks) {
  if (!blocks || !blocks.length) return null;
  const wrap = el('div');
  blocks.forEach((b) => {
    wrap.append(
      el('div', { class: 'block' },
        b.heading ? el('div', { class: 'block-heading' }, b.heading) : null,
        b.category && b.category !== b.heading ? el('div', { class: 'block-cat' }, b.category) : null,
        el('div', { class: 'rich', html: b.html }))
    );
  });
  return wrap;
}

function renderThemeCard(t, foreignSources) {
  let badge;
  if (t.nlHasIt && t.foreignHasIt) badge = el('span', { class: 'badge both' }, 'beide');
  else if (t.nlHasIt) badge = el('span', { class: 'badge nl-only' }, 'alleen NL');
  else badge = el('span', { class: 'badge foreign-only' }, 'ontbreekt bij NL');

  const details = el('details', { class: 'panel theme-card', ...(t.foreignHasIt && !t.nlHasIt ? { open: 'open' } : {}) });
  details.append(el('summary', {}, t.theme.label, badge));

  const cols = el('div', { class: 'compare-cols' + (foreignSources.length >= 2 ? ' cols-3' : '') });
  const nlCol = el('div', { class: 'compare-col' }, el('h4', {}, '🇳🇱 NederlandWereldwijd'));
  nlCol.append(t.nlHasIt ? renderBlocks(t.nl) : el('div', { class: 'empty-col' }, 'Niet apart behandeld in het Nederlandse reisadvies.'));
  cols.append(nlCol);

  foreignSources.forEach((fs) => {
    const entry = t.foreign[fs.id] || { blocks: [] };
    const col = el('div', { class: 'compare-col' }, el('h4', {}, `${fs.flag || ''} ${fs.label}`));
    col.append(entry.blocks?.length ? renderBlocks(entry.blocks) : el('div', { class: 'empty-col' }, 'Niet apart behandeld.'));
    cols.append(col);
  });
  details.append(cols);
  return details;
}

// ==========================================================================
// ZOEKEN
// ==========================================================================
const scopeHints = {
  nl: 'Doorzoekt alle Nederlandse reisadviezen. Toont per land waar iets over je zoekwoord staat.',
  foreign: 'Doorzoekt buitenlandse reisadviezen (FCDO). Let op: gebruik een Engelse term (bijv. "election" i.p.v. "verkiezingen").',
  both: 'Vergelijkt Nederlandse en buitenlandse reisadviezen op je zoekwoord. Tip: NL en FCDO zijn anderstalig; kies een term of vul een land in.',
};
$('#search-scope').addEventListener('change', (e) => {
  $('#search-hint').textContent = scopeHints[e.target.value] || '';
});
$('#search-hint').textContent = scopeHints.nl;

function searchInIndex(index, term, isoFilter) {
  const t = term.toLowerCase();
  const results = [];
  for (const entry of index) {
    if (isoFilter && entry.iso3 !== isoFilter) continue;
    const matches = [];
    for (const block of entry.blocks) {
      if (block.text && block.text.toLowerCase().includes(t)) {
        matches.push({
          category: block.category,
          heading: block.heading,
          theme: block.themeLabel || null,
          themeId: block.themeId,
          snippet: snippetAround(block.text, term),
        });
      }
    }
    const inSummary = entry.summaryText ? entry.summaryText.toLowerCase().includes(t) : false;
    if (matches.length || inSummary) {
      results.push({
        iso3: entry.iso3,
        name: entry.name,
        url: entry.url,
        color: entry.color ?? null,
        source: entry.source,
        sourceLabel: entry.sourceLabel,
        inSummary,
        summarySnippet: inSummary ? snippetAround(entry.summaryText, term) : null,
        matches,
        matchCount: matches.length + (inSummary ? 1 : 0),
      });
    }
  }
  results.sort((a, b) => b.matchCount - a.matchCount || a.name.localeCompare(b.name, 'nl'));
  return results;
}

$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#search-input').value.trim();
  const scope = $('#search-scope').value;
  const countryInput = $('#search-country').value.trim();
  const status = $('#search-status');
  const result = $('#search-result');
  if (!q) return;

  let iso = null;
  if (countryInput) {
    const c = resolveCountry(countryInput);
    if (!c) {
      status.className = 'status error';
      status.textContent = `Land “${countryInput}” niet gevonden.`;
      result.innerHTML = '';
      return;
    }
    iso = c.iso3;
  }

  status.className = 'status';
  status.innerHTML = `<span class="spinner"></span>Zoeken naar “${esc(q)}”…`;
  result.innerHTML = '';
  try {
    const out = { query: q, scope };
    if (scope === 'nl' || scope === 'both') {
      const idx = await loadJSON('search/nl.json');
      out.nl = searchInIndex(idx, q, iso);
    }
    if (scope === 'foreign' || scope === 'both') {
      const idx = await loadJSON('search/foreign.json');
      out.foreign = searchInIndex(idx, q, iso);
    }
    status.textContent = '';
    renderSearch(out, result, q);
  } catch (err) {
    status.className = 'status error';
    status.textContent = err.message;
  }
});

function renderCountryResult(r, term) {
  const details = el('details', { class: 'panel result-country' });
  details.append(
    el('summary', {},
      el('span', {}, r.color ? el('span', { class: `dot c-${r.color}`, title: COLOR_LABELS[r.color] }) : '', ' ' + r.name),
      el('span', { class: 'count-pill', style: 'margin-left:auto' }, `${r.matchCount}×`),
      el('a', { href: r.url, target: '_blank', rel: 'noopener', style: 'margin-left:10px;font-weight:400;font-size:13px', onclick: (ev) => ev.stopPropagation() }, 'origineel →'))
  );
  if (r.inSummary && r.summarySnippet) {
    details.append(el('div', { class: 'match' },
      el('div', { class: 'm-head' }, 'In het kort (samenvatting)'),
      el('div', { class: 'snippet', html: highlight(r.summarySnippet, term) })));
  }
  (r.matches || []).forEach((m) => {
    details.append(el('div', { class: 'match' },
      el('div', { class: 'm-head' },
        m.category && m.category !== m.heading ? `${m.category} › ` : '',
        el('strong', {}, m.heading),
        m.theme ? el('span', { class: 'm-theme' }, m.theme) : null),
      el('div', { class: 'snippet', html: highlight(m.snippet, term) })));
  });
  return details;
}

function renderSearch(data, root, term) {
  const frag = document.createDocumentFragment();
  const hasNl = Array.isArray(data.nl);
  const hasForeign = Array.isArray(data.foreign);

  if (hasNl && hasForeign) {
    const cols = el('div', { class: 'results-columns' });
    const left = el('div', {}, el('h3', { class: 'section-title' }, `🇳🇱 NederlandWereldwijd (${data.nl.length})`));
    if (!data.nl.length) left.append(el('p', { class: 'empty-col' }, 'Geen Nederlandse reisadviezen met deze term.'));
    data.nl.forEach((r) => left.append(renderCountryResult(r, term)));
    const right = el('div', {}, el('h3', { class: 'section-title' }, `🌍 Buitenland / FCDO (${data.foreign.length})`));
    if (!data.foreign.length) right.append(el('p', { class: 'empty-col' }, 'Geen buitenlandse reisadviezen met deze term (probeer een Engelse term).'));
    data.foreign.forEach((r) => right.append(renderCountryResult(r, term)));
    cols.append(left, right);
    frag.append(cols);
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
