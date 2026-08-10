/**
 * Tests voor de terugval van de reader bij een saldofout (src/lib/fetch.js).
 *
 * Aanleiding: Australië stond een week lang stil. In het logboek van de
 * zesuurlijkse snapshot:
 *
 *   au: 220/220 mislukt (100%) — reader 402 … {"code":402,"name":"InsufficientBa…"}
 *
 * De Smartraveller-adapter hangt volledig aan de reader — die bron weigert
 * datacenter-IP's, dus er is geen rechtstreekse route. Zodra het saldo van de
 * key op was, viel Australië dus in één klap volledig weg. De vergelijking
 * bleef ondertussen de snapshot van 3 augustus tonen alsof er niets aan de hand
 * was.
 *
 * De pointe: mét een uitgeputte key antwoordt de reader 402, zónder key krijg
 * je gewoon de gratis anonieme laag. Een lege key is in die toestand dus béter
 * dan een gevulde. Vandaar dat een 402 opnieuw wordt geprobeerd als anonieme
 * bezoeker.
 *
 * Draaien: cd worker && node --test test/reader-402.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getViaReader, setReaderKey } from '../src/lib/fetch.js';

const echteFetch = globalThis.fetch;

/** Vervangt fetch door een opnemer die per beurt een antwoord teruggeeft. */
function nep(antwoorden) {
  const beurten = [];
  globalThis.fetch = async (url, opts = {}) => {
    const auth = opts.headers?.Authorization || null;
    beurten.push({ url: String(url), auth });
    const a = antwoorden[beurten.length - 1];
    if (!a) throw new Error(`onverwachte extra aanroep (${beurten.length})`);
    return {
      ok: a.status >= 200 && a.status < 300,
      status: a.status,
      text: async () => a.body ?? '',
    };
  };
  return beurten;
}

test.afterEach(() => { globalThis.fetch = echteFetch; setReaderKey(null); });

test('een 402 met key wordt opnieuw geprobeerd zonder key', async () => {
  setReaderKey('sleutel-zonder-saldo');
  const beurten = nep([
    { status: 402, body: '{"data":null,"code":402,"name":"InsufficientBalanceError"}' },
    { status: 200, body: '<html>advies</html>' },
  ]);

  const html = await getViaReader('https://www.smartraveller.gov.au/destinations/asia/thailand', 'html');

  assert.equal(html, '<html>advies</html>');
  assert.equal(beurten.length, 2, 'precies één herkansing');
  assert.ok(beurten[0].auth, 'eerste poging hoort de key mee te sturen');
  assert.equal(beurten[1].auth, null, 'de herkansing hoort anoniem te zijn');
  // De overige kopregels horen gewoon mee te gaan; alleen de key valt weg.
  assert.equal(beurten[0].url, beurten[1].url);
});

test('zonder key wordt er niets opnieuw geprobeerd', async () => {
  // Anders zou een 402 op de gratis laag het aantal verzoeken verdubbelen
  // zonder ooit iets op te lossen.
  const beurten = nep([{ status: 402, body: 'geen saldo' }]);
  await assert.rejects(
    () => getViaReader('https://example.org/x'),
    /reader 402/,
  );
  assert.equal(beurten.length, 1);
});

test('helpt de herkansing niet, dan blijft de saldofout de melding', async () => {
  // De anonieme laag weigert niet elk IP even hartelijk: vanaf een IP met een
  // slechte naam komt er 401 "bad IP reputation" terug. Zou die de melding
  // worden, dan ging het bericht over het IP terwijl er een leeg tegoed onder
  // ligt — en dat laatste is wat er opgelost moet worden.
  setReaderKey('sleutel-zonder-saldo');
  nep([
    { status: 402, body: '{"code":402,"name":"InsufficientBalanceError"}' },
    { status: 401, body: '{"code":401,"name":"AuthenticationRequiredError","message":"bad IP reputation"}' },
  ]);
  await assert.rejects(
    () => getViaReader('https://example.org/x'),
    (e) => {
      assert.match(e.message, /reader 402/);
      assert.match(e.message, /InsufficientBalance/);
      assert.match(e.message, /anonieme herkansing: 401/, 'de uitkomst van de herkansing hoort erbij te staan');
      return true;
    },
  );
});

test('een andere fout dan saldo wordt niet opnieuw geprobeerd', async () => {
  setReaderKey('geldige-sleutel');
  const beurten = nep([{ status: 451, body: 'niet beschikbaar' }]);
  await assert.rejects(() => getViaReader('https://example.org/x'), /reader 451/);
  assert.equal(beurten.length, 1, 'alleen een saldofout verdient een herkansing');
});

test('een geslaagde eerste poging kost één verzoek', async () => {
  setReaderKey('geldige-sleutel');
  const beurten = nep([{ status: 200, body: 'ok' }]);
  assert.equal(await getViaReader('https://example.org/x'), 'ok');
  assert.equal(beurten.length, 1);
});
