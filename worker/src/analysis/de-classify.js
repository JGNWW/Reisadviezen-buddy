/**
 * Duitsland (Auswärtiges Amt) — landelijk niveau uit de tekstuele
 * standaardformules, als aanvulling op de gestructureerde waarschuwingsvlaggen
 * van de opendata-API.
 *
 * De vlaggen (warning/partialWarning/situationWarning/…) kennen géén oranje
 * trap: een land waar het AA "von nicht unbedingt erforderlichen Reisen wird
 * abgeraten" schrijft (niet-noodzakelijke reizen afgeraden) zou zonder deze
 * tekstlezing op geel of groen blijven hangen. Daarom lezen we de nationale
 * formule óók uit de tekst en nemen we in de adapter het hoogste van (vlag,
 * tekst).
 *
 *   rood  (4): "Von Reisen wird abgeraten"            (reizen afgeraden, hele land)
 *   oranje(3): "Von nicht unbedingt erforderlichen Reisen wird abgeraten"
 *              (+ varianten: notwendigen / dringend erforderlichen /
 *               touristischen Reisen)
 *
 * KRITISCH — "abgeraten" is in het Duits sterk overladen ("von der Nutzung der
 * Überlandbusse abgeraten", "von nicht dringenden Zahnbehandlungen abgeraten",
 * "von einer Mitnahme … abgeraten"). Daarom eisen alle patronen dat "Reisen"
 * DIRECT door "wird (dringend) abgeraten" wordt gevolgd. Zo blijft:
 *   - overladen gebruik buiten schot (er staat dan geen "Reisen wird" pal ervoor);
 *   - een REGIONALE formule buiten schot ("von … Reisen IN fünf der sechs
 *     Provinzen … wird abgeraten" — "Reisen" wordt gevolgd door "in <regio>",
 *     niet door "wird"), zodat een regiozone het landniveau niet opkrikt.
 * De formele Reisewarnung (rood) laten we bewust aan de vlaggen over
 * (warning-flag) — die is betrouwbaarder dan het woord "Reisewarnung" in
 * vrije tekst, dat ook regionaal ("Teilreisewarnung für …") kan voorkomen.
 */
const norm = (s) => (s || '').replace(/\s+/g, ' ').toLowerCase();

// "wird [adverb] [adverb] abgeraten" — tot twee bijwoorden tussen "wird" en
// "abgeraten" (dringend/derzeit/weiterhin/aktuell/…). Een regio staat altijd
// VÓÓR "wird" ("… Reisen IN die Provinz X wird abgeraten"), nooit erna, dus dit
// blijft landelijk-scope-veilig.
const WIRD_ABGERATEN = String.raw`wird (?:\w+ ){0,2}abgeraten`;

// Rood: "Von Reisen wird (…) abgeraten" — kaal, dus landelijk. Ook de expliciet
// landelijke variant "in dieses Land / in das (gesamte) Land".
const DE_NATIONAL_RED =
  new RegExp(String.raw`\bvon reisen ${WIRD_ABGERATEN}\b`);
const DE_NATIONAL_RED_LAND =
  new RegExp(String.raw`\bvon reisen in (?:dieses land|das (?:gesamte |ganze )?land|das gesamte staatsgebiet) ${WIRD_ABGERATEN}\b`);

// Oranje: "Von <niet-noodzakelijke/toeristische> Reisen wird (…) abgeraten" —
// "Reisen" pal gevolgd door "wird", dus landelijk (niet regionaal).
const DE_NATIONAL_ORANGE =
  new RegExp(String.raw`\bvon (?:nicht unbedingt (?:erforderlichen?|notwendigen?)|nicht dringend (?:erforderlichen?|notwendigen?)|nicht notwendigen?|touristischen) reisen ${WIRD_ABGERATEN}\b`);

/**
 * Landelijk niveau (3 = oranje, 4 = rood) uit de Duitse standaardformules, of
 * null als er geen landelijke ontradingsformule in de tekst staat.
 * @param {string} text
 * @returns {3|4|null}
 */
export function classifyGermanNational(text) {
  const t = norm(text);
  if (!t) return null;
  if (DE_NATIONAL_RED.test(t) || DE_NATIONAL_RED_LAND.test(t)) return 4;
  if (DE_NATIONAL_ORANGE.test(t)) return 3;
  return null;
}
