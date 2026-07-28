/**
 * Tests voor de Zuid-Koreaanse niveaubepaling (kind 'kr_alert_zones' in
 * src/analysis/country-level.js).
 *
 * MOFA (0404.go.kr) geeft per land (waarschuwing, gebied)-paren. Het aantal
 * trappen wringt: Korea kent er vijf — 여행유의 (blauw), 여행자제 (geel),
 * 특별여행주의보 (rood gestreept), 출국권고 (rood) en 여행금지 (zwart) — en
 * wij vier kleuren.
 *
 * Eerder werd de BOVENKANT verankerd: 여행금지 kreeg onze rood, waardoor alles
 * eronder een trap opschoof en Korea's eigen RODE niveau 출국권고 op onze
 * oranje belandde. Bahrein stond daardoor op 0404.go.kr rood en bij ons
 * oranje, en Zuid-Korea kwam structureel milder in de matrix dan elke andere
 * bron — terwijl die matrix juist bestaat om bronnen naast elkaar te leggen.
 *
 * Nu volgt de schaal de kleuren die MOFA zelf gebruikt. 여행금지 is zwaarder
 * dan onze rood maar valt daar noodgedwongen mee samen; het verschil met
 * 출국권고 blijft in het label en de toelichting staan.
 *
 * Draaien: cd worker && node --test test/korea-levels.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretStructured } from '../src/analysis/country-level.js';

const beoordeel = (zones) => interpretStructured({ kind: 'kr_alert_zones', value: zones });

test('het gemelde geval Bahrein: 출국권고 voor het hele land is rood', () => {
  const r = beoordeel([{ alert: '출국권고', area: '전 지역' }]);
  assert.equal(r.level, 4);
  assert.equal(r.color, 'rood');
  assert.match(r.explanation, /vertrek aanbevolen/);
});

test('여행금지 blijft rood, maar is in de tekst te onderscheiden van 출국권고', () => {
  const verbod = beoordeel([{ alert: '여행금지', area: '전 지역' }]);
  const vertrek = beoordeel([{ alert: '출국권고', area: '전 지역' }]);
  assert.equal(verbod.level, 4);
  assert.equal(vertrek.level, 4);
  assert.match(verbod.explanation, /reisverbod/);
  assert.match(vertrek.explanation, /vertrek aanbevolen/);
});

test('특별여행주의보 blijft oranje (rood gestreept bij MOFA)', () => {
  const r = beoordeel([{ alert: '특별여행주의보', area: '전 지역' }]);
  assert.equal(r.level, 3);
  assert.equal(r.color, 'oranje');
});

test('de milde trappen blijven ongewijzigd', () => {
  assert.equal(beoordeel([{ alert: '여행자제', area: '전 지역' }]).level, 2);
  assert.equal(beoordeel([{ alert: '여행유의', area: '전 지역' }]).level, 1);
  assert.equal(beoordeel([]).level, 1);
});

test('een zwaarder GEBIED tilt het landelijke niveau niet op', () => {
  // Ecuador: landelijk 여행자제 (geel), met 출국권고 voor één provincie.
  const r = beoordeel([
    { alert: '여행자제', area: '출국권고를 제외한 전 지역' },
    { alert: '출국권고', area: '과야스주' },
  ]);
  assert.equal(r.level, 2, 'landelijk blijft geel');
  assert.equal(r.regionalMaxLevel, 4, 'regionaal wél rood');
  assert.equal(r.hasRegionalWarnings, true);
});

test('"X를 제외한 지역" is de landelijke basislijn, geen gebied', () => {
  // Israël: landelijk 출국권고 met daarbinnen een 여행금지-gebied.
  const r = beoordeel([
    { alert: '출국권고', area: '4단계 지정 지역을 제외한 지역' },
    { alert: '여행금지', area: '가자지구' },
  ]);
  assert.equal(r.level, 4);
  assert.equal(r.regionalMaxLevel, 4);
  assert.deepEqual(r.structuredRegional, [{ region: '가자지구', level: 4 }]);
});

test('speciale-waarschuwingsgebieden komen regionaal terug bij een groen land', () => {
  // Thailand: landelijk 여행유의, met 특별여행주의보 voor de zuidelijke provincies.
  const r = beoordeel([
    { alert: '여행유의', area: '특별여행주의보 지정 지역을 제외한 지역' },
    { alert: '특별여행주의보', area: '남부 4개주' },
  ]);
  assert.equal(r.level, 1);
  assert.equal(r.color, 'groen');
  assert.equal(r.regionalMaxLevel, 3);
  assert.equal(r.hasRegionalWarnings, true);
});
