/**
 * Tests voor de Duitse tekst→niveau-classifier (src/analysis/de-classify.js).
 *
 * Twee assen bepalen het niveau, en beide gingen eerder mis. Het AA gebruikt
 * "abgeraten" (oranje) en "dringend abgeraten" (rood) als bewust verschillende
 * trappen — bij Jordanië staat het grensgebied op "dringend abgeraten" en de
 * rest van het land op enkel "abgeraten". Die trap ontbrak: alles werd rood.
 * En de landelijke formule werd alleen kaal herkend, waardoor "Von Reisen nach
 * Kuwait wird dringend abgeraten" helemaal niet meetelde en Koeweit groen bleef.
 * Daarom krijgt de classifier nu de Duitse landnaam mee.
 *
 * Draaien: cd worker && node --test test/de-classify.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGermanNational } from '../src/analysis/de-classify.js';

test('oranje (3): "Von nicht unbedingt erforderlichen Reisen wird abgeraten"', () => {
  assert.equal(classifyGermanNational('Von nicht unbedingt erforderlichen Reisen wird abgeraten.'), 3);
});

test('oranje (3): variant "nicht unbedingt notwendigen"', () => {
  assert.equal(classifyGermanNational('Von nicht unbedingt notwendigen Reisen wird abgeraten.'), 3);
});

test('oranje (3): variant "touristischen Reisen"', () => {
  assert.equal(classifyGermanNational('Von touristischen Reisen wird derzeit abgeraten.'), 3);
});

test('"abgeraten" is oranje, "dringend abgeraten" is rood', () => {
  // Dit onderscheid ontbrak; elke landelijke formule werd rood.
  assert.equal(classifyGermanNational('Von Reisen wird abgeraten.'), 3);
  assert.equal(classifyGermanNational('Von Reisen wird dringend abgeraten.'), 4);
  assert.equal(classifyGermanNational('Von Reisen in dieses Land wird abgeraten.'), 3);
  assert.equal(classifyGermanNational('Von Reisen in dieses Land wird dringend abgeraten.'), 4);
});

test('het gemelde geval Koeweit: "Von Reisen nach <Land> wird dringend abgeraten" is landelijk', () => {
  assert.equal(classifyGermanNational('Von Reisen nach Kuwait wird dringend abgeraten.', 'Kuwait'), 4);
  assert.equal(classifyGermanNational('Von Reisen nach Kuba wird derzeit dringend abgeraten.', 'Kuba'), 4);
  // Zonder landnaam kan de landelijke vorm niet van een stad worden onderscheiden.
  assert.equal(classifyGermanNational('Von Reisen nach Kuwait wird dringend abgeraten.'), null);
});

test('het gemelde geval Jordanië: de restformule dekt het land, het grensgebied niet', () => {
  // "andere Landesteile" = de rest van het land -> landelijk oranje.
  assert.equal(classifyGermanNational('Von Reisen in andere Landesteile Jordaniens wird abgeraten.', 'Jordanien'), 3);
  assert.equal(classifyGermanNational('Von Reisen in andere Landesteile Libanons wird dringend abgeraten.', 'Libanon'), 4);
  // De gebiedszin eromheen mag het landniveau NIET optillen.
  assert.equal(
    classifyGermanNational('Von Reisen in das unmittelbare syrisch-jordanische Grenzgebiet sowie nach Aqaba wird dringend abgeraten.', 'Jordanien'),
    null,
  );
});

test('een advies over een BUURLAND telt niet mee', () => {
  // Op de pagina van Belarus staat een waarschuwing over Rusland; zonder
  // naamcontrole zou Belarus daar ten onrechte van opkleuren.
  assert.equal(classifyGermanNational('Von Reisen in die Russische Föderation wird abgeraten.', 'Belarus'), null);
  // Ook een stad is niet het land (Israël: "nach Ost-Jerusalem").
  assert.equal(classifyGermanNational('Von Reisen nach Ost-Jerusalem wird abgeraten.', 'Israel'), null);
});

test('verbogen landnamen worden herkend (Duitse naamvallen en genitief)', () => {
  assert.equal(
    classifyGermanNational('Von nicht notwendigen Reisen in die Vereinigten Arabischen Emirate wird abgeraten.', 'Vereinigte Arabische Emirate'),
    3,
  );
  assert.equal(classifyGermanNational('Von Reisen in die anderen Landesteile Venezuelas wird derzeit abgeraten.', 'Venezuela'), 3);
});

test('geen landelijke formule → null', () => {
  assert.equal(classifyGermanNational(''), null);
  assert.equal(classifyGermanNational('Seien Sie wachsam und meiden Sie Menschenmengen.'), null);
});

test('overladen "abgeraten" (bussen/paspoorten/tandarts) telt NIET', () => {
  assert.equal(classifyGermanNational('Von der Nutzung der Überlandbusse wird abgeraten.'), null);
  assert.equal(classifyGermanNational('Von der Mitnahme als gestohlen gemeldeter Reisepässe wird abgeraten.'), null);
  assert.equal(classifyGermanNational('Operative Eingriffe und nicht dringende Zahnbehandlungen sollten in Deutschland durchgeführt werden.'), null);
});

test('REGIONALE formule telt niet als landelijk (Indonesië-vorm)', () => {
  // "Reisen" wordt gevolgd door "in fünf der sechs Provinzen", niet door "wird".
  assert.equal(
    classifyGermanNational('Von nicht unbedingt erforderlichen Reisen in fünf der sechs Provinzen des Landes wird abgeraten.'),
    null,
  );
});

test('kiest het zwaarste als er meerdere formules staan', () => {
  const t = 'Von nicht unbedingt erforderlichen Reisen wird abgeraten. Aktuell gilt: Von Reisen wird dringend abgeraten.';
  assert.equal(classifyGermanNational(t), 4);
});

test('beperkte reizen blijven oranje, ook mét "dringend"', () => {
  // "Niet-noodzakelijke reizen worden dringend afgeraden" is inherent een
  // lichtere maatregel dan "reis helemaal niet".
  assert.equal(classifyGermanNational('Von nicht notwendigen Reisen wird dringend abgeraten.'), 3);
});
