/**
 * Tests voor de Oostenrijkse Sicherheitsstufe-box (kind 'at_security_box').
 *
 * BMEIA zet per land een box neer met één of meer stufes op hun eigen
 * 4-puntsschaal. Staat er meer dan één, dan hoort de LANDELIJKE ondergrens
 * gelezen te worden — de stufe die geldt voor wat er niet apart genoemd is.
 * Die restcategorie schrijven ze op minstens vier manieren op, en dat is waar
 * het misging: Rusland kwam landelijk op groen binnen terwijl de bron voor het
 * hele land minstens stufe 3 aanhoudt.
 *
 * De fragmenten hieronder zijn letterlijk van bmeia.gv.at, inclusief de
 * HTML-resten (&nbsp;, <a>, <strong>) — de adapter voert namelijk een ruwe
 * pagina-slice aan en niet de opgeschoonde tekst.
 *
 * Draaien: cd worker && node --test test/austria-levels.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretStructured } from '../src/analysis/country-level.js';

const at = (text) => interpretStructured({ kind: 'at_security_box', value: text });

test('Rusland: "in den restlichen Regionen" is de landelijke ondergrens', () => {
  const r = at('Sicherheitsstufe&nbsp;4 (regional) seit&nbsp;09.03.2022'
    + ' <a>Sicherheitsstufe 4</a>&nbsp;(von 4) gilt für die an die Ukraine angrenzenden Verwaltungsgebiete (Belgorod, Kursk).'
    + ' <strong>Hohes Sicherheitsrisiko</strong>&nbsp;<a>Sicherheitsstufe&nbsp;3</a>&nbsp;(von 4) gilt&nbsp;<strong>in den restlichen Regionen.</strong>');
  assert.equal(r.level, 3);
  assert.equal(r.regionalMaxLevel, 4);
  assert.equal(r.hasRegionalWarnings, true);
});

test('Israël: "für die restlichen Landesteile" telt ook', () => {
  const r = at('Sicherheitsstufe 4 (regional) seit 28.02.2026'
    + ' Regionale Reisewarnung (Sicherheitsstufe 4) für den Norden Israels (nördlich der Straße 85).'
    + ' Hohes Sicherheitsrisiko (Sicherheitsstufe 3) für die restlichen Landesteile Israels.');
  assert.equal(r.level, 3, 'het regionale maximum mag het landniveau niet zijn');
  assert.equal(r.regionalMaxLevel, 4);
});

test('Filipijnen: de rest van een eiland is niet de rest van het land', () => {
  // Drie stufes onder elkaar. "der restliche Teil der Insel Mindanao" is een
  // gebied; pas "im Rest des Landes" geldt landelijk — en dat is de mildste.
  const r = at('Sicherheitsstufe&nbsp;4 (regional) seit&nbsp;01.01.2014'
    + ' <a>Sicherheitsstufe 4</a>&nbsp;(von 4) gilt auf der&nbsp;gesamten Westküste der Insel Mindanao inklusive der Bangsamoro Region.'
    + ' <a>Sicherheitsstufe 3</a>&nbsp;(von 4) gilt für den restlichen Teil der Insel Mindanao.'
    + ' <a>Sicherheitsstufe 2</a>&nbsp;(von 4) gilt&nbsp;<strong>im Rest des Landes.</strong>');
  assert.equal(r.level, 2);
  assert.equal(r.regionalMaxLevel, 4);
});

test('Oekraïne: "die gesamte Ukraine" blijft landelijk niveau 4', () => {
  // De ruime variant ("gesamte <naam>") is nodig voor landen waar BMEIA de
  // landnaam gebruikt in plaats van het woord "Land". Die moest blijven werken.
  const r = at('Sicherheitsstufe&nbsp;4 (von 4) Reisewarnung für die gesamte Ukraine.');
  assert.equal(r.level, 4);
});

test('alleen een regionale stufe houdt het land landelijk groen', () => {
  const r = at('Sicherheitsstufe&nbsp;4 (regional) seit&nbsp;01.01.2020'
    + ' <a>Sicherheitsstufe 4</a>&nbsp;(von 4) gilt für die Grenzregion zu Mali.');
  assert.equal(r.level, 1);
  assert.equal(r.regionalMaxLevel, 4);
  assert.equal(r.hasRegionalWarnings, true);
});

test('zonder Sicherheitsstufe blijft het oordeel onzeker', () => {
  assert.equal(at('Stand 11.08.2026. Keine Angaben.').assessmentStatus, 'uncertain');
});
