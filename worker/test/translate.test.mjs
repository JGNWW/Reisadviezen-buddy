/**
 * Tests voor de vertaalketen (src/lib/translate.js): Google primair, MyMemory
 * als vangnet wanneer Google faalt. Er wordt niet echt over het netwerk
 * vertaald: globalThis.fetch wordt gemockt en op URL gerouteerd (Google vs
 * MyMemory) zodat we het overschakelen, het request en het parsen kunnen
 * controleren.
 *
 * Draaien: cd worker && node --test test/translate.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { configureTranslator, activeTranslator, translate } from '../src/lib/translate.js';

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

let calls;
/** Routeert fetch naar de google- of mymemory-handler en logt elke call. */
function route({ google, mymemory }) {
  calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const kind = u.includes('mymemory') ? 'mymemory' : 'google';
    calls.push({ kind, url: u, opts: opts || {} });
    const h = kind === 'mymemory' ? mymemory : google;
    return h(u, opts || {});
  };
}
const okJson = (obj) => ({ ok: true, status: 200, json: async () => obj });
const httpErr = (status) => ({ ok: false, status, json: async () => ({}) });
const googleOk = (t) => okJson([[[t, 'src', null, null]], null, 'en']);
const mmOk = (t) => okJson({ responseStatus: 200, responseData: { translatedText: t } });

test('activeTranslator meldt de keten google→mymemory', () => {
  assert.equal(configureTranslator({}), 'google→mymemory');
  assert.equal(activeTranslator(), 'google→mymemory');
});

test('Google lukt → Google-resultaat, MyMemory wordt niet aangeroepen', async () => {
  configureTranslator({});
  route({ google: () => googleOk('Hallo via google A'), mymemory: () => { throw new Error('niet aanroepen'); } });
  const r = await translate('Hello google-primair-A', 'nl', 'en');
  assert.equal(r.text, 'Hallo via google A');
  assert.deepEqual(calls.map((c) => c.kind), ['google']);
});

test('Google faalt (403) → schakelt over op MyMemory', async () => {
  configureTranslator({});
  route({ google: () => httpErr(403), mymemory: () => mmOk('Hallo via mymemory B') });
  const r = await translate('Hello fallback-B', 'nl', 'en');
  assert.equal(r.text, 'Hallo via mymemory B');
  assert.equal(calls.filter((c) => c.kind === 'google').length, 1);
  assert.equal(calls.filter((c) => c.kind === 'mymemory').length, 1);
  const mm = calls.find((c) => c.kind === 'mymemory');
  assert.match(mm.url, /langpair=en\|nl/); // en|nl (pipe letterlijk, geldig voor MyMemory)
});

test('MYMEMORY_EMAIL wordt als &de= meegestuurd', async () => {
  configureTranslator({ MYMEMORY_EMAIL: 'redactie@example.org' });
  route({ google: () => httpErr(403), mymemory: () => mmOk('vertaald C') });
  await translate('Hello email-C', 'nl', 'en');
  const mm = calls.find((c) => c.kind === 'mymemory');
  assert.match(mm.url, /de=redactie%40example\.org/);
  configureTranslator({}); // reset voor volgende tests
});

test('beide backends falen → translate() werpt (aanroeper toont dan de brontekst)', async () => {
  configureTranslator({});
  route({ google: () => httpErr(403), mymemory: () => httpErr(403) });
  await assert.rejects(translate('Hello beide-falen-D', 'nl', 'en'));
});

test('MyMemory-quotummelding in het tekstveld telt als mislukt', async () => {
  configureTranslator({});
  route({
    google: () => httpErr(403),
    mymemory: () => okJson({ responseStatus: 200, responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY' } }),
  });
  await assert.rejects(translate('Hello quota-E', 'nl', 'en'));
});

test('MyMemory wordt overgeslagen bij bron "auto" (geen taalpaar mogelijk)', async () => {
  configureTranslator({});
  route({ google: () => httpErr(403), mymemory: () => mmOk('zou niet mogen') });
  await assert.rejects(translate('Hello auto-F', 'nl', 'auto'));
  assert.equal(calls.filter((c) => c.kind === 'mymemory').length, 0);
});

test('lege invoer → lege vertaling, geen enkele fetch', async () => {
  configureTranslator({});
  let called = false;
  globalThis.fetch = async () => { called = true; return okJson([]); };
  const r = await translate('   ', 'nl', 'en');
  assert.equal(r.text, '');
  assert.equal(called, false);
});
