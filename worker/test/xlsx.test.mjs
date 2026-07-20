/**
 * Rooktest voor de dependency-vrije XLSX-schrijver (public/xlsx.js).
 * Draait de browser-IIFE in Node (die hangt buildXlsx aan globalThis) en
 * controleert dat er een geldig, store-only ZIP-pakket uit komt met de
 * verwachte onderdelen. Omdat we niet comprimeren, staat alle celtekst
 * letterlijk (onversleuteld) in de bytes — handig om inhoud te checken.
 *
 * Draaien: cd worker && node --test test/xlsx.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

await import('../../public/xlsx.js'); // zet globalThis.buildXlsx

test('buildXlsx: geldig ZIP-pakket met bladen, stijlen en celtekst', async () => {
  const blob = globalThis.buildXlsx([
    { name: 'Overzicht', freeze: 1, cols: [20, 12], merges: ['A1:B1'],
      rows: [
        [{ v: 'Titel', t: 'title' }],
        [{ v: 'Land', t: 'header' }, { v: 'Kleur', t: 'header' }],
        [{ v: 'Kenia', t: 'country' }, { v: 'Geel', t: 'cc_geel' }],
        [{ v: 'Somalië', t: 'country' }, { v: 'Rood', t: 'cc_rood' }],
      ] },
    { name: 'Inhoud', rows: [[{ v: 'Wat de bron zegt', t: 'header' }], [{ v: 'Demonstraties in Nairobi.', t: 'text' }]] },
  ]);

  assert.ok(blob && typeof blob.arrayBuffer === 'function', 'geeft een Blob terug');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.ok(bytes.length > 500, 'niet-leeg pakket');

  // ZIP-signaturen: lokaal record (PK\x03\x04) en einde-centrale-directory (PK\x05\x06).
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'begint met ZIP local header');
  const hasEOCD = (() => {
    for (let i = bytes.length - 22; i >= 0; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) return true;
    }
    return false;
  })();
  assert.ok(hasEOCD, 'bevat einde-centrale-directory');

  // Store-only: alle onderdelen + celtekst staan letterlijk in de bytes.
  const txt = new TextDecoder('latin1').decode(bytes);
  for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml',
    'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) {
    assert.ok(txt.includes(part), `bevat ${part}`);
  }
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  assert.ok(utf8.includes('Kenia') && utf8.includes('Demonstraties in Nairobi.'), 'celtekst aanwezig');
  assert.ok(utf8.includes('Overzicht') && utf8.includes('Inhoud'), 'bladnamen aanwezig');
  assert.ok(utf8.includes('mergeCell ref="A1:B1"'), 'samengevoegde cel aanwezig');
});
