/**
 * Tests voor de kaart-kleurwaardering (src/analysis/map-palette.js).
 *
 * De vijf ijk-vectoren zijn de ECHTE pixel-tellingen die de proef-run tegen
 * de France-Diplomatie-zonekaarten opleverde (CI-run #3, handmatig
 * geverifieerd tegen de kaarten): Irak, Oekraïne, Mali, Thailand, Japan. Ze
 * leggen het gewenste gedrag vast:
 *   - zwaar-rode landen → landelijke basislijn rood (4);
 *   - land met normale basis + één zware regio (Thailand/Japan) → basislijn
 *     wit/normaal (1) mét een hoger regionaal maximum.
 *
 * Draaien: cd worker && node --test test/map-palette.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveMapAssessment } from '../src/analysis/map-palette.js';

// Pixel-tellingen (bemonsterd op stap 2) uit de proef-run. Alleen de
// land-klassen zijn relevant voor de afleiding; zee/grijs staan er voor de
// volledigheid bij zodat de test de echte input weerspiegelt.
const VECTORS = {
  IRQ: { rood: 30000, oranje: 10600, geel: 100, wit: 9800, blauw: 6300, grijs: 42000 },
  UKR: { rood: 38000, oranje: 100, geel: 200, wit: 23000, blauw: 7400, grijs: 29000 },
  MLI: { rood: 35000, oranje: 100, geel: 100, wit: 9200, blauw: 4800, grijs: 49000 },
  THA: { rood: 2600, oranje: 300, geel: 15900, wit: 41000, blauw: 9400, grijs: 29000 },
  JPN: { rood: 100, oranje: 100, geel: 3600, wit: 72000, blauw: 6900, grijs: 14000 },
};

test('Irak: vrijwel volledig rood → landelijk rood (4)', () => {
  const a = deriveMapAssessment(VECTORS.IRQ);
  assert.equal(a.baselineLevel, 4);
  assert.equal(a.color, 'rood');
  assert.equal(a.regionalMaxLevel, 4);
});

test('Oekraïne: overwegend rood → landelijk rood (4)', () => {
  const a = deriveMapAssessment(VECTORS.UKR);
  assert.equal(a.baselineLevel, 4);
  assert.equal(a.color, 'rood');
});

test('Mali: overwegend rood → landelijk rood (4)', () => {
  const a = deriveMapAssessment(VECTORS.MLI);
  assert.equal(a.baselineLevel, 4);
  assert.equal(a.color, 'rood');
});

test('Thailand: normaal met rode zuidzone → basislijn groen (1), regionaal rood (4)', () => {
  const a = deriveMapAssessment(VECTORS.THA);
  assert.equal(a.baselineLevel, 1);
  assert.equal(a.color, 'groen');
  assert.equal(a.regionalMaxLevel, 4);
  assert.equal(a.hasRegionalWarnings, true);
});

test('Japan: normaal met kleine gele zone → basislijn groen (1), regionaal geel (2)', () => {
  const a = deriveMapAssessment(VECTORS.JPN);
  assert.equal(a.baselineLevel, 1);
  assert.equal(a.color, 'groen');
  assert.equal(a.regionalMaxLevel, 2);
  assert.equal(a.hasRegionalWarnings, true);
});

test('te weinig land-pixels → null (onbetrouwbaar, niet gebruiken)', () => {
  assert.equal(deriveMapAssessment({ rood: 10, wit: 20 }), null);
});

test('kleine losse zone onder de drempel telt niet als regionaal maximum', () => {
  // 0,5% rood in een verder wit land: onder ZONE_THRESHOLD (1,5%).
  const a = deriveMapAssessment({ rood: 250, wit: 49750 });
  assert.equal(a.baselineLevel, 1);
  assert.equal(a.regionalMaxLevel, 1);
  assert.equal(a.hasRegionalWarnings, false);
});

test('dunne gele marge blijft conservatief groen i.p.v. ten onrechte geel', () => {
  // Geel < 50% van het land door witte marge → basislijn 1, maar wél als
  // regionaal geel zichtbaar (nooit-escaleren-principe).
  const a = deriveMapAssessment({ geel: 15000, wit: 35000 });
  assert.equal(a.baselineLevel, 1);
  assert.equal(a.regionalMaxLevel, 2);
});
