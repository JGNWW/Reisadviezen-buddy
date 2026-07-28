/**
 * Duitsland (Auswärtiges Amt) — landelijk niveau uit de tekstuele
 * standaardformules, als aanvulling op de gestructureerde waarschuwingsvlaggen
 * van de opendata-API.
 *
 * De vlaggen (warning/partialWarning/situationWarning/…) kennen géén oranje
 * trap en staan bovendien lang niet altijd aan: Koeweit en Jordanië kwamen op
 * groen binnen terwijl het AA er letterlijk "Von Reisen nach Kuwait wird
 * dringend abgeraten" schreef. Daarom lezen we de nationale formule óók uit de
 * tekst en neemt de adapter het hoogste van (vlag, tekst).
 *
 * Twee assen bepalen samen het niveau:
 *
 *   1. REIKWIJDTE — geldt het voor het hele land of voor een gebied?
 *      Landelijk is: de kale vorm, "nach <Land>", "in dieses Land / das
 *      gesamte Staatsgebiet", en de restformule "in andere Landesteile
 *      <Land>s" (die dekt per definitie de rest van het land).
 *      Een gebiedsformule ("in die Provinz X", "nach Aqaba", "in diese
 *      Gebiete") is NIET landelijk en mag het landniveau niet optillen — die
 *      wordt door de regio-extractie apart opgepikt.
 *
 *   2. INTENSITEIT — "abgeraten" is oranje, "dringend abgeraten" is rood.
 *      Dat onderscheid ontbrak: élke "Von Reisen wird abgeraten" werd rood,
 *      terwijl het AA die trap juist bewust gebruikt. Bij Jordanië staat het
 *      grensgebied op "dringend abgeraten" en de rest van het land op enkel
 *      "abgeraten" — twee verschillende kleuren dus.
 *      Reizen die al beperkt zijn tot niet-noodzakelijk of toeristisch blijven
 *      oranje: dat is inherent een lichtere maatregel dan "helemaal niet".
 *
 * De landnaam is nodig om "Von Reisen nach <Land>" (landelijk) te scheiden van
 * "Von Reisen nach <stad/gebied>" (regionaal) — bij Israël staat bijvoorbeeld
 * "nach Ost-Jerusalem". Even belangrijk: hij voorkomt dat een advies over een
 * BUURLAND meetelt. Op de pagina van Belarus staat "Von Reisen in die
 * Russische Föderation wird abgeraten"; zonder naamcontrole zou Belarus daar
 * ten onrechte van opkleuren.
 *
 * De formele Reisewarnung laten we aan de vlaggen over — die is betrouwbaarder
 * dan het woord "Reisewarnung" in vrije tekst, dat ook regionaal
 * ("Teilreisewarnung für …") kan voorkomen.
 */
const norm = (s) => (s || '').replace(/\s+/g, ' ').toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Bouwt een patroon dat de Duitse landnaam ook in verbogen vorm herkent.
 * Duits verbuigt zowel het lidwoord als het bijvoeglijk naamwoord én kent een
 * genitief-s: "Vereinigte Arabische Emirate" verschijnt als "in die
 * Vereinigten Arabischen Emirate", en "Jordanien" als "Jordaniens". Daarom
 * knippen we per woord de uitgang af en laten we de rest vrij.
 */
function landPattern(countryName) {
  const woorden = norm(countryName).split(/[\s-]+/).filter((w) => w.length > 2);
  if (!woorden.length) return null;
  return woorden.map((w) => `${esc(w.replace(/(?:en|er|es|e|n|s)$/, ''))}\\w*`).join('[\\s-]+');
}

// "wird [bijwoord]{0,2} abgeraten" — dringend/derzeit/weiterhin/daher/…
const WIRD = String.raw`wird (?:\w+ ){0,2}abgeraten`;
// Beperking tot niet-noodzakelijke/toeristische reizen → blijft oranje.
const BEPERKT = String.raw`(?:nicht (?:unbedingt )?(?:dringend )?(?:erforderlichen?|notwendigen?)|touristischen?|individual)`;
// Expliciet het hele land, zonder dat de naam valt.
const HEEL_LAND = String.raw`(?:diese[ns]? land|das (?:gesamte |ganze )?land|das gesamte staatsgebiet|alle landesteile)`;
// Restformule: "in (die) anderen/übrigen Landesteile <Lands>" — dekt per
// definitie het deel van het land dat niet apart genoemd is. Achter
// "Landesteile" volgt vaak de landnaam in de genitief ("Landesteile
// Jordaniens"), dus daar is ruimte voor.
const REST_LAND = String.raw`(?:die )?(?:anderen?|übrigen?|weiteren?) landesteile(?: \w+)?`;

/** Staat er "dringend"/"eindringlich" in de gevonden formule? */
const isDringend = (zin) => /\b(dringend|eindringlich)\b/.test(zin);

/**
 * Landelijk niveau (3 = oranje, 4 = rood) uit de Duitse standaardformules, of
 * null als er geen LANDELIJKE ontradingsformule in de tekst staat.
 *
 * @param {string} text          volledige adviestekst
 * @param {string} [countryName] Duitse landnaam uit de opendata-API ("Kuwait",
 *                               "Jordanien"). Zonder naam blijven alleen de
 *                               naamloze landelijke vormen over.
 * @returns {3|4|null}
 */
export function classifyGermanNational(text, countryName = null) {
  const t = norm(text);
  if (!t) return null;
  const land = countryName ? landPattern(countryName) : null;

  // Doelen die na "Reisen" als "het hele land" gelden.
  const doelen = [HEEL_LAND, REST_LAND];
  if (land) doelen.push(String.raw`(?:den |die |das |der )?${land}`);
  const doel = `(?:in |nach )(?:${doelen.join('|')})`;

  const kandidaten = [
    // Volledige reizen, landelijk: kaal of met een landelijk doel.
    { re: new RegExp(String.raw`\bvon reisen ${WIRD}`), beperkt: false },
    { re: new RegExp(String.raw`\bvon reisen ${doel} ${WIRD}`), beperkt: false },
    // Beperkte reizen (niet-noodzakelijk/toeristisch), landelijk.
    { re: new RegExp(String.raw`\bvon ${BEPERKT} reisen ${WIRD}`), beperkt: true },
    { re: new RegExp(String.raw`\bvon ${BEPERKT} reisen ${doel} ${WIRD}`), beperkt: true },
  ];

  let hoogste = null;
  for (const { re, beperkt } of kandidaten) {
    const m = t.match(re);
    if (!m) continue;
    // Beperkte reizen blijven oranje; volledige reizen worden rood zodra het
    // AA er "dringend" bij zet.
    const niveau = !beperkt && isDringend(m[0]) ? 4 : 3;
    if (niveau > (hoogste ?? 0)) hoogste = niveau;
  }
  return hoogste;
}
