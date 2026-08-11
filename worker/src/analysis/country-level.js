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

/**
 * De bron publiceert aantoonbaar GEEN kleurcode voor dit land. Dat is iets
 * anders dan 'uncertain' (wij konden het niet bepalen): hier is het antwoord
 * juist zeker, namelijk dat er niets te kleuren valt.
 *
 * Aanleiding: FCDO kent geen kleurenschaal. Bij landen zonder
 * vermijdingswaarschuwing — El Salvador bijvoorbeeld — publiceert het geen
 * gekleurde zones en staat er in hun API een leeg alert_status. Wij maakten
 * daar groen van, en dat is een gok: de afwezigheid van een waarschuwing als
 * kleur presenteren suggereert een oordeel dat de bron niet geeft.
 */
const geenKleurcode = (explanation) => ({
  level: null, color: null, label: null, explanation,
  regionalMaxLevel: null, hasRegionalWarnings: false,
  confidence: 'high', sourceMethod: 'structured', assessmentStatus: 'none',
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

const RE_ESC = /[.*+?^${}()|[\]\\]/g;

/**
 * FCDO gebruikt bij niet-uniforme adviezen soms een landelijke restcategorie:
 * "advises against (all but essential) travel to all other regions/the rest of/
 * the whole of {land}". Die "elders"-regel is de landelijke ondergrens, geen
 * losse regio. Geeft 4 (alle reizen), 3 (niet-noodzakelijke reizen) of null.
 *
 * Cruciaal: het land (of "the country") moet DIRECT op de verbindingswoorden
 * volgen. Zo blijft "the rest of Beirut and Mount Lebanon" (een deelgebied)
 * buiten schot, terwijl "the rest of Somalia" wél telt.
 */
function ukElsewhereBaseline(text, country) {
  const t = String(text || '');
  if (!t) return null;
  const C = country ? String(country).replace(RE_ESC, '\\$&') : '';
  const tail = `(?:all other (?:regions|areas|parts)|the rest|the whole) of (?:the )?(?:country${C ? `|${C}` : ''})\\b`;
  if (new RegExp(`advises? against all travel to ${tail}`, 'i').test(t)) return 4;
  if (new RegExp(`advises? against all but essential travel to ${tail}`, 'i').test(t)) return 3;
  // Sommige landen (Irak) sommen géén catch-all op maar noemen elk gebied
  // apart: "the remainder of X province" voor provincie na provincie, zodat
  // het hele land onder minstens een 'all but essential'-advies valt. Drie of
  // meer "the remainder of" ⇒ landelijke ondergrens 3 (niet-noodzakelijke
  // reizen overal); specifieke grenszones (Jordanië/Saoedi-Arabië) noemen dit
  // niet en blijven landelijk groen.
  if ((t.match(/the remainder of/gi) || []).length >= 3) return 3;
  return null;
}

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
    if (hasParts) {
      // FCDO's alert_status-taxonomie zet 'whole_country' alleen als het advies
      // volledig uniform is. Landen als Oekraïne en Somalië — waar FCDO tegen
      // alle reizen naar "all other regions of X" / "the rest of X" adviseert
      // (het hele land op enkele uitzonderingen na) — blijven zo 'to_parts'.
      // Dat mag landelijk niet groen worden: de restcategorie ("elders") ís de
      // landelijke ondergrens. Detecteer die catch-all in de tekst.
      const baseline = ukElsewhereBaseline(structured.text || '', structured.country || '');
      if (baseline) {
        return ok({
          level: baseline,
          regionalMaxLevel: Math.max(baseline, partsMax || 0),
          hasRegionalWarnings: true,
          explanation: baseline >= 4
            ? 'VK adviseert tegen alle reizen naar vrijwel het hele land (restgebieden), met lokale uitzonderingen.'
            : 'VK adviseert tegen niet-noodzakelijke reizen naar vrijwel het hele land (restgebieden), met lokale uitzonderingen.',
        });
      }
      return ok({ level: 1, regionalMaxLevel: partsMax, hasRegionalWarnings: true, explanation: 'VK-waarschuwing geldt voor delen van het land, niet landelijk — zie regionale risico’s.' });
    }
    // Leeg alert_status: FCDO geeft geen enkele vermijdingswaarschuwing én
    // publiceert voor zo'n land geen gekleurde zones. Hier stond eerder groen,
    // maar dat is een afleiding die de bron zelf niet maakt — zie geenKleurcode.
    return geenKleurcode('FCDO publiceert geen kleurcode voor dit land (geen vermijdingswaarschuwing).');
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

  if (kind === 'it_caution_areas') {
    // Viaggiare Sicuri kent geen niveauveld, maar een LEEG "Aree di
    // particolare cautela"-veld is affirmatief bewijs van "geen
    // waarschuwingsgebieden". Alleen een échte ontradings-formulering
    // (niveau ≥ 3, "sconsigliati …") elders in de scheda blokkeert dat
    // signaal — generieke voorzichtigheids-proza ("prestare particolare
    // attenzione" in een gezondheidsparagraaf) niet.
    const { cautionText, fullText } = value || {};
    const maxSev = Math.max(0, ...allSeverityMatches(String(fullText || ''), 'it').map((m) => m.level));
    if (maxSev >= 3) return null; // tekstpad beslist
    if (!String(cautionText || '').trim()) {
      return ok({
        level: 1, regionalMaxLevel: null, confidence: 'medium',
        label: 'Nessuna area di particolare cautela (geen waarschuwingsgebieden)',
        explanation: 'Viaggiare Sicuri (Italië): geen "aree di particolare cautela" en geen adviesformulering — normale voorzorg.',
      });
    }
    return null; // gebied-tekst aanwezig maar geen formulering: tekstpad/onzeker
  }

  if (kind === 'at_security_box') {
    // bmeia.gv.at toont per land een "Sicherheitsstufe"-box op de eigen
    // 4-puntsschaal ("Sicherheitsstufe 4 (von 4)"), met een expliciete
    // "(regional)"-kwalificatie wanneer die stufe alleen voor delen van het
    // land geldt. Empirisch geverifieerd: FR "2" (landelijk), UA "4 …
    // gesamte Ukraine", AF "4 … ganze Land", IN "4 (regional)", MX "3
    // (regional)".
    const text = String(value || '');
    // Alle Sicherheitsstufe-vermeldingen met hun context (BMEIA noemt er soms
    // meerdere: één voor een regio/exklave en één "im Rest des Landes").
    // De context staat in een vooruitblik en wordt dus niet meeverbruikt.
    // Anders slokt het venster van 80 tekens de eerstvolgende
    // Sicherheitsstufe-vermelding op zodra BMEIA ze dicht op elkaar zet — en
    // juist de laatste noemt meestal de landelijke ondergrens.
    const all = [...text.matchAll(/Sicherheitsstufe(?:&nbsp;|\s)*([1-4])(?:\s*\(von 4\))?(?=([\s\S]{0,80}))/gi)]
      .map((m) => ({ level: Number(m[1]), ctx: m[2] }));
    if (!all.length) return uncertain('Geen Sicherheitsstufe gevonden in de landenbox van bmeia.gv.at.');
    const regionalMax = Math.max(...all.map((x) => x.level));
    // Landelijke ondergrens = de stufe die expliciet "im Rest des Landes",
    // "im übrigen Land", "landesweit" of "im ganzen/gesamten Land" geldt.
    // "in den restlichen Regionen" hoorde daar ook bij: bij Rusland staat de
    // landelijke ondergrens zo geschreven ("Sicherheitsstufe 4 … für die an die
    // Ukraine angrenzenden Verwaltungsgebiete. Hohes Sicherheitsrisiko
    // Sicherheitsstufe 3 gilt in den restlichen Regionen."). Zonder die vorm
    // vond de restzoektocht niets en kwam het land landelijk op groen, terwijl
    // de bron voor het hele land minstens stufe 3 aanhoudt.
    // Let op: géén kaal "restlicher Teil". Bij de Filipijnen staat er "gilt für
    // den restlichen Teil der Insel Mindanao" — de rest van een eiland, niet
    // van het land. "Landesteile" mag wel; dat zegt het letterlijk.
    const restfrase = /rest des landes|restlich\w*\s+(?:regionen|gebiet\w*|landesteil\w*|land\w*)|übrigen?\s+land|im ganzen land|gesamt\w*\s+land|ganze[ns]?\s+land|landesweit|gesamte[ns]?\s+\w+|ganz(?:e|es)\s+\w+/i;
    // Passen er meerdere, dan is de mildste de landelijke ondergrens. De ruime
    // varianten hierboven ("gesamte <naam>", nodig voor "die gesamte Ukraine")
    // pikken namelijk ook "auf der gesamten Westküste der Insel Mindanao" mee;
    // daar staat verderop "gilt im Rest des Landes" met een lagere stufe, en
    // dát is wat er voor het hele land geldt.
    const restKandidaten = all.filter((x) => restfrase.test(x.ctx));
    const rest = restKandidaten.length
      ? restKandidaten.reduce((a, b) => (b.level < a.level ? b : a))
      : null;
    if (rest) {
      return ok({
        level: rest.level, regionalMaxLevel: regionalMax > rest.level ? regionalMax : (rest.level >= 2 ? rest.level : null),
        hasRegionalWarnings: regionalMax > rest.level,
        label: `Sicherheitsstufe ${rest.level}`,
        explanation: `BMEIA (Oostenrijk): Sicherheitsstufe ${rest.level} landelijk${regionalMax > rest.level ? `, tot ${regionalMax} regionaal` : ''}.`,
      });
    }
    // Alleen een "(regional)"-stufe zonder landelijke ondergrens → landelijk 1.
    // De context komt uit ruwe HTML, dus tussen "gilt" en het voorzetsel kunnen
    // entiteiten en tags staan: Tsjaad heeft "gilt&nbsp;<strong>in der
    // Hauptstadt N'Djamena". Met een harde spatie daar viel die vermelding
    // buiten de regionaal-toets, werd de box niet als "alleen regionaal"
    // gezien, en kreeg het land het zwaarste gebiedsniveau als landniveau —
    // terwijl de badge er zelf "(regional)" bij zet.
    const onlyRegional = all.every((x) => /\(\s*regional\s*\)|gilt(?:&nbsp;|\s|<[^>]*>)*(?:in|für|entlang|im gebiet)|exklave|provinz|region|grenz|hauptstadt/i.test(x.ctx));
    if (onlyRegional && /\(\s*regional\s*\)/i.test(text)) {
      return ok({
        level: 1, regionalMaxLevel: regionalMax, hasRegionalWarnings: true, confidence: 'medium',
        label: `Sicherheitsstufe ${regionalMax} (regional)`,
        explanation: `BMEIA (Oostenrijk): Sicherheitsstufe ${regionalMax} geldt voor delen van het land, niet landelijk.`,
      });
    }
    // Eén landelijke stufe zonder regio-kwalificatie.
    const level = all[0].level;
    return ok({ level, regionalMaxLevel: regionalMax > level ? regionalMax : null, label: `Sicherheitsstufe ${level}`, explanation: `BMEIA (Oostenrijk): Sicherheitsstufe ${level} (van 4).` });
  }

  if (kind === 'no_advarsel') {
    // regjeringen.no toont alleen een "Reiseadvarsel"-blok als er een
    // waarschuwing IS; geen blok = geen advarsel = laagste niveau.
    const text = String(value || '').trim();
    if (!text) {
      return ok({ level: 1, regionalMaxLevel: null, label: 'Ingen reiseadvarsel (geen waarschuwing)', explanation: 'Utenriksdepartementet (Noorwegen): geen reiseadvarsel voor dit land.' });
    }
    // De sterke markeerformules ("… er under normale omstendigheter et trygt
    // land …" / "Sikkerhetssituasjonen … er svært utfordrende" / "fraråder
    // …") staan altijd in de EERSTE zin — net als bij Zwitserland
    // (ch-classify.js) classificeren we die zin eerst. Zo kan een generiek
    // "utvis aktsomhet"-devies verderop in een langere inleiding (veel-
    // voorkomende boilerplate, geen echt risicosignaal op zich) het oordeel
    // niet overstemmen — vóór deze aanpassing werd zo'n land ten onrechte
    // geel, puur omdat die formulering toevallig eerder in de tekst stond.
    const first = text.split(/\.\s/)[0] || text;
    const strong = findSeverity(first, 'no');
    if (strong) return ok({ level: strong.level, label: strong.phrase.trim(), explanation: `Utenriksdepartementet (Noorwegen): ${strong.phrase.trim()}.` });
    // Vangnet: geen herkenbare formule in de eerste zin, maar wél een
    // mildere aktsomhet-formulering verderop → geel. Kan nooit escaleren
    // (alleen niveau ≤2 telt hier mee), zodat dit vangnet een land nooit ten
    // onrechte naar oranje/rood tilt op basis van tekst buiten de openingszin.
    const mild = allSeverityMatches(text, 'no').find((m) => m.level <= 2);
    if (mild) return ok({ level: mild.level, label: mild.phrase.trim(), confidence: 'medium', explanation: `Utenriksdepartementet (Noorwegen): ${mild.phrase.trim()}.` });
    return uncertain('Reiseadvarsel-blok aanwezig maar geen herkenbare formulering (fraråder/aktsomhet/trygt land/svært utfordrende …).');
  }

  if (kind === 'kr_alert_zones') {
    // 0404.go.kr toont per land één of meer (waarschuwing, gebied)-paren:
    //   여행금지 | 전 지역                          → landelijk niveau 4
    //   출국권고 | X를 제외한 전지역                → landelijke basislijn 4
    //   여행자제 | 북부 국경지역                    → regionale vermelding 2
    // De adapter levert de RUWE paren; de betekenis staat hier.
    //
    // De schaal volgt de KLEUREN die MOFA zelf aan zijn niveaus geeft, niet de
    // rangorde. Korea kent vijf stappen (blauw/geel/rood-gestreept/rood/zwart)
    // en wij vier. Werd de bovenkant verankerd — 여행금지 (zwart) op onze rood
    // — dan schoof alles eronder een trap omlaag en belandde Korea's eigen
    // RODE niveau 출국권고 op onze oranje. Zuid-Korea kwam daardoor
    // structureel milder in de matrix dan alle andere bronnen, terwijl die
    // matrix juist bestaat om bronnen naast elkaar te leggen (Bahrein: op
    // 0404.go.kr rood, bij ons oranje).
    //
    // Daarom nu op kleur: blauw→groen, geel→geel, rood-gestreept→oranje,
    // rood→rood. 여행금지 (zwart) is zwaarder dan onze rood maar valt daar
    // noodgedwongen mee samen; het onderscheid met 출국권고 blijft in het
    // label en de toelichting staan.
    const zones = Array.isArray(value) ? value : [];
    const KR_LEVEL = [
      [/여행금지/, 4], [/출국권고|철수권고/, 4], [/특별여행주의보|특별/, 3],
      [/여행자제|자제/, 2], [/여행유의|유의/, 1],
    ];
    // Nederlandse toelichting per trap — nodig nu 출국권고 en 여행금지 dezelfde
    // kleur delen: in de tekst blijft "vertrek aanbevolen" te onderscheiden van
    // een juridisch reisverbod.
    const KR_GLOSS = [
      [/여행금지/, 'reisverbod'], [/출국권고|철수권고/, 'vertrek aanbevolen'],
      [/특별여행주의보|특별/, 'speciale reiswaarschuwing'],
      [/여행자제|자제/, 'reizen afraden'], [/여행유의|유의/, 'oplettendheid geboden'],
    ];
    const toLevel = (word) => (KR_LEVEL.find(([re]) => re.test(String(word || ''))) || [null, null])[1];
    const toGloss = (word) => (KR_GLOSS.find(([re]) => re.test(String(word || ''))) || [null, null])[1];
    if (!zones.length) {
      return ok({ level: 1, regionalMaxLevel: null, label: '여행경보 없음 (geen waarschuwing)', explanation: 'MOFA (Zuid-Korea): geen 여행경보 (reiswaarschuwing) voor dit land.' });
    }
    let national = null;
    let nationalAlert = null;
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
        if (national == null || plain) {
          national = level;
          nationalAlert = z.alert;
          nationalLabel = `${z.alert}${area ? ` (${area})` : ''}`;
        }
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
      // Gloss erbij: 출국권고 en 여행금지 delen sinds de kleurmapping dezelfde
      // rode kleur, dus het verschil moet uit de tekst blijken.
      explanation: `MOFA (Zuid-Korea): ${nationalLabel}${toGloss(nationalAlert) ? ` — ${toGloss(nationalAlert)}` : ''}.`,
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
    // De trap zoals MOFA hem in een advieszin zet: "レベル4：退避してください".
    // De dubbele punt onderscheidt het oordeel van een terloopse vermelding.
    const JA_LEVEL_ADVIES = /レベル\s*([１２３４1234])\s*[：:]/;
    // "Het hele land". 全域 betekent óók "het hele X" en staat net zo goed
    // achter een provincie: Armenië heeft "シュニク州全域" — de hele provincie
    // Syunik, niet het hele land. Zonder die uitzondering werd zo'n bullet als
    // landelijk niveau gelezen.
    const JA_LANDELIJK = /全土|国全体|(?<![州県省市郡])全域/;
    // De restcategorie ("de overige gebieden"), die de landelijke ondergrens
    // vormt. Er staat lang niet altijd alleen "上記以外の地域": Eritrea schrijft
    // "首都アスマラ及び上記以外の地域" en Tanzania "上記以外のこれまで危険レベルが
    // 発出されていなかった地域". Vandaar zoeken in plaats van vooraan verankeren,
    // met ruimte voor een omschrijving tussen "以外の" en "地域".
    // Naast "上記以外の…" bestaat ook de vorm met 除く ("met uitzondering van
    // bovenstaande"), die Oezbekistan gebruikt: "上記を除く地域".
    // De 除く-vorm hoeft niet met 上記 te beginnen: Rusland schrijft
    // "ウクライナとの国境周辺地域を除く地域（モスクワ市を含む）" — alle gebieden
    // behálve de Oekraïense grensstreek, Moskou inbegrepen. Dat is net zo goed
    // de landelijke ondergrens, en zonder deze vorm bleef Rusland groen terwijl
    // MOFA voor de rest van het land afraadt te reizen.
    // De 除く-vorm moet het hele gebiedslabel beslaan, dus op het eind ankeren.
    // Rusland schrijft "ウクライナとの国境周辺地域を除く地域（モスクワ市を含む）" —
    // alles behálve de Oekraïense grensstreek, Moskou inbegrepen: de landelijke
    // ondergrens. Zonder anker matcht het ook een uitzondering binnen één
    // provincie ("ティジ・ウズ県（山間部を除く地域…）" — Tizi Ouzou zonder het
    // bergland), en dan wordt een deelgebied als landelijk niveau gelezen.
    const JA_RESTGEBIED = /(?:その他|それ以外|上記以外)の[^、。]{0,25}?地域|を除く[^、。]{0,10}?地域(?:（[^）]*）)?\s*$/;
    const toNum = (d) => '１２３４'.includes(d) ? '１２３４'.indexOf(d) + 1 : Number(d);
    // MOFA's rangnummer is NIET onze schaal. Hun laagste trap is al een
    // waarschuwing — レベル1 「十分注意」 betekent "wees goed op uw hoede", niet
    // "niets aan de hand" — en de trap daarboven ontraadt al niet-noodzakelijke
    // reizen. Eén-op-één overnemen maakte El Salvador landelijk groen terwijl
    // MOFA er geel en oranje geeft; Japan kwam zo structureel een trap milder
    // in de matrix dan de andere bronnen.
    //
    //   レベル1 十分注意                  → geel
    //   レベル2 不要不急の渡航中止        → oranje
    //   レベル3 渡航中止勧告              → rood
    //   レベル4 退避してください          → rood (zwaarder dan onze rood)
    //
    // Groen blijft voorbehouden aan landen zonder 危険情報 (zie hierboven).
    // Omdat レベル3 en レベル4 dezelfde kleur delen, benoemt de toelichting de
    // trap in het Nederlands zodat het verschil zichtbaar blijft.
    const JP_SCALE = { 1: 2, 2: 3, 3: 4, 4: 4 };
    const JP_GLOSS = { 1: 'wees op uw hoede', 2: 'geen niet-noodzakelijke reizen', 3: 'reizen ontraden', 4: 'vertrek aanbevolen' };
    // Datumregels ("2026年03月25日") zijn geen gebied maar de publicatiedatum
    // van de badge; zonder deze uitsluiting belandden ze als regio in de
    // uitsplitsing.
    const JA_DATE_ONLY = /^\s*\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日\s*$/;
    // Niet elke landpagina gebruikt ● als opsommingsteken; Oezbekistan zet er
    // 〇 neer. Zonder die tekens erbij levert zo'n pagina nul bullets op en
    // valt het land terug op "geen niveau gevonden".
    const bullets = body.split(/[●〇○]/).map((s) => s.trim()).filter(Boolean);
    let national = null;
    let nationalTier = null;
    let nationalLabel = null;
    const structuredRegional = [];
    for (const b of bullets) {
      // Het niveau dat telt is dat van de advieszin ("レベル4：退避してください"),
      // niet elke レベル die in de omschrijving voorkomt. Iran had als eerste
      // bullet "首都テヘランを含む、これまで危険情報がレベル3であった地域
      // レベル4：…" — het eerste voorkomen is daar de trap waar het gebied
      // vandáán komt. Zonder deze voorkeur werd dat als het gebiedsniveau
      // gelezen én brak de regionaam middenin af.
      const m = b.match(JA_LEVEL_ADVIES) || b.match(JA_LEVEL);
      if (!m) continue;
      const tier = toNum(m[1]);
      const level = JP_SCALE[tier] ?? tier;
      // Regionaam: tekst vóór レベルN; samengestelde beschrijvingen worden
      // afgekapt op de sublijst-separator " ・" (spatie + interpunct — de
      // interpunct ín namen als ジャンム・カシミール heeft geen spatie ervoor).
      const region = b.slice(0, m.index).split(/\s・/)[0].replace(/[：:、。\s]+$/, '').trim();
      const phrase = (b.slice(m.index).match(/^レベル[１２３４1234][：:]?[^（(●]*/) || [b.slice(m.index)])[0].trim();
      if (JA_LANDELIJK.test(region) || JA_RESTGEBIED.test(region) || !region) {
        // 全土 wint altijd; その他の地域 alleen als er nog geen landelijk niveau is.
        if (national == null || JA_LANDELIJK.test(region)) {
          national = level; nationalTier = tier; nationalLabel = phrase;
        }
      } else if (!JA_DATE_ONLY.test(region)) {
        structuredRegional.push({ region, level });
      }
    }
    // MOFA zet een landelijke verhoging niet altijd in een eigen gebiedsbullet.
    // Bij Iran en Libanon staat hij alleen in de lopende tekst van 【ポイント】:
    //   「これにより、イラン全土の危険情報がレベル4（退避勧告）となります。」
    // Zonder die zin bleef er enkel regionaal bewijs over en kwam het land
    // landelijk op groen, terwijl de bron letterlijk zegt dat het hele land op
    // de zwaarste trap staat. Het maximum, want zo'n alinea beschrijft vaak
    // eerst de oude trap en dan de nieuwe.
    // Let op: hier bewust `text` en niet `body`. De 全土-zin staat vaak juist in
    // 【ポイント】, en dat deel is uit `body` geknipt omdat daar de gebied→niveau-
    // bullets niet in staan.
    if (national == null) {
      let hoogste = null;
      for (const m of text.matchAll(/全土[^。]{0,30}?レベル\s*([１２３４1234])/g)) {
        // 感染症危険情報 is een aparte schaal met dezelfde woorden; die hoort
        // hier niet mee te tellen.
        if (/感染症/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
        const tier = toNum(m[1]);
        if (hoogste == null || tier > hoogste) hoogste = tier;
      }
      if (hoogste != null) {
        national = JP_SCALE[hoogste] ?? hoogste;
        nationalTier = hoogste;
        nationalLabel = `全土 レベル${hoogste}`;
      }
    }

    // Laatste redmiddel: de niveaubadge in de paginakop, maar alléén als er
    // helemaal geen gebiedsbullets zijn. Dan beschrijft die badge het land als
    // geheel (Madagaskar: kop "レベル１ 十分注意", daaronder enkel proza). Zodra
    // er wél gebieden staan, zegt de badge alleen wat het zwáárste gebied is —
    // en dat mag het landelijke niveau nooit optillen.
    if (national == null && !structuredRegional.length) {
      const kop = iLevel >= 0 ? text.slice(0, iLevel) : text.slice(0, 60);
      const trappen = [...kop.matchAll(/レベル\s*([１２３４1234])/g)].map((m) => toNum(m[1]));
      if (trappen.length) {
        const laagste = Math.min(...trappen);
        national = JP_SCALE[laagste] ?? laagste;
        nationalTier = laagste;
        nationalLabel = `レベル${laagste}`;
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
      explanation: `MOFA (Japan): ${nationalLabel || `レベル${nationalTier}`}`
        + `${JP_GLOSS[nationalTier] ? ` — ${JP_GLOSS[nationalTier]}` : ''}.`,
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
