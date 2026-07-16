/**
 * Contracttests voor de bron-adapters, tegen vaste fixtures (echte pagina's,
 * opgeslagen in test/fixtures/). Draaien offline en deterministisch — ze
 * bewaken dat een adapter uit bekende input de afgesproken vorm haalt:
 * een geldig niveau (of eerlijk "uncertain"), voldoende thema's, en koppen
 * zonder gelekte scriptcode. Als een bronsite z'n HTML verbouwt, halen we
 * nieuwe fixtures op en zien we hier meteen wat er stukgaat.
 *
 * Draaien: cd worker && node --test test/analysis.test.mjs test/contract.test.mjs test/coverage.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFixtureFetch } from './fixtures.mjs';

// fetch-mock: elke URL wordt uit een fixture beantwoord (zie fixtures.mjs).
installFixtureFetch();

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
  ['jp', (await import('../src/adapters/japan.js')), '010'],
  ['it', (await import('../src/adapters/italy.js')), 'NPL'],
  ['fi', (await import('../src/adapters/finland.js')), 'NP'],
  // KR/NO/AT-fixtures zijn Afghanistan — Nepal vergde daar een extra mapping-fetch.
  ['kr', (await import('../src/adapters/southkorea.js')), '284'],
  ['no', (await import('../src/adapters/norway.js')), 'afghanistan/2415875'],
  ['at', (await import('../src/adapters/austria.js')), 'afghanistan'],
];

// Minimaal aantal thema's per adapter. Oorlogslanden hebben bij BMEIA een
// ingeklapte sectieset (alleen Sicherheitsstufe + Sicherheit & Kriminalität).
const MIN_THEMES = { at: 2 };

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
    assert.ok(adv.themes.length >= (MIN_THEMES[id] ?? 3), `${id}: maar ${adv.themes.length} thema's`);
    for (const t of adv.themes) {
      assert.ok(t.heading.length <= 140, `${id}: verdacht lange kop: ${t.heading.slice(0, 60)}…`);
      assert.ok(!CODE_HEADING.test(t.heading), `${id}: code in kop: ${t.heading.slice(0, 60)}…`);
      // Als een site-template verandert en de content-selector niet meer
      // matcht, valt de scraper soms terug op de HELE pagina (nav, <head>,
      // scripts) i.p.v. alleen de brontekst — dat is precies gebeurd bij een
      // eerdere versie van de US-adapter na een sitewijziging.
      assert.ok(!/<!DOCTYPE|<html[\s>]|<head[\s>]|<script[\s>]/i.test(t.text),
        `${id}: pagina-HTML gelekt in tekst (kop "${t.heading}"): ${t.text.slice(0, 80)}…`);
    }
    assert.ok(adv.fullText.length > 200, `${id}: fullText verdacht kort`);

    // Datum, indien aanwezig, in yyyy-mm-dd-achtige vorm.
    if (adv.lastModified) {
      assert.match(String(adv.lastModified), /^\d{4}-\d{2}-\d{2}/, `${id}: datum ${adv.lastModified}`);
    }

    // DE: de URL moet naar de "Reise- und Sicherheitshinweise"-pagina zelf
    // wijzen (slug + opendata-content-ID), niet naar de politieke landen-
    // pagina (/de/aussenpolitik/laender/{slug}-node) waar het advies níet
    // staat. Slugpatroon: kleine letters, umlauten getranslitereerd, geen
    // koppeltekens/spaties — eerder gaf een naïeve toLowerCase() een 404.
    if (id === 'de') {
      assert.match(adv.url, /^https:\/\/www\.auswaertiges-amt\.de\/de\/service\/laender\/[a-z0-9]+-node\/[a-z0-9]+sicherheit-\d+$/,
        `${id}: onverwachte URL-vorm ${adv.url}`);
    }

    // UK: GOV.UK verdeelt één advies over meerdere sub-pagina's (één per
    // "part", bijv. .../nepal/safety-and-security) — elk thema hoort naar
    // zíjn eigen sub-pagina te linken, niet allemaal naar de hoofdpagina,
    // anders matcht een Text-Fragment-deeplink de tekst niet.
    if (id === 'uk') {
      const urls = new Set(adv.themes.map((t) => t.url));
      assert.ok(urls.size > 1, `${id}: alle thema's linken naar dezelfde URL (${[...urls]})`);
      for (const t of adv.themes) {
        assert.match(t.url, /^https:\/\/www\.gov\.uk\/foreign-travel-advice\/nepal(\/[a-z0-9-]+)?$/,
          `${id}: onverwachte thema-URL ${t.url}`);
      }
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
