import { htmlToText } from './html.js';

/**
 * Kleurcodes van NederlandWereldwijd, van veilig naar gevaarlijk.
 * groen  = geen bijzondere veiligheidsrisico’s
 * geel   = let op, bijzondere veiligheidsrisico’s
 * oranje = reis alleen als het noodzakelijk is
 * rood   = niet reizen
 */
export const NL_COLORS = {
  groen: { label: 'Groen', rank: 1, hex: '#3a9d3a', meaning: 'Geen bijzondere veiligheidsrisico’s' },
  geel: { label: 'Geel', rank: 2, hex: '#f2c800', meaning: 'Let op: bijzondere veiligheidsrisico’s' },
  oranje: { label: 'Oranje', rank: 3, hex: '#e8730c', meaning: 'Reis alleen als het noodzakelijk is' },
  rood: { label: 'Rood', rank: 4, hex: '#d0021b', meaning: 'Niet reizen' },
};

/**
 * Haalt de kleurcode(s) uit de "In het kort"-tekst van een NL-reisadvies.
 * Een land kan meerdere kleuren hebben (bijv. rood grensgebied, geel rest).
 * Retourneert { overall, colors: [{color, context}] }.
 */
export function extractNlColors(introHtml) {
  const text = htmlToText(introHtml);
  const found = [];
  // Zoek per zin naar kleurwoorden zodat we context kunnen bewaren.
  const sentences = text.split(/(?<=[.!?])\s+/);
  const colorWords = ['groen', 'geel', 'oranje', 'rood'];
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    for (const c of colorWords) {
      // "kleurcode ... <kleur>" of "<kleur> ... kleurcode" of losse kleur bij "reisadvies"
      if (new RegExp(`\\b${c}\\b`).test(lower) && /kleurcode|reisadvies|geldt|is/.test(lower)) {
        found.push({ color: c, context: sentence.trim() });
        break;
      }
    }
  }
  // Dedupliceer op kleur maar bewaar de eerste context.
  const seen = new Set();
  const colors = [];
  for (const f of found) {
    if (!seen.has(f.color)) {
      seen.add(f.color);
      colors.push(f);
    }
  }
  // "Overall" = de OVERWEGENDE (landelijke) kleur. Bij meerdere kleuren is dat
  // de kleur van "de rest van het land" — NederlandWereldwijd noemt eerst de
  // afwijkende gebieden en sluit af met "Voor de rest van <land> geldt
  // kleurcode X". De zwaarste regionale kleur mag het landelijke beeld niet
  // overschrijven (Japan is niet "rood" omdat alleen zuidoost-Fukushima rood
  // is); de regionale kleuren blijven via colors[] zichtbaar in de UI.
  let overall = null;
  if (colors.length === 1) {
    overall = colors[0].color;
  } else if (colors.length > 1) {
    const REST = /\brest\b|\bhele land\b|\bheel het land\b|\bvoor heel\b|\boverige (deel|delen|gebieden)\b|\belders\b/i;
    const rest = colors.find((c) => REST.test(c.context));
    if (rest) {
      overall = rest.color;
    } else {
      // Geen "rest van"-formulering gevonden: terugvallen op de zwaarste
      // kleur (liever te streng tonen dan een waarschuwing verstoppen).
      for (const { color } of colors) {
        if (!overall || NL_COLORS[color].rank > NL_COLORS[overall].rank) overall = color;
      }
    }
  }
  return { overall, colors };
}

/**
 * Mapt een buitenlands reisadvies naar de NL-kleurenschaal op basis van de
 * gebruikte formuleringen. Dit is een benadering om vergelijking mogelijk te
 * maken; de originele formulering wordt altijd los getoond.
 */
export function mapForeignToNlColor(fullText) {
  const t = (fullText || '').toLowerCase();
  // Volgorde van zwaar naar licht; eerste match wint.
  if (/advise against all travel|do not travel|all travel to/.test(t)) {
    return { color: 'rood', basis: 'advies tegen alle reizen' };
  }
  if (/against all but essential travel|essential travel only|reconsider your need to travel|reconsider travel/.test(t)) {
    return { color: 'oranje', basis: 'advies tegen niet-noodzakelijke reizen' };
  }
  if (/exercise (a )?high degree of caution|high degree of caution|increased caution|see our advice|be aware|exercise caution/.test(t)) {
    return { color: 'geel', basis: 'verhoogde voorzichtigheid' };
  }
  return { color: 'groen', basis: 'geen bijzondere waarschuwing gevonden' };
}
