/**
 * Normaliseert de uiteenlopende risiconiveaus van buitenlandse bronnen naar
 * één schaal 1–4 die overeenkomt met de Nederlandse kleurcodes:
 *   1 = groen  (geen bijzondere risico's)
 *   2 = geel   (verhoogde voorzichtigheid)
 *   3 = oranje (alleen noodzakelijke reizen)
 *   4 = rood   (niet reizen)
 */
export const LEVEL_COLOR = { 1: 'groen', 2: 'geel', 3: 'oranje', 4: 'rood' };
export const COLOR_LEVEL = { groen: 1, geel: 2, oranje: 3, rood: 4 };

export function levelToColor(level) {
  return LEVEL_COLOR[level] || null;
}

/** VS: "Level 1..4". */
export function usLevel(n) {
  const l = Number(n);
  return l >= 1 && l <= 4 ? l : null;
}

/** Canada: advisory-state 0..3 -> niveau 1..4. */
export function canadaStateToLevel(state) {
  const map = { 0: 1, 1: 2, 2: 3, 3: 4 };
  return map[Number(state)] ?? null;
}

/** Ierland/algemene tekst -> niveau op basis van formuleringen. */
export function textToLevel(text) {
  const t = (text || '').toLowerCase();
  if (/\bdo not travel\b|avoid all travel|all travel to/.test(t)) return 4;
  if (/avoid non-essential travel|against all but essential|reconsider (your need to )?travel|essential travel only/.test(t)) return 3;
  if (/high degree of caution|increased caution|exercise (a )?high|be aware|exercise caution/.test(t)) return 2;
  if (/normal (security )?precautions|no advisory|exercise normal/.test(t)) return 1;
  return null;
}
