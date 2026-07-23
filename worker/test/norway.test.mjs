/**
 * Tests voor de Noorse reisadvarsel-classificatie (interpretStructured,
 * kind 'no_advarsel', in src/analysis/country-level.js). regjeringen.no
 * gebruikt twee vaste templateformules aan het begin van het advarsel-/
 * inleidingsblok — "{land} er under normale omstendigheter et trygt land å
 * ferdes og oppholde seg i" (groen) en "Sikkerhetssituasjonen i {land} er
 * svært utfordrende" (rood) — naast de reguliere "fraråder …"-vormen.
 *
 * Kernregel: alleen de EERSTE zin bepaalt het oordeel (zoals bij Zwitserland,
 * ch-classify.js). Een generieke "utvis aktsomhet"-opmerking verderop in een
 * langere inleiding (veelvoorkomende boilerplate) mag een land niet ten
 * onrechte naar geel/oranje/rood tillen als de openingszin een ander
 * (of geen) oordeel geeft.
 *
 * Draaien: cd worker && node --test test/norway.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretStructured } from '../src/analysis/country-level.js';

const assess = (value) => interpretStructured({ kind: 'no_advarsel', value });

test('groen (1): "… er under normale omstendigheter et trygt land å ferdes og oppholde seg i"', () => {
  const a = assess('Belgia er under normale omstendigheter et trygt land å ferdes og oppholde seg i.');
  assert.equal(a.level, 1);
  assert.equal(a.color, 'groen');
});

test('rood (4): "Sikkerhetssituasjonen i … er svært utfordrende"', () => {
  const a = assess('Sikkerhetssituasjonen i Afghanistan er svært utfordrende. Norske myndigheter fraråder alle reiser.');
  assert.equal(a.level, 4);
  assert.equal(a.color, 'rood');
});

test('rood (4): kale "fraråder alle reiser" (echte Afghanistan-formule)', () => {
  const a = assess('Utenriksdepartementet fraråder alle reiser til Afghanistan. Nordmenn som befinner seg i Afghanistan oppfordres til å forlate landet.');
  assert.equal(a.level, 4);
});

test('oranje (3): "fraråder … som ikke er strengt nødvendige"', () => {
  const a = assess('Utenriksdepartementet fraråder reiser som ikke er strengt nødvendige til regionen.');
  assert.equal(a.level, 3);
});

test('geel (2): "utvis (særlig) aktsomhet" IN de eerste zin', () => {
  const a = assess('Utvis særlig aktsomhet i grenseområdene. Ellers er situasjonen stabil.');
  assert.equal(a.level, 2);
});

test('generieke "utvis aktsomhet" VERDEROP in een langere inleiding overstemt de groene openingszin niet', () => {
  // Dit was de gemelde bug: een land met een duidelijk groen oordeel in de
  // openingszin werd ten onrechte geel omdat een generiek aktsomhet-devies
  // later in de (langere) inleiding stond.
  const a = assess(
    'Belgia er under normale omstendigheter et trygt land å ferdes og oppholde seg i. '
    + 'Norske reisende oppfordres likevel alltid til å utvise aktsomhet og følge lokale råd, '
    + 'som i alle land.'
  );
  assert.equal(a.level, 1);
  assert.equal(a.color, 'groen');
});

test('geen sterke formule in de eerste zin, wél een milde aktsomhet-formulering verderop → geel (vangnet)', () => {
  const a = assess(
    'Landet har generelt gode helsetjenester og infrastruktur i de store byene. '
    + 'I enkelte grenseområder: utvis aktsomhet på grunn av økt kriminalitet.'
  );
  assert.equal(a.level, 2);
});

test('geen herkenbare formule ergens → onzeker (nooit een gok)', () => {
  const a = assess('Landet har en lang kystlinje og et variert klima gjennom hele året.');
  assert.equal(a.assessmentStatus, 'uncertain');
  assert.equal(a.level, null);
});

test('leeg advarsel-blok → groen (geen waarschuwing gepubliceerd)', () => {
  const a = assess('');
  assert.equal(a.level, 1);
  assert.equal(a.color, 'groen');
});

test('vangnet kan nooit escaleren: een rood signaal buiten de eerste zin telt niet mee (liever onzeker dan een gok)', () => {
  // Zou "fraråder alle reiser" verderop (niet in de eerste zin) wél als
  // landelijk niveau tellen, dan zou dit ten onrechte rood worden — het mag
  // alleen als het letterlijk de openingszin is (zie de aparte rood-test).
  // Het vangnet accepteert uitsluitend niveau ≤2, dus dit land wordt eerlijk
  // onzeker in plaats van fout geëscaleerd.
  const a = assess(
    'Landet er generelt stabilt, men vær oppmerksom på lokale forhold. '
    + 'Myndighetene fraråder alle reiser til grenseregionen.'
  );
  assert.equal(a.level, null);
  assert.equal(a.assessmentStatus, 'uncertain');
});
