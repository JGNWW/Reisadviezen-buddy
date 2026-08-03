/**
 * Tests voor de Noorse reisadvies-RSS (src/lib/norway-rss.js).
 *
 * Achtergrond: regjeringen.no blokkeert elk datacenter-IP met een
 * Cloudflare-challenge — curl, de reader-proxy, de reader met browser-engine en
 * een volledige headless Chromium stuiten er allemaal op. Noorwegen ontbreekt
 * daardoor volledig in Recente wijzigingen. De feed is de enige route die geen
 * adviespagina hoeft te openen.
 *
 * De fixture is een echt fragment van die feed (zes items), zodat de
 * verrassingen van het formaat vastliggen: guid als paginanummer, adresvormen
 * die per land verschillen, en Noorse tekst met æ/ø/å.
 *
 * Draaien: cd worker && node --test test/norway-rss.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseNorwayFeed, matchToCountries, diffFeed } from '../src/lib/norway-rss.js';
import { classifyTheme } from '../src/lib/themes.js';
import countries from '../src/data/countries.json' with { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const XML = readFileSync(path.join(__dirname, 'fixtures', 'norway-rss.xml'), 'utf8');

test('leest de items met datum, samenvatting en paginanummer', () => {
  const items = parseNorwayFeed(XML);
  assert.equal(items.length, 6);
  const tonga = items.find((i) => i.country === 'Tonga');
  assert.ok(tonga, 'Tonga verwacht');
  assert.equal(tonga.guid, '2415548');
  assert.match(tonga.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(tonga.summary.length > 40, `samenvatting te kort: "${tonga.summary}"`);
  // De titel "Tonga - reiseinformasjon" hoort tot de landnaam teruggebracht.
  assert.equal(tonga.title.includes('reiseinformasjon'), true);
  assert.equal(tonga.country.includes('reiseinformasjon'), false);
});

test('haalt de slug uit de link in plaats van hem te verzinnen', () => {
  // Niet elk land heeft de vorm reiseinfo_{land}: er bestaan ook
  // bahrain_reiseinfo, qatar_reiseinformasjon en reiseinformasjon-for-ghana.
  // Daarom komt de slug uit de link zelf.
  for (const it of parseNorwayFeed(XML)) {
    assert.ok(it.slug, `geen slug voor ${it.country}`);
    assert.ok(it.link.includes(it.slug), `slug "${it.slug}" hoort in ${it.link}`);
  }
});

test('koppelt op paginanummer aan een ISO3, niet op naam', () => {
  const { gekoppeld, ongekoppeld } = matchToCountries(parseNorwayFeed(XML), countries);
  assert.equal(ongekoppeld.length, 0, `niet gekoppeld: ${ongekoppeld.map((o) => o.country).join(', ')}`);
  assert.deepEqual(gekoppeld.map((g) => g.iso3).sort(), ['CAN', 'SLB', 'TON', 'TUR', 'TUV', 'VUT']);
});

test('de samenvattingen vallen in een categorie', () => {
  // De feed noemt natuurgeweld in het Noors (skogbranner, sykloner,
  // jordskjelv). Zonder die woorden in de trefwoordenlijst zou hier niets
  // uitkomen — dit bewaakt dat de Noorse termen erin blijven.
  const items = parseNorwayFeed(XML);
  const turkije = items.find((i) => i.country === 'Tyrkia');
  assert.equal(classifyTheme(turkije.country, turkije.summary), 'natuurgeweld');
  const zonder = items.filter((i) => !classifyTheme(i.country, i.summary));
  assert.ok(zonder.length <= 1, `te veel zonder categorie: ${zonder.map((z) => z.country).join(', ')}`);
});

test('eerste keer meldt niets, daarna alleen echte verschillen', () => {
  const { gekoppeld } = matchToCountries(parseNorwayFeed(XML), countries);
  const eerste = diffFeed(gekoppeld, {});
  assert.deepEqual(eerste.wijzigingen, [], 'eerste run mag geen 100 "wijzigingen" opleveren');
  assert.equal(Object.keys(eerste.volgende).length, 6);

  // Ongewijzigd draaien → stilte.
  assert.deepEqual(diffFeed(gekoppeld, eerste.volgende).wijzigingen, []);

  // Nieuwe datum → melding met datum-bewijs.
  const nieuwerDatum = gekoppeld.map((g) => (g.iso3 === 'CAN' ? { ...g, date: '2026-08-02' } : g));
  const d1 = diffFeed(nieuwerDatum, eerste.volgende).wijzigingen;
  assert.equal(d1.length, 1);
  assert.equal(d1[0].iso3, 'CAN');
  assert.equal(d1[0].evidence, 'date');

  // Zelfde datum, andere tekst → melding met inhoud-bewijs.
  const andereTekst = gekoppeld.map((g) => (g.iso3 === 'TON' ? { ...g, summary: 'Iets heel anders.' } : g));
  const d2 = diffFeed(andereTekst, eerste.volgende).wijzigingen;
  assert.equal(d2.length, 1);
  assert.equal(d2[0].iso3, 'TON');
  assert.equal(d2[0].evidence, 'content');
});

test('een lege of kapotte feed levert geen brokken op', () => {
  assert.deepEqual(parseNorwayFeed(''), []);
  assert.deepEqual(parseNorwayFeed('<rss><channel></channel></rss>'), []);
  assert.deepEqual(parseNorwayFeed(null), []);
});
