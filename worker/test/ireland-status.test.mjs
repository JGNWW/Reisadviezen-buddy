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
import { statusFromText } from '../src/adapters/ireland.js';

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
