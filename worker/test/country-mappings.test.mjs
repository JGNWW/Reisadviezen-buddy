/**
 * Bewaakt de landkoppelingen (countries.json) — met nadruk op Spanje.
 *
 * Aanleiding: de Spaanse koppeling is een landnáám in de URL (?trc=Naam) en
 * werd afgeleid via machinevertaling. Een onbekende naam geeft bij
 * exteriores.gob.es echter HTTP 200 mét een stubpagina, geen 404. Daardoor
 * bleven 54 landen jarenlang stil op "niet vast te stellen" staan: Jordanië
 * kwam binnen als "Jordán", Togo als "Ir", Groenland als "Tierra Verde", en
 * Dominica wees zelfs naar de pagina van de Dominicaanse Republiek. Geen
 * enkele netwerkcontrole kon dat zien.
 *
 * Daarom staan de Spaanse namen nu vast in slug-overrides.json, overgenomen
 * uit de eigen landenlijst van de site. Deze tests bewaken dat die tabel de
 * bron van waarheid blijft en dat de twee kopieën van countries.json
 * (Worker en server) niet uit elkaar lopen.
 *
 * Draaien: cd worker && node --test test/country-mappings.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const lees = (p) => JSON.parse(readFileSync(join(hier, p), 'utf8'));

const workerLanden = lees('../src/data/countries.json');
const serverLanden = lees('../../server/data/countries.json');
const overrides = lees('../../server/data/slug-overrides.json');

test('de Worker- en server-kopie kennen dezelfde landen en Spaanse namen', () => {
  // De Worker-kopie heeft méér bronnen (jp/it/fi/kr/no/at/ch kwamen er later
  // bij en draaien alleen in de Worker), dus de bestanden zijn bewust niet
  // identiek. De landenset en de gedeelde koppelingen horen wél gelijk te
  // lopen — anders repareer je er stilzwijgend maar één van de twee.
  assert.deepEqual(Object.keys(workerLanden).sort(), Object.keys(serverLanden).sort());
  const scheef = Object.keys(workerLanden)
    .filter((iso) => (workerLanden[iso].sources?.es ?? null) !== (serverLanden[iso].sources?.es ?? null))
    .map((iso) => `${iso}: worker ${JSON.stringify(workerLanden[iso].sources?.es)} vs server ${JSON.stringify(serverLanden[iso].sources?.es)}`);
  assert.deepEqual(scheef, [], `Spaanse naam loopt uiteen:\n${scheef.join('\n')}`);
});

test('elke Spaanse koppeling ligt vast in slug-overrides.json', () => {
  const vast = overrides.es || {};
  const ontbreekt = Object.keys(workerLanden).filter(
    (iso) => !Object.prototype.hasOwnProperty.call(vast, iso),
  );
  assert.deepEqual(ontbreekt, [], `zonder vastgelegde Spaanse naam: ${ontbreekt.join(', ')}`);

  const afwijkend = Object.keys(workerLanden)
    .filter((iso) => (workerLanden[iso].sources?.es ?? null) !== (vast[iso] ?? null))
    .map((iso) => `${iso}: ${JSON.stringify(workerLanden[iso].sources?.es)} != ${JSON.stringify(vast[iso])}`);
  assert.deepEqual(afwijkend, [], `wijkt af van de overridetabel:\n${afwijkend.join('\n')}`);
});

test('de bekende foute Spaanse namen komen niet terug', () => {
  // Steekproef uit wat de vertaling ervan maakte, plus de ISO-langvormen die
  // de site niet kent. Eén ervan terugzien betekent dat de afleiding via
  // vertaling weer aan staat.
  const fout = {
    JOR: 'Jordán', TGO: 'Ir', GRL: 'Tierra Verde', DMA: 'república dominicana',
    IRN: 'Irán, República Islámica de', SYR: 'República Árabe Siria',
    LAO: 'República Democrática Popular Lao', KOR: 'Corea del Sur',
    CZE: 'Chequia', MMR: 'Birmania', SLV: 'Salvador', GUY: 'Guayana',
  };
  for (const [iso, waarde] of Object.entries(fout)) {
    assert.notEqual(
      String(workerLanden[iso]?.sources?.es || '').toLowerCase(), waarde.toLowerCase(),
      `${iso} staat weer op de verkeerde Spaanse naam "${waarde}"`,
    );
  }
  // En de gerepareerde waarden staan er wél.
  assert.equal(workerLanden.JOR.sources.es, 'Jordania');
  assert.equal(workerLanden.TGO.sources.es, 'Togo');
  assert.equal(workerLanden.DMA.sources.es, 'Dominica');
  assert.equal(workerLanden.IRN.sources.es, 'Irán');
});

test('geen enkele Spaanse naam draagt nog een ISO-langvorm', () => {
  // "X, República de" / "X, Estado de" zijn ISO-3166-namen; exteriores.gob.es
  // gebruikt uitsluitend de korte vorm.
  const langvorm = Object.entries(workerLanden)
    .filter(([, r]) => typeof r.sources?.es === 'string' && /,\s/.test(r.sources.es))
    .map(([iso, r]) => `${iso}: ${r.sources.es}`);
  assert.deepEqual(langvorm, [], `ISO-langvorm als Spaanse naam:\n${langvorm.join('\n')}`);
});
