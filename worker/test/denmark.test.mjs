/**
 * Tests voor de Deense standaardtekst-herkenning (src/adapters/denmark.js).
 * Als um.dk alleen de generieke veiligheidstekst toont (geen bijzonderheden),
 * is dat een normaal/laag risico — geen ontbrekende data.
 *
 * Draaien: cd worker && node --test test/denmark.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDanishStandardOnly, isDanishNoAdvisory } from '../src/adapters/denmark.js';
import { installFixtureFetch } from './fixtures.mjs';

installFixtureFetch();

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

test('"Vi har ingen rejsevejledning" is een antwoord van de bron, geen mislukte ophaling', () => {
  // um.dk heeft voor elk land uit zijn keuzelijst een pagina, maar voor 118
  // van de 194 geen advies. Die pagina's zijn geen kapotte ophaling: er staat
  // letterlijk "Vi har ingen rejsevejledning for Afghanistan".
  assert.equal(isDanishNoAdvisory('Vi har ingen rejsevejledning for Afghanistan'), true);
  assert.equal(isDanishNoAdvisory('vi har ingen rejsevejledning for Antigua og Barbuda'), true);
  // Een pagina mét advies zegt dit nooit.
  assert.equal(isDanishNoAdvisory('Rejsevejledning opdateret: 22.06.2026 Gyldig: 13.08.2026 Udenrigsministeriet fraråder alle rejser'), false);
  assert.equal(isDanishNoAdvisory(''), false);
  assert.equal(isDanishNoAdvisory(null), false);
});

test('geen advies levert status "none", niet "uncertain"', async () => {
  // Het verschil is niet cosmetisch. Een niveauloos resultaat met status
  // 'uncertain' mag in het vangnet (snapshot-foreign.mjs) een eerder bewaard
  // advies niet overschrijven — dat beschermt tegen haperende ophalingen.
  // Zou Denemarken een advies intrekken, dan bleef het ingetrokken advies
  // daardoor eeuwig in beeld. Met 'none' gaat die wijziging wél door, net als
  // bij de VK-landen zonder waarschuwing.
  const { getAdvisory } = await import('../src/adapters/denmark.js');
  const adv = await getAdvisory('_geen-advies');
  assert.equal(adv.assessmentStatus, 'none');
  assert.equal(adv.level, null);
  assert.equal(adv.themes.length, 0);
  assert.match(adv.levelLabel, /geen reisadvies/i);
});
