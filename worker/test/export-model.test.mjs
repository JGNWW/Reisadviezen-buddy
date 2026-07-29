/**
 * Tests voor het uitdraai-model (public/export-model.js): de vorm van de
 * Excel-bladen en PDF-pagina's. Bewust DOM-vrij, dus hier in Node te draaien.
 *
 * Draaien: cd worker && node --test test/export-model.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

await import('../../public/export-model.js'); // zet globalThis.ExportModel
const M = globalThis.ExportModel;

// ---- Een compacte, realistische dataset ------------------------------------
const ds = () => ({
  sources: [
    { id: 'uk', label: 'Verenigd Koninkrijk (FCDO)', short: 'VK' },
    { id: 'de', label: 'Duitsland (Auswärtiges Amt)', short: 'DE' },
    { id: 'kr', label: 'Zuid-Korea (MOFA)', short: 'KR' },
    { id: 'ch', label: 'Zwitserland (EDA)', short: 'CH' },
  ],
  countries: [
    {
      iso3: 'JOR', name: 'Jordanië',
      nl: { color: 'geel', level: 2, extras: [], regional: false, date: '24-07-2026', url: 'https://nww/jor' },
      sources: [
        { id: 'uk', label: 'Verenigd Koninkrijk (FCDO)', short: 'VK', color: 'geel', level: 2, status: 'ok', regional: true, date: '27-07-2026', stale: false, url: 'https://fcdo/jor' },
        { id: 'de', label: 'Duitsland (Auswärtiges Amt)', short: 'DE', color: 'oranje', level: 3, status: 'ok', regional: true, date: '29-07-2026', stale: false, url: 'https://aa/jor' },
        { id: 'kr', label: 'Zuid-Korea (MOFA)', short: 'KR', color: 'oranje', level: 3, status: 'ok', regional: false, date: '28-07-2026', stale: false, url: 'https://mofa/jor' },
        { id: 'ch', label: 'Zwitserland (EDA)', short: 'CH', color: 'geel', level: 2, status: 'ok', regional: false, date: '22-07-2026', stale: true, snapshotDate: '22-07-2026', url: 'https://eda/jor' },
      ],
      themes: [
        { id: 'veiligheid', label: 'Veiligheid', entries: [
          { sourceId: 'de', label: 'Duitsland (Auswärtiges Amt)', color: 'oranje', level: 3, status: 'ok', text: 'Van reizen naar het grensgebied wordt dringend afgeraden. Elders gelden geen beperkingen.' },
          { sourceId: 'uk', label: 'Verenigd Koninkrijk (FCDO)', color: 'geel', level: 2, status: 'ok', text: 'Avoid all travel within 3 km of the border with Syria.' },
        ] },
      ],
      changes: [{ label: 'Duitsland (Auswärtiges Amt)', date: '27-07-2026', heading: 'Aktuelles', sentence: 'Grensgebied verhoogd.' }],
    },
    {
      iso3: 'SLV', name: 'El Salvador',
      nl: { color: 'geel', level: 2, extras: [], regional: false, date: '20-07-2026', url: 'https://nww/slv' },
      sources: [
        { id: 'uk', label: 'Verenigd Koninkrijk (FCDO)', short: 'VK', status: 'none', color: null, level: null, date: '27-07-2026', stale: false, url: 'https://fcdo/slv' },
        { id: 'de', label: 'Duitsland (Auswärtiges Amt)', short: 'DE', color: 'groen', level: 1, status: 'ok', regional: false, date: '29-07-2026', stale: false, url: 'https://aa/slv' },
        { id: 'kr', label: 'Zuid-Korea (MOFA)', short: 'KR', color: 'oranje', level: 3, status: 'ok', regional: false, date: '28-07-2026', stale: false, url: 'https://mofa/slv' },
        { id: 'ch', label: 'Zwitserland (EDA)', short: 'CH', status: 'na' },
      ],
      themes: [], changes: [],
    },
  ],
});

test('overviewMatrix: kop, cellen en telling per kleurcode', () => {
  const { header, body, tally } = M.overviewMatrix(ds());
  assert.equal(header[0], 'Land');
  assert.equal(header[1], 'NL (NWW)');
  assert.ok(header.includes('Zuid-Korea (MOFA)'));
  assert.equal(body.length, 2);
  assert.equal(body[0].country, 'Jordanië');
  assert.equal(body[0].nl.level, 2);
  assert.equal(body[0].cells.length, 4);
  // Beide landen staan bij NL op geel.
  assert.deepEqual(tally, { groen: 0, geel: 2, oranje: 0, rood: 0, onbekend: 0 });
});

test('overviewMatrix: elke rij draagt de verdeling en de mediaan', () => {
  const { body } = M.overviewMatrix(ds());
  // Jordanië: VK geel, DE oranje, KR oranje, CH geel → 2× geel, 2× oranje.
  assert.deepEqual(body[0].dist, { groen: 0, geel: 2, oranje: 2, rood: 0, geen: 0 });
  assert.equal(body[0].median, 3); // 2,2,3,3 → afgerond 3
  // El Salvador: VK geen kleurcode, CH niet opgehaald.
  assert.deepEqual(body[1].dist, { groen: 1, geel: 0, oranje: 1, rood: 0, geen: 2 });
});

test('overviewMatrix: grootste afwijking noemt de strengste bronnen', () => {
  const { body } = M.overviewMatrix(ds());
  assert.equal(body[0].deviation, 'DE, KR strenger');
  // El Salvador: KR strenger én DE milder — beide richtingen in één zin.
  assert.equal(body[1].deviation, 'KR strenger, DE milder');
});

test('overviewMatrix: niveau 4 leest als "niet reizen"', () => {
  const d = ds();
  d.countries[0].sources[1].color = 'rood';
  d.countries[0].sources[1].level = 4;
  d.countries[0].sources[2].color = 'rood';
  d.countries[0].sources[2].level = 4;
  assert.equal(M.overviewMatrix(d).body[0].deviation, 'DE, KR: niet reizen');
});

test('overviewMatrix: eensgezind als niemand afwijkt', () => {
  const d = ds();
  d.countries[0].sources.forEach((s) => { s.color = 'geel'; s.level = 2; s.status = 'ok'; });
  assert.equal(M.overviewMatrix(d).body[0].deviation, 'Eensgezind');
});

test('overviewMatrix: "geen kleurcode" wordt gemeld, niet weggelaten', () => {
  const d = ds();
  // Alleen nog het VK, dat geen kleurcode publiceert.
  d.countries[1].sources = [d.countries[1].sources[0]];
  d.sources = [d.sources[0]];
  const { body } = M.overviewMatrix(d);
  assert.equal(body[1].deviation, 'VK: geen kleurcode');
  assert.equal(M.colorText(body[1].cells[0]), 'Kleurcode ontbreekt');
  assert.equal(M.cellMark(body[1].cells[0]), '—');
});

test('cellMark: cijfer bij een kleur, symbool bij de bijzondere gevallen', () => {
  assert.equal(M.cellMark({ status: 'ok', color: 'oranje', level: 3 }), '3');
  assert.equal(M.cellMark({ status: 'ok', color: 'geel' }), '2');
  assert.equal(M.cellMark({ status: 'uncertain' }), '?');
  assert.equal(M.cellMark({ status: 'na' }), '·');
});

test('longRows: één rij per land × bron × thema, met herkomst', () => {
  const rows = M.longRows(ds());
  assert.equal(rows.length, 2);
  assert.equal(rows[0].land, 'Jordanië');
  assert.equal(rows[0].bron, 'Duitsland (Auswärtiges Amt)');
  assert.equal(rows[0].thema, 'Veiligheid');
  assert.equal(rows[0].niveau, 3);
  assert.equal(rows[0].kleur, 'Oranje');
  assert.equal(rows[0].herkomst, 'live');
  // De volledige tekst gaat onverkort mee (het inkorten is alleen voor de PDF).
  assert.ok(rows[0].tekst.endsWith('geen beperkingen.'));
});

test('longRows: een bron uit het vangnet is herkenbaar als snapshot', () => {
  const d = ds();
  d.countries[0].themes[0].entries.push({ sourceId: 'ch', label: 'Zwitserland (EDA)', color: 'geel', level: 2, status: 'ok', text: 'Erhöhte Vorsicht.' });
  const row = M.longRows(d).find((r) => r.bronId === 'ch');
  assert.equal(row.herkomst, 'snapshot 22-07-2026');
});

test('divergenceRows: alleen afwijkingen, zwaarste eerst, met richting', () => {
  const rows = M.divergenceRows(ds());
  const jor = rows.filter((r) => r.land === 'Jordanië');
  assert.equal(jor.length, 2); // DE en KR wijken af; VK en CH staan gelijk
  assert.ok(jor.every((r) => r.richting === 'strenger' && r.verschil === 1));
  const slv = rows.filter((r) => r.land === 'El Salvador');
  assert.deepEqual(slv.map((r) => r.richting).sort(), ['geen kleurcode', 'milder', 'strenger']);
  // Zwaarste afwijking bovenaan.
  assert.ok((rows[0].verschil || 0) >= (rows[rows.length - 1].verschil || 0));
});

test('provenanceRows: telt live, snapshot en niet-opgehaald per bron', () => {
  const rows = M.provenanceRows(ds());
  const ch = rows.find((r) => r.bron === 'Zwitserland (EDA)');
  assert.deepEqual([ch.live, ch.snapshot, ch.nietOpgehaald], [0, 1, 1]);
  const uk = rows.find((r) => r.bron.startsWith('Verenigd'));
  assert.equal(uk.live, 2);
  assert.equal(uk.geenKleurcode, 1);
  assert.equal(uk.bijgewerkt, '27-07-2026');
});

// ---- Verdeling, mediaan en de vergelijking met NederlandWereldwijd --------
const cellen = () => [
  { status: 'ok', color: 'geel', level: 2 },
  { status: 'ok', color: 'geel', level: 2 },
  { status: 'ok', color: 'oranje', level: 3 },
  { status: 'ok', color: 'rood', level: 4 },
  { status: 'none' },
  { status: 'na' },
  { status: 'uncertain' },
];

test('distribution: telt per kleur, de rest valt onder "geen"', () => {
  assert.deepEqual(M.distribution(cellen()), { groen: 0, geel: 2, oranje: 1, rood: 1, geen: 3 });
});

test('distribution: de vijf getallen tellen op tot het aantal bronnen', () => {
  const cells = cellen();
  const d = M.distribution(cells);
  assert.equal(d.groen + d.geel + d.oranje + d.rood + d.geen, cells.length);
  assert.deepEqual(M.distribution([]), { groen: 0, geel: 0, oranje: 0, rood: 0, geen: 0 });
});

test('distribution: kleur zonder "ok"-status telt niet mee als kleur', () => {
  // Een onzekere inschatting mag niet als harde kleurcode meetellen.
  assert.deepEqual(M.distribution([{ status: 'uncertain', color: 'rood', level: 4 }]),
    { groen: 0, geel: 0, oranje: 0, rood: 0, geen: 1 });
});

test('medianLevel: middelste niveau, alleen over bronnen mét een kleurcode', () => {
  assert.equal(M.medianLevel(cellen()), 3); // 2,2,3,4 → gemiddelde van 2 en 3, afgerond
  assert.equal(M.medianLevel([{ status: 'ok', color: 'geel', level: 2 }]), 2);
  assert.equal(M.medianLevel([{ status: 'none' }, { status: 'na' }]), null);
  assert.equal(M.medianLevel([]), null);
});

test('medianLevel: leidt het niveau af uit de kleur als het veld ontbreekt', () => {
  assert.equal(M.medianLevel([{ status: 'ok', color: 'oranje' }, { status: 'ok', color: 'oranje' }]), 3);
});

test('versusNl: telt strenger, milder en gelijk', () => {
  assert.deepEqual(M.versusNl(cellen(), 2), { strenger: 2, milder: 0, gelijk: 2, beoordeeld: 4 });
  assert.deepEqual(M.versusNl(cellen(), 4), { strenger: 0, milder: 3, gelijk: 1, beoordeeld: 4 });
});

test('versusNl: zonder Nederlandse kleurcode alleen tellen, niet vergelijken', () => {
  const r = M.versusNl(cellen(), null);
  assert.equal(r.beoordeeld, 4);
  assert.deepEqual([r.strenger, r.milder, r.gelijk], [0, 0, 0]);
});

test('clipSentences: kapt op een zinsgrens, niet midden in een woord', () => {
  const t = 'Eerste zin. Tweede zin. Derde zin. Vierde zin.';
  assert.equal(M.clipSentences(t, 3), 'Eerste zin. Tweede zin. Derde zin. …');
  assert.equal(M.clipSentences(t, 9), t); // niets weggelaten → geen beletselteken
});

test('clipSentences: één lange zin eindigt op een woordgrens', () => {
  const lang = 'woord '.repeat(200).trim() + '.';
  const out = M.clipSentences(lang, 3, 100);
  assert.ok(out.length <= 104, `te lang: ${out.length}`);
  assert.ok(out.endsWith(' …'));
  assert.ok(!/woor …$/.test(out), 'mag niet midden in een woord afkappen');
});

test('clipSentences: Oost-Aziatische punt telt ook als zinsgrens', () => {
  const out = M.clipSentences('여행자제 지역입니다。 전 지역에 해당합니다。 세 번째 문장입니다。', 1);
  assert.equal(out, '여행자제 지역입니다。 …');
});

test('clipSentences: leeg blijft leeg', () => {
  assert.equal(M.clipSentences(''), '');
  assert.equal(M.clipSentences(null), '');
});
