/**
 * Tests voor het geofilter van het lokale nieuws (geoVerdict/splitByGeo in
 * src/lib/news.js).
 *
 * Aanleiding: het nieuwsblok filterde alleen op ONDERWERP (conflict,
 * gezondheid, …), nooit op PLAATS. Daardoor stond er onder België een
 * NYT-kop over Groenland — de landenquery matcht de artikeltekst, terwijl wij
 * alleen de kop lezen — en vulden Afghaanse outlets hun conflictrubriek met
 * Oekraïne en Mexico, want een site:-query garandeert een lokale krant en
 * geen lokaal onderwerp.
 *
 * De regel is bewust asymmetrisch: lokale kranten noemen hun eigen land zelden
 * in de kop ("Explosion rocks capital"), dus bij een gecureerde outlet wordt
 * alleen bij hard tegenbewijs afgevoerd. Bij de gemengde landenquery is
 * positief bewijs vereist.
 *
 * Draaien: cd worker && node --test test/news-geo.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { geoVerdict, splitByGeo } from '../src/lib/news.js';

test('het gemelde geval: Groenland-kop hoort niet bij België', () => {
  assert.equal(
    geoVerdict('Greenland, Tariffs, NATO and Now Soccer. Trump Creates a New Clash With Europe.', 'BEL'),
    'other',
  );
});

test('land in de kop → self, ook als er meer landen in staan', () => {
  assert.equal(geoVerdict('At least 3,700 excess deaths during heatwave in France, Belgium and Netherlands', 'BEL'), 'self');
  assert.equal(geoVerdict('Germany defends Afghan deportation policy after fatal knife attack', 'DEU'), 'self');
});

test('demonym en hoofdstad tellen als het land zelf', () => {
  // Zonder demonym zou dit ten onrechte aan Pakistan worden toegeschreven.
  assert.equal(geoVerdict('Afghan Child Takes First Steps with Prosthetic After Pakistan Airstrike', 'AFG'), 'self');
  assert.equal(geoVerdict('IEA PM reviews progress of Kabul-Jalalabad second highway project', 'AFG'), 'self');
  assert.equal(geoVerdict('Dutch police arrest three in Amsterdam drugs raid', 'NLD'), 'self');
});

test('geen enkel land in de kop → none (de gewone lokale kop)', () => {
  assert.equal(geoVerdict('Officials Urge Relocation from High-Risk Areas Following Deadly Floods', 'AFG'), 'none');
  assert.equal(geoVerdict('Explosion rocks capital, dozens injured', 'UGA'), 'none');
});

test('langste naam wint: South Sudan is niet Sudan, American Samoa niet Samoa', () => {
  assert.equal(geoVerdict('Heavy rains flood Juba as South Sudan braces for more', 'SSD'), 'self');
  assert.equal(geoVerdict('Heavy rains flood Juba as South Sudan braces for more', 'SDN'), 'other');
  assert.equal(geoVerdict('Cyclone warning issued for American Samoa', 'ASM'), 'self');
  assert.equal(geoVerdict('Cyclone warning issued for American Samoa', 'WSM'), 'other');
});

test('samengestelde naam: "Antigua" telt voor Antigua and Barbuda', () => {
  // Dit ging eerst mis: de kop noemt alleen "Antigua", terwijl "Barbados"
  // voluit in de kop staat — het item werd aan Barbados toegeschreven.
  assert.equal(geoVerdict('Sunrise Airways launches nonstop flights between Antigua and Barbados', 'ATG'), 'self');
  assert.equal(geoVerdict('Storm damage reported across Trinidad', 'TTO'), 'self');
});

test('dubbelzinnige woorden wijzen niets af (Georgia is ook een Amerikaanse staat)', () => {
  // "Georgia" mag een kop wél aan Georgië toekennen, maar nooit een kop van
  // een ánder land afwijzen — anders sneuvelt nieuws over de VS-staat.
  assert.equal(geoVerdict('Wildfires spread across Georgia', 'GEO'), 'self');
  assert.equal(geoVerdict('Wildfires spread across Georgia', 'ARM'), 'none');
  assert.equal(geoVerdict('Jordan scores twice in the final', 'KEN'), 'none');
});

test('afkortingen met punten worden herkend (U.S. hoort niet bij Afghanistan)', () => {
  assert.equal(geoVerdict('Trump Fires Election Assistance Commission Members Ahead of U.S. Midterms', 'AFG'), 'other');
});

test('splitByGeo: gecureerde outlet voert alleen bij hard tegenbewijs af', () => {
  const items = [
    { title: 'Officials urge relocation following deadly floods' },   // none  -> blijft
    { title: 'Kabul market blast kills four' },                        // self  -> blijft
    { title: 'Mexico highway crash kills nine' },                      // other -> weg
  ];
  const { onTopic, demoted } = splitByGeo(items, 'AFG', true);
  assert.deepEqual(onTopic.map((i) => i.geo), ['none', 'self']);
  assert.deepEqual(demoted.map((i) => i.title), ['Mexico highway crash kills nine']);
});

test('splitByGeo: landenquery eist positief bewijs, dus ook "none" gaat opzij', () => {
  const items = [
    { title: 'Officials urge relocation following deadly floods' },    // none -> weg
    { title: 'Flooding hits Brussels after record rainfall' },          // self -> blijft
  ];
  const { onTopic, demoted } = splitByGeo(items, 'BEL', false);
  assert.deepEqual(onTopic.map((i) => i.title), ['Flooding hits Brussels after record rainfall']);
  assert.equal(demoted.length, 1);
});

test('ReliefWeb-kop met ISO3-code vooraan telt als het land zelf', () => {
  assert.equal(geoVerdict('LAO: Flood - 07-2026 - Flooding as a result of Typhoon Maysak', 'LAO'), 'self');
  // Alleen vooraan mét dubbele punt — losse drieletterwoorden zijn te riskant
  // ("and", "are", "can" zijn ook ISO3-codes).
  assert.equal(geoVerdict('Rescuers can reach the village by boat', 'CAN'), 'none');
});

test('lokale outlet krijgt binnen de landenquery dezelfde coulance als een gecureerde bron', () => {
  // Dit was het geval Cook Islands: de lokale krant schrijft "Teen tourist
  // rescued from cross-island track" zonder het land te noemen. Onder de
  // strenge queryregel viel vrijwel het hele nieuwsblok weg.
  const items = [
    { title: 'Teen tourist rescued from cross-island track after fall', outlet: 'Cook Islands News' },
    { title: 'Dengue in the Pacific: Multicountry Situation - Fiji', outlet: 'ReliefWeb' },
    { title: 'Letter: A real choice or a divided Opposition?', outlet: 'Cook Islands News' },
  ];
  const { onTopic, demoted } = splitByGeo(items, 'COK', false);
  assert.equal(onTopic.length, 2, 'de twee stukken van de lokale krant blijven staan');
  assert.deepEqual(demoted.map((i) => i.outlet), ['ReliefWeb']);
});

test('splitByGeo gooit niets weg: alles komt in precies één van de twee bakken', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ title: `Bericht ${i} over van alles en nog wat` }));
  const { onTopic, demoted } = splitByGeo(items, 'KEN', true);
  assert.equal(onTopic.length + demoted.length, items.length);
});
