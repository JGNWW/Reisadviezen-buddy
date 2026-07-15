/**
 * Regio-extractor — haalt concrete gebiedsnamen uit aanbevelingszinnen en
 * sectiekoppen: regio's, provincies, staten, steden, eilanden en
 * grensverwijzingen ("within 10 km of the India-Pakistan border").
 *
 * Ontwerpprincipe: liever te weinig dan gegokt. Een kandidaat die niet met
 * een hoofdletter begint of te generiek is ("the country", "some areas")
 * wordt verworpen; de aanroeper valt dan terug op bewijs op zinsniveau.
 */
import { exceptionIndex, SCOPE_MARKERS } from './scope-detector.js';

// "binnen N km van de grens met X" — de naam behoudt de brontekst, de
// kilometrering wordt als toevoeging genoteerd.
const BORDER_ZONE = /within\s+(\d+)\s?(?:km|kilomet\w+|miles?)\s+of\s+(?:the\s+)?([^,;.]*?borders?[^,;.]*)/i;

// "grens met X" in alle brontalen; levert border-vermeldingen op ook als de
// zin verder geen extraheerbare tail heeft (bijv. Duits: ernst-formulering
// aan het eind van de zin).
const BORDER_WITH = /(?:borders?|fronti[eè]res?|fronter(?:a|as|izo|iza|izos|izas)|gr[æa]nse[nrt]?|grenzgebiete?[ns]?|grenze)\s+(?:with|avec|con|zu[rm]?|til|med)\s+([A-ZÀ-Þ][^,.;:()]*)/i;

// Verbindingswoorden tussen adviesformulering en doelgebied.
const LEAD_IN = /^\s*(?:when\s+)?(?:travell?ing\s+)?(?:de\s+(?:se\s+rendre|voyager)\s+)?(?:to|into|in|at|au|aux|à|en|dans|vers|hacia|a|nach|i|til)\s*:?\s+/i;

// Uitzonderingswoord gevolgd door een REDEN ("salvo por razones ineludibles",
// "except for essential reasons") is een ernst-kwalificatie, geen
// geografische uitzondering.
const EXCEPTION_IS_REASON = /^\s*(?:at\s+|in\s+)?(?:por\s+|de\s+|for\s+|pour\s+)?(?:razones|motivos|raisons?|raison|reasons?|essential|imperative|imp[ée]rative)/i;

// Redenen en bijzinnen die achter het doelgebied volgen.
const REASON_CUT = /,?\s+(?:due to|because|owing to|as a result|in view of|en raison|pour cause|debido a|wegen|p[åa] grund af)\b.*$/i;
// Relatieve bijzinnen achter het doelgebied ("… states, where Islamic State
// West Africa operates") horen niet bij de gebiedsnaam.
const CLAUSE_CUT = /,?\s+(?:where|which|that is|as well as|o[ùu]|dont|donde|wo)\b.*$/i;
const INCLUDING_CUT = /,?\s+(?:including|incluant|y compris|incluyendo|einschlie[ßs]lich|herunder)\b[^,;.]*/gi;

// Lidwoorden en beschrijvende voorvoegsels die vóór de eigenlijke naam staan.
const ARTICLES = /^(?:the|la|le|les|los|las|el|die|der|das|den|il|other)\s+/i;
const DESCRIPTOR = /^(?:provinces?|states?|regions?|areas?|parts?|city|cities|governorates?|districts?|departments?|d[ée]partements?|r[ée]gions?|wilayas?|zonas?|provincias?|estados?|ciudad(?:es)?|regi[oó]n(?:es)?|delstaten?|bundesstaat)\s+(?:of|de|du|des|del?|von)\s+/i;

const GENERIC = /^(?:country|countries|region|regions|area|areas|place|places|part|parts|following|these|those|it|there|night|day|areas mentioned)$/i;

function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Normaliseert een regionaam tot een ontdubbelsleutel ("State of Chihuahua" ≡ "Chihuahua"). */
export function normalizeRegionKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/^(the\s+)?state of\s+/, '')
    .replace(/,.*/, '')
    .replace(/\s+(region|state|province|governorate|city)$/, '')
    .trim();
}

/** Maakt van een losse token een valide regionaam, of null. */
function cleanToken(tok, countryName) {
  let t = String(tok || '')
    .trim()
    .replace(/^[-–—:;()[\]"'*•]+|[.:;()[\]"'*•]+$/g, '')
    .trim();
  // "border with X" mag met een kleine letter beginnen — normaliseer naar
  // een herkenbare grens-vermelding.
  const bw = t.match(/^(?:the\s+)?borders?\s+(?:with|of)\s+(.+)$/i);
  if (bw) return { name: `Grensgebied met ${bw[1].trim()}`, type: 'border' };
  t = t.replace(ARTICLES, '').replace(DESCRIPTOR, '').replace(ARTICLES, '').trim();
  if (!t || t.length < 2 || t.length > 60) return null;
  if (!/^[A-ZÀ-Þ0-9]/.test(t)) return null; // moet als eigennaam ogen
  if (t.split(/\s+/).length > 7) return null;
  // Volledig KAPITALEN over meerdere woorden is vrijwel altijd een geschreeuwd
  // zinsdeel ("Y ABSTENERSE DE HACERLO"), geen plaatsnaam.
  if (t.split(/\s+/).length > 2 && !/[a-zà-ÿ]/.test(t)) return null;
  if (GENERIC.test(t)) return null;
  if (countryName && t.toLowerCase() === String(countryName).toLowerCase()) return null;
  return { name: t, type: null };
}

function typeFor(text, fallback = 'region') {
  for (const t of SCOPE_MARKERS.TARGETS) {
    if ((t.re.en).test(text) || Object.values(t.re).some((re) => re.test(text))) return t.type;
  }
  return fallback;
}

/**
 * Extraheert doelgebieden uit één aanbevelingszin.
 *
 * @param sentence  de volledige zin
 * @param lang      brontaal
 * @param opts      { severityIndex, severityLength, countryName }
 *                  severityIndex/Length: positie van de gevonden
 *                  ernst-formulering — extractie begint erná ("Do not travel
 *                  to |X, Y and Z| due to …").
 * @returns { regions: [{name,type}], exceptions: [name] }
 */
export function extractRegions(sentence, lang = 'en', opts = {}) {
  const s = String(sentence || '');
  const regions = [];
  const exceptions = [];
  const seen = new Set();
  const push = (item) => {
    if (!item) return;
    const key = normalizeRegionKey(item.name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    regions.push(item);
  };

  // 1. Uitzonderings-clausule afsplitsen ("…, except at the Wagah-Attari
  //    border crossing"): die namen horen NIET bij het gewaarschuwde gebied.
  //    Let op: een uitzonderingswoord BINNEN de ernst-formulering zelf
  //    ("no viajar salvo razones ineludibles") is een ernst-kwalificatie,
  //    geen geografische uitzondering — die wordt genegeerd.
  let body = s;
  let exIdx = exceptionIndex(s, lang);
  if (
    exIdx >= 0 && opts.severityIndex != null && opts.severityLength != null &&
    exIdx >= opts.severityIndex && exIdx < opts.severityIndex + opts.severityLength
  ) exIdx = -1;
  if (exIdx > 0 && EXCEPTION_IS_REASON.test(s.slice(exIdx).replace(/^[^\s]+/, ''))) exIdx = -1;
  if (exIdx > 0) {
    const tail = s.slice(exIdx).replace(/^[^\s]+\s+/, ''); // marker zelf eraf
    body = s.slice(0, exIdx);
    for (const rawTok of tail.split(/,| and | et | y | og | und | or | ou /i)) {
      const cleaned = cleanToken(rawTok.replace(/^(?:at|in|de|en)\s+/i, ''), opts.countryName);
      if (cleaned) exceptions.push(cleaned.name);
    }
  }

  // 2. Kilometer-grenszones ("within 10 km of the India-Pakistan border").
  const bz = body.match(BORDER_ZONE);
  if (bz) push({ name: `${bz[2].trim()} (binnen ${bz[1]} km)`, type: 'border' });

  // 3. "grens met X" — vangt ook zinnen waar de ernst-formulering achteraan
  //    staat (Duits) of de grens midden in de zin genoemd wordt.
  if (!bz) {
    const bwm = body.match(BORDER_WITH);
    if (bwm) {
      const captured = bwm[1].replace(REASON_CUT, '');
      for (const part of captured.split(/,| and | et | y | og | und | oder /i)) {
        const name = part.trim().replace(/[.:;]$/, '');
        if (/^[A-ZÀ-Þ]/.test(name)) push({ name: `Grensgebied met ${name}`, type: 'border' });
      }
    }
  }

  // 4. Doelgebied-tail na de adviesformulering: "…travel to X, Y and Z due
  //    to crime" → [X, Y, Z].
  let tail = null;
  if (opts.severityIndex != null && opts.severityLength != null) {
    tail = body.slice(opts.severityIndex + opts.severityLength);
  }
  if (tail) {
    tail = tail.replace(LEAD_IN, '');
    tail = tail.replace(INCLUDING_CUT, '');
    tail = tail.replace(REASON_CUT, '');
    tail = tail.replace(CLAUSE_CUT, '');
    tail = tail.replace(/[.:;]\s*$/, '').trim();
    if (tail && !BORDER_ZONE.test(body)) {
      for (const rawTok of tail.split(/,| and | et | y | og | und | or | ou /i)) {
        let tok = rawTok;
        // "Marawi City in Mindanao" → alleen het genoemde doel zelf.
        const inCut = tok.search(/\s+in\s+(?:the\s+)?[A-ZÀ-Þ]/);
        if (inCut > 0) tok = tok.slice(0, inCut);
        const cleaned = cleanToken(tok, opts.countryName);
        if (cleaned) push({ name: cleaned.name, type: cleaned.type || typeFor(rawTok, typeFor(body)) });
      }
    }
  }

  return { regions, exceptions };
}

/**
 * Kandidaat-regionaam uit een LIJSTITEM zonder eigen adviesformulering
 * ("Guerrero state due to crime.") — gebruikt bij dubbele-punt-lijsten waar
 * het niveau van de inleidende zin wordt overgeërfd.
 */
export function extractRegionFromListItem(sentence, lang = 'en', opts = {}) {
  let body = String(sentence || '');
  const exIdx = exceptionIndex(body, lang);
  if (exIdx > 0) body = body.slice(0, exIdx);
  const bz = body.match(BORDER_ZONE);
  if (bz) return { name: `${bz[2].trim()} (binnen ${bz[1]} km)`, type: 'border' };
  body = body.replace(INCLUDING_CUT, '').replace(REASON_CUT, '').replace(CLAUSE_CUT, '').replace(/[.:;]\s*$/, '').trim();
  const inCut = body.search(/\s+in\s+(?:the\s+)?[A-ZÀ-Þ]/);
  if (inCut > 0) body = body.slice(0, inCut);
  if (body.split(/\s+/).length > 8) return null; // te lang voor een lijstitem
  const cleaned = cleanToken(body, opts.countryName);
  return cleaned ? { name: cleaned.name, type: cleaned.type || typeFor(sentence) } : null;
}

// Koppen die vrijwel nooit een regionaam zijn (rubrieken, thema's, service-
// pagina's) — overgenomen uit de vorige level-assessment en hier beheerd.
export const NON_REGIONAL_HEADING = /^(safety and security|entry requirements|health|getting help|local laws|customs rules|customs|terrorism\b|crime\b|road travel|rail travel|air travel|bus travel|boat travel|sea travel|river travel|ferry|trekking|mountaineering|swimming|scams?\b|natural disasters|extreme weather|hurricanes?|tsunamis?|cyclones?|storms?|monsoons?|money\b|travel insurance|insurance\b|before you travel|about (fcdo|this)|summary|overview|warnings? and insurance|documentation|visa requirements|applying for a visa|vaccine|passport|dual nationals?|taking money|travel(l)?ing with children|souvenirs|risk of arrest|protecting yourself|security escorts|laws and cultural|personal id|ramadan|alcohol laws|illegal drugs|mobile phone|using cameras|lgbt|family law|military service|road conditions|taxis\b|wildfires|flooding|earthquakes|emergency|refunds|support from|contact(ing)?|help (abroad|in)|risk information|risk levels?|situation s[ée]curitaire|s[ée]curit[ée]\b|entr[ée]e.{0,3}s[ée]jour|sant[ée]\b|informations utiles|documentaci[oó]n y visados|sanidad|divisas|^otros$|direcciones y tel[ée]fonos|notas importantes|seguridad\b|recommandations? g[ée]n[ée]rales?|s[ûu]ret[ée]\b|aktuelles|kriminalit[äa]t|gesundheit|einreise|reiseinfos)\b/i;

/** Bevat de kop een expliciet geografisch scope-woord (regio/grens/stad/eiland)? */
export function headingHasScopeWord(heading, lang = 'en') {
  const trimmed = String(heading || '').trim();
  if (!trimmed) return false;
  return SCOPE_MARKERS.TARGETS
    .filter((t) => ['region', 'border', 'city', 'island'].includes(t.type))
    .some((t) => (t.re[lang] || t.re.en).test(trimmed));
}

/**
 * Bepaalt of een sectiekop een geografische naam is (en dus als regiokop mag
 * dienen). Retourneert de opgeschoonde naam, of null.
 */
export function headingRegion(heading, lang = 'en') {
  const trimmed = String(heading || '').trim();
  if (!trimmed || NON_REGIONAL_HEADING.test(trimmed)) return null;
  if (headingHasScopeWord(trimmed, lang)) return trimmed;
  // Korte kop die als eigennaam oogt ("Kabylia", "Algeria-Morocco border").
  const words = trimmed.split(/\s+/);
  if (words.length <= 6 && /^[A-ZÀ-Ýa-zà-ÿ0-9]/.test(trimmed) && /[A-ZÀ-Ý]/.test(trimmed)) return trimmed;
  return null;
}

export function escapeForRe(s) {
  return esc(s);
}
