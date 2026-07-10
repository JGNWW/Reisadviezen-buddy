import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyTheme } from './themes.js';
import { extractNlColors, mapForeignToNlColor } from './colors.js';
import { htmlToText, splitByHeadings, snippetAround } from './html.js';

test('classifyTheme herkent NL-subkoppen', () => {
  assert.equal(classifyTheme('Criminaliteit'), 'criminaliteit');
  assert.equal(classifyTheme('Natuurgeweld'), 'natuurgeweld');
  assert.equal(classifyTheme('Wetten en gebruiken'), 'wetten-gebruiken');
  assert.equal(classifyTheme('Demonstraties'), 'demonstraties-politiek');
});

test('classifyTheme herkent Engelse FCDO-koppen', () => {
  assert.equal(classifyTheme('Safety and security'), 'veiligheid-algemeen');
  assert.equal(classifyTheme('Entry requirements'), 'inreis-documenten');
  assert.equal(classifyTheme('Health'), 'gezondheid');
  assert.equal(classifyTheme('Terrorism'), 'terrorisme');
});

test('classifyTheme geeft null bij onbekende kop', () => {
  assert.equal(classifyTheme('Iets heel willekeurigs xyz'), null);
});

test('extractNlColors haalt meerdere kleuren met context', () => {
  const html =
    '<h2>In het kort</h2><ul><li>De kleurcode is rood voor het grensgebied.</li>' +
    '<li>Voor de rest geldt kleurcode geel.</li></ul>';
  const { overall, colors } = extractNlColors(html);
  // Overwegend = de kleur van "de rest van het land"; een zwaardere kleur
  // voor alleen een deelgebied mag het landelijke beeld niet overschrijven.
  assert.equal(overall, 'geel');
  const found = colors.map((c) => c.color).sort();
  assert.deepEqual(found, ['geel', 'rood']);
});

test('extractNlColors valt zonder "rest"-formulering terug op de zwaarste kleur', () => {
  const html =
    '<h2>In het kort</h2><ul><li>De kleurcode is oranje voor het noorden.</li>' +
    '<li>Kleurcode geel geldt voor het zuiden.</li></ul>';
  assert.equal(extractNlColors(html).overall, 'oranje');
});

test('extractNlColors: één kleur blijft die kleur', () => {
  const html = '<h2>In het kort</h2><p>Voor heel Syrië geldt kleurcode rood.</p>';
  assert.equal(extractNlColors(html).overall, 'rood');
});

test('mapForeignToNlColor mapt FCDO-formuleringen', () => {
  assert.equal(mapForeignToNlColor('FCDO advises against all travel to X').color, 'rood');
  assert.equal(mapForeignToNlColor('advises against all but essential travel').color, 'oranje');
  assert.equal(mapForeignToNlColor('Exercise a high degree of caution').color, 'geel');
  assert.equal(mapForeignToNlColor('Have a nice trip').color, 'groen');
});

test('htmlToText verwijdert tags en normaliseert witruimte', () => {
  assert.equal(htmlToText('<p>Hallo</p><p>wereld</p>'), 'Hallo wereld');
});

test('splitByHeadings splitst op koppen', () => {
  const secs = splitByHeadings('<p>intro</p><h4>Drugs</h4><p>tekst</p><h4>Lhbtiq+</h4><p>meer</p>');
  const headings = secs.map((s) => s.heading);
  assert.deepEqual(headings, [null, 'Drugs', 'Lhbtiq+']);
});

test('snippetAround centreert rond de term', () => {
  const s = snippetAround('Er zijn regelmatig verkiezingen in dit land dit jaar', 'verkiezingen', 10);
  assert.match(s, /verkiezingen/);
  assert.match(s, /…/);
});
