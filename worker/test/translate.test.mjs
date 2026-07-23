/**
 * Tests voor de inwisselbare vertaalbackends (src/lib/translate.js). Er wordt
 * niet echt over het netwerk vertaald: globalThis.fetch wordt gemockt zodat we
 * (a) de backendkeuze via configureTranslator, (b) de opgebouwde request en
 * (c) het parsen van de respons per backend kunnen controleren.
 *
 * Draaien: cd worker && node --test test/translate.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { configureTranslator, activeTranslator, translate } from '../src/lib/translate.js';

const realFetch = globalThis.fetch;
let LAST; // laatste { url, opts } die aan fetch is meegegeven
function mockFetch(jsonForCall) {
  globalThis.fetch = async (url, opts) => {
    LAST = { url: String(url), opts: opts || {} };
    return { ok: true, status: 200, json: async () => jsonForCall(LAST) };
  };
}
test.after(() => { globalThis.fetch = realFetch; });

test('configureTranslator kiest de backend op basis van secrets', () => {
  assert.equal(configureTranslator({}), 'google');
  assert.equal(configureTranslator({ LIBRETRANSLATE_URL: 'http://lt:5000/' }), 'libre');
  assert.equal(configureTranslator({ DEEPL_KEY: 'x' }), 'deepl'); // DeepL wint van Libre
  assert.equal(configureTranslator({ DEEPL_KEY: 'x', LIBRETRANSLATE_URL: 'http://lt' }), 'deepl');
  configureTranslator({});
  assert.equal(activeTranslator(), 'google');
});

test('google (standaard): juist endpoint + parse van de geneste array-respons', async () => {
  configureTranslator({});
  mockFetch(() => [[['Hallo wereld google', 'Hello world', null, null]], null, 'en']);
  const r = await translate('Hello world google-uniek', 'nl', 'en');
  assert.match(LAST.url, /translate_a\/single/);
  assert.match(LAST.url, /tl=nl/);
  assert.equal(r.text, 'Hallo wereld google');
  assert.equal(r.detected, 'en');
});

test('deepl: POST met Authorization-header, uppercase target_lang, parse van translations[]', async () => {
  configureTranslator({ DEEPL_KEY: 'test-key' });
  mockFetch(() => ({ translations: [{ text: 'Hallo wereld deepl', detected_source_language: 'EN' }] }));
  const r = await translate('Hello world deepl-uniek', 'nl', 'en');
  assert.match(LAST.url, /api-free\.deepl\.com/);
  assert.equal(LAST.opts.method, 'POST');
  assert.equal(LAST.opts.headers.Authorization, 'DeepL-Auth-Key test-key');
  assert.match(String(LAST.opts.body), /target_lang=NL/);
  assert.equal(r.text, 'Hallo wereld deepl');
  assert.equal(r.detected, 'en');
});

test('deepl: Noors (no) → Bokmål (NB) als source_lang', async () => {
  configureTranslator({ DEEPL_KEY: 'k' });
  mockFetch(() => ({ translations: [{ text: 'vertaald', detected_source_language: 'NB' }] }));
  await translate('Norsk kildetekst deepl-no', 'nl', 'no');
  assert.match(String(LAST.opts.body), /source_lang=NB/);
});

test('libre: POST /translate met JSON-body en parse van translatedText', async () => {
  configureTranslator({ LIBRETRANSLATE_URL: 'http://lt:5000/', LIBRETRANSLATE_KEY: 'lk' });
  mockFetch(() => ({ translatedText: 'Hallo wereld libre', detectedLanguage: { language: 'en' } }));
  const r = await translate('Hello world libre-uniek', 'nl', 'en');
  assert.equal(LAST.url, 'http://lt:5000/translate'); // trailing slash genormaliseerd
  const body = JSON.parse(LAST.opts.body);
  assert.equal(body.q, 'Hello world libre-uniek');
  assert.equal(body.target, 'nl');
  assert.equal(body.api_key, 'lk');
  assert.equal(r.text, 'Hallo wereld libre');
  assert.equal(r.detected, 'en');
});

test('lege invoer → lege vertaling, geen fetch', async () => {
  configureTranslator({});
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, json: async () => [] }; };
  const r = await translate('   ', 'nl', 'en');
  assert.equal(r.text, '');
  assert.equal(called, false);
});
