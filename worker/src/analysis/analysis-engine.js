/**
 * Analyse-engine — orkestreert de generieke pijplijn:
 *
 *   secties → zinnen → classifier → scope → ernst → regio's → landelijk oordeel
 *
 * Eén gedeelde motor voor ALLE bronnen; adapters downloaden alleen nog,
 * schonen HTML op en leveren secties (plus eventueel het ruwe gestructureerde
 * niveauveld van hun bron) aan. Alle interpretatie gebeurt hier.
 *
 * Harde invariant: het landelijke niveau wordt NOOIT verhoogd door regionale
 * waarschuwingen. Regionale ernst leeft in `regions`/`regionalBreakdown` en
 * `regionalMaxLevel`, gescheiden van `level`.
 *
 * De uitvoer is byte-compatibel met de velden die de frontend al gebruikt
 * (level, color, levelLabel, regionalMaxLevel, hasRegionalWarnings,
 * regionalBreakdown, regionalCoverage, confidence, assessmentStatus);
 * `regions` (naam → niveau) is een additief nieuw veld.
 */
import { parseSections } from './document-parser.js';
import { classifySentence } from './sentence-classifier.js';
import { extractRegions, extractRegionFromListItem, headingRegion, headingHasScopeWord, normalizeRegionKey } from './region-extractor.js';
import { interpretStructured, deriveNationalFromSentences, levelToColor } from './country-level.js';
import { findSeverity } from './severity-detector.js';

// Secties waarvan de zinnen op regionale aanbevelingen worden gescand (naast
// het ankerblok en geografische koppen): samenvattings-/waarschuwingsblokken.
const SCANNABLE_HEADING = /summary|overview|warnings and insurance|advisor|risk levels?|safety and security|security status|latest update|country summary|situation s[ée]curitaire|s[ée]curit[ée]|recommandations|notas importantes|seguridad|aktuell|sicherheitslage|rejsevejledning|latest travel alert/i;

const LEVEL_COLOR = ['', 'groen', 'geel', 'oranje', 'rood'];

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * @param {object} opts
 * @param {Array}  opts.sections         [{heading, text}] — de opgeschoonde bronsecties
 * @param {string} opts.lang             brontaal ('en'|'fr'|'es'|'de'|'da')
 * @param {object} opts.structured       {kind, value} ruw officieel niveauveld, of null
 * @param {RegExp} opts.anchorHeadingRe  kop van het samenvattende blok (optioneel)
 * @param {string} opts.anchorText       expliciet samenvattend tekstblok (optioneel,
 *                                       voor bronnen zonder bruikbare kopstructuur)
 * @param {string} opts.countryName      naam van het land (voor scope-detectie)
 */
export function analyzeAdvisory({ sections = [], lang = 'en', structured = null, anchorHeadingRe = null, anchorText = null, countryName = null } = {}) {
  const doc = parseSections(anchorText ? [{ heading: '__anchor', text: anchorText }, ...sections] : sections);

  // ---- Ankerblok kiezen: expliciet > kop-regex > samenvattingsachtig > eerste.
  const anchor =
    (anchorText && doc[0]) ||
    (anchorHeadingRe && doc.find((s) => s.heading && anchorHeadingRe.test(s.heading))) ||
    doc.find((s) => s.heading && SCANNABLE_HEADING.test(s.heading)) ||
    doc[0] || null;

  // ---- Zinnen classificeren per sectie (rol bepaalt de scan-diepte).
  const classified = doc.map((section) => {
    const geo = section !== anchor ? headingRegion(section.heading, lang) : null;
    const role = section === anchor ? 'anchor' : geo ? 'geo' : (section.heading && SCANNABLE_HEADING.test(section.heading)) ? 'summary' : 'other';
    const analyzed = (role === 'other')
      ? [] // niet-relevante secties niet op zinsniveau analyseren (ruisbeheersing)
      : section.sentences.map((t) => classifySentence(t, lang, { countryName, sectionRole: role }));
    return { section, role, geo, analyzed };
  });

  // ---- Landelijk niveau: gestructureerd bewijs eerst, anders ankertekst.
  const structuredAssessment = interpretStructured(structured);
  const regionalHintOnly = structuredAssessment?.regionalHintOnly ? structuredAssessment : null;
  const national = (structuredAssessment && !regionalHintOnly)
    ? structuredAssessment
    : deriveNationalFromSentences(classified.find((c) => c.role === 'anchor')?.analyzed || []);

  // ---- Regionale vermeldingen verzamelen.
  const mentionsByKey = new Map();
  const addMention = (m) => {
    if (!m || !m.level || m.level < 2) return;
    const key = normalizeRegionKey(m.normalizedRegion || m.region);
    if (!key) return;
    const existing = mentionsByKey.get(key);
    if (existing && existing.level >= m.level) return; // hoogste niveau wint
    mentionsByKey.set(key, m);
  };

  for (const { section, role, geo, analyzed } of classified) {
    // a) Geografische kop + niveau-formulering in de sectie → regiokop-vermelding.
    if (geo) {
      const sev = findSeverity(section.text, lang);
      // Vervoers-/tijdstip-advies is geen gebiedsadvies: "Do not travel ON
      // overloaded buses / AT night" mag geen regiovermelding worden.
      const modal = sev && /^\s*(on|at|during|after|alone|by|via)\b/i.test(section.text.slice(sev.index + sev.length));
      // Ruisbeheersing: een kop op de TitleCase-heuristiek alleen (zonder
      // expliciet geografisch scope-woord) telt uitsluitend bij zware
      // niveaus (3-4) — een los "exercise caution" in een sectie als
      // "Tourist scams" is algemeen advies, geen regionale escalatie.
      const headingStrong = headingHasScopeWord(section.heading, lang);
      if (sev && !modal && (sev.level >= 3 || headingStrong)) {
        addMention({
          region: geo, normalizedRegion: geo, level: sev.level, color: LEVEL_COLOR[sev.level],
          confidence: 'high', assessmentStatus: 'ok', sourceHeading: section.heading,
          matchedPhrase: sev.phrase.trim(),
          excerpt: section.text.slice(Math.max(0, sev.index - 100), sev.index + sev.length + 100).trim(),
          extractionMethod: 'heading_plus_section_level',
        });
      }
    }
    if (role === 'other') continue;

    // b) Zinsniveau: regionale aanbevelingen + dubbele-punt-lijsten.
    let carry = null; // { level, phrase } van "…travel to:" totdat de lijst eindigt
    for (const a of analyzed) {
      // De zin waaruit het landelijke niveau is afgeleid nooit óók als
      // regionale vermelding rapporteren (voorheen: anchorSkipMatch).
      if (national.pickText && a.text === national.pickText) continue;
      if (a.severity) {
        const afterSev = a.text.slice(a.severity.index + a.severity.length, a.severity.index + a.severity.length + 60);
        carry = /(?:^|\s)(?:to|a|à|hacia|nach|til|vers)?\s*:/.test(afterSev) ? { level: a.severity.level, phrase: a.severity.phrase } : null;
      }
      if (a.kind === 'regional-recommendation') {
        const { regions, exceptions } = extractRegions(a.text, lang, {
          severityIndex: a.severity.index, severityLength: a.severity.length, countryName,
        });
        for (const r of regions) {
          addMention({
            region: r.name, normalizedRegion: r.name, level: a.severity.level, color: LEVEL_COLOR[a.severity.level],
            confidence: 'medium', assessmentStatus: 'ok', sourceHeading: section.heading || null,
            matchedPhrase: a.severity.phrase.trim(),
            excerpt: a.text.length > 200 ? a.text.slice(0, 200) + '…' : a.text,
            extractionMethod: 'sentence_scope_level',
            targetType: r.type || null,
            exceptions: exceptions.length ? exceptions : undefined,
          });
        }
        // Compat: in het ANKERBLOK ook zonder extraheerbare naam een
        // vermelding op zinsniveau opnemen (zoals vóór de refactor).
        if (!regions.length && role === 'anchor') {
          const trimmed = a.text.trim();
          addMention({
            region: trimmed.length > 90 ? trimmed.slice(0, 90) + '…' : trimmed,
            normalizedRegion: null, level: a.severity.level, color: LEVEL_COLOR[a.severity.level],
            confidence: 'medium', assessmentStatus: 'ok', sourceHeading: null,
            matchedPhrase: a.severity.phrase.trim(), excerpt: trimmed,
            extractionMethod: 'anchor_sentence_level',
          });
        }
      } else if (!a.severity && carry) {
        // Lijstitem zonder eigen adviesformulering ("Guerrero state due to
        // crime.") — erft het niveau van de inleidende "…travel to:"-zin.
        const item = extractRegionFromListItem(a.text, lang, { countryName });
        if (item) {
          addMention({
            region: item.name, normalizedRegion: item.name, level: carry.level, color: LEVEL_COLOR[carry.level],
            confidence: 'medium', assessmentStatus: 'ok', sourceHeading: section.heading || null,
            matchedPhrase: carry.phrase.trim(),
            excerpt: a.text.length > 200 ? a.text.slice(0, 200) + '…' : a.text,
            extractionMethod: 'list_item_inherited_level',
            targetType: item.type || null,
          });
        } else if (a.text.split(/\s+/).length > 12) {
          carry = null; // lang proza: de lijst is voorbij
        }
      }
    }
  }

  const regionalBreakdown = [...mentionsByKey.values()];

  // ---- Samenvoegen: regionale max + vlaggen (landelijk niveau blijft onaangetast).
  const levels = regionalBreakdown.map((m) => m.level);
  if (national.regionalMaxLevel != null) levels.push(national.regionalMaxLevel);
  if (regionalHintOnly?.regionalMaxLevel != null) levels.push(regionalHintOnly.regionalMaxLevel);
  const regionalMaxLevel = levels.length ? Math.max(...levels) : null;
  const hasRegionalWarnings =
    national.hasRegionalWarnings ||
    regionalBreakdown.length > 0 ||
    (regionalHintOnly?.regionalMaxLevel != null && national.level != null && regionalHintOnly.regionalMaxLevel > national.level);

  // ---- AdvisoryAtlas-achtige regiokaart: naam → niveau (additief veld).
  const regions = {};
  for (const m of regionalBreakdown) if (m.normalizedRegion) regions[m.region] = m.level;

  return {
    level: national.level,
    color: national.color ?? levelToColor(national.level),
    levelLabel: national.label || national.explanation || null,
    explanation: national.explanation || null,
    confidence: national.confidence,
    sourceMethod: national.sourceMethod,
    assessmentStatus: national.assessmentStatus,
    regionalMaxLevel,
    hasRegionalWarnings,
    regionalBreakdown: regionalBreakdown.length ? regionalBreakdown : null,
    regionalCoverage: hasRegionalWarnings ? 'partial' : null,
    regions,
  };
}

export { cap };
