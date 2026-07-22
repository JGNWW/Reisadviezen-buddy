/**
 * Tests voor de EDA-crisis-classifier (src/analysis/ch-classify.js).
 * De teksten zijn de standaardformules van het EDA (Afghanistan is de echte
 * tekst uit de crisis-portal-proef).
 *
 * Draaien: cd worker && node --test test/ch-classify.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyChNational, assessChAdvisory } from '../src/analysis/ch-classify.js';

test('rood (4): "Von Reisen … wird abgeraten" (Afghanistan, echte tekst)', () => {
  const g = 'Von Reisen nach Afghanistan und von Aufenthalten jeder Art wird abgeraten. Die Lage bleibt fragil und unbeständig.';
  assert.equal(classifyChNational(g), 4);
});

test('rood (4): "Von Reisen in dieses Land … wird abgeraten"', () => {
  assert.equal(classifyChNational('Von Reisen in dieses Land wird abgeraten.'), 4);
});

test('oranje (3): "Von nicht dringend notwendigen Reisen … wird abgeraten"', () => {
  const g = 'Von nicht dringend notwendigen Reisen nach Beispielland wird abgeraten.';
  assert.equal(classifyChNational(g), 3);
});

test('geel (2): "… Aufmerksamkeit zu schenken"', () => {
  const g = 'Der persönlichen Sicherheit ist im ganzen Land erhöhte Aufmerksamkeit zu schenken.';
  assert.equal(classifyChNational(g), 2);
});

test('groen (1): "… kann grundsätzlich als sicher gelten"', () => {
  assert.equal(classifyChNational('Beispielland kann grundsätzlich als sicher gelten.'), 1);
});

test('leeg/onbekend → null', () => {
  assert.equal(classifyChNational(''), null);
  assert.equal(classifyChNational('Willkommen auf der Krisenseite.'), null);
});

test('landelijk groen met rode regiozone → basis 1, regionaal 4', () => {
  const grund = 'Das Land kann grundsätzlich als sicher gelten.';
  const full = grund + ' Von Reisen in die Grenzregion zu Nachbarland wird abgeraten.';
  const a = assessChAdvisory(grund, full);
  assert.equal(a.level, 1);
  assert.equal(a.color, 'groen');
  assert.equal(a.regionalMaxLevel, 4);
  assert.equal(a.regionalColor, 'rood');
  assert.equal(a.hasRegionalWarnings, true);
});

test('landelijk rood → regionaal niet lager dan landelijk', () => {
  const a = assessChAdvisory('Von Reisen nach X und von Aufenthalten jeder Art wird abgeraten.', 'Von Reisen nach X … wird abgeraten.');
  assert.equal(a.level, 4);
  assert.equal(a.regionalMaxLevel, 4);
  assert.equal(a.hasRegionalWarnings, false);
});

test('vangnet: eerste zin generiek, milde formule later → geel (2)', () => {
  const g = 'Meiden Sie Kundgebungen jeder Art. Der persönlichen Sicherheit ist erhöhte Aufmerksamkeit zu schenken.';
  assert.equal(classifyChNational(g), 2);
});
