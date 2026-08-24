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
 * Eerder werd レベルN één-op-één als niveau N overgenomen, maar MOFA's laagste
 * trap is al een waarschuwing. El Salvador — waar MOFA レベル2 voor zes
 * districten en レベル1 voor de rest geeft — kwam daardoor landelijk op groen
 * uit terwijl de bron er wel degelijk waarschuwt. Groen blijft voorbehouden
 * aan landen zonder 危険情報.
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

// ---- Gemeld geval: Iran stond landelijk groen -------------------------------
// De vergelijker liet Japan voor Iran groen zien met een rode regiostreep,
// terwijl de bron letterlijk "イラン全土の危険情報がレベル4" schrijft. Vier
// oorzaken kwamen samen; elk daarvan staat hieronder apart.

test('Iran: de landelijke verhoging staat alleen in de lopende tekst van 【ポイント】', () => {
  // Het 【危険レベル】-blok noemt alleen gebieden; pas de toelichting zegt dat
  // het hele land omhoog gaat. Dat deel wordt voor de gebiedsbullets bewust
  // weggeknipt, dus de zoektocht naar 全土 moet over de héle tekst gaan.
  const r = jp('2026年01月16日 レベル４ 退避勧告 【危険レベル】'
    + ' ●首都テヘランを含む、これまで危険情報がレベル3であった地域 レベル4：退避してください。（退避勧告）《引上げ》'
    + ' ●パキスタンとの国境地帯 レベル4：退避してください。（退避勧告）《継続》'
    + ' 【ポイント】 ●これにより、イラン全土の危険情報がレベル4（退避勧告）となります。');
  assert.equal(r.level, 4);
  assert.equal(r.assessmentStatus, 'ok');
});

test('het niveau van de advieszin telt, niet elke レベル in de omschrijving', () => {
  // "これまで危険情報がレベル3であった地域 レベル4：…" — het eerste getal is de
  // trap waar het gebied vandáán komt. Werd dat gelezen als het gebiedsniveau,
  // dan brak de regionaam ook nog eens middenin af.
  const r = jp('【危険レベル】 ●これまで危険情報がレベル3であった地域 レベル4：退避してください。'
    + ' ●上記以外の地域 レベル1：十分注意してください。');
  assert.equal(r.level, 2, 'restgebied レベル1 → geel');
  assert.equal(r.regionalMaxLevel, 4);
  const namen = (r.structuredRegional || []).map((x) => x.region);
  assert.ok(namen.some((n) => n.includes('地域')), `regionaam afgekapt: ${JSON.stringify(namen)}`);
});

test('全域 achter een provincie is niet het hele land', () => {
  // Congo ("カサイ3州全域") en Armenië ("シュニク州全域") kwamen landelijk op de
  // zwaarste trap terecht omdat 全域 als "heel het land" werd gelezen, terwijl
  // er "heel de provincie" staat. Het restgebied bepaalt hier het landelijke
  // niveau.
  const r = jp('【危険レベル】 ●カサイ3州全域及び北キブ州全域 レベル4：退避してください。《継続》'
    + ' ●上記以外の地域 レベル2：不要不急の渡航は止めてください。《継続》');
  assert.equal(r.level, 3, 'restgebied レベル2 → oranje');
  assert.equal(r.regionalMaxLevel, 4);
});

test('het restgebied hoeft niet vooraan in de gebiedsnaam te staan', () => {
  // Eritrea: "首都アスマラ及び上記以外の地域" — de catch-all staat achteraan.
  const r = jp('【危険レベル】 ●エチオピアとの国境付近 レベル4：退避してください。（継続）'
    + ' ●首都アスマラ及び上記以外の地域 レベル2：不要不急の渡航は止めてください。（継続）');
  assert.equal(r.level, 3);
});

test('het restgebied mag een omschrijving in zich hebben', () => {
  // Tanzania: "上記以外のこれまで危険レベルが発出されていなかった地域".
  const r = jp('【危険レベル】 ●タンザニア南部 レベル4：退避してください。'
    + ' ●上記以外のこれまで危険レベルが発出されていなかった地域 レベル1：十分注意してください。');
  assert.equal(r.level, 2);
  assert.equal(r.regionalMaxLevel, 4);
});

test('〇 telt net zo goed als opsommingsteken', () => {
  // Oezbekistan gebruikt 〇 in plaats van ●; daardoor vond de parser nul
  // gebieden en viel het land terug op "geen niveau gevonden".
  const r = jp('【危険レベル】 〇アフガニスタンとの国境付近 レベル２：不要不急の渡航は止めてください《継続》'
    + ' 〇上記を除く地域（首都タシケント市を含む） レベル１：十分注意してください《継続》');
  assert.equal(r.level, 2);
  assert.equal(r.regionalMaxLevel, 3);
});

test('zonder gebiedsbullets spreekt de niveaubadge in de kop voor het hele land', () => {
  // Madagaskar: kop "レベル１ 十分注意", daaronder alleen proza zonder niveaus.
  const r = jp('2025年11月26日 レベル１ 十分注意 ●首都アンタナナリボを中心にデモが発生しました。'
    + ' ●強盗、スリ、ひったくりといった一般犯罪が多発しており、注意が必要です。');
  assert.equal(r.level, 2);
});

test('de badge tilt het landelijke niveau niet op zodra er gebieden staan', () => {
  // De badge toont het zwáárste gebied. Bij een bron die alleen een grensstrook
  // opwaardeert, mag dat het land niet meeslepen — dat was juist de invariant
  // die deze fix niet mocht breken.
  const r = jp('2026年03月01日 レベル３ 渡航中止勧告 【危険レベル】'
    + ' ●南部国境地帯 レベル3：渡航は止めてください。');
  assert.equal(r.level, 1, 'alleen regionaal → landelijk blijft groen');
  assert.equal(r.regionalMaxLevel, 4);
});

test('Rusland: "…を除く地域" is de landelijke ondergrens', () => {
  // MOFA schrijft het restgebied hier niet als 上記以外 maar als "alle gebieden
  // behalve de Oekraïense grensstreek (Moskou inbegrepen)".
  const r = jp('【危険レベル】 ●ウクライナとの国境周辺地域 レベル4：退避してください。（退避勧告）（継続）'
    + ' ●ウクライナとの国境周辺地域を除く地域（モスクワ市を含む） レベル3：渡航は止めてください。（渡航中止勧告）');
  assert.equal(r.level, 4, 'レベル3 landelijk → onze rood');
  assert.equal(r.regionalMaxLevel, 4);
});

test('een uitzondering bínnen één provincie is niet het restgebied', () => {
  // Algerije: "ティジ・ウズ県（山間部を除く地域（県都を含む））" is de provincie
  // Tizi Ouzou zónder het bergland — een deelgebied. Zou dat als landelijke
  // ondergrens tellen, dan kreeg het land het niveau van die provincie.
  const r = jp('【危険レベル】 ●リビアとの国境地帯 レベル４：退避してください。（継続）'
    + ' ●ティジ・ウズ県（山間部を除く地域（県都ティジ・ウズ市を含む））、アイン・デフラ県 レベル２：不要不急の渡航は止めてください。'
    + ' ●上記以外の地域 レベル１：十分注意してください。（継続）');
  assert.equal(r.level, 2, 'het échte restgebied (上記以外) geeft レベル1 → geel');
  assert.equal(r.regionalMaxLevel, 4);
});

test('"geen 危険情報" dekt het hele land, dus regio = land', () => {
  // MOFA publiceert een vaste schaal (レベル1-4). Staat er niets, dan is dat
  // een uitspraak over het hele land — geen ontbrekende kennis. Met
  // regionalMaxLevel null was in de tabel niet te zien welk van de twee het
  // was, en betekende een ontbrekend regiobalkje dus niets.
  const a = jp('危険情報は出ておりません');
  assert.equal(a.level, 1);
  assert.equal(a.regionalMaxLevel, 1);
  assert.equal(a.hasRegionalWarnings, false);
});
