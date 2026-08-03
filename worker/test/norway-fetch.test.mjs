/**
 * Tests voor het ophalen van het Noorse advies (src/adapters/norway.js).
 *
 * Achtergrond: regjeringen.no zet een Cloudflare-botcheck voor élk verzoek van
 * een datacenter-IP. Die wachtkamer ("Just a moment…") komt terug met HTTP 200,
 * dus een geslaagde fetch zei niets. De adapter vond op zo'n pagina geen
 * secties en gaf stílletjes null terug — niet te onderscheiden van "dit land
 * heeft geen advies". Gevolg: Noorwegen stond in geen enkel van de 226
 * landbestanden in het snapshot-vangnet (0%, tegen 32-100% voor de andere
 * bronnen) en verdween uit de vergelijking zodra live ophalen faalde.
 *
 * De adapter probeert vier routes achter elkaar: rechtstreeks (met volledige
 * browser-headers, en intern de CORS-proxy als vangnet), de reader, de reader
 * via een Noorse proxy, en tot slot die proxy mét browser-engine. Elke route
 * wordt op de wachtkamer gecontroleerd — een HTTP 200 zegt hier niets.
 *
 * Die derde route is de enige die niet vanaf een datacenter-IP komt, en dat is
 * precies waar de Cloudflare-wachtkamer op selecteert.
 *
 * Er wordt niet echt over het netwerk opgehaald: globalThis.fetch wordt gemockt
 * zodat we per poging kunnen bepalen wat er terugkomt — wachtkamer of echte
 * pagina.
 *
 * Draaien: cd worker && node --test test/norway-fetch.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAdvisory, looksBlocked } from '../src/adapters/norway.js';

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

// Verkorte, maar echte Cloudflare-interstitial (zoals r.jina.ai hem teruggaf).
const CHALLENGE = `<html lang="en-US"><head><title>Just a moment...</title>
<meta name="robots" content="noindex,nofollow"></head><body>
<div class="main-wrapper"><p>Verifying you are human. This may take a few seconds.</p></div></body></html>`;

// Een geloofwaardige adviespagina: h1 + h2/h3-secties met genoeg tekst
// (splitByHeadings eist >40 tekens per sectie).
const vul = (s) => s + ' '.repeat(0) + 'Dette avsnittet inneholder nok tekst til at seksjonen regnes som reell innhold.';
const PAGINA = `<html><body><article>
<h1>Egypt - reiseinformasjon</h1>
<h2>Reiseadvarsel for Egypt</h2><p>${vul('Utenriksdepartementet fraråder reiser som ikke er strengt nødvendige til Nord-Sinai.')}</p>
<h3>Sikkerhet</h3><p>${vul('Det er økt risiko for terror i deler av landet.')}</p>
<h3>Helse</h3><p>${vul('Helsetilbudet varierer betydelig utenfor de store byene.')}</p>
<p>Oppdatert: 14.05.2026</p>
</article></body></html>`;

/**
 * Mockt het netwerk; `plan(n, route)` levert per aanroep een body (of een
 * statuscode om te laten falen). `route` is 'direct', 'reader' of
 * 'reader+browser', zodat een test kan vastleggen wélke route aan de beurt was.
 */
function netwerkGeeft(plan) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const h = opts.headers || {};
    const viaReader = String(url).includes('r.jina.ai');
    const proxy = h['x-proxy'] ? '+proxy' : '';
    const route = !viaReader ? 'direct'
      : (h['X-Engine'] === 'browser' ? 'reader+browser' : 'reader') + proxy;
    calls.push({ url: String(url), route });
    const out = plan(calls.length, route);
    if (out instanceof Error) throw out;
    if (typeof out === 'number') return { ok: false, status: out, text: async () => '' };
    return { ok: true, status: 200, text: async () => out };
  };
  return calls;
}

const EGY = 'egypt/2415880';

test('looksBlocked herkent de Cloudflare-wachtkamer, niet een echt advies', () => {
  assert.equal(looksBlocked(CHALLENGE), true);
  assert.equal(looksBlocked(PAGINA), false);
  assert.equal(looksBlocked(''), false);
});

test('rechtstreeks al goed → advies met thema\'s, reader wordt niet gebruikt', async () => {
  const calls = netwerkGeeft(() => PAGINA);
  const adv = await getAdvisory(EGY);
  assert.ok(adv, 'advies verwacht');
  assert.ok(adv.themes.length >= 2, `>=2 thema's verwacht, kreeg ${adv.themes?.length}`);
  assert.equal(adv.source, 'no');
  assert.equal(adv.lastModified, '2026-05-14');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, 'direct');
});

test('rechtstreeks geblokkeerd → de reader mag het proberen', async () => {
  const calls = netwerkGeeft((n) => (n === 1 ? CHALLENGE : PAGINA));
  const adv = await getAdvisory(EGY);
  assert.ok(adv, 'advies verwacht via de reader');
  assert.deepEqual(calls.map((c) => c.route), ['direct', 'reader']);
});

test('pas de Noorse proxy komt erdoor', async () => {
  const calls = netwerkGeeft((n) => (n < 3 ? CHALLENGE : PAGINA));
  const adv = await getAdvisory(EGY);
  assert.ok(adv, 'advies verwacht via de proxy-poging');
  assert.ok(adv.themes.length >= 2);
  assert.deepEqual(calls.map((c) => c.route), ['direct', 'reader', 'reader+proxy']);
});

test('de proxy-routes vragen om een Noors uitgaand IP', async () => {
  const calls = netwerkGeeft(() => CHALLENGE);
  await assert.rejects(getAdvisory(EGY));
  const metProxy = calls.filter((c) => c.route.includes('proxy'));
  assert.equal(metProxy.length, 2, 'twee proxy-pogingen verwacht');
});

test('alle routes geblokkeerd → werpt (i.p.v. stil null, dat las als "geen advies")', async () => {
  netwerkGeeft(() => CHALLENGE);
  await assert.rejects(getAdvisory(EGY), /botcheck/i);
});

test('de foutmelding noemt per route wat er misging', async () => {
  netwerkGeeft((n, route) => (route.includes('browser') ? 401 : CHALLENGE));
  await assert.rejects(getAdvisory(EGY), (e) => {
    assert.match(e.message, /direct: botcheck/);
    assert.match(e.message, /reader: botcheck/);
    assert.match(e.message, /reader\+proxy: botcheck/);
    assert.match(e.message, /reader\+browser\+proxy: .*401/);
    return true;
  });
});

test('zonder of met kapotte mapping → null, zonder ook maar te fetchen', async () => {
  const calls = netwerkGeeft(() => PAGINA);
  assert.equal(await getAdvisory(''), null);
  assert.equal(await getAdvisory('alleen-slug-zonder-id'), null);
  assert.equal(calls.length, 0);
});
