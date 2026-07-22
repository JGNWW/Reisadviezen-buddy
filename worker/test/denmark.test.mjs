/**
 * Tests voor de Deense standaardtekst-herkenning (src/adapters/denmark.js).
 * Als um.dk alleen de generieke veiligheidstekst toont (geen bijzonderheden),
 * is dat een normaal/laag risico — geen ontbrekende data.
 *
 * Draaien: cd worker && node --test test/denmark.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDanishStandardOnly } from '../src/adapters/denmark.js';

test('standaardtekst "Brug din sunde fornuft …" → standaard (laag risico)', () => {
  assert.equal(
    isDanishStandardOnly('Brug din sunde fornuft og vær opmærksom på mistænkelig adfærd som du ville være det, hvis du var i Danmark.'),
    true,
  );
});

test('"vær opmærksom på" zonder waarschuwing → standaard', () => {
  assert.equal(isDanishStandardOnly('Vær opmærksom på lokale forhold. Der er ingen særlige rejseråd.'), true);
});

test('echte waarschuwing ("fraråder alle rejser") → NIET standaard', () => {
  assert.equal(
    isDanishStandardOnly('Udenrigsministeriet fraråder alle rejser til området. Brug din sunde fornuft.'),
    false,
  );
});

test('"fraråder alle ikke-nødvendige rejser" → NIET standaard', () => {
  assert.equal(isDanishStandardOnly('Udenrigsministeriet fraråder alle ikke-nødvendige rejser til landet.'), false);
});

test('onschuldig "fraråder ikke rejser" blokkeert de standaard NIET', () => {
  // "fraråder ikke" (raadt NIET af) is geen waarschuwing.
  assert.equal(
    isDanishStandardOnly('Udenrigsministeriet fraråder ikke rejser til landet. Brug din sunde fornuft.'),
    true,
  );
});

test('lege / niet-herkende tekst → geen standaard', () => {
  assert.equal(isDanishStandardOnly(''), false);
  assert.equal(isDanishStandardOnly('Tilfældig tekst uden standardformulering.'), false);
});
