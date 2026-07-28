/**
 * Tests voor de Duitse gebiedsherkenning (Auswärtiges Amt).
 *
 * Aanleiding: Koeweit kreeg naast het terechte rood ook een oranje gebied te
 * zien. Dat "gebied" heette "Sicherheit" — een vaste sectiekop van het AA, die
 * als TitleCase-eigennaam door de regioheuristiek glipte. Hetzelfde gebeurde
 * met "Innenpolitische Lage", "Infrastruktur/Verkehr" en "Terrorismus", en bij
 * Oostenrijk met "Sicherheit & Kriminalität".
 *
 * Twee dingen moeten daarom tegelijk waar zijn, en dat is precies de val waar
 * de Ierse fix eerder in liep: zo'n kop mag géén gebiedsnaam opleveren, maar
 * de sectie eronder moet wél doorzocht blijven — daar staan de échte gebieden
 * in (Egypte: Sinaï, de grensgebieden met Libië en Soedan).
 *
 * Daarnaast de niveautrap: het AA gebruikt "abgeraten" (oranje) en "dringend
 * abgeraten" (rood) als bewust verschillende trappen, ook binnen één advies.
 *
 * Draaien: cd worker && node --test test/de-regions.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAdvisory } from '../src/analysis/analysis-engine.js';
import { headingRegion, STRUCTURAL_HEADING } from '../src/analysis/region-extractor.js';
import { findSeverity } from '../src/analysis/severity-detector.js';

const namen = (a) => (a.regionalBreakdown || []).map((r) => r.region);

test('vaste AA-kopjes zijn geen gebiedsnaam', () => {
  for (const h of ['Sicherheit', 'Innenpolitische Lage', 'Infrastruktur/Verkehr', 'Terrorismus',
    'Sicherheit & Kriminalität', 'Weiterreise in Nachbarländer/Grenzübergänge', 'Aktuelles',
    'Übrige Landesteile', 'Landminen']) {
    assert.equal(headingRegion(h, 'de'), null, `"${h}" zou geen gebied mogen zijn`);
    assert.ok(STRUCTURAL_HEADING.test(h), `"${h}" hoort structureel te heten`);
  }
});

test('echte Duitse gebiedskoppen blijven gewoon een gebied', () => {
  assert.equal(headingRegion('Sinai-Halbinsel', 'de'), 'Sinai-Halbinsel');
  assert.equal(headingRegion('Südosten und Osten', 'de'), 'Südosten und Osten');
});

test('gebieden BINNEN een vaste sectie worden nog steeds gevonden', () => {
  // De kern: de kop weren als gebiedsnaam mag de sectie niet dichtzetten.
  const a = analyzeAdvisory({
    lang: 'de',
    sections: [
      { heading: 'Aktuelles', text: 'Die Lage ist unübersichtlich und kann sich kurzfristig ändern.' },
      {
        heading: 'Sicherheit',
        text: 'Von Reisen in das Grenzgebiet zu Libyen wird dringend abgeraten. Die Lage bleibt angespannt.',
      },
    ],
  });
  assert.match(namen(a).join(' '), /Libyen/, `grensgebied niet gevonden in ${JSON.stringify(namen(a))}`);
  assert.ok(!namen(a).includes('Sicherheit'), 'de sectiekop mag geen gebied worden');
  assert.equal(a.regionalMaxLevel, 4);
});

test('"dringend abgeraten" telt als zwaarste, ook in een lange opsomming', () => {
  // Dit ging eerder mis: de Duitse zin met "dringend" is te lang voor het
  // patroon dat de Zwitserse EDA-vorm afvangt, en viel daardoor terug op de
  // milde trap (3). De "dringend"-regel staat nu vóór dat patroon.
  const lang = 'Von Reisen in das unmittelbare syrisch-jordanische Grenzgebiet sowie in den '
    + 'Nordosten des Landes, nach Aqaba und in die Grenzregion zu Irak wird dringend abgeraten.';
  assert.equal(findSeverity(lang, 'de')?.level, 4);
  assert.equal(findSeverity('Von Reisen wird dringend abgeraten.', 'de')?.level, 4);
  // NB: de trap "abgeraten = oranje" is Duits-specifiek en zit daarom in
  // classifyGermanNational (zie de-classify.test.mjs); de gedeelde ladder wordt
  // ook door de Zwitserse EDA gebruikt, waar "wird abgeraten" juist het
  // zwaarste niveau is.
});

test('de formele Reisewarnung blijft het zwaarst', () => {
  assert.equal(findSeverity('Vor Reisen in dieses Gebiet wird gewarnt.', 'de')?.level, 4);
  assert.equal(findSeverity('Es besteht eine Reisewarnung für das Land.', 'de')?.level, 4);
});
