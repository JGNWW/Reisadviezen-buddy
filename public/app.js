'use strict';

// ---- Helpers --------------------------------------------------------------
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

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fout ${res.status}`);
  return data;
}

function highlight(text, term) {
  if (!term) return esc(text);
  const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return esc(text).replace(re, '<mark>$1</mark>');
}

// ---- Tabs -----------------------------------------------------------------
$$('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${t.dataset.view}`));
  })
);

// ---- Bootstrap: landen + bronnen -----------------------------------------
let SOURCES = [];
async function bootstrap() {
  const [countries, sources] = await Promise.all([api('/api/countries'), api('/api/sources')]);
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
}

// ---- Compare view ---------------------------------------------------------
$('#compare-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const country = $('#country-input').value.trim();
  const sources = $$('#source-toggles input:checked').map((i) => i.value);
  const status = $('#compare-status');
  const result = $('#compare-result');
  if (!country) return;
  if (!sources.length) {
    status.className = 'status error';
    status.textContent = 'Kies minstens één land om mee te vergelijken.';
    return;
  }
  status.className = 'status';
  status.innerHTML = `<span class="spinner"></span>Reisadviezen ophalen voor ${esc(country)}…`;
  result.innerHTML = '';
  try {
    const data = await api(`/api/compare/${encodeURIComponent(country)}?sources=${sources.join(',')}`);
    status.textContent = '';
    renderComparison(data, result);
  } catch (err) {
    status.className = 'status error';
    status.textContent = err.message;
  }
});

function colorBadge(color) {
  if (!color) return el('span', { class: 'empty-col' }, 'geen kleurcode gevonden');
  return el(
    'span',
    { class: `color-badge c-${color}` },
    el('span', { class: 'dot' }),
    COLOR_LABELS[color] || color
  );
}

function renderComparison(data, root) {
  const nl = data.nl;
  const cc = data.colorComparison;
  const frag = document.createDocumentFragment();

  // Kop
  frag.append(
    el(
      'div',
      { class: 'result-head' },
      el('h2', {}, `${data.country.nl}`),
      el('p', { class: 'meta' }, nl.modificationDate || `Laatst gewijzigd: ${(nl.lastModified || '').slice(0, 10)}`)
    )
  );

  // Melding als een bron geen advies heeft voor dit land
  if (data.unavailable && data.unavailable.length) {
    frag.append(
      el(
        'div',
        { class: 'callout', style: 'background:#eef4fb;border-color:#b9d3ef;border-left-color:var(--nl-blue)' },
        el('h3', { style: 'color:var(--nl-blue)' }, 'ℹ️ Geen buitenlands advies beschikbaar'),
        el(
          'p',
          { style: 'margin:0' },
          `Voor ${data.country.nl} is geen los reisadvies gevonden bij: ` +
            data.unavailable.map((u) => u.label).join(', ') + '.'
        )
      )
    );
  }

  // Kleurcode-vergelijking
  const colorsGrid = el('div', { class: 'colors-grid' });
  const nlCard = el(
    'div',
    { class: 'panel color-card' },
    el('h3', {}, '🇳🇱 NederlandWereldwijd'),
    colorBadge(cc.nl.overall),
    cc.nl.overall ? el('div', { class: 'color-note' }, COLOR_MEANING[cc.nl.overall]) : null
  );
  if (cc.nl.colors && cc.nl.colors.length) {
    const ul = el('ul', { class: 'color-contexts' });
    cc.nl.colors.forEach((c) =>
      ul.append(el('li', {}, el('strong', {}, `${COLOR_LABELS[c.color]}: `), c.context))
    );
    nlCard.append(ul);
  }
  colorsGrid.append(nlCard);

  cc.foreign.forEach((f) => {
    colorsGrid.append(
      el(
        'div',
        { class: 'panel color-card' },
        el('h3', {}, `${f.flag || ''} ${f.label}`),
        el(
          'span',
          {},
          colorBadge(f.mappedColor),
          el('span', { class: 'approx-tag', title: 'Vertaald naar de Nederlandse kleurenschaal' }, 'benadering')
        ),
        el('div', { class: 'color-note' }, `Grondslag: ${f.basis}`),
        f.alertStatus && f.alertStatus.length
          ? el('div', { class: 'color-note' }, `Waarschuwing: ${f.alertStatus.join(', ')}`)
          : null,
        el('div', { class: 'color-note' }, el('a', { href: f.url, target: '_blank', rel: 'noopener' }, 'Bekijk origineel reisadvies →'))
      )
    );
  });
  frag.append(el('h3', { class: 'section-title' }, 'Kleurcodes'), colorsGrid);

  // Kaarten naast elkaar
  const mapsGrid = el('div', { class: 'maps-grid' });
  mapsGrid.append(
    el(
      'figure',
      { class: 'map-box' },
      el('img', { src: `/api/nl/${data.country.iso3}/map?type=standard`, alt: `Kaart reisadvies ${data.country.nl}` }),
      el('figcaption', {}, '🇳🇱 NederlandWereldwijd')
    )
  );
  data.foreign.forEach((f) => {
    mapsGrid.append(
      el(
        'figure',
        { class: 'map-box' },
        el(
          'div',
          { class: 'map-missing' },
          `${f.flag || ''} ${f.sourceLabel} publiceert geen losse kaartafbeelding via de open data. `,
          el('a', { href: f.url, target: '_blank', rel: 'noopener' }, 'Bekijk de kaart op de bronpagina →')
        )
      )
    );
  });
  frag.append(el('h3', { class: 'section-title' }, 'Kaarten'), mapsGrid);

  // Wat vermelden andere landen wel en wij niet?
  const tc = data.themeComparison;
  if (tc.missingFromNl.length) {
    const ul = el('ul');
    tc.missingFromNl.forEach((m) => {
      const srcs = Object.entries(m.foreign)
        .filter(([, v]) => v.blocks.length)
        .map(([, v]) => v.label);
      ul.append(
        el('li', {}, el('strong', {}, m.theme.label), ' ', el('span', { class: 'src' }, `— wel behandeld door ${srcs.join(', ')}`))
      );
    });
    frag.append(
      el(
        'div',
        { class: 'callout' },
        el('h3', {}, '💡 Thema’s die andere landen wél noemen en NederlandWereldwijd niet'),
        ul
      )
    );
  }

  // Thema-voor-thema vergelijking
  frag.append(el('h3', { class: 'section-title' }, 'Vergelijking per thema'));
  const foreignSources = data.foreign.map((f) => ({ id: f.source, label: f.sourceLabel, flag: f.flag }));
  let lastGroup = null;
  tc.themes.forEach((t) => {
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
      el(
        'div',
        { class: 'block' },
        b.heading ? el('div', { class: 'block-heading' }, b.heading) : null,
        b.category && b.category !== b.heading ? el('div', { class: 'block-cat' }, b.category) : null,
        el('div', { class: 'rich', html: b.html })
      )
    );
  });
  return wrap;
}

function renderThemeCard(t, foreignSources) {
  const nlHas = t.nlHasIt;
  const forHas = t.foreignHasIt;
  let badge;
  if (nlHas && forHas) badge = el('span', { class: 'badge both' }, 'beide');
  else if (nlHas) badge = el('span', { class: 'badge nl-only' }, 'alleen NL');
  else badge = el('span', { class: 'badge foreign-only' }, 'ontbreekt bij NL');

  const details = el('details', { class: 'panel theme-card', ...(forHas && !nlHas ? { open: 'open' } : {}) });
  details.append(el('summary', {}, t.theme.label, badge));

  const cols = el('div', { class: 'compare-cols' + (foreignSources.length >= 2 ? ' cols-3' : '') });

  // NL-kolom
  const nlCol = el('div', { class: 'compare-col' }, el('h4', {}, '🇳🇱 NederlandWereldwijd'));
  nlCol.append(nlHas ? renderBlocks(t.nl) : el('div', { class: 'empty-col' }, 'Niet apart behandeld in het Nederlandse reisadvies.'));
  cols.append(nlCol);

  // Buitenlandse kolommen
  foreignSources.forEach((fs) => {
    const entry = t.foreign[fs.id] || { blocks: [] };
    const col = el('div', { class: 'compare-col' }, el('h4', {}, `${fs.flag || ''} ${fs.label}`));
    if (entry.blocks && entry.blocks.length) {
      col.append(renderBlocks(entry.blocks));
    } else {
      col.append(
        el('div', { class: 'empty-col' + (nlHas ? '' : '') }, 'Niet apart behandeld.')
      );
    }
    cols.append(col);
  });

  details.append(cols);
  return details;
}

// ---- Search view ----------------------------------------------------------
const scopeHints = {
  nl: 'Doorzoekt alle Nederlandse reisadviezen. Toont per land waar iets over je zoekwoord staat.',
  foreign:
    'Doorzoekt buitenlandse reisadviezen (FCDO). Let op: gebruik een Engelse term (bijv. "election" i.p.v. "verkiezingen").',
  both:
    'Vergelijkt Nederlandse en buitenlandse reisadviezen op je zoekwoord. Tip: NL en FCDO zijn anderstalig; kies een term of vul een land in.',
};
$('#search-scope').addEventListener('change', (e) => {
  $('#search-hint').textContent = scopeHints[e.target.value] || '';
});
$('#search-hint').textContent = scopeHints.nl;

$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#search-input').value.trim();
  const scope = $('#search-scope').value;
  const country = $('#search-country').value.trim();
  const status = $('#search-status');
  const result = $('#search-result');
  if (!q) return;
  status.className = 'status';
  status.innerHTML = `<span class="spinner"></span>Zoeken naar “${esc(q)}”…${scope !== 'nl' ? ' (buitenlandse adviezen kunnen even duren)' : ''}`;
  result.innerHTML = '';
  try {
    const params = new URLSearchParams({ q, scope });
    if (country) params.set('country', country);
    const data = await api(`/api/search?${params}`);
    status.textContent = '';
    renderSearch(data, result, q);
  } catch (err) {
    status.className = 'status error';
    status.textContent = err.message;
  }
});

function renderCountryResult(r, term, sourceLabel) {
  const details = el('details', { class: 'panel result-country' });
  const summary = el(
    'summary',
    {},
    el('span', {}, r.color ? el('span', { class: `dot c-${r.color}`, title: COLOR_LABELS[r.color] }) : '', ' ' + r.name),
    el('span', { class: 'count-pill', style: 'margin-left:auto' }, `${r.matchCount}×`),
    el('a', { href: r.url, target: '_blank', rel: 'noopener', style: 'margin-left:10px;font-weight:400;font-size:13px', onclick: (ev) => ev.stopPropagation() }, 'origineel →')
  );
  details.append(summary);

  if (r.inSummary && r.summarySnippet) {
    details.append(
      el(
        'div',
        { class: 'match' },
        el('div', { class: 'm-head' }, 'In het kort (samenvatting)'),
        el('div', { class: 'snippet', html: highlight(r.summarySnippet, term) })
      )
    );
  }
  (r.matches || []).forEach((m) => {
    details.append(
      el(
        'div',
        { class: 'match' },
        el(
          'div',
          { class: 'm-head' },
          m.category && m.category !== m.heading ? `${m.category} › ` : '',
          el('strong', {}, m.heading),
          m.theme ? el('span', { class: 'm-theme' }, m.theme) : null
        ),
        el('div', { class: 'snippet', html: highlight(m.snippet, term) })
      )
    );
  });
  return details;
}

function renderSearch(data, root, term) {
  const frag = document.createDocumentFragment();
  const hasNl = Array.isArray(data.nl);
  const hasForeign = Array.isArray(data.foreign);

  if (hasNl && hasForeign) {
    // Vergelijkingsweergave in twee kolommen
    const cols = el('div', { class: 'results-columns' });
    const left = el('div', {}, el('h3', { class: 'section-title' }, `🇳🇱 NederlandWereldwijd (${data.nl.length})`));
    if (!data.nl.length) left.append(el('p', { class: 'empty-col' }, 'Geen Nederlandse reisadviezen met deze term.'));
    data.nl.forEach((r) => left.append(renderCountryResult(r, term)));

    const right = el('div', {}, el('h3', { class: 'section-title' }, `🌍 Buitenland / FCDO (${data.foreign.length})`));
    if (!data.foreign.length) right.append(el('p', { class: 'empty-col' }, 'Geen buitenlandse reisadviezen met deze term (probeer een Engelse term).'));
    data.foreign.forEach((r) => right.append(renderCountryResult(r, term, r.sourceLabel)));

    cols.append(left, right);
    frag.append(cols);
  } else if (hasNl) {
    frag.append(el('h3', { class: 'section-title' }, `Gevonden in ${data.nl.length} Nederlands(e) reisadvies/reisadviezen`));
    if (!data.nl.length) frag.append(el('p', { class: 'empty-col' }, 'Geen resultaten.'));
    data.nl.forEach((r) => frag.append(renderCountryResult(r, term)));
  } else if (hasForeign) {
    frag.append(el('h3', { class: 'section-title' }, `Gevonden in ${data.foreign.length} buitenlands(e) reisadvies/reisadviezen`));
    if (!data.foreign.length) frag.append(el('p', { class: 'empty-col' }, 'Geen resultaten (probeer een Engelse term).'));
    data.foreign.forEach((r) => frag.append(renderCountryResult(r, term, r.sourceLabel)));
  }
  root.append(frag);
}

// ---- Init -----------------------------------------------------------------
bootstrap().catch((e) => {
  $('#compare-status').className = 'status error';
  $('#compare-status').textContent = 'Kan landenlijst niet laden: ' + e.message;
});
