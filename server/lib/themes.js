/**
 * Canonieke thema-taxonomie — één bron van waarheid.
 *
 * De taxonomie stond hier lang in een eigen kopie naast die van de Worker.
 * Die twee zijn uit elkaar gegroeid (471 om 301 trefwoorden), en dat is precies
 * het verkeerde verschil: het Nederlandse reisadvies werd dan met een kleiner
 * vocabulaire ingedeeld dan de buitenlandse bronnen waarmee we het vergelijken,
 * zodat dezelfde bosbrand links wél en rechts níét onder Natuurgeweld viel.
 *
 * Daarom is dit nu een doorgeefluik naar worker/src/lib/themes.js. Trefwoorden
 * en de matcher horen daar thuis; deze module bestaat alleen nog zodat de
 * bestaande imports in server/ blijven werken.
 */
export { THEMES, themeById, classifyTheme, orderThemes } from '../../worker/src/lib/themes.js';
