/**
 * Ernst-detector — normaliseert de uiteenlopende bronformuleringen naar één
 * canonieke schaal, ongeacht land of taal:
 *
 *   1  Exercise normal precautions   (groen)
 *   2  Exercise increased caution    (geel)
 *   3  Avoid non-essential travel    (oranje)
 *   4  Do not travel                 (rood)
 *
 * Dit is de ENIGE plek in de codebase met niveau-formuleringen; adapters
 * bevatten er geen meer. Nieuwe bron of taal? Voeg hier patronen toe.
 */
import { levelToColor } from '../lib/levels.js';

export const SEVERITY_LABELS = {
  1: 'Exercise normal precautions',
  2: 'Exercise increased caution',
  3: 'Avoid non-essential travel',
  4: 'Do not travel',
};

const P = (re, level) => ({ re, level });

// Per taal, elk patroon exclusief geformuleerd zodat een zwaardere variant
// nooit per ongeluk in een lichtere matcht ("against all but essential
// travel" bevat níet de tekenreeks "against all travel").
const PATTERNS = {
  en: [
    P(/\bdo not travel\b/i, 4),
    P(/advis\w+ against all travel/i, 4),
    P(/\bavoid all travel\b/i, 4),
    P(/advis\w+ against all but essential travel/i, 3),
    P(/\bavoid (all )?non-?essential travel\b/i, 3),
    P(/\breconsider (your need to )?travel\b/i, 3),
    P(/\bessential travel only\b/i, 3),
    P(/exercise (a )?(high(er)? degree of|increased|heightened) caution/i, 2),
    P(/\bexercise (particular |extra )?caution\b/i, 2),
    P(/exercise normal (safety |security )?(and security )?precautions/i, 1),
    P(/take normal (safety |security )?precautions/i, 1),
    P(/no (specific )?travel advisory/i, 1),
  ],
  fr: [
    P(/formellement d[ée]conseill[ée]/i, 4),
    P(/d[ée]conseill[ée] sauf raison imp[ée]rative/i, 3),
    P(/vigilance renforc[ée]e/i, 2),
    P(/vigilance normale/i, 1),
  ],
  es: [
    P(/se desaconseja (todo|cualquier) (viaje|desplazamiento)/i, 4),
    // "se desaconseja viajar a X" (zonder 'salvo'-uitzondering) = niet reizen.
    P(/se desaconseja(n)? (viajar|el viaje|todo (el )?viaje)\b(?![^.]*salvo)/i, 4),
    P(/se recomienda (valorar )?no viajar\b(?!.*salvo)/i, 4),
    P(/evitar (todo|cualquier) desplazamiento/i, 4),
    P(/no viajar salvo|salvo (por )?razones (ineludibles|de fuerza mayor)/i, 3),
    // "aplazar/posponer el viaje … salvo que sea necesario/imprescindible" of
    // "… hasta nuevo aviso" — niet-noodzakelijke reizen ontraden (niveau 3).
    P(/(aplazar|posponer)( el| su| todo)? (viaje|desplazamiento)s?[^.]{0,80}(salvo que sea (necesario|imprescindible)|hasta nuevo aviso)/i, 3),
    P(/desaconseja(n)? (los|el) (viajes?|desplazamientos?)/i, 3),
    P(/viajar con (mucha |extrema |extremada )?precauci[oó]n|extrem(ar|e|a) (las )?precauci|adoptar precauciones|alto grado de precauci/i, 2),
    P(/viaje sin restricciones|sin restricciones|no hay restricciones/i, 1),
  ],
  da: [
    // Volgorde: "ikke-nødvendige" vóór het bredere "alle rejser".
    P(/frar[åa]der alle ikke-n[øo]dvendige rejser/i, 3),
    P(/frar[åa]der alle rejser/i, 4),
    P(/v[æa]r ekstra forsigtig|sk[æa]rpet (sikkerhed|forsigtighed)/i, 2),
    P(/v[æa]r forsigtig/i, 2),
    P(/v[æa]r opm[æa]rksom|ingen s[æa]rlige|normale forholdsregler/i, 1),
  ],
  de: [
    P(/wird gewarnt|reisewarnung/i, 4),
    // Zwitserse EDA-vormen ("Von Reisen nach X … wird abgeraten" = tegen
    // álle reizen, hun zwaarste vorm; Duitsland zelf zegt "Vor Reisen …
    // wird gewarnt", dus deze patronen raken Duitse teksten niet).
    P(/von reisen (nach|in) .{0,80}wird abgeraten/i, 4),
    P(/von touristischen reisen .{0,80}wird abgeraten|von nicht dringend(en)? reisen .{0,80}wird abgeraten/i, 3),
    P(/wird (dringend )?abgeraten/i, 3),
    P(/erh[öo]hte vorsicht|besondere vorsicht/i, 2),
  ],
  // Italië (Viaggiare Sicuri) — tekstueel, geen vaste niveaus. "sconsigliati
  // a qualsiasi titolo" (4) bevat "sconsigliati" (3): de ontdubbeling
  // (langste match op dezelfde positie wint) lost die overlap op.
  // "sconsigliat…" alleen in reis-context: Italiaanse schede ontraden ook
  // activiteiten ("sconsigliato le salite in vetta") — dat is geen
  // reisadvies. Beide woordvolgordes ("i viaggi … sono sconsigliati" én
  // "si sconsigliano i viaggi") gedekt; de 4-variant begint op dezelfde
  // positie en is langer, zodat de langste-match-ontdubbeling hem laat winnen.
  it: [
    P(/(?:viaggi|spostamenti)[^.]{0,80}sconsigli\w+ a qualsiasi titolo|sconsigli\w+ a qualsiasi titolo|evacuare il paese/i, 4),
    P(/(?:viaggi|spostamenti)[^.]{0,80}sconsigli\w+|sconsigli\w+[^.]{0,40}(?:viaggi|spostamenti|recarsi)|si sconsiglia(?:no)? di (?:recarsi|viaggiare)/i, 3),
    P(/particolare cautela|elevata cautela|massima prudenza|particolare prudenza|particolare attenzione/i, 2),
    P(/normali misure di prudenza|normali precauzioni/i, 1),
  ],
  // Finland (um.fi) — vier vaste niveaus (Turvallisuustaso), met zowel de
  // korte formulering als het "kehotetaan välttämään"-proza.
  fi: [
    P(/v[äa]lt[äa] kaikkea matkust(usta|amista)|kaikkea matkustamista .{0,30}kehotetaan v[äa]ltt[äa]m[äa][äa]n/i, 4),
    P(/v[äa]lt[äa] (kaikkea )?tarpeetonta matkust(usta|amista)|tarpeetonta matkustamista .{0,30}kehotetaan v[äa]ltt[äa]m[äa][äa]n/i, 3),
    P(/noudata erityist[äa] varovaisuutta|erityist[äa] varovaisuutta/i, 2),
    P(/noudata tavanomaista varovaisuutta|tavanomaista varovaisuutta/i, 1),
  ],
  // Noorwegen (regjeringen.no) — twee vaste reisadvarsel-vormen. De
  // 3-variant ("… som ikke er strengt nødvendige") bevat de 4-frase
  // ("fraråder alle reiser"); langste-match-ontdubbeling lost dat op.
  no: [
    P(/frar[åa]der (alle )?reiser som ikke er strengt n[øo]dvendige/i, 3),
    P(/frar[åa]der alle reiser/i, 4),
    P(/frar[åa]der reiser til/i, 3),
    P(/utvis (s[æa]rlig )?aktsomhet/i, 2),
  ],
  // Zuid-Korea (0404.go.kr) — vier vaste stappen (여행경보) plus de
  // 특별여행주의보 (speciale waarschuwing, tussen stap 2 en 3 — genormaliseerd
  // naar 3, conform hoe aggregatoren die duiden).
  ko: [
    P(/여행금지/, 4),
    P(/출국권고|철수권고/, 3),
    P(/특별여행주의보/, 3),
    P(/여행자제/, 2),
    P(/여행유의/, 1),
  ],
  // Japan (MOFA) — vier vaste niveaus, zowel met als zonder "レベルN"-prefix.
  // Let op de volgorde/overlap: レベル2 ("不要不急の渡航は止めてください")
  // bevat de レベル3-frase ("渡航は止めてください"); de ontdubbeling in
  // allSeverityMatches (vroegste + langste match wint) vangt dat op zolang
  // het レベル2-patroon de volledige frase inclusief 不要不急の matcht.
  ja: [
    P(/レベル[４4]|退避してください|退避勧告/, 4),
    P(/不要不急の渡航は止めて|レベル[２2]/, 2),
    P(/レベル[３3]|渡航中止勧告|渡航は止めてください/, 3),
    P(/レベル[１1]|十分(に)?注意してください/, 1),
  ],
};

export function severityPatterns(lang) {
  return PATTERNS[lang] || PATTERNS.en;
}

/**
 * Alle ernst-matches in een tekst, in documentvolgorde. Overlappende matches
 * op dezelfde plek worden ontdubbeld (langste — meest specifieke — wint).
 */
export function allSeverityMatches(text, lang = 'en') {
  const t = String(text || '');
  const found = [];
  for (const p of severityPatterns(lang)) {
    const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g');
    let m;
    while ((m = re.exec(t))) {
      found.push({ level: p.level, phrase: m[0], index: m.index, length: m[0].length });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  found.sort((a, b) => a.index - b.index || b.length - a.length);
  const out = [];
  for (const f of found) {
    const last = out[out.length - 1];
    if (last && f.index < last.index + last.length) continue;
    out.push(f);
  }
  return out;
}

/** Eerste (meest prominente) ernst-formulering in een zin of tekst, of null. */
export function findSeverity(text, lang = 'en') {
  const all = allSeverityMatches(text, lang);
  return all.length ? all[0] : null;
}

/** Niveau → canoniek label + kleur, voor bronnen zonder eigen label. */
export function severityLabel(level) {
  return SEVERITY_LABELS[level] || null;
}

export { levelToColor };
