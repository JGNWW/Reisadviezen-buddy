/**
 * Bepaalt het landelijke risiconiveau van een bron zonder de klassieke fout
 * te maken: een lokale/regionale waarschuwing (bijv. "vermijd deze ene weg
 * naar stad X") aanzien voor een landelijke ("heel dit land is niveau 4").
 *
 * Kernprincipe (zie ook de discussie die tot dit bestand leidde): gebruik
 * altijd het gestructureerde/officiële veld van een bron als dat bestaat;
 * scan nooit de hele paginatekst (incl. regionale subsecties) op trefwoorden.
 * Waar geen gestructureerd veld bestaat, wordt gezocht in een specifiek
 * geïdentificeerd samenvattend blok, met scope-detectie (landelijk vs.
 * regionaal) — en bij twijfel is de uitkomst "onzeker", nooit een gok.
 *
 * Retourvorm (per bron), naast de bestaande level/color:
 *   regionalMaxLevel   hoogste niveau dat ergens in het land regionaal geldt
 *   hasRegionalWarnings of er regionale waarschuwingen zijn (ook als het
 *                        landelijke niveau laag is — "groen" mag nooit
 *                        gelezen worden als "overal veilig")
 *   confidence         'high' | 'medium' | 'low'
 *   sourceMethod       'structured' | 'summary-block' | 'fallback-text'
 *   assessmentStatus   'ok' | 'uncertain'
 *   explanation        korte Nederlandse toelichting
 */

const REGIONAL_WORDS_EN = /\b(regions?|provinces?|state of|border areas?|city of|routes?|areas?|parts? of)\b/i;
const REGIONAL_WORDS_FR = /\b(r[ée]gions?|provinces?|zones?|frontali[eè]res?|ville de|routes?|[EÉ]tats? de|certaines? (zones|r[ée]gions))\b/i;
const REGIONAL_WORDS_ES = /\b(regi[oó]n(es)?|provincias?|zonas?|fronter(a|iz[oa]s?)|ciudad(es)? de|carreteras?|estados? de|determinadas? zonas)\b/i;
const REGIONAL_WORDS_DA = /\b(regionen?|provins|omr[åa]der?|delstat|byen? |gr[æa]nse|nordlige|sydlige|[øo]stlige|vestlige|dele af)\b/i;
const NATIONWIDE_WORDS = /\b(throughout the country|whole country|entire country|dans l['’]ensemble du pays|tout le pays|todo el pa[ií]s|en la totalidad del pa[ií]s|hele landet)\b/i;

// Koppen/onderwerpen die vrijwel nooit een regionamen zijn, ook al bevatten ze
// soms een woord dat op de regionale-scope-regex lijkt (bijv. "area", "zone").
// Alleen gebruikt om overduidelijke non-regio's uit te sluiten VOORDAT een
// kop als kandidaat-regio wordt beoordeeld — een regionamen als "Border
// areas" of "Kabylia" komt hier niet in voor en blijft dus een kandidaat.
const NON_REGIONAL_HEADING = /^(safety and security|entry requirements|health|getting help|local laws|customs rules|customs|terrorism\b|crime\b|road travel|rail travel|air travel|natural disasters|extreme weather|hurricanes?|tsunamis?|cyclones?|storms?|monsoons?|money\b|travel insurance|insurance\b|before you travel|about (fcdo|this)|summary|overview|warnings? and insurance|documentation|visa requirements|applying for a visa|vaccine|passport|dual nationals?|taking money|travel(l)?ing with children|souvenirs|risk of arrest|protecting yourself|security escorts|laws and cultural|personal id|ramadan|alcohol laws|illegal drugs|mobile phone|using cameras|lgbt|family law|military service|road conditions|taxis\b|wildfires|flooding|earthquakes|emergency|refunds|support from|contact(ing)?|help (abroad|in)|risk information|situation s[ée]curitaire|s[ée]curit[ée]\b|entr[ée]e.{0,3}s[ée]jour|sant[ée]\b|informations utiles|documentaci[oó]n y visados|sanidad|divisas|^otros$|direcciones y tel[ée]fonos|notas importantes|seguridad\b|recommandations? g[ée]n[ée]rales?|s[ûu]ret[ée]\b)\b/i;

function base(overrides) {
  return {
    level: null, color: null, regionalMaxLevel: null, hasRegionalWarnings: false,
    confidence: 'low', sourceMethod: 'fallback-text', assessmentStatus: 'uncertain',
    explanation: 'Niet vastgesteld.', ...overrides,
  };
}

const LEVEL_COLOR = ['', 'groen', 'geel', 'oranje', 'rood'];

/** Vindt de best passende (eerst optredende) niveau-formulering in tekst. */
function findBestMatch(text, patterns) {
  let best = null;
  for (const p of patterns) {
    const m = text.match(p.re);
    if (m && (!best || m.index < best.index)) best = { level: p.level, index: m.index, match: m[0] };
  }
  return best;
}

function looksGeographic(heading, regionalWordsRe) {
  if (!heading) return false;
  const trimmed = heading.trim();
  if (!trimmed || NON_REGIONAL_HEADING.test(trimmed)) return false;
  if (regionalWordsRe.test(trimmed)) return true;
  // Korte kop die met een hoofdletter begint: waarschijnlijk een plaatsnaam
  // (bijv. "Kabylia", "Algeria-Morocco border" zonder scope-woord).
  const words = trimmed.split(/\s+/);
  return words.length <= 6 && /^[A-ZÀ-Ýa-zà-ÿ0-9]/.test(trimmed) && /[A-ZÀ-Ý]/.test(trimmed);
}

function excerptAround(text, index, matchLen, span = 100) {
  const start = Math.max(0, index - span);
  const end = Math.min(text.length, index + matchLen + span);
  return text.slice(start, end).trim();
}

// Sommige bronnen (GOV.UK) noemen dezelfde regio twee keer: eerst in een
// samenvattend overzicht ("State of Chihuahua"), later in een uitgebreidere
// subsectie ("Chihuahua" of "Chihuahua, including Ciudad Juárez"). Dit
// normaliseert beide vormen naar dezelfde sleutel zodat we niet dubbel
// rapporteren.
function normalizeRegionKey(heading) {
  return heading
    .toLowerCase()
    .replace(/^(the\s+)?state of\s+/, '')
    .replace(/,.*/, '')
    .replace(/\s+(region|state)$/, '')
    .trim();
}

/**
 * VK: leidt het niveau af uit het gestructureerde `alert_status`-veld van de
 * GOV.UK Content API (NIET uit vrije paginatekst). Ontbrekend/onverwacht
 * formaat wordt expliciet als onzeker behandeld — anders dan een lege array,
 * die betekent "geen vermijdingswaarschuwing gevonden", niet per se "geen
 * enkel risico" (zie toelichting).
 */
export function assessUkAlertStatus(alertStatus) {
  if (!Array.isArray(alertStatus)) {
    return base({ explanation: 'VK alert_status ontbreekt of heeft een onverwacht formaat.' });
  }
  const wholeAll = alertStatus.includes('avoid_all_travel_to_whole_country');
  const wholeEssential = alertStatus.includes('avoid_all_but_essential_travel_to_whole_country');
  const partsAll = alertStatus.includes('avoid_all_travel_to_parts');
  const partsEssential = alertStatus.includes('avoid_all_but_essential_travel_to_parts');
  const hasParts = partsAll || partsEssential;
  const partsMax = partsAll ? 4 : partsEssential ? 3 : null;

  if (wholeAll) {
    return base({
      level: 4, color: 'rood', regionalMaxLevel: 4, hasRegionalWarnings: hasParts,
      confidence: 'high', sourceMethod: 'structured', assessmentStatus: 'ok',
      explanation: 'VK adviseert tegen alle reizen naar het hele land.',
    });
  }
  if (wholeEssential) {
    return base({
      level: 3, color: 'oranje', regionalMaxLevel: partsAll ? 4 : (partsEssential ? 3 : 3), hasRegionalWarnings: hasParts,
      confidence: 'high', sourceMethod: 'structured', assessmentStatus: 'ok',
      explanation: 'VK adviseert alleen noodzakelijke reizen naar het hele land.',
    });
  }
  if (hasParts) {
    // Regionale waarschuwing(en), geen landelijke: landelijk laag houden,
    // maar de regionale ernst apart zichtbaar maken (nooit alleen "groen" tonen).
    return base({
      level: 1, color: 'groen', regionalMaxLevel: partsMax, hasRegionalWarnings: true,
      confidence: 'high', sourceMethod: 'structured', assessmentStatus: 'ok',
      explanation: 'VK-waarschuwing geldt voor delen van het land, niet landelijk — zie regionale risico’s.',
    });
  }
  return base({
    level: 1, color: 'groen', regionalMaxLevel: null, hasRegionalWarnings: false,
    confidence: 'high', sourceMethod: 'structured', assessmentStatus: 'ok',
    explanation: 'Geen VK-vermijdingswaarschuwing gevonden voor dit land.',
  });
}

/**
 * Generieke, scope-bewuste tekst-assessor voor bronnen zonder gestructureerd
 * niveauveld (Frankrijk, Spanje). Zoekt UITSLUITEND in het meegegeven
 * (al geankerde, d.w.z. beperkte) tekstblok — nooit de hele pagina — en
 * beoordeelt per match of de omliggende zin landelijk of regionaal geformuleerd
 * is. Bij twijfel: onzeker, geen gok.
 */
export function assessFromAnchoredText(anchoredText, patterns, regionalWordsRe) {
  if (!anchoredText) return base({ explanation: 'Geen samenvattend tekstblok gevonden om te beoordelen.' });

  const best = findBestMatch(anchoredText, patterns);
  if (!best) {
    return base({ sourceMethod: 'summary-block', explanation: 'Geen herkenbare niveau-formulering gevonden in het samenvattend blok.' });
  }

  // Zin rond de match voor scope-detectie.
  const start = Math.max(0, best.index - 120);
  const end = Math.min(anchoredText.length, best.index + best.match.length + 160);
  const sentence = anchoredText.slice(start, end);
  const isNationwide = NATIONWIDE_WORDS.test(sentence);
  const isRegional = regionalWordsRe.test(sentence);

  if (best.level <= 2 || isNationwide || !isRegional) {
    // Geel/groen-achtige formuleringen zijn doorgaans sowieso landelijk
    // (algemene "wees voorzichtig"-adviezen gelden voor het hele land); voor
    // zwaardere niveaus (3-4) alleen landelijk toepassen als de zin geen
    // regionale scope-woorden bevat (of expliciet landelijk is).
    return base({
      level: best.level, color: ['', 'groen', 'geel', 'oranje', 'rood'][best.level],
      regionalMaxLevel: best.level, hasRegionalWarnings: false,
      confidence: isNationwide ? 'high' : 'medium', sourceMethod: 'summary-block', assessmentStatus: 'ok',
      explanation: `Niveau afgeleid uit samenvattend blok ("${best.match.trim()}").`,
    });
  }

  // Zware formulering (3-4) met duidelijk regionale scope: niet landelijk escaleren.
  return base({
    level: 1, color: 'groen', regionalMaxLevel: best.level, hasRegionalWarnings: true,
    confidence: 'medium', sourceMethod: 'summary-block', assessmentStatus: 'ok',
    explanation: `Waarschuwing ("${best.match.trim()}") lijkt regionaal, niet landelijk — landelijk niveau laag gehouden.`,
  });
}

/**
 * Zoekt expliciet gevonden regionale vermeldingen — GEEN complete
 * geografische kaart, maar een lijst met bewijs (kop/zin, gematchte
 * formulering, fragment) per vermelding. Twee bronnen van kandidaten:
 *   - `sections`: secties buiten het landelijke ankerblok (elk met een eigen
 *     kop), bijv. de "Kabylia"/"Algeria border areas"-achtige subsecties.
 *   - `anchorText` (optioneel): het ankerblok zelf, voor bronnen (Spanje) die
 *     landelijke én regionale zinnen in hetzelfde blok bundelen. Hier is een
 *     kop niet beschikbaar, dus wordt een expliciet regionaal scope-woord in
 *     dezelfde zin geëist.
 * `anchorSkipMatch` (het resultaat van findBestMatch op datzelfde ankerblok,
 * dat al als landelijk oordeel is gebruikt) voorkomt dat die ene zin ook nog
 * eens dubbel als "regionale vermelding" verschijnt.
 *
 * Regel: een vermelding wordt ALLEEN opgenomen als (a) de kop geen bekende
 * niet-regionale rubriek is en er geografisch genoeg uitziet, EN (b) de
 * tekst zelf een niveau-formulering bevat. Zonder dat laatste bewijs wordt
 * niets gerapporteerd — liever onvolledig dan gegokt.
 */
export function extractRegionalMentions({ sections = [], anchorText = '', anchorSkipMatch = null, patterns, regionalWordsRe }) {
  const mentions = [];
  const seenRegionKeys = new Set();

  for (const s of sections) {
    if (!s?.text) continue;
    const best = findBestMatch(s.text, patterns);
    if (!best) continue;
    if (!looksGeographic(s.heading, regionalWordsRe)) continue;
    const key = normalizeRegionKey(s.heading);
    if (seenRegionKeys.has(key)) continue;
    seenRegionKeys.add(key);
    mentions.push({
      region: (s.heading || '').trim(),
      normalizedRegion: (s.heading || '').trim(),
      level: best.level,
      color: LEVEL_COLOR[best.level],
      confidence: regionalWordsRe.test(s.heading || '') ? 'high' : 'medium',
      assessmentStatus: 'ok',
      sourceHeading: s.heading || null,
      matchedPhrase: best.match.trim(),
      excerpt: excerptAround(s.text, best.index, best.match.length),
      extractionMethod: 'heading_plus_section_level',
    });
  }

  if (anchorText) {
    const sentences = anchorText.split(/(?<=[.!?])\s+/);
    let offset = 0;
    for (const sentence of sentences) {
      const idx = anchorText.indexOf(sentence, offset);
      offset = idx + sentence.length;
      if (
        anchorSkipMatch &&
        idx <= anchorSkipMatch.index + anchorSkipMatch.match.length &&
        idx + sentence.length >= anchorSkipMatch.index
      ) {
        continue; // dit is de zin die al als landelijk oordeel gebruikt is
      }
      const best = findBestMatch(sentence, patterns);
      if (!best) continue;
      if (!regionalWordsRe.test(sentence)) continue; // eis: expliciet regionaal scope-woord in dezelfde zin
      const trimmed = sentence.trim();
      mentions.push({
        region: trimmed.length > 90 ? trimmed.slice(0, 90) + '…' : trimmed,
        normalizedRegion: null,
        level: best.level,
        color: LEVEL_COLOR[best.level],
        confidence: 'medium',
        assessmentStatus: 'ok',
        sourceHeading: null,
        matchedPhrase: best.match.trim(),
        excerpt: trimmed,
        extractionMethod: 'anchor_sentence_level',
      });
    }
  }

  return mentions;
}

/** Combineert het (eventueel structurele) regionalMaxLevel met concrete vermeldingen. */
export function mergeRegionalMax(existingMax, mentions) {
  const levels = mentions.map((m) => m.level).filter((l) => l != null);
  if (existingMax != null) levels.push(existingMax);
  return levels.length ? Math.max(...levels) : null;
}

export { findBestMatch };
export const REGIONAL_WORDS = { en: REGIONAL_WORDS_EN, fr: REGIONAL_WORDS_FR, es: REGIONAL_WORDS_ES, da: REGIONAL_WORDS_DA };
