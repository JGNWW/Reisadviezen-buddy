/**
 * Tests voor "de bron publiceert geen kleurcode" (assessmentStatus 'none').
 *
 * FCDO kent geen kleurenschaal. Bij landen zonder vermijdingswaarschuwing —
 * El Salvador bijvoorbeeld — publiceert het geen gekleurde zones en staat er
 * in de API een leeg alert_status. Daar maakten wij groen van, en dat is een
 * gok: de afwezigheid van een waarschuwing als kleur presenteren suggereert
 * een oordeel dat de bron niet geeft. Gemeten ging het om 137 van de 209
 * VK-landen, en precies die 137 hebben ook geen kaartkleur.
 *
 * 'none' is bewust iets anders dan 'uncertain': bij 'uncertain' konden wij het
 * niet bepalen, bij 'none' is juist zeker dát er niets te kleuren valt. Dat
 * onderscheid telt verderop: de Worker hoeft er geen snapshot bij te halen en
 * de snapshot-CI mag het niet als uitgeklede ophaling wegfilteren.
 *
 * Draaien: cd worker && node --test test/uk-no-colour.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretStructured } from '../src/analysis/country-level.js';
import { pickSourceResult } from '../src/index.js';

const uk = (value, extra = {}) => interpretStructured({ kind: 'uk_alert_status', value, ...extra });

test('het gemelde geval El Salvador: leeg alert_status geeft geen kleur', () => {
  const r = uk([]);
  assert.equal(r.level, null);
  assert.equal(r.color, null);
  assert.equal(r.assessmentStatus, 'none');
  assert.match(r.explanation, /geen kleurcode/i);
});

test('"none" is geen "uncertain" — we weten het juist zeker', () => {
  const r = uk([]);
  assert.notEqual(r.assessmentStatus, 'uncertain');
  assert.equal(r.confidence, 'high');
});

test('een expliciete waarschuwing houdt gewoon zijn kleur', () => {
  assert.equal(uk(['avoid_all_travel_to_whole_country']).level, 4);
  assert.equal(uk(['avoid_all_but_essential_travel_to_whole_country']).level, 3);
  // Alleen delen van het land: landelijk groen, regionaal zwaarder.
  const delen = uk(['avoid_all_travel_to_parts']);
  assert.equal(delen.level, 1);
  assert.equal(delen.regionalMaxLevel, 4);
});

test('een "none"-resultaat wordt getoond, niet vervangen door het snapshot', () => {
  const live = { level: null, assessmentStatus: 'none', themes: [{ text: 'x'.repeat(50) }] };
  const snap = { themes: [{ text: 'oude tekst' }] };
  assert.equal(pickSourceResult(live, snap), 'live');
});
