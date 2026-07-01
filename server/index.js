import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as nlSource from './sources/nl.js';
import * as ukSource from './sources/uk.js';
import { allCountries, getCountryByIso, resolveCountry, getUkSlug } from './lib/countries.js';
import { buildThemeComparison, buildColorComparison } from './lib/compare.js';
import { THEMES } from './lib/themes.js';
import {
  searchNl,
  searchForeign,
  ensureNlIndex,
  nlIndexStatus,
} from './lib/search.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Beschikbare buitenlandse bronnen (uitbreidbaar).
const FOREIGN_SOURCES = { uk: ukSource };

const asyncH = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  res.status(502).json({ error: String(err?.message || err) });
});

// ---- Metadata -------------------------------------------------------------

app.get('/api/countries', (req, res) => {
  res.json(allCountries());
});

app.get('/api/themes', (req, res) => {
  res.json(THEMES.map((t) => ({ id: t.id, label: t.label, group: t.group })));
});

app.get('/api/sources', (req, res) => {
  res.json(
    Object.values(FOREIGN_SOURCES).map((s) => ({
      id: s.meta.id,
      label: s.meta.label,
      flag: s.meta.flag,
    }))
  );
});

// ---- Losse reisadviezen ---------------------------------------------------

app.get('/api/nl/:country', asyncH(async (req, res) => {
  const rec = resolveCountry(req.params.country);
  if (!rec) return res.status(404).json({ error: 'Land niet gevonden' });
  const adv = await nlSource.getAdvisory(rec.iso3);
  res.json(adv);
}));

app.get('/api/nl/:country/map', asyncH(async (req, res) => {
  const rec = resolveCountry(req.params.country);
  if (!rec) return res.status(404).end();
  const { buffer, contentType } = await nlSource.fetchMap(
    rec.iso3,
    req.query.type === 'legend' ? 'legend' : 'standard'
  );
  res.set('Content-Type', contentType);
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(buffer);
}));

// ---- Vergelijking ---------------------------------------------------------

app.get('/api/compare/:country', asyncH(async (req, res) => {
  const rec = resolveCountry(req.params.country);
  if (!rec) return res.status(404).json({ error: 'Land niet gevonden' });

  const sourceIds = (req.query.sources || 'uk')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => FOREIGN_SOURCES[s]);

  const nl = await nlSource.getAdvisory(rec.iso3);

  const foreignList = [];
  const unavailable = [];
  for (const sid of sourceIds) {
    const src = FOREIGN_SOURCES[sid];
    let slug = null;
    if (sid === 'uk') slug = getUkSlug(rec.iso3);
    const adv = slug ? await src.getAdvisory(slug) : null;
    if (adv) foreignList.push(adv);
    else unavailable.push({ source: sid, label: src.meta.label });
  }

  res.json({
    country: { iso3: rec.iso3, nl: rec.nl, en: rec.en },
    nl,
    foreign: foreignList,
    unavailable,
    colorComparison: buildColorComparison(nl, foreignList),
    themeComparison: buildThemeComparison(nl, foreignList),
  });
}));

// ---- Zoeken ---------------------------------------------------------------

app.get('/api/search/status', (req, res) => {
  res.json({ nl: nlIndexStatus() });
});

app.get('/api/search', asyncH(async (req, res) => {
  const q = (req.query.q || '').trim();
  const scope = req.query.scope || 'nl'; // nl | foreign | both
  const countryParam = req.query.country;
  if (!q) return res.status(400).json({ error: 'Geef een zoekwoord of thema op (q).' });

  let country = null;
  if (countryParam) {
    country = resolveCountry(countryParam);
    if (!country) return res.status(404).json({ error: 'Land niet gevonden' });
  }

  const out = { query: q, scope };

  if (scope === 'nl' || scope === 'both') {
    const nlResults = await searchNl(q);
    out.nl = country ? nlResults.filter((r) => r.iso3 === country.iso3) : nlResults;
  }
  if (scope === 'foreign' || scope === 'both') {
    out.foreign = await searchForeign(q, { iso3: country?.iso3 || null });
  }

  res.json(out);
}));

// ---- Statische frontend ---------------------------------------------------

app.use(express.static(join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`Reisadviezen-buddy draait op http://localhost:${PORT}`);
  // Bouw de NL-zoekindex alvast op de achtergrond op.
  ensureNlIndex()
    .then((idx) => console.log(`NL-zoekindex gereed: ${idx.byIso.size} landen.`))
    .catch((e) => console.warn('NL-zoekindex opbouwen mislukt (wordt later opnieuw geprobeerd):', e.message));
});

export default app;
