/**
 * Tests voor de Japanse niveaubepaling (kind 'jp_hazard_levels').
 *
 * MOFA (anzen.mofa.go.jp) publiceert per land een 【危険レベル】-blok met
 * ●-bullets per gebied. Het rangnummer daarin is NIET onze schaal: MOFA's
 * laagste trap is al een waarschuwing.
 *
 *   レベル1 十分注意          "wees goed op uw hoede"        -> geel
 *   レベル2 不要不急の渡航中止 "geen niet-noodzakelijke reizen" -> oranje
 *   レベル3 渡航中止勧告      "reizen ontraden"               -> rood
 *   レベル4 退避してください   "vertrek"                       -> rood
 *
 * Eerder werd レベルN één-op-één als niveau N overgenomen. El Salvador — waar
 * MOFA レベル2 voor zes districten en レベル1 voor de rest geeft — kwam
 * daardoor landelijk op groen uit, terwijl de bron zelf geel en oranje toont.
 * Japan stond zo structureel een trap milder in de matrix dan de andere
 * bronnen. Groen blijft voorbehouden aan landen zonder 危険情報.
 *
 * Draaien: cd worker && node --test test/japan-levels.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretStructured } from '../src/analysis/country-level.js';

const jp = (text) => interpretStructured({ kind: 'jp_hazard_levels', value: text });

test('het gemelde geval El Salvador: geel landelijk, oranje regionaal', () => {
  const r = jp('【危険レベル】 ●サンサルバドル県中央市メヒカノス区 レベル2：不要不急の渡航は止めてください。《継続》'
    + ' ●上記以外の地域 レベル1：十分注意してください。《継続》 【ポイント】');
  assert.equal(r.level, 2);
  assert.equal(r.color, 'geel');
  assert.equal(r.regionalMaxLevel, 3);
  assert.equal(r.hasRegionalWarnings, true);
});

test('elke MOFA-trap landt op de bedoelde kleur', () => {
  const heelLand = (n) => jp(`【危険レベル】 ●全土 レベル${n}：テスト`);
  assert.equal(heelLand(1).color, 'geel');
  assert.equal(heelLand(2).color, 'oranje');
  assert.equal(heelLand(3).color, 'rood');
  assert.equal(heelLand(4).color, 'rood');
});

test('groen blijft voorbehouden aan landen zonder 危険情報', () => {
  const r = jp('危険情報は出ておりません');
  assert.equal(r.level, 1);
  assert.equal(r.color, 'groen');
});

test('een publicatiedatum is geen gebied', () => {
  // "2026年03月25日" kwam eerder als regio in de uitsplitsing terecht.
  const r = jp('【危険レベル】 ●2026年03月25日 レベル2：テスト ●全土 レベル1：十分注意してください。');
  assert.deepEqual(r.structuredRegional, undefined);
  assert.equal(r.level, 2, 'landelijk volgt de 全土-bullet');
});

test('een zwaarder gebied tilt het landelijke niveau niet op', () => {
  const r = jp('【危険レベル】 ●北部国境地帯 レベル3：渡航は止めてください。 ●その他の地域 レベル1：十分注意してください。');
  assert.equal(r.level, 2, 'landelijk = レベル1 -> geel');
  assert.equal(r.regionalMaxLevel, 4, 'regionaal = レベル3 -> rood');
});

test('de toelichting benoemt de trap in het Nederlands', () => {
  assert.match(jp('【危険レベル】 ●全土 レベル4：退避してください。').explanation, /vertrek aanbevolen/);
  assert.match(jp('【危険レベル】 ●全土 レベル1：十分注意してください。').explanation, /op uw hoede/);
});
