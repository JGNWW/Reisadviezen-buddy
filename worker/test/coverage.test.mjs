/**
 * Thema-dekkingstest: bewaakt dat de trefwoord-classificatie voldoende
 * secties van elke bron een thema geeft. Elk niet-geclassificeerd blok
 * belandt in "Overige / niet ingedeeld" en staat dan in de matrix naast
 * níks — dus dalende dekking (bijv. door een nieuwe kopstructuur bij een
 * bron, of een sneuvelend trefwoord) hoort CI te breken.
 *
 * De drempels liggen bewust onder de gemeten waarden (juli 2026: uk 100%,
 * dk 100%, de 96%, es 86%, ie 79%, us 76%, fr 67%) — de rest is echte
 * niet-adviesinhoud (navigatie, podcasts, doelgroep-pagina's).
 *
 * Draaien: cd worker && node --test test/contract.test.mjs test/coverage.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFixtureFetch } from './fixtures.mjs';

installFixtureFetch();

const CASES = [
  ['uk', 'nepal', '../src/adapters/uk.js', 95],
  ['us', 'nepal', '../src/adapters/us.js', 70],
  ['ie', 'nepal', '../src/adapters/ireland.js', 70],
  ['fr', 'nepal', '../src/adapters/france.js', 60],
  ['es', 'Nepal', '../src/adapters/spain.js', 80],
  ['de', 'NPL', '../src/adapters/germany.js', 85],
  ['dk', 'nepal', '../src/adapters/denmark.js', 90],
];

for (const [sid, arg, mod, minPct] of CASES) {
  test(`thema-dekking ${sid}: >= ${minPct}% van de secties krijgt een thema`, async () => {
    const adapter = await import(mod);
    const adv = await adapter.getAdvisory(arg);
    const total = adv.themes.length;
    const classified = adv.themes.filter((t) => t.themeId).length;
    const pct = Math.round((classified / total) * 100);
    const missing = adv.themes.filter((t) => !t.themeId).map((t) => t.heading.slice(0, 40));
    assert.ok(pct >= minPct,
      `${sid}: dekking ${pct}% (< ${minPct}%). Zonder thema: ${missing.join(' | ')}`);
  });
}
