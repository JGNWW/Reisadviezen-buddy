/**
 * Contracttests voor de bron-adapters, tegen vaste fixtures (echte pagina's,
 * opgeslagen in test/fixtures/). Draaien offline en deterministisch — ze
 * bewaken dat een adapter uit bekende input de afgesproken vorm haalt:
 * een geldig niveau (of eerlijk "uncertain"), voldoende thema's, en koppen
 * zonder gelekte scriptcode. Als een bronsite z'n HTML verbouwt, halen we
 * nieuwe fixtures op en zien we hier meteen wat er stukgaat.
 *
 * Draaien: cd worker && node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ---- fetch-mock: elke URL wordt uit een fixture beantwoord -----------------
// Volgorde is belangrijk: specifieke routes vóór generieke (de-index).
const ROUTES = [
  ['gov.uk/api/content/foreign-travel-advice/nepal', 'uk-nepal.json'],
  ['nepal-travel-advisory.html', 'us-nepal.html'],
  ['index-alpha-eng.json', 'ca-index.json'],
  ['travel.gc.ca/destinations/nepal', 'ca-nepal.html'],
  ['a-z-list-of-countries/nepal', 'ie-nepal.html'],
  ['conseils-par-pays-destination/nepal', 'fr-nepal.html'],
  ['trc=Nepal', 'es-nepal.html'],
  ['opendata/travelwarning/221216', 'de-nepal.json'],
  ['opendata/travelwarning', 'de-index.json'],
  ['safetravel.govt.nz/destinations/nepal', 'nz-nepal.html'],
  ['rejsevejledninger/nepal', 'dk-nepal.html'],
];

globalThis.fetch = async (url) => {
  const u = String(url);
  const hit = ROUTES.find(([frag]) => u.includes(frag));
  if (!hit) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
  const body = readFileSync(new URL(`./fixtures/${hit[1]}`, import.meta.url), 'utf8');
  return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
};

// Adapters pas ná de mock importeren.
const ADAPTERS = [
  ['uk', (await import('../src/adapters/uk.js')), 'nepal'],
  ['us', (await import('../src/adapters/us.js')), 'nepal'],
  ['ca', (await import('../src/adapters/canada.js')), { iso2: 'NP', id: 205000, slug: 'nepal' }],
  ['ie', (await import('../src/adapters/ireland.js')), 'nepal'],
  ['fr', (await import('../src/adapters/france.js')), 'nepal'],
  ['es', (await import('../src/adapters/spain.js')), 'Nepal'],
  ['de', (await import('../src/adapters/germany.js')), 'NPL'],
  ['nz', (await import('../src/adapters/newzealand.js')), 'nepal'],
  ['dk', (await import('../src/adapters/denmark.js')), 'nepal'],
];

const CODE_HEADING = /querySelector|shadowRoot|innerHTML|function\s*\(|=>|[{};$]|document\.|window\./;

for (const [id, adapter, arg] of ADAPTERS) {
  test(`adapter ${id}: levert een geldig advies uit de fixture`, async () => {
    const adv = await adapter.getAdvisory(arg);
    assert.ok(adv, `${id}: getAdvisory gaf null`);
    assert.equal(typeof adv.url, 'string');

    // Niveau: 1..4 of een eerlijke "uncertain" — nooit iets ertussenin.
    if (adv.assessmentStatus === 'uncertain') {
      assert.equal(adv.level, null, `${id}: uncertain hoort geen niveau te hebben`);
    } else {
      assert.ok(adv.level >= 1 && adv.level <= 4, `${id}: niveau ${adv.level} buiten 1..4`);
      assert.ok(['groen', 'geel', 'oranje', 'rood'].includes(adv.color), `${id}: kleur ${adv.color}`);
    }

    // Inhoud: voldoende secties, met schone koppen (geen gelekte scripts).
    assert.ok(adv.themes.length >= 3, `${id}: maar ${adv.themes.length} thema's`);
    for (const t of adv.themes) {
      assert.ok(t.heading.length <= 140, `${id}: verdacht lange kop: ${t.heading.slice(0, 60)}…`);
      assert.ok(!CODE_HEADING.test(t.heading), `${id}: code in kop: ${t.heading.slice(0, 60)}…`);
    }
    assert.ok(adv.fullText.length > 200, `${id}: fullText verdacht kort`);

    // Datum, indien aanwezig, in yyyy-mm-dd-achtige vorm.
    if (adv.lastModified) {
      assert.match(String(adv.lastModified), /^\d{4}-\d{2}-\d{2}/, `${id}: datum ${adv.lastModified}`);
    }
  });
}

// ---- Pure functies van het snapshot-script ---------------------------------
const { indexTokens } = await import('../scripts/snapshot-foreign.mjs');

test('indexTokens: normaliseert, filtert en vouwt slot-s', () => {
  const t = indexTokens('Earthquakes and EARTHQUAKE près de Katmandou; the of and.');
  assert.ok(t.has('earthquake'), 'enkelvoud/meervoud gevouwen');
  assert.ok(!t.has('earthquakes'));
  assert.ok(t.has('katmandou'), 'diakrieten genormaliseerd');
  assert.ok(!t.has('the') && !t.has('of'), 'korte woorden weg');
});
