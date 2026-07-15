/**
 * Normaliseert de uiteenlopende risiconiveaus van buitenlandse bronnen naar
 * één schaal 1–4 die overeenkomt met de Nederlandse kleurcodes:
 *   1 = groen  (geen bijzondere risico's)
 *   2 = geel   (verhoogde voorzichtigheid)
 *   3 = oranje (alleen noodzakelijke reizen)
 *   4 = rood   (niet reizen)
 *
 * De bron-specifieke betekenistoekenning (VS "Level N", Canada
 * advisory-state, tekstformuleringen per taal) leeft in worker/src/analysis/;
 * dit bestand bevat alleen de kleurtabel.
 */
export const LEVEL_COLOR = { 1: 'groen', 2: 'geel', 3: 'oranje', 4: 'rood' };
export const COLOR_LEVEL = { groen: 1, geel: 2, oranje: 3, rood: 4 };

export function levelToColor(level) {
  return LEVEL_COLOR[level] || null;
}
