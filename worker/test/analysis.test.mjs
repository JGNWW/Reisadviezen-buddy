/**
 * Unit-tests voor de generieke analyse-engine (worker/src/analysis/), met
 * échte adviesteksten (fragmenten van de bronsites) voor tien landen.
 *
 * Bewaakte invarianten:
 *   - het LANDELIJKE niveau komt alleen uit landelijke aanbevelingen;
 *   - regionale waarschuwingen verhogen het landelijke niveau NOOIT;
 *   - regionale ernst wordt apart en per gebied gerapporteerd;
 *   - alle bronformuleringen normaliseren naar dezelfde schaal 1..4.
 *
 * Draaien: cd worker && node --test test/analysis.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { splitSentences } from '../src/analysis/document-parser.js';
import { findSeverity } from '../src/analysis/severity-detector.js';
import { detectScope } from '../src/analysis/scope-detector.js';
import { classifySentence } from '../src/analysis/sentence-classifier.js';
import { extractRegions, normalizeRegionKey } from '../src/analysis/region-extractor.js';
import { analyzeAdvisory } from '../src/analysis/analysis-engine.js';

const keys = (a) => (a.regionalBreakdown || []).map((m) => normalizeRegionKey(m.region));
const byKey = (a, k) => (a.regionalBreakdown || []).find((m) => normalizeRegionKey(m.region).includes(k));

// ---------------------------------------------------------------------------
// Bouwstenen
// ---------------------------------------------------------------------------

test('zinsplitser: afkortingen en decimalen breken geen zin', () => {
  const s = splitSentences('U.S. citizens should remain alert. The zone extends approx. 10.5 km north. Contact the embassy.');
  assert.equal(s.length, 3);
  assert.match(s[0], /^U\.S\. citizens/);
  assert.match(s[1], /10\.5 km north\.$/);
});

test('ernst-detector: alle bekende formuleringen normaliseren naar 1..4', () => {
  const cases = [
    ['Do not travel to this area.', 'en', 4],
    ['The FCDO advises against all travel to parts of the country.', 'en', 4],
    ['Avoid all travel to the region.', 'en', 4],
    ['The FCDO advises against all but essential travel.', 'en', 3],
    ['Avoid non-essential travel.', 'en', 3],
    ['Reconsider travel to the country.', 'en', 3],
    ['Exercise a high degree of caution.', 'en', 2],
    ['Exercise increased caution due to terrorism.', 'en', 2],
    ['Exercise normal precautions.', 'en', 1],
    ['Take normal security precautions.', 'en', 1],
    ['Il est formellement déconseillé de se rendre dans cette zone.', 'fr', 4],
    ['La vigilance renforcée est de mise.', 'fr', 2],
    ['Se recomienda viajar con mucha precaución.', 'es', 2],
    ['Udenrigsministeriet fraråder alle rejser til området.', 'da', 4],
    ['Udenrigsministeriet fraråder alle ikke-nødvendige rejser.', 'da', 3],
    ['Vor Reisen in das Grenzgebiet wird gewarnt.', 'de', 4],
  ];
  for (const [text, lang, expected] of cases) {
    assert.equal(findSeverity(text, lang)?.level, expected, text);
  }
});

test('ernst-detector: "all but essential" wordt nooit als "all travel" gelezen', () => {
  const sev = findSeverity('FCDO advises against all but essential travel to the rest of Niger.', 'en');
  assert.equal(sev.level, 3);
});

test('scope-detector: landnaam als doel = landelijk, regio-woorden = regionaal', () => {
  assert.equal(detectScope('Exercise increased caution in France due to terrorism.', 'en', { countryName: 'France' }).scope, 'national');
  assert.equal(detectScope('Do not travel to Burkina Faso due to terrorism.', 'en', { countryName: 'Burkina Faso' }).scope, 'national');
  assert.equal(detectScope('Avoid all travel to Borno State.', 'en').scope, 'regional');
  assert.equal(detectScope('Exercise increased caution elsewhere.', 'en').isElsewhere, true);
  assert.equal(detectScope('La vigilance renforcée s’applique dans le reste du pays.', 'fr').isElsewhere, true);
});

test('classifier: hoofdklassen', () => {
  assert.equal(classifySentence('Do not travel to Tigray Region due to armed conflict.', 'en').kind, 'regional-recommendation');
  assert.equal(classifySentence('Exercise normal precautions in Canada.', 'en', { countryName: 'Canada' }).kind, 'national-recommendation');
  assert.equal(classifySentence('Exercise increased caution elsewhere in the country.', 'en').kind, 'elsewhere');
  assert.equal(classifySentence('Terrorist groups continue plotting possible attacks.', 'en').kind, 'warning');
  assert.equal(classifySentence('Safety and security', 'en').kind, 'header');
});

test('regio-extractor: lijst, staten en grensverwijzing', () => {
  const s = 'Do not travel to Tigray Region and border with Eritrea due to armed conflict.';
  const sev = findSeverity(s, 'en');
  const { regions } = extractRegions(s, 'en', { severityIndex: sev.index, severityLength: sev.length });
  const names = regions.map((r) => r.name);
  assert.ok(names.some((n) => /Tigray/.test(n)), names.join('|'));
  assert.ok(names.some((n) => /Eritrea/.test(n)), names.join('|'));
  assert.equal(regions.find((r) => /Eritrea/.test(r.name)).type, 'border');
});

// ---------------------------------------------------------------------------
// Landen — echte adviesteksten (fragmenten)
// ---------------------------------------------------------------------------

test('Ethiopië (US): landelijk 3, regio’s op 4 — nooit landelijk geëscaleerd', () => {
  const a = analyzeAdvisory({
    lang: 'en',
    countryName: 'Ethiopia',
    structured: { kind: 'us_level_heading', value: 'Ethiopia Travel Advisory - Level 3: Reconsider Travel' },
    sections: [{
      heading: 'Country Summary',
      text: 'Reconsider travel to Ethiopia due to sporadic violent conflict, civil unrest, crime, communications disruptions, and kidnapping. ' +
        'Do not travel to: Tigray Region and border with Eritrea due to sporadic violent conflict and civil unrest. ' +
        'Afar-Tigray border area due to sporadic violent conflict and civil unrest. ' +
        'Amhara Region due to sporadic violent conflict and civil unrest. ' +
        'Gambella Region and Benishangul Gumuz Region due to crime, kidnapping, and sporadic violent conflict.',
    }],
  });
  assert.equal(a.level, 3);
  assert.equal(a.color, 'oranje');
  assert.equal(a.assessmentStatus, 'ok');
  assert.equal(a.regionalMaxLevel, 4);
  assert.ok(byKey(a, 'tigray'), keys(a).join('|'));
  assert.equal(byKey(a, 'tigray').level, 4);
  assert.ok(byKey(a, 'amhara'));
  assert.equal(a.regions[Object.keys(a.regions).find((k) => /Amhara/.test(k))], 4);
});

test('Mexico (US): dubbele-punt-lijst — elk item wordt een eigen regio op 4', () => {
  const a = analyzeAdvisory({
    lang: 'en',
    countryName: 'Mexico',
    structured: { kind: 'us_level_heading', value: 'Mexico Travel Advisory - Level 2: Exercise Increased Caution' },
    sections: [{
      heading: 'Country Summary',
      text: 'Exercise increased caution in Mexico due to crime and kidnapping. ' +
        'Do not travel to: Colima state due to crime and kidnapping. ' +
        'Guerrero state due to crime. ' +
        'Michoacan state due to crime and kidnapping. ' +
        'Sinaloa state due to crime and kidnapping. ' +
        'Tamaulipas state due to crime and kidnapping. ' +
        'Zacatecas state due to crime and kidnapping.',
    }],
  });
  assert.equal(a.level, 2, 'landelijk niveau komt uit het officiële Level 2');
  for (const st of ['colima', 'guerrero', 'michoacan', 'sinaloa', 'tamaulipas', 'zacatecas']) {
    const m = byKey(a, st);
    assert.ok(m, `regio ${st} ontbreekt: ${keys(a).join('|')}`);
    assert.equal(m.level, 4, st);
  }
  assert.equal(a.regionalMaxLevel, 4);
  assert.equal(a.level, 2, 'zes niveau-4-regio’s escaleren het land niet');
});

test('Nigeria (UK): parts-vlag + regionale staten uit de tekst', () => {
  const a = analyzeAdvisory({
    lang: 'en',
    countryName: 'Nigeria',
    structured: { kind: 'uk_alert_status', value: ['avoid_all_travel_to_parts', 'avoid_all_but_essential_travel_to_parts'] },
    sections: [{
      heading: 'Warnings and insurance',
      text: 'FCDO advises against all travel to: Borno State. Yobe State. Adamawa State. Gombe State. ' +
        'FCDO advises against all but essential travel to: Bauchi State. Kano State.',
    }],
  });
  assert.equal(a.level, 1, 'alleen regionale waarschuwingen → landelijk laag');
  assert.equal(a.color, 'groen');
  assert.equal(a.hasRegionalWarnings, true);
  assert.equal(a.regionalMaxLevel, 4);
  assert.equal(byKey(a, 'borno')?.level, 4, keys(a).join('|'));
  assert.equal(byKey(a, 'bauchi')?.level, 3);
});

test('India (UK): kilometer-grenszone met uitzondering (Wagah-Attari)', () => {
  const a = analyzeAdvisory({
    lang: 'en',
    countryName: 'India',
    structured: { kind: 'uk_alert_status', value: ['avoid_all_travel_to_parts'] },
    sections: [{
      heading: 'Warnings and insurance',
      text: 'FCDO advises against all travel to within 10km of the India-Pakistan border, except at the Wagah-Attari border crossing.',
    }],
  });
  assert.equal(a.level, 1);
  const border = byKey(a, 'india-pakistan border');
  assert.ok(border, keys(a).join('|'));
  assert.equal(border.level, 4);
  assert.match(border.region, /binnen 10 km/);
  assert.ok(border.exceptions?.some((e) => /Wagah/.test(e)), JSON.stringify(border.exceptions));
});

test('Filipijnen (US): archipel, stad én "reconsider"-gebied apart', () => {
  const a = analyzeAdvisory({
    lang: 'en',
    countryName: 'the Philippines',
    structured: { kind: 'us_level_heading', value: 'Philippines Travel Advisory - Level 2: Exercise Increased Caution' },
    sections: [{
      heading: 'Country Summary',
      text: 'Exercise increased caution to the Philippines due to crime, terrorism, civil unrest, and kidnapping. ' +
        'Do not travel to: The Sulu Archipelago, including certain areas of the Sulu Sea, due to crime, terrorism, civil unrest, and kidnapping. ' +
        'Marawi City in Mindanao due to terrorism and civil unrest. ' +
        'Reconsider travel to: Other areas of Mindanao due to crime, terrorism, civil unrest, and kidnapping.',
    }],
  });
  assert.equal(a.level, 2);
  assert.equal(byKey(a, 'sulu archipelago')?.level, 4, keys(a).join('|'));
  assert.equal(byKey(a, 'marawi')?.level, 4);
  assert.equal(byKey(a, 'mindanao')?.level, 3, 'lijst-erfenis wisselt naar 3 na "Reconsider travel to:"');
});

test('Colombia (CA): officiële advisory-state + grenszone en stad uit de tekst', () => {
  const a = analyzeAdvisory({
    lang: 'en',
    countryName: 'Colombia',
    structured: { kind: 'ca_advisory_state', value: 1 },
    sections: [{
      heading: 'Risk levels',
      text: 'Avoid all travel to within 20 km of the border with Venezuela, due to drug trafficking and the presence of armed groups. ' +
        'Avoid non-essential travel to the city of Buenaventura.',
    }],
  });
  assert.equal(a.level, 2);
  assert.equal(a.levelLabel, 'Exercise a high degree of caution');
  const border = byKey(a, 'border with venezuela');
  assert.ok(border, keys(a).join('|'));
  assert.equal(border.level, 4);
  assert.equal(byKey(a, 'buenaventura')?.level, 3);
  assert.equal(a.level, 2, 'regionale niveau-4-zone escaleert het land niet');
});

test('Frankrijk (US): landnaam-doel is landelijk, geen regio-ruis', () => {
  const a = analyzeAdvisory({
    lang: 'en',
    countryName: 'France',
    sections: [{
      heading: 'Country Summary',
      text: 'Exercise increased caution in France due to terrorism and civil unrest.',
    }],
  });
  assert.equal(a.level, 2);
  assert.equal(a.assessmentStatus, 'ok');
  assert.equal(a.regionalBreakdown, null);
  assert.equal(a.hasRegionalWarnings, false);
});

test('VK (US): landelijk 2 zonder regionale vermeldingen', () => {
  const a = analyzeAdvisory({
    lang: 'en',
    countryName: 'United Kingdom',
    sections: [{
      heading: 'Country Summary',
      text: 'Exercise increased caution in the United Kingdom due to terrorism.',
    }],
  });
  assert.equal(a.level, 2);
  assert.equal(a.hasRegionalWarnings, false);
});

test('Canada (US): niveau 1 landelijk', () => {
  const a = analyzeAdvisory({
    lang: 'en',
    countryName: 'Canada',
    sections: [{ heading: 'Country Summary', text: 'Exercise normal precautions in Canada.' }],
  });
  assert.equal(a.level, 1);
  assert.equal(a.color, 'groen');
});

test('Australië (Smartraveller): gestructureerd overall-niveau', () => {
  const a = analyzeAdvisory({
    lang: 'en',
    countryName: 'Australia',
    structured: { kind: 'au_overall_text', value: 'Exercise normal safety precautions in Australia overall.' },
    sections: [{ heading: 'Safety', text: 'Australia has a moderate crime rate.' }],
  });
  assert.equal(a.level, 1);
  assert.equal(a.levelLabel, 'Exercise normal safety precautions');
});

// ---------------------------------------------------------------------------
// Meertalig + invarianten
// ---------------------------------------------------------------------------

test('Frans (Mali-stijl): "elders"-clausule levert de landelijke basislijn', () => {
  const a = analyzeAdvisory({
    lang: 'fr',
    anchorHeadingRe: /^situation s[ée]curitaire/i,
    sections: [{
      heading: 'Situation sécuritaire',
      text: 'Il est formellement déconseillé de se rendre dans les régions de Kidal, Gao et Tombouctou. ' +
        'La vigilance renforcée s’applique dans le reste du pays.',
    }],
  });
  assert.equal(a.level, 2, '"vigilance renforcée … reste du pays" = landelijke basislijn');
  assert.equal(a.regionalMaxLevel, 4);
  assert.equal(byKey(a, 'kidal')?.level, 4, keys(a).join('|'));
  assert.equal(byKey(a, 'gao')?.level, 4);
  assert.equal(byKey(a, 'tombouctou')?.level, 4);
});

test('Spaans: "salvo razones ineludibles" is ernst-kwalificatie, geen uitzondering', () => {
  const a = analyzeAdvisory({
    lang: 'es',
    anchorHeadingRe: /^notas importantes/i,
    sections: [{
      heading: 'Notas importantes',
      text: 'Se desaconseja el viaje salvo por razones ineludibles a las provincias fronterizas con Libia y Argelia. ' +
        'Se recomienda viajar con precaución en el resto del país.',
    }],
  });
  assert.equal(a.level, 2, 'landelijke basislijn uit de "resto del país"-zin');
  const libie = byKey(a, 'libia');
  assert.ok(libie, keys(a).join('|'));
  assert.equal(libie.level, 3);
  assert.equal(libie.targetType, 'border');
});

test('invariant: een regionale niveau-4-waarschuwing verhoogt een landelijk 1 nooit', () => {
  const a = analyzeAdvisory({
    lang: 'en',
    countryName: 'Testland',
    sections: [{
      heading: 'Summary',
      text: 'Exercise normal precautions in Testland. Do not travel to the Northern Province due to armed conflict.',
    }],
  });
  assert.equal(a.level, 1);
  assert.equal(a.regionalMaxLevel, 4);
  assert.equal(a.hasRegionalWarnings, true);
});

test('invariant: geen herkenbare formulering → onzeker, geen gok', () => {
  const a = analyzeAdvisory({
    lang: 'en',
    sections: [{ heading: 'Summary', text: 'The situation is calm. Local festivals attract many visitors.' }],
  });
  assert.equal(a.assessmentStatus, 'uncertain');
  assert.equal(a.level, null);
});

test('Duits: regionale Reisewarnung uit de tekst (grensgebied)', () => {
  const a = analyzeAdvisory({
    lang: 'de',
    countryName: 'Thailand',
    structured: { kind: 'de_warning_flags', value: { warning: false, partialWarning: true, situationWarning: false, situationPartWarning: false } },
    sections: [{
      heading: 'Aktuelles',
      text: 'Vor Reisen in das Grenzgebiet zu Kambodscha wird gewarnt.',
    }],
  });
  assert.equal(a.level, 1, 'Teilreisewarnung is regionaal, niet landelijk');
  assert.equal(a.regionalMaxLevel, 4);
  assert.ok(byKey(a, 'kambodscha'), keys(a).join('|'));
});
