/**
 * Landelijk niveau — twee bronnen van bewijs, in vaste rangorde:
 *
 *   1. GESTRUCTUREERD bewijs (officieel veld van de bron: GOV.UK
 *      alert_status, Canada advisory-state, Ierland security-status, het
 *      "Level N"-kopje van het State Department, Duitse warning-vlaggen, …).
 *      Adapters leveren de RUWE waarde aan; de betekenis (→ niveau 1..4)
 *      staat uitsluitend hier.
 *   2. TEKSTUEEL bewijs uit geanalyseerde zinnen van het samenvattende blok.
 *
 * Kernregel (in beide paden): het landelijke niveau komt ALLEEN uit
 * landelijke aanbevelingen. Een regionale waarschuwing — hoe zwaar ook —
 * verhoogt het landelijke niveau nooit; die ernst wordt apart bijgehouden.
 */
import { levelToColor } from '../lib/levels.js';
import { allSeverityMatches, findSeverity } from './severity-detector.js';

const uncertain = (explanation) => ({
  level: null, color: null, label: null, explanation,
  regionalMaxLevel: null, hasRegionalWarnings: false,
  confidence: 'low', sourceMethod: 'fallback-text', assessmentStatus: 'uncertain',
});

const ok = (o) => ({
  label: null, regionalMaxLevel: o.level ?? null, hasRegionalWarnings: false,
  confidence: 'high', sourceMethod: 'structured', assessmentStatus: 'ok',
  color: levelToColor(o.level), ...o,
});

// Officiële labels per bron, zoals de adapters ze vóór de refactor toonden —
// de UI (levelLabel) blijft daardoor identiek.
const CA_STATE = {
  0: { level: 1, label: 'Take normal security precautions' },
  1: { level: 2, label: 'Exercise a high degree of caution' },
  2: { level: 3, label: 'Avoid non-essential travel' },
  3: { level: 4, label: 'Avoid all travel' },
};
const IE_STATUS = {
  normal: { level: 1, label: 'Normal precautions' },
  'high-caution': { level: 2, label: 'High degree of caution' },
  avoid: { level: 3, label: 'Avoid non-essential travel' },
  'do-not': { level: 4, label: 'Do not travel' },
};
const AU_LABEL = {
  1: 'Exercise normal safety precautions', 2: 'Exercise a high degree of caution',
  3: 'Reconsider your need to travel', 4: 'Do not travel',
};
const NZ_LABEL = {
  1: 'Exercise normal safety precautions', 2: 'Exercise increased caution',
  3: 'Avoid non-essential travel', 4: 'Do not travel',
};

/**
 * Interpreteert het gestructureerde bewijs van een bron.
 * @param structured {kind, value} of null
 * @returns assessment-object, of null als er geen gestructureerd bewijs is.
 */
export function interpretStructured(structured) {
  if (!structured || !structured.kind) return null;
  const { kind, value } = structured;

  if (kind === 'uk_alert_status') {
    if (!Array.isArray(value)) return uncertain('VK alert_status ontbreekt of heeft een onverwacht formaat.');
    const wholeAll = value.includes('avoid_all_travel_to_whole_country');
    const wholeEssential = value.includes('avoid_all_but_essential_travel_to_whole_country');
    const partsAll = value.includes('avoid_all_travel_to_parts');
    const partsEssential = value.includes('avoid_all_but_essential_travel_to_parts');
    const hasParts = partsAll || partsEssential;
    const partsMax = partsAll ? 4 : partsEssential ? 3 : null;
    if (wholeAll) return ok({ level: 4, regionalMaxLevel: 4, hasRegionalWarnings: hasParts, explanation: 'VK adviseert tegen alle reizen naar het hele land.' });
    if (wholeEssential) return ok({ level: 3, regionalMaxLevel: partsAll ? 4 : 3, hasRegionalWarnings: hasParts, explanation: 'VK adviseert alleen noodzakelijke reizen naar het hele land.' });
    if (hasParts) return ok({ level: 1, regionalMaxLevel: partsMax, hasRegionalWarnings: true, explanation: 'VK-waarschuwing geldt voor delen van het land, niet landelijk — zie regionale risico’s.' });
    return ok({ level: 1, regionalMaxLevel: null, explanation: 'Geen VK-vermijdingswaarschuwing gevonden voor dit land.' });
  }

  if (kind === 'us_level_heading') {
    const text = String(value || '');
    const m = text.match(/Level\s*([1-4])\s*[:\-–]/i);
    if (!m) return uncertain('Geen "Level N"-kop gevonden op de State Department-pagina.');
    const level = Number(m[1]);
    const lm = text.match(/Level\s*[1-4]\s*[:\-–]\s*([A-Za-z ]{3,40})/i);
    return ok({ level, label: lm ? `Level ${level}: ${lm[1].trim()}` : `Level ${level}`, explanation: `State Department Level ${level}.` });
  }

  if (kind === 'ca_advisory_state') {
    const entry = CA_STATE[Number(value)];
    if (!entry) return uncertain('Canadese advisory-state ontbreekt of is onbekend.');
    return ok({ ...entry, explanation: `Canada: ${entry.label}.` });
  }

  if (kind === 'ie_security_status') {
    const entry = IE_STATUS[String(value || '').toLowerCase()];
    if (!entry) return uncertain('Ierse security-status niet gevonden op de pagina.');
    return ok({ ...entry, explanation: `Ierland: ${entry.label}.` });
  }

  if (kind === 'au_overall_text') {
    const sev = findSeverity(String(value || ''), 'en');
    if (!sev) return uncertain('Geen herkenbaar "overall advice level" gevonden bij Smartraveller.');
    return ok({ level: sev.level, label: AU_LABEL[sev.level], explanation: `Smartraveller: ${AU_LABEL[sev.level]}.` });
  }

  if (kind === 'nz_prominent_text') {
    // SafeTravel zet het landelijke niveau prominent bovenaan: de EERSTE
    // niveau-formulering op de pagina telt, niet de zwaarste ergens onderin.
    const all = allSeverityMatches(String(value || ''), 'en');
    if (!all.length) return uncertain('Geen herkenbare SafeTravel-niveauformulering gevonden.');
    const level = all[0].level;
    const hasRegional = /higher advice levels? in some areas|higher advice level applies|regional advice/i.test(String(value || ''));
    return ok({
      level, label: NZ_LABEL[level],
      regionalMaxLevel: hasRegional ? 4 : level, hasRegionalWarnings: hasRegional,
      explanation: `SafeTravel: ${NZ_LABEL[level]}.`,
    });
  }

  if (kind === 'de_warning_flags') {
    const e = value || {};
    if (e.warning) return ok({ level: 4, regionalMaxLevel: 4, hasRegionalWarnings: !!e.partialWarning, label: 'Reisewarnung (het Auswärtiges Amt raadt reizen af).', explanation: 'Reisewarnung (het Auswärtiges Amt raadt reizen af).' });
    if (e.partialWarning) return ok({ level: 1, regionalMaxLevel: 4, hasRegionalWarnings: true, label: 'Teilreisewarnung: reiswaarschuwing voor delen van het land, niet landelijk.', explanation: 'Teilreisewarnung: reiswaarschuwing voor delen van het land, niet landelijk.' });
    if (e.situationWarning) return ok({ level: 2, regionalMaxLevel: 2, confidence: 'medium', label: 'Sicherheitshinweis: verhoogde aandacht voor het hele land.', explanation: 'Sicherheitshinweis: verhoogde aandacht voor het hele land.' });
    if (e.situationPartWarning) return ok({ level: 1, regionalMaxLevel: 2, hasRegionalWarnings: true, confidence: 'medium', label: 'Regionale veiligheidsaanwijzing voor delen van het land.', explanation: 'Regionale veiligheidsaanwijzing voor delen van het land.' });
    return ok({ level: 1, regionalMaxLevel: null, label: 'Geen reiswaarschuwing of veiligheidsaanwijzing.', explanation: 'Geen reiswaarschuwing of veiligheidsaanwijzing.' });
  }

  if (kind === 'at_security_box') {
    // bmeia.gv.at toont per land een "Sicherheitsstufe"-box op de eigen
    // 4-puntsschaal ("Sicherheitsstufe 4 (von 4)"), met een expliciete
    // "(regional)"-kwalificatie wanneer die stufe alleen voor delen van het
    // land geldt. Empirisch geverifieerd: FR "2" (landelijk), UA "4 …
    // gesamte Ukraine", AF "4 … ganze Land", IN "4 (regional)", MX "3
    // (regional)".
    const text = String(value || '');
    const m = text.match(/Sicherheitsstufe(?:&nbsp;|\s)*([1-4])/i);
    if (!m) return uncertain('Geen Sicherheitsstufe gevonden in de landenbox van bmeia.gv.at.');
    const level = Number(m[1]);
    const regional = /\(\s*regional\s*\)/i.test(text);
    if (regional) {
      return ok({
        level: 1, regionalMaxLevel: level, hasRegionalWarnings: true, confidence: 'medium',
        label: `Sicherheitsstufe ${level} (regional)`,
        explanation: `BMEIA (Oostenrijk): Sicherheitsstufe ${level} geldt voor delen van het land, niet landelijk.`,
      });
    }
    return ok({ level, label: `Sicherheitsstufe ${level}`, explanation: `BMEIA (Oostenrijk): Sicherheitsstufe ${level} (van 4).` });
  }

  if (kind === 'no_advarsel') {
    // regjeringen.no toont alleen een "Reiseadvarsel"-blok als er een
    // waarschuwing IS; geen blok = geen advarsel = laagste niveau.
    const text = String(value || '').trim();
    if (!text) {
      return ok({ level: 1, regionalMaxLevel: null, label: 'Ingen reiseadvarsel (geen waarschuwing)', explanation: 'Utenriksdepartementet (Noorwegen): geen reiseadvarsel voor dit land.' });
    }
    const sev = findSeverity(text, 'no');
    if (!sev) return uncertain('Reiseadvarsel-blok aanwezig maar geen herkenbare formulering (fraråder …).');
    return ok({ level: sev.level, label: sev.phrase.trim(), explanation: `Utenriksdepartementet (Noorwegen): ${sev.phrase.trim()}.` });
  }

  if (kind === 'kr_alert_zones') {
    // 0404.go.kr toont per land één of meer (waarschuwing, gebied)-paren:
    //   여행금지 | 전 지역                          → landelijk niveau 4
    //   출국권고 | X를 제외한 전지역                → landelijke basislijn 3
    //   여행자제 | 북부 국경지역                    → regionale vermelding 2
    // De adapter levert de RUWE paren; de betekenis staat hier.
    const zones = Array.isArray(value) ? value : [];
    const KR_LEVEL = [
      [/여행금지/, 4], [/출국권고|철수권고/, 3], [/특별여행주의보|특별/, 3],
      [/여행자제|자제/, 2], [/여행유의|유의/, 1],
    ];
    const toLevel = (word) => (KR_LEVEL.find(([re]) => re.test(String(word || ''))) || [null, null])[1];
    if (!zones.length) {
      return ok({ level: 1, regionalMaxLevel: null, label: '여행경보 없음 (geen waarschuwing)', explanation: 'MOFA (Zuid-Korea): geen 여행경보 (reiswaarschuwing) voor dit land.' });
    }
    let national = null;
    let nationalLabel = null;
    const structuredRegional = [];
    for (const z of zones) {
      const level = toLevel(z.alert);
      if (!level) continue;
      const area = String(z.area || '').trim();
      // "…을 제외한 (전) 지역" = "alle gebieden behalve …" — dat is de
      // landelijke basislijn (elders-regel), geen regionale vermelding.
      const isNationwide = /전 ?지역|전역|전 ?국토/.test(area) || /제외한 ?(전 ?)?지역/.test(area) || !area;
      if (isNationwide) {
        // Plain 전지역 wint van een "X를 제외한 전지역"-basislijn.
        const plain = !/제외/.test(area);
        if (national == null || plain) { national = level; nationalLabel = `${z.alert}${area ? ` (${area})` : ''}`; }
      } else {
        structuredRegional.push({ region: area, level });
      }
    }
    if (national == null) {
      if (structuredRegional.length) {
        const maxR = Math.max(...structuredRegional.map((r) => r.level));
        return ok({
          level: 1, regionalMaxLevel: maxR, hasRegionalWarnings: true,
          label: 'Alleen regionale 여행경보 (reiswaarschuwing).',
          explanation: 'MOFA (Zuid-Korea): waarschuwingen gelden voor delen van het land, niet landelijk.',
          structuredRegional,
        });
      }
      return uncertain('Geen herkenbaar 여행경보-niveau gevonden op de 0404.go.kr-pagina.');
    }
    const maxR = structuredRegional.length ? Math.max(...structuredRegional.map((r) => r.level)) : null;
    return ok({
      level: national,
      regionalMaxLevel: maxR != null ? Math.max(maxR, national) : national,
      hasRegionalWarnings: structuredRegional.length > 0,
      label: nationalLabel,
      explanation: `MOFA (Zuid-Korea): ${nationalLabel}.`,
      structuredRegional: structuredRegional.length ? structuredRegional : undefined,
    });
  }

  if (kind === 'fi_security_level') {
    // um.fi toont het landelijke niveau als vast "Turvallisuustaso"-veld met
    // één van vier vaste formuleringen — de ernst-detector (fi) vertaalt die.
    const sev = findSeverity(String(value || ''), 'fi');
    if (!sev) return uncertain('Geen herkenbare Turvallisuustaso-formulering gevonden bij um.fi.');
    return ok({ level: sev.level, label: sev.phrase.trim(), explanation: `um.fi (Finland): ${sev.phrase.trim()}.` });
  }

  if (kind === 'jp_hazard_levels') {
    // MOFA (Japan) publiceert per land een 【危険レベル】-blok met ●-bullets:
    //   ●アフガニスタン全土 レベル4：退避してください。…
    //   ●ジャンム・カシミール州 レベル3：…  ●その他の地域 レベル1：…
    // 全土/全域 (hele land) of その他の地域 (elders = basislijn) bepaalt het
    // landelijke niveau; overige bullets zijn regionale vermeldingen. Die
    // gaan als structuredRegional mee naar de engine.
    const text = String(value || '');
    if (!text.trim() || /危険情報は出ておりません/.test(text)) {
      return ok({ level: 1, regionalMaxLevel: null, label: '危険情報なし (geen waarschuwing)', explanation: 'MOFA (Japan): geen 危険情報 (gevareninformatie) voor dit land.' });
    }
    // Alleen het deel tússen 【危険レベル】 en 【ポイント】 bevat de
    // gebied→niveau-bullets. Ervóór staat de paginakop (datum + niveaubadge —
    // zou anders als "regio" meekomen), erna staan proza-punten.
    let body = text;
    const iLevel = body.indexOf('【危険レベル】');
    if (iLevel >= 0) body = body.slice(iLevel + '【危険レベル】'.length);
    const iPoints = body.indexOf('【ポイント】');
    if (iPoints >= 0) body = body.slice(0, iPoints);
    const JA_LEVEL = /レベル([１２３４1234])/;
    const toNum = (d) => '１２３４'.includes(d) ? '１２３４'.indexOf(d) + 1 : Number(d);
    const bullets = body.split('●').map((s) => s.trim()).filter(Boolean);
    let national = null;
    let nationalLabel = null;
    const structuredRegional = [];
    for (const b of bullets) {
      const m = b.match(JA_LEVEL);
      if (!m) continue;
      const level = toNum(m[1]);
      // Regionaam: tekst vóór レベルN; samengestelde beschrijvingen worden
      // afgekapt op de sublijst-separator " ・" (spatie + interpunct — de
      // interpunct ín namen als ジャンム・カシミール heeft geen spatie ervoor).
      const region = b.slice(0, m.index).split(/\s・/)[0].replace(/[：:、。\s]+$/, '').trim();
      const phrase = (b.slice(m.index).match(/^レベル[１２３４1234][：:]?[^（(●]*/) || [b.slice(m.index)])[0].trim();
      if (/全土|全域|国全体/.test(region) || /その他の地域|それ以外の地域|上記以外の地域/.test(region) || !region) {
        // 全土 wint altijd; その他の地域 alleen als er nog geen landelijk niveau is.
        if (national == null || /全土|全域|国全体/.test(region)) { national = level; nationalLabel = phrase; }
      } else {
        structuredRegional.push({ region, level });
      }
    }
    if (national == null) {
      // Alleen regionale bullets: landelijk bewust laag (zelfde invariant als
      // overal — regionaal verhoogt landelijk nooit).
      if (structuredRegional.length) {
        const maxR = Math.max(...structuredRegional.map((r) => r.level));
        return ok({
          level: 1, regionalMaxLevel: maxR, hasRegionalWarnings: true,
          label: 'Alleen regionale 危険情報 (gevareninformatie).',
          explanation: 'MOFA (Japan): waarschuwingen gelden voor delen van het land, niet landelijk.',
          structuredRegional,
        });
      }
      return uncertain('Geen herkenbaar MOFA-niveau (レベル1-4) gevonden in het 危険レベル-blok.');
    }
    const maxR = structuredRegional.length ? Math.max(...structuredRegional.map((r) => r.level)) : null;
    return ok({
      level: national,
      regionalMaxLevel: maxR != null ? Math.max(maxR, national) : national,
      hasRegionalWarnings: structuredRegional.length > 0,
      label: nationalLabel || null,
      explanation: `MOFA (Japan): ${nationalLabel || `レベル${national}`}.`,
      structuredRegional: structuredRegional.length ? structuredRegional : undefined,
    });
  }

  if (kind === 'dk_summary_bars') {
    // um.dk toont regionale afwijkingen als gekleurde "bjælker" (balken) in
    // het samenvattende blok; dit levert alleen een regionale-max-hint op,
    // het landelijke niveau komt uit de tekstanalyse.
    const text = String(value || '');
    let barMax = null;
    if (/r[øo]de? bj[æa]lke/i.test(text)) barMax = 4;
    else if (/orange bj[æa]lke/i.test(text)) barMax = 3;
    else if (/gule? bj[æa]lke/i.test(text)) barMax = 2;
    return barMax ? { regionalHintOnly: true, regionalMaxLevel: barMax } : null;
  }

  return null;
}

/**
 * Leidt het landelijke niveau af uit geanalyseerde zinnen (classifier-
 * uitvoer) van het samenvattende blok. Rangorde:
 *   1. expliciet landelijke aanbeveling;
 *   2. "elders"-aanbeveling (de basislijn naast regionale afwijkingen);
 *   3. scope-loze aanbeveling — niveau ≤ 2 geldt als landelijk (algemene
 *      voorzichtigheidsadviezen), niveau ≥ 3 alleen als er géén regionale
 *      aanwijzing in de zin staat (zelfde gedragsregel als vóór de refactor);
 *   4. alleen regionale aanbevelingen gevonden → landelijk laag (1), met
 *      uitleg — regionale ernst wordt apart gerapporteerd;
 *   5. niets gevonden → onzeker (nooit een gok).
 */
export function deriveNationalFromSentences(analyzed) {
  const recs = analyzed.filter((a) => a.severity);
  if (!recs.length) return uncertain('Geen herkenbare niveau-formulering gevonden in het samenvattend blok.');

  const national = recs.find((a) => a.kind === 'national-recommendation');
  const elsewhere = recs.find((a) => a.kind === 'elsewhere');
  const unscoped = recs.find((a) => a.kind === 'recommendation');
  // Niveau ≤ 2 met regiowoorden in de zin: algemene voorzichtigheids-
  // formuleringen ("viajar con precaución … por determinadas zonas") gelden
  // in de praktijk landelijk — alleen zware niveaus (3-4) blijven regionaal.
  const softRegional = recs.find((a) => a.kind === 'regional-recommendation' && a.severity.level <= 2);
  const pick = national || elsewhere || unscoped || softRegional;

  if (pick) {
    const viaElsewhere = pick.kind === 'elsewhere';
    return {
      level: pick.severity.level,
      color: levelToColor(pick.severity.level),
      label: null,
      explanation: viaElsewhere
        ? `Landelijke basislijn afgeleid uit "elders"-formulering ("${pick.severity.phrase.trim()}") — regionale afwijkingen apart vermeld.`
        : `Niveau afgeleid uit samenvattend blok ("${pick.severity.phrase.trim()}").`,
      regionalMaxLevel: pick.severity.level,
      hasRegionalWarnings: false,
      confidence: pick.scope?.nationwide ? 'high' : 'medium',
      sourceMethod: 'summary-block',
      assessmentStatus: 'ok',
      pickText: pick.text,
    };
  }

  // Alleen (zware) regionale aanbevelingen: landelijk bewust laag houden.
  const regional = recs.find((a) => a.kind === 'regional-recommendation');
  return {
    level: 1, color: 'groen', label: null,
    explanation: `Waarschuwing ("${regional.severity.phrase.trim()}") lijkt regionaal, niet landelijk — landelijk niveau laag gehouden.`,
    regionalMaxLevel: regional.severity.level, hasRegionalWarnings: true,
    confidence: 'medium', sourceMethod: 'summary-block', assessmentStatus: 'ok',
  };
}

export { levelToColor };
