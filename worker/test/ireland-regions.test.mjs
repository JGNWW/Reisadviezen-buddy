/**
 * Tests voor de Ierse (DFA) regio-uitsplitsing.
 *
 * Aanleiding: Ierland toonde verkeerde kleurcodes. Het landelijke niveau bleek
 * goed — de `security-status`-class kwam over 45 live gecontroleerde landen
 * exact overeen met wat de pagina in tekst zegt. De fout zat in de REGIONALE
 * uitsplitsing: DFA zet zijn adviezen onder het vaste kopje "General Travel
 * Advice", en dat kopje is drie woorden in TitleCase — precies genoeg om door
 * de "oogt als een eigennaam"-heuristiek te glippen. Zo verscheen bij 19
 * landen een rood of oranje "gebied" met de naam General Travel Advice, en bij
 * Georgië tilde dat het regionale maximum van 3 naar 4.
 *
 * De valkuil bij het repareren: datzelfde kopje was óók de poort waardoor de
 * sectie überhaupt op zinsniveau werd doorzocht. Het simpelweg weren als
 * regionaam zette de hele sectie dicht en kostte bij Ethiopië ruim twintig
 * échte regio's, en bij Colombia en Guinee-Bissau de waarschuwing helemaal.
 * Vandaar de driedeling die deze tests bewaken: geen nepnaam, sectie blijft
 * doorzocht, en het niveau blijft meetellen ook zonder noembaar gebied.
 *
 * Draaien: cd worker && node --test test/ireland-regions.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAdvisory } from '../src/analysis/analysis-engine.js';
import { headingRegion, STRUCTURAL_HEADING } from '../src/analysis/region-extractor.js';

const namen = (a) => (a.regionalBreakdown || []).map((r) => r.region);

test('structurele DFA-kopjes gelden niet als gebiedsnaam', () => {
  for (const h of ['General Travel Advice', 'Additional Information', 'Latest Travel Alert', 'Border security', 'Security Status', 'Embassy Contact']) {
    assert.equal(headingRegion(h, 'en'), null, `${h} zou geen regio mogen zijn`);
    assert.ok(STRUCTURAL_HEADING.test(h), `${h} hoort structureel te heten`);
  }
});

test('echte gebiedskoppen blijven gewoon een regio', () => {
  assert.equal(headingRegion('South Ossetia and Abkhazia', 'en'), 'South Ossetia and Abkhazia');
  assert.equal(headingRegion('Northern Kosovo', 'en'), 'Northern Kosovo');
});

test('"General Travel Advice" komt niet als gebied in de uitsplitsing', () => {
  const a = analyzeAdvisory({
    lang: 'en',
    structured: { kind: 'ie_security_status', value: 'normal' },
    sections: [
      { heading: 'Overview', text: 'Security Status: Normal Precautions.' },
      {
        heading: 'General Travel Advice',
        text: 'We recommend that you do not travel to these areas as there is no official border control.',
      },
    ],
  });
  assert.ok(!namen(a).includes('General Travel Advice'), `verzonnen gebied gevonden: ${JSON.stringify(namen(a))}`);
});

test('het niveau uit zo\'n sectie telt wél mee — anders verdwijnt de waarschuwing', () => {
  // Dit was het geval Colombia/Guinee-Bissau: het kopje weren als gebiedsnaam
  // liet er niets voor in de plaats, waardoor de bron ineens géén regionale
  // afwijking meer meldde. Het gebied is onbekend, het risico niet.
  const a = analyzeAdvisory({
    lang: 'en',
    structured: { kind: 'ie_security_status', value: 'high-caution' },
    sections: [
      { heading: 'Overview', text: 'Security Status: High Degree of Caution.' },
      { heading: 'Border security', text: 'Do not travel to the areas described in this section.' },
    ],
  });
  assert.equal(a.regionalMaxLevel, 4);
  assert.equal(a.hasRegionalWarnings, true);
  assert.deepEqual(namen(a), [], 'geen verzonnen gebied, wel de vlag');
});

test('regio\'s BINNEN een structurele sectie worden nog steeds gevonden', () => {
  // De belangrijkste regressietest: het kopje was ook de poort tot de sectie.
  // Werd die dichtgezet, dan verloor Ethiopië ruim twintig echte regio's.
  const a = analyzeAdvisory({
    lang: 'en',
    structured: { kind: 'ie_security_status', value: 'high-caution' },
    sections: [
      { heading: 'Overview', text: 'Security Status: High Degree of Caution.' },
      {
        heading: 'General Travel Advice',
        text: 'Avoid non-essential travel to the Tigray region.',
      },
    ],
  });
  assert.match(namen(a).join(' '), /Tigray/, `Tigray niet gevonden in ${JSON.stringify(namen(a))}`);
  assert.ok(!namen(a).includes('General Travel Advice'));
  // Het gebied levert zijn eigen niveau (3); de sectie wordt dus wel degelijk
  // nog op zinsniveau doorzocht.
  assert.equal(a.regionalMaxLevel, 3);
});

test('het landelijke niveau blijft dat van de security-status, niet van een regio', () => {
  // Ierland zet het landelijke oordeel in de class/tekst; een zwaardere
  // regionale melding mag dat nooit optillen.
  const a = analyzeAdvisory({
    lang: 'en',
    structured: { kind: 'ie_security_status', value: 'normal' },
    sections: [
      { heading: 'Overview', text: 'Security Status: Normal Precautions.' },
      { heading: 'South Ossetia and Abkhazia', text: 'Do not travel to these regions.' },
    ],
  });
  assert.equal(a.level, 1);
  assert.equal(a.color, 'groen');
  assert.equal(a.regionalMaxLevel, 4);
  assert.equal(a.hasRegionalWarnings, true);
});
