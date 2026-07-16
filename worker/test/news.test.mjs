/**
 * Tests voor de lokaal-nieuws-functies (lib/news.js): RSS-parsing,
 * categorie-classificatie, ruisfilters en kruisbevestiging.
 *
 * Draaien: cd worker && node --test test/*.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNewsRss, classifyNews, markCorroborated, buildNewsOverview } from '../src/lib/news.js';

test('parseNewsRss: titels, outlet-suffix eraf, datums genormaliseerd', () => {
  const xml = `<rss><channel>
    <item><title>Floods displace hundreds in Mbale - Daily Monitor</title><link>https://x/1</link><pubDate>Tue, 30 Jun 2026 08:00:00 GMT</pubDate></item>
    <item><title><![CDATA[Army confirms operation near border - New Vision]]></title><link>https://x/2</link><pubDate>Wed, 01 Jul 2026 09:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const items = parseNewsRss(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Floods displace hundreds in Mbale');
  assert.equal(items[0].date, '2026-06-30');
  assert.equal(items[1].title, 'Army confirms operation near border');
});

test('classifyNews: reisadvies-categorieën en ruis', () => {
  assert.equal(classifyNews('Floods displace hundreds in eastern districts'), 'natuurgeweld');
  assert.equal(classifyNews('Gunmen attack village near the border'), 'conflict');
  assert.equal(classifyNews('Court denies opposition leader bail amid protests'), 'politiek');
  assert.equal(classifyNews('New visa rules for foreign tourists announced'), 'reizen');
  assert.equal(classifyNews('Cholera outbreak declared in coastal region'), 'gezondheid');
  assert.equal(classifyNews('Police warn of kidnap gangs targeting taxis'), 'criminaliteit');
  // Ruis: jubileum, buitenlandrubriek, sport, zoekpagina — en niet-relevant.
  assert.equal(classifyNews('Today in History: Terror strikes during 2010 World Cup final'), null);
  assert.equal(classifyNews('World: Eight soldiers killed in fresh strikes abroad'), null);
  assert.equal(classifyNews('Sports: national team wins qualifier'), null);
  assert.equal(classifyNews('Search results for drought'), null);
  assert.equal(classifyNews('Central bank keeps interest rate unchanged'), null);
});

test('markCorroborated: zelfde nieuws bij twee outlets → multi, zelfde outlet niet', () => {
  const items = [
    { title: 'Ebola response workers attacked in western region', outlet: 'A', ts: 2 },
    { title: 'Attacks leave Ebola response workers wounded in western region', outlet: 'B', ts: 1 },
    { title: 'Ebola response workers attacked in western region — update', outlet: 'A', ts: 3 },
    { title: 'Parliament passes new budget', outlet: 'B', ts: 1 },
  ];
  markCorroborated(items);
  assert.ok(items[0].multi && items[1].multi, 'kruisbevestiging over outlets heen');
  assert.ok(!items[3].multi, 'los bericht niet gemarkeerd');
  assert.ok(items[0].alsoAt.has('B'));
});

test('buildNewsOverview: kruisbevestigd eerst, ontdubbeld, max per outlet', () => {
  const mk = (title, outlet, ts) => ({ title, outlet, ts, link: 'https://x', date: '2026-07-01' });
  const items = [
    mk('Gunmen attack convoy on northern highway', 'A', 5),
    mk('Convoy attacked by gunmen on northern highway', 'B', 4), // zelfde nieuws
    mk('Rebels clash with army in eastern hills', 'A', 9),
    mk('Militia fighting reported near southern town', 'A', 8),
    mk('Army offensive continues against insurgents', 'A', 7), // 3e van outlet A → cap
  ];
  const out = buildNewsOverview(items, 5);
  const conflict = out.conflict.items;
  assert.ok(conflict[0].multi, 'kruisbevestigd item staat bovenaan');
  const titles = conflict.map((i) => i.title);
  assert.ok(!titles.includes('Convoy attacked by gunmen on northern highway'), 'duplicaat ontdubbeld');
  assert.ok(conflict.filter((i) => i.outlet === 'A').length <= 2, 'max 2 per outlet per categorie');
});

test('buildNewsOverview: lege invoer → leeg overzicht', () => {
  assert.deepEqual(buildNewsOverview([], 5), {});
});
