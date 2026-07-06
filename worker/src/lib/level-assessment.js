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

const REGIONAL_WORDS_EN = /\b(region|province|state of|border area|city of|route|areas?|parts? of)\b/i;
const REGIONAL_WORDS_FR = /\b(r[ée]gion|province|zone|frontali[eè]re?|ville de|route|[EÉ]tat de|certaines? (zones|r[ée]gions))\b/i;
const REGIONAL_WORDS_ES = /\b(regi[oó]n|provincia|zona|frontera|ciudad de|carretera|estado de|determinadas? zonas)\b/i;
const NATIONWIDE_WORDS = /\b(throughout the country|whole country|entire country|dans l['’]ensemble du pays|tout le pays|todo el pa[ií]s|en la totalidad del pa[ií]s)\b/i;

function base(overrides) {
  return {
    level: null, color: null, regionalMaxLevel: null, hasRegionalWarnings: false,
    confidence: 'low', sourceMethod: 'fallback-text', assessmentStatus: 'uncertain',
    explanation: 'Niet vastgesteld.', ...overrides,
  };
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

  let best = null; // { level, index, sentence }
  for (const p of patterns) {
    const m = anchoredText.match(p.re);
    if (m && (!best || m.index < best.index)) best = { level: p.level, index: m.index, match: m[0] };
  }
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

export const REGIONAL_WORDS = { en: REGIONAL_WORDS_EN, fr: REGIONAL_WORDS_FR, es: REGIONAL_WORDS_ES };
