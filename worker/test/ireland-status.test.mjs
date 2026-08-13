/**
 * Tests voor het uitlezen van de Ierse security status (adapters/ireland.js).
 *
 * Aanleiding: Jordanië stond in de tool op geel terwijl ireland.ie oranje gaf.
 * De oorzaak was niet de extractie maar de BRON: het advies verhuisde van
 * dfa.ie naar ireland.ie, en dfa.ie bleef daarna gewoon pagina's serveren —
 * met een bevroren, oude stand. Niets faalde zichtbaar; we lazen een dode
 * site. Op ireland.ie is de CSS-class met het niveau verdwenen en staat de
 * status alleen nog als tekst.
 *
 * De valstrik in die tekst is de uitleglijst: de pagina somt onder hetzelfde
 * kopje "Security Status" ook álle vier de niveaus achter elkaar op. Wie het
 * eerste label pakt dat hij tegenkomt, leest dus "Normal precautions" voor een
 * land dat op "Do not travel" staat.
 *
 * Draaien: cd worker && node --test test/ireland-status.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { statusFromText, lastModifiedFromHtml } from '../src/adapters/ireland.js';
import { installFixtureFetch } from './fixtures.mjs';

installFixtureFetch();

test('de echte status wordt gelezen, niet de uitleglijst ervoor', () => {
  // Zo staat het op ireland.ie: eerst de legenda, dan de status.
  const pagina = 'Travel Advice Security Status Normal precautions High degree of caution '
    + 'Avoid non-essential travel Do not travel Overview Security Status Do Not Travel '
    + 'This is our highest level of warning.';
  assert.equal(statusFromText(pagina), 'do-not');
});

test('het gemelde geval Jordanië: Avoid Non-Essential Travel', () => {
  const pagina = 'Security Status What does this mean? Avoid Non-Essential Travel This is our '
    + 'second-highest level of warning. Countries at this level have serious risks.';
  assert.equal(statusFromText(pagina), 'avoid');
});

test('alle vier de niveaus worden herkend', () => {
  const maak = (label) => `Security Status ${label} This is what that means for travellers.`;
  assert.equal(statusFromText(maak('Normal Precautions')), 'normal');
  assert.equal(statusFromText(maak('High Degree of Caution')), 'high-caution');
  assert.equal(statusFromText(maak('Avoid Non-Essential Travel')), 'avoid');
  assert.equal(statusFromText(maak('Do Not Travel')), 'do-not');
});

test('een pagina met alléén de legenda levert geen status op (liever niets dan fout)', () => {
  const legenda = 'Security Status Normal precautions High degree of caution '
    + 'Avoid non-essential travel Do not travel';
  assert.equal(statusFromText(legenda), null);
});

test('spelling en witruimte doen er niet toe', () => {
  assert.equal(statusFromText('Security   Status\n\n  avoid non essential travel  — see below'), 'avoid');
  assert.equal(statusFromText('SECURITY STATUS: HIGH DEGREE OF CAUTION applies here'), 'high-caution');
});

test('geen statusblok → null, geen gok', () => {
  assert.equal(statusFromText('Ireland has an embassy in this country. Contact details below.'), null);
  assert.equal(statusFromText(''), null);
  assert.equal(statusFromText(null), null);
});

test('de wijzigingsdatum komt uit de meta-tag van ireland.ie', async () => {
  // Tweede laag van dezelfde val. De adapter gaf lastModified hard op null
  // ("ireland.ie toont geen datum") en source-dates.json wordt alléén gevuld
  // met wat een adapter teruggeeft — dus bleven daar de dfa.ie-datums van vóór
  // de verhuizing staan. Libanon toonde 17-11-2022 terwijl ireland.ie
  // 23-04-2026 meldt, en niets faalde zichtbaar.
  assert.equal(
    lastModifiedFromHtml('<meta property="website:modified_time" content="2026-04-23T14:09:48.159653+01:00" />'),
    '2026-04-23',
  );
  // De offset is de Ierse: we houden de kalenderdatum van de bron aan en
  // rekenen niet naar UTC om, anders verspringt een avondupdate een dag.
  assert.equal(
    lastModifiedFromHtml("<meta content='2026-01-01T00:30:00+01:00' property='website:modified_time'>"),
    '2026-01-01',
  );
  // published_time komt leeg mee en is een ander veld — beide mogen niets doen.
  assert.equal(lastModifiedFromHtml('<meta property="website:published_time" content="" />'), null);
  assert.equal(lastModifiedFromHtml('<meta property="website:modified_time" content="" />'), null);
  assert.equal(lastModifiedFromHtml('<html><head></head></html>'), null);
  assert.equal(lastModifiedFromHtml(null), null);

  // En op de echte fixture-pagina.
  const { getAdvisory } = await import('../src/adapters/ireland.js');
  const adv = await getAdvisory('nepal');
  assert.equal(adv.lastModified, '2026-02-10');
});
