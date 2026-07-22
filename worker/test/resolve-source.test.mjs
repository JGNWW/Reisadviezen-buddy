/**
 * Tests voor de bron-voorrang van de Worker (src/index.js): live eerst,
 * snapshot als vangnet, en — cruciaal — de tekst altijd tonen zodra die er is,
 * ook als het niveau/de kleur niet bepaald kon worden.
 *
 * Draaien: cd worker && node --test test/resolve-source.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickSourceResult, textVolume, MIN_USABLE_TEXT } from '../src/index.js';

const themesOf = (len) => [{ heading: 'x', text: 'a'.repeat(len) }];
const live = (o = {}) => ({ level: null, assessmentStatus: null, themes: themesOf(2000), ...o });
const snap = (o = {}) => ({ level: null, assessmentStatus: null, themes: themesOf(2000), stale: true, ...o });

test('textVolume telt de tekstlengte van alle thema’s', () => {
  assert.equal(textVolume({ themes: [{ text: 'abc' }, { text: 'de' }] }), 5);
  assert.equal(textVolume({ themes: [] }), 0);
  assert.equal(textVolume(null), 0);
});

test('1) live met betrouwbaar niveau wint altijd van de snapshot', () => {
  assert.equal(pickSourceResult(live({ level: 2, assessmentStatus: 'ok' }), snap({ level: 4 })), 'live');
});

test('2) live met volwaardige tekst maar zónder niveau wint van de snapshot (#1+#2)', () => {
  // De kern van verzoek #1: kleurbepaling faalde live, maar er is verse tekst.
  assert.equal(pickSourceResult(live({ level: null }), snap({ level: 3 })), 'live');
});

test('2b) live tekst zonder niveau, status "uncertain" → nog steeds live tonen', () => {
  assert.equal(pickSourceResult(live({ level: null, assessmentStatus: 'uncertain' }), snap({ level: 3 })), 'live');
});

test('3) live faalt volledig (null) → snapshot met niveau', () => {
  assert.equal(pickSourceResult(null, snap({ level: 3 })), 'snap');
});

test('3b) live faalt (null) → snapshot mét tekst maar zónder niveau (kleur onbekend)', () => {
  assert.equal(pickSourceResult(null, snap({ level: null })), 'snap');
});

test('4) lege live-schil (te weinig tekst) verliest van een snapshot met niveau', () => {
  const shell = live({ level: null, themes: themesOf(MIN_USABLE_TEXT - 50) });
  assert.equal(pickSourceResult(shell, snap({ level: 3 })), 'snap');
});

test('5) lege live-schil zonder snapshot → toon tóch de beetje tekst die er is', () => {
  const shell = live({ level: null, themes: themesOf(50) });
  assert.equal(pickSourceResult(shell, null), 'live');
});

test('6) niets bruikbaars (geen live, geen snapshot) → none', () => {
  assert.equal(pickSourceResult(null, null), 'none');
  assert.equal(pickSourceResult({ themes: [] }, { themes: [] }), 'none');
});
