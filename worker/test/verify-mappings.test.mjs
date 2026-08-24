/**
 * Tests voor de beoordelingslogica van de mapping-bewaking
 * (scripts/verify-mappings.mjs).
 *
 * Twee dingen moeten kloppen, en het tweede is net zo belangrijk als het
 * eerste:
 *   • een stubpagina moet opvallen — dat is waar de hele controle om draait;
 *   • een geldig antwoord mag géén alarm geven, want een rapport dat vals
 *     alarm slaat wordt niet meer gelezen, en dan is de échte melding straks
 *     ook onzichtbaar.
 *
 * Draaien: cd worker && node --test test/verify-mappings.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { beoordeelOphaling, kiesSteekproef, toonId } from '../scripts/verify-mappings.mjs';

const advies = (over = {}) => ({
  level: 2, assessmentStatus: 'ok',
  themes: [{ text: 'x'.repeat(600) }],
  ...over,
});

test('een stubpagina valt op', () => {
  // Zo kwam de Spaanse stubpagina binnen: wel een pagina, geen advies.
  assert.match(beoordeelOphaling(advies({ level: null, assessmentStatus: 'uncertain', themes: [] })), /stubpagina/);
  // En zo de Nieuw-Zeelandse: een pagina van 19 kB zonder adviesinhoud.
  assert.match(
    beoordeelOphaling(advies({ level: null, assessmentStatus: 'uncertain', themes: [{ text: 'kort' }] })),
    /nauwelijks tekst/,
  );
  assert.equal(beoordeelOphaling(null), 'geen advies teruggegeven');
});

test('een geldig antwoord geeft geen alarm', () => {
  assert.equal(beoordeelOphaling(advies()), null);
  // Japan geeft voor rustige landen niveau 1 met "危険情報なし" en nul secties.
  assert.equal(beoordeelOphaling(advies({ level: 1, themes: [] })), null);
  // Denemarken zegt met zoveel woorden dat het voor dit land niets publiceert.
  assert.equal(beoordeelOphaling(advies({ level: null, assessmentStatus: 'none', themes: [] })), null);
  // Eerlijk onzeker mét adviestekst is een oordeelskwestie, geen koppelingsfout.
  assert.equal(beoordeelOphaling(advies({ level: null, assessmentStatus: 'uncertain' })), null);
});

test('de steekproef wandelt door de lijst in plaats van te blijven hangen', () => {
  const isos = Array.from({ length: 20 }, (_, i) => `L${i}`);
  const dag1 = kiesSteekproef(isos, 100, 5);
  const dag2 = kiesSteekproef(isos, 101, 5);
  assert.equal(dag1.length, 5);
  // Opeenvolgende dagen mogen elkaar niet overlappen, anders duurt het eeuwig
  // voor land 137 aan de beurt is — precies het gat in de oude canary.
  assert.deepEqual(dag1.filter((x) => dag2.includes(x)), []);
  // Vier dagen dekken alle twintig.
  const vier = new Set([...dag1, ...dag2, ...kiesSteekproef(isos, 102, 5), ...kiesSteekproef(isos, 103, 5)]);
  assert.equal(vier.size, 20);
  // Dezelfde dag geeft dezelfde uitkomst (reproduceerbaar rapport).
  assert.deepEqual(kiesSteekproef(isos, 100, 5), dag1);
  // Bronnen krijgen met een eigen versprong niet dezelfde landen.
  assert.notDeepEqual(kiesSteekproef(isos, 100, 5, 7), dag1);
});

test('de steekproef gaat niet stuk op randgevallen', () => {
  assert.deepEqual(kiesSteekproef([], 5, 6), []);
  assert.deepEqual(kiesSteekproef(['A', 'B'], 3, 6).sort(), ['A', 'B']);
  assert.equal(new Set(kiesSteekproef(['A', 'B', 'C'], 7, 3)).size, 3);
});

test('koppelingen met een object worden leesbaar getoond', () => {
  // Australië en Canada koppelen met een object; "[object Object]" in een
  // rapport is onbruikbaar.
  assert.equal(toonId({ continent: 'africa', slug: 'guinea-bissau' }), 'africa/guinea-bissau');
  assert.equal(toonId('nepal'), 'nepal');
});
