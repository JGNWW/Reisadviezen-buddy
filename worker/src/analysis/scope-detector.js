/**
 * Scope-detector — bepaalt per zin waarop een aanbeveling betrekking heeft:
 *
 *   national   het hele land ("throughout the country", "in <landnaam>")
 *   regional   één of meer regio's/steden/grensgebieden/eilanden/…
 *   elsewhere  "elders"/"de rest van het land" — d.w.z. de landelijke
 *              basislijn NA aftrek van eerder genoemde regio's
 *   mixed      landelijk én regionaal in dezelfde zin
 *   unknown    geen scope-aanwijzing gevonden
 *
 * Plus doeltypen (region/border/city/island/airport/transport) en vlaggen
 * voor uitzonderings- ("except …") en elders-clausules.
 */

const NATIONWIDE = {
  en: /throughout (the )?country|whole country|entire country|country-?wide|nationwide|all of the country/i,
  fr: /l['’]ensemble du (pays|territoire)|tout le (pays|territoire)|sur l['’]ensemble|dans tout le pays/i,
  es: /todo el pa[ií]s|la totalidad del (pa[ií]s|territorio)|todo el territorio/i,
  da: /hele landet/i,
  de: /im ganzen land|landesweit|das gesamte land/i,
  ja: /全土|全域|国全体/,
  it: /in tutto il (paese|territorio)|tutto il territorio nazionale|su tutto il territorio/i,
  fi: /koko maassa|koko maan alueella/i,
  ko: /전 ?지역|전역|전 ?국토/,
  no: /hele landet/i,
};

const ELSEWHERE = {
  en: /\belsewhere\b|rest of the country|in (all )?other (areas|parts|regions)|other areas of the country/i,
  fr: /le reste du pays|dans le reste|partout ailleurs|ailleurs dans le pays/i,
  es: /el resto del pa[ií]s|en el resto/i,
  da: /resten af landet|[øo]vrige dele/i,
  de: /im rest des landes|[üu]brigen landesteilen?|restlichen landesteilen?/i,
  ja: /その他の地域|それ以外の地域|上記以外の地域/,
  it: /nel resto del paese|nelle altre (aree|zone|regioni)/i,
  fi: /muualla maassa|muilla alueilla/i,
  ko: /제외한 전 ?지역|그 외 지역|나머지 지역/,
  no: /resten av landet|[øo]vrige deler/i,
};

const EXCEPTION = {
  en: /\bexcept\b|with the exception of|apart from|other than/i,
  fr: /\bsauf\b|[àa] l['’]exception de|hormis/i,
  es: /\bsalvo\b|excepto|con la excepci[oó]n de|a excepci[oó]n de/i,
  da: /undtagen|med undtagelse af/i,
  de: /au[ßs]er\b|mit ausnahme/i,
  ja: /を除く|を除き|以外/,
  it: /ad eccezione di|salvo\b|eccetto|tranne/i,
  fi: /lukuun ottamatta|paitsi/i,
  ko: /을 제외한|를 제외한|제외하고/,
  no: /med unntak av|unntatt/i,
};

// Doeltypen (voor de regio-extractor en de UI). Eén zin kan meerdere typen
// raken ("the border provinces and the city of X").
const TARGETS = [
  { type: 'border', re: { en: /\bborder(s|ing)?\b|frontier/i, fr: /frontali[eè]re?s?|fronti[eè]re/i, es: /fronter(a|as|izo|iza|izos|izas)/i, da: /gr[æa]nse/i, de: /grenzgebiet|grenze\b|grenznah/i } },
  { type: 'city', re: { en: /\bcity\b|\bcities\b/i, fr: /\bvilles?\b/i, es: /\bciudad(es)?\b/i, da: /\bbyen\b|\bbyer(ne)?\b/i, de: /\bstadt\b|\bst[äa]dte\b/i } },
  { type: 'island', re: { en: /\bislands?\b|\barchipelago\b/i, fr: /\b[îi]les?\b|archipel/i, es: /\bislas?\b|archipi[ée]lago/i, da: /\b[øo]en\b|\b[øo]erne\b/i, de: /\binseln?\b|archipel/i } },
  { type: 'airport', re: { en: /\bairports?\b/i, fr: /a[ée]roports?/i, es: /aeropuertos?/i, da: /lufthavne?n?/i, de: /flugh[äa]fen|flughafen/i } },
  { type: 'transport', re: { en: /public transport|\bbuses\b|\btrains\b|\bmetro\b|\bhighways?\b/i, fr: /transports? (en commun|publics?)|axes? routiers?/i, es: /transporte p[uú]blico|autobuses|carreteras principales/i, da: /offentlig transport/i, de: /[öo]ffentliche verkehrsmittel/i } },
  { type: 'region', re: {
    en: /\bregions?\b|\bprovinces?\b|\bstates?\b|\bgovernorates?\b|\bdistricts?\b|\bdepartments?\b|\boblast\b|\bparts? of\b|\bareas? of\b/i,
    fr: /r[ée]gions?|provinces?|d[ée]partements?|wilayas?|gouvernorats?|\bzones?\b|certaines (zones|r[ée]gions)/i,
    es: /regi[oó]n(es)?|provincias?|estados? de|\bzonas?\b|departamentos?/i,
    da: /region(en|er)?|provins(en|er)?|omr[åa]de(t|r)?|delstat|nordlige|sydlige|[øo]stlige|vestlige|dele af/i,
    de: /region(en)?|provinz(en)?|bundesstaat(en)?|landesteil(e|en)?|gebiet(e|en)?|teile(n)? (des|von)/i,
  } },
];

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const forLang = (map, lang) => map[lang] || map.en;

/**
 * Bepaalt de scope van één zin.
 * `countryName` (indien bekend) laat "…travel to <Land>"/"…in <Land>" als
 * LANDELIJK herkennen — cruciaal voor bronnen als het US State Department,
 * waar het landelijke advies de landnaam als doel noemt ("Do not travel to
 * Burkina Faso") en zonder deze kennis onterecht regionaal zou lijken.
 */
export function detectScope(sentence, lang = 'en', opts = {}) {
  const s = String(sentence || '');
  const isElsewhere = forLang(ELSEWHERE, lang).test(s);
  const isException = forLang(EXCEPTION, lang).test(s);
  const targetTypes = TARGETS.filter((t) => forLang(t.re, lang).test(s)).map((t) => t.type);

  let nationwide = forLang(NATIONWIDE, lang).test(s);
  if (!nationwide && opts.countryName) {
    const name = escapeRe(String(opts.countryName).trim());
    if (name.length >= 3) {
      nationwide = new RegExp(`\\b(?:to|in|into|for|au|aux|en|dans|vers|a|hacia|nach|i|til)\\s+(?:the\\s+|le\\s+|la\\s+|el\\s+)?${name}\\b`, 'i').test(s);
    }
  }

  let scope = 'unknown';
  if (isElsewhere) scope = 'elsewhere';
  else if (nationwide && targetTypes.length === 0) scope = 'national';
  else if (nationwide) scope = 'mixed';
  else if (targetTypes.length) scope = 'regional';

  return { scope, targetTypes, isElsewhere, isException, nationwide };
}

/** Splitspunt van de uitzonderings-clausule in een zin (of -1). */
export function exceptionIndex(sentence, lang = 'en') {
  const m = String(sentence || '').match(forLang(EXCEPTION, lang));
  return m ? m.index : -1;
}

export const SCOPE_MARKERS = { NATIONWIDE, ELSEWHERE, EXCEPTION, TARGETS };
