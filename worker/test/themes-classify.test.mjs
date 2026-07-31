/**
 * Trefwoordtest voor de thema-classificatie.
 *
 * Aanleiding: dezelfde bosbrand belandde per bron in een andere categorie.
 * Elke bron schrijft er iets anders over (wildfire / Waldbrand / feux de forêt /
 * incendi boschivi / metsäpalo / skovbrand / 山火事 / 산불) en wat niet in de
 * trefwoordenlijst stond, viel op de tekst eronder terug — en dus willekeurig
 * ergens anders. Deze tabel legt per taal vast waar zulke koppen horen te
 * landen, zodat opschonen van de lijst niet stilletjes een taal laat vallen.
 *
 * Daarnaast de andere kant op: korte trefwoorden mogen niet middenin een ander
 * woord raken ("hiv" in "incendi boschivi", "road" in "abroad").
 *
 * Draaien: cd worker && node --test test/themes-classify.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTheme } from '../src/lib/themes.js';

// Kop → verwacht thema. Puur op de kop, zonder tekst eronder: dat is het
// scenario waarin de classificatie het moeilijkst heeft.
const KOPPEN = [
  // natuurbranden, per brontaal
  ['Bosbranden', 'natuurgeweld'],
  ['Natuurbranden', 'natuurgeweld'],
  ['Wildfires', 'natuurgeweld'],
  ['Bushfires in Australia', 'natuurgeweld'],
  ['Bush Fires', 'natuurgeweld'],
  ['Forest fires and smoke haze', 'natuurgeweld'],
  ['Waldbrände', 'natuurgeweld'],
  ['Busch- und Waldbrände', 'natuurgeweld'],
  ['Waldbrandgefahr', 'natuurgeweld'],
  ['Feux de forêt', 'natuurgeweld'],
  ['Incendies', 'natuurgeweld'],
  ['Incendi boschivi', 'natuurgeweld'],
  ['Incendios forestales', 'natuurgeweld'],
  ['Skovbrande', 'natuurgeweld'],
  ['Skogbranner', 'natuurgeweld'],
  ['Naturbrann', 'natuurgeweld'],
  ['Metsäpalot', 'natuurgeweld'],
  ['山火事', 'natuurgeweld'],
  ['산불', 'natuurgeweld'],
  // hitte en aardverschuivingen — dezelfde vertaalval
  ['Hittegolf', 'natuurgeweld'],
  ['Hitzewelle', 'natuurgeweld'],
  ['Canicule', 'natuurgeweld'],
  ['Heat wave', 'natuurgeweld'],
  ['Aardverschuiving', 'natuurgeweld'],
  ['Landslides', 'natuurgeweld'],
  ['Erdrutsche', 'natuurgeweld'],
  ['Glissement de terrain', 'natuurgeweld'],
  ['Flooding', 'natuurgeweld'],
  ['Umwelt', 'natuurgeweld'],
  // een paar andere thema's, om te bewaken dat de tabel niet alles naar
  // natuurgeweld trekt
  ['Cybercrime', 'criminaliteit'],
  ['Kriminalität', 'criminaliteit'],
  ['범죄', 'criminaliteit'],
  ['Terrorismo', 'terrorisme'],
  ['2SLGBTQI+ persons', 'wetten-gebruiken'],
  ['LGBTQIA+ travellers', 'wetten-gebruiken'],
  ['Help abroad', 'nood-hulp'],
  ['Einfuhr & Ausfuhr', 'inreis-documenten'],
  // vaste NWW-koppen: die horen per definitie te landen
  ['Bagageregels', 'inreis-documenten'],
  ['Actueel', 'veiligheid-algemeen'],
  ['치안', 'veiligheid-algemeen'],
];

test('koppen komen in elke brontaal in hetzelfde thema terecht', () => {
  const fout = KOPPEN.filter(([kop, verwacht]) => classifyTheme(kop, '') !== verwacht)
    .map(([kop, verwacht]) => `${kop} → ${classifyTheme(kop, '') || '(geen)'}, verwacht ${verwacht}`);
  assert.deepEqual(fout, []);
});

// Korte trefwoorden verborgen in een langer woord. Dit ging eerder mis: 'hiv'
// zit in "boschivi", 'road' in "abroad", 'dress' in "address" — en dan werd een
// bosbrand een gezondheidswaarschuwing.
const GEEN_TREFFER = [
  ['Incendi boschivi', 'gezondheid'],
  ['Death abroad', 'verkeer-vervoer'],
  ['Postal address', 'wetten-gebruiken'],
  ['Warnings and insurance', 'conflict-grens'],
];

test('korte trefwoorden matchen niet middenin een ander woord', () => {
  for (const [kop, nietDit] of GEEN_TREFFER) {
    assert.notEqual(classifyTheme(kop, ''), nietDit, `${kop} mag geen ${nietDit} zijn`);
  }
});

// Verbuigingen en samenstellingen moeten juist wél blijven werken.
test('meervouden en samenstellingen blijven matchen', () => {
  assert.equal(classifyTheme('Taxis', ''), 'verkeer-vervoer');
  assert.equal(classifyTheme('Roadblocks', ''), 'verkeer-vervoer');
  assert.equal(classifyTheme('Naturkatastrophen', ''), 'natuurgeweld');
  assert.equal(classifyTheme('Erdbebengefahr', ''), 'natuurgeweld');
});
