/**
 * Tests voor de steekproefkeuze van de live-canary (scripts/canary.mjs).
 *
 * De canary testte jarenlang twee vaste landen (Nepal en Marokko). Daarmee
 * vind je per definitie geen fout bij land 137 — en dat is nu juist het soort
 * fout dat hier hoort op te vallen: safetravel.govt.nz serveerde voor
 * "moldova-republic-of" een lege pagina zonder ooit een foutcode te geven.
 *
 * Draaien: cd worker && node --test test/canary.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { testLanden } from '../scripts/canary.mjs';

const isos = Array.from({ length: 12 }, (_, i) => `L${i}`);

test('het ankerland staat er altijd bij, en vooraan', () => {
  // Nepal is bij alle bronnen gekoppeld en stabiel: een echte regressie in de
  // parseerlogica moet elke run opvallen, niet pas als het toevallig langskomt.
  const uit = testLanden(isos, 40, 2, 0, 'L3');
  assert.equal(uit[0], 'L3');
  assert.equal(uit.length, 3);
  // En hij komt niet dubbel voor als de rotatie er ook op uitkomt.
  for (let dag = 0; dag < 30; dag++) {
    const r = testLanden(isos, dag, 2, 0, 'L3');
    assert.equal(new Set(r).size, r.length, `dubbel op dag ${dag}: ${r}`);
  }
});

test('de roulatie wandelt door de lijst', () => {
  const dag1 = testLanden(isos, 50, 2, 0, 'L0').slice(1);
  const dag2 = testLanden(isos, 51, 2, 0, 'L0').slice(1);
  assert.deepEqual(dag1.filter((x) => dag2.includes(x)), []);
  // Binnen een handvol dagen is de hele lijst geweest.
  const gezien = new Set();
  for (let dag = 0; dag < 6; dag++) testLanden(isos, dag, 2, 0, 'L0').slice(1).forEach((x) => gezien.add(x));
  assert.equal(gezien.size, 11); // alles behalve het ankerland
  // Reproduceerbaar: dezelfde dag geeft dezelfde landen.
  assert.deepEqual(testLanden(isos, 50, 2, 0, 'L0'), testLanden(isos, 50, 2, 0, 'L0'));
});

test('bronnen krijgen niet allemaal dezelfde landen', () => {
  // Zonder eigen versprong zou een bronspecifieke fout alsnog buiten beeld
  // blijven, want elke bron zou precies dezelfde landen bevragen. In de
  // canary is de versprong de eigen vensterbreedte (bron 0 pakt landen 0-1,
  // bron 1 de landen 2-3), dus opeenvolgende bronnen liggen naast elkaar.
  const lijsten = Array.from({ length: 17 }, (_, i) => testLanden(isos, 50, 2, i * 2, 'L0').join(','));
  assert.ok(new Set(lijsten).size > 1, 'alle bronnen kregen dezelfde landen');
  // Twee opeenvolgende bronnen overlappen niet.
  const a = testLanden(isos, 50, 2, 0, 'L0').slice(1);
  const b = testLanden(isos, 50, 2, 2, 'L0').slice(1);
  assert.deepEqual(a.filter((x) => b.includes(x)), []);
});

test('randgevallen leveren geen lege of kapotte lijst op', () => {
  assert.deepEqual(testLanden([], 5, 2, 0, 'NPL'), []);
  assert.deepEqual(testLanden(['NPL'], 5, 2, 0, 'NPL'), ['NPL']);
  // Ankerland dat deze bron niet kent: dan gewoon twee roterende landen.
  const uit = testLanden(['A', 'B', 'C'], 5, 2, 0, 'NPL');
  assert.equal(uit.length, 2);
  assert.ok(!uit.includes('NPL'));
});
