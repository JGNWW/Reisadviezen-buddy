/**
 * Tests voor de Duitse tekst→niveau-classifier (src/analysis/de-classify.js).
 * Draaien: cd worker && node --test test/de-classify.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGermanNational } from '../src/analysis/de-classify.js';

test('oranje (3): "Von nicht unbedingt erforderlichen Reisen wird abgeraten"', () => {
  assert.equal(classifyGermanNational('Von nicht unbedingt erforderlichen Reisen wird abgeraten.'), 3);
});

test('oranje (3): variant "nicht unbedingt notwendigen"', () => {
  assert.equal(classifyGermanNational('Von nicht unbedingt notwendigen Reisen wird abgeraten.'), 3);
});

test('oranje (3): variant "touristischen Reisen"', () => {
  assert.equal(classifyGermanNational('Von touristischen Reisen wird derzeit abgeraten.'), 3);
});

test('rood (4): "Von Reisen wird abgeraten" (kaal = landelijk)', () => {
  assert.equal(classifyGermanNational('Von Reisen wird abgeraten.'), 4);
  assert.equal(classifyGermanNational('Von Reisen wird dringend abgeraten.'), 4);
});

test('rood (4): "Von Reisen in dieses Land wird abgeraten"', () => {
  assert.equal(classifyGermanNational('Von Reisen in dieses Land wird abgeraten.'), 4);
});

test('geen landelijke formule → null', () => {
  assert.equal(classifyGermanNational(''), null);
  assert.equal(classifyGermanNational('Seien Sie wachsam und meiden Sie Menschenmengen.'), null);
});

test('overladen "abgeraten" (bussen/paspoorten/tandarts) telt NIET', () => {
  assert.equal(classifyGermanNational('Von der Nutzung der Überlandbusse wird abgeraten.'), null);
  assert.equal(classifyGermanNational('Von der Mitnahme als gestohlen gemeldeter Reisepässe wird abgeraten.'), null);
  assert.equal(classifyGermanNational('Operative Eingriffe und nicht dringende Zahnbehandlungen sollten in Deutschland durchgeführt werden.'), null);
});

test('REGIONALE formule telt niet als landelijk (Indonesië-vorm)', () => {
  // "Reisen" wordt gevolgd door "in fünf der sechs Provinzen", niet door "wird".
  assert.equal(
    classifyGermanNational('Von nicht unbedingt erforderlichen Reisen in fünf der sechs Provinzen des Landes wird abgeraten.'),
    null,
  );
});

test('kiest het zwaarste: rood wint van een losse oranje-zin', () => {
  const t = 'Von nicht unbedingt erforderlichen Reisen wird abgeraten. Aktuell gilt: Von Reisen wird abgeraten.';
  assert.equal(classifyGermanNational(t), 4);
});
