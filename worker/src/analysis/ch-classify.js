/**
 * Zwitserland (EDA) — kleurwaardering uit de standaardformules van de
 * crisis-portal Reisehinweise (eda.admin.ch/crisis). Het EDA hanteert vaste
 * bewoordingen die één-op-één op onze schaal 1–4 passen:
 *
 *   1 groen  — "… kann grundsätzlich als sicher gelten"
 *   2 geel   — "Der persönlichen Sicherheit ist (erhöhte/grosse) Aufmerksamkeit
 *              zu schenken"
 *   3 oranje — "Von nicht dringend notwendigen Reisen … wird abgeraten"
 *   4 rood   — "Von Reisen (nach X / in dieses Land) … wird abgeraten"
 *
 * De pagina zet per land eerst een "Grundsätzliche Einschätzung" (het
 * landelijke oordeel) en daarna regionale paragrafen. We bepalen het
 * LANDELIJKE niveau uitsluitend uit de Grundsätzliche-Einschätzung-tekst
 * (zodat een zware regiozone het landniveau niet opkrikt) en het REGIONALE
 * maximum uit de volledige tekst (regionale "wird abgeraten"-zones).
 */
import { levelToColor } from '../lib/levels.js';
import { SEVERITY_LABELS } from './severity-detector.js';

const norm = (s) => (s || '').replace(/\s+/g, ' ').toLowerCase();

/**
 * Landelijk niveau uit de "Grundsätzliche Einschätzung"-tekst. Het EDA zet
 * het landelijke oordeel altijd in de EERSTE zin ("Von Reisen … wird
 * abgeraten", "… gelten grundsätzlich als sicher", …); regionale nuances
 * komen in latere zinnen. Daarom classificeren we de eerste zin — zo maakt
 * het niet uit of het land "nach X", "in dieses Land" of "in die Ukraine/den
 * Irak" (lidwoord-landen) heet, en tilt een rode regiozone het landniveau
 * niet op.
 */
export function classifyChNational(grundText) {
  const t = norm(grundText);
  if (!t) return null;
  const first = t.split(/\.\s/)[0] || t; // eerste zin = het landelijke oordeel
  // "nicht dringend notwendige / touristische Reisen … wird abgeraten" (3) vóór
  // de ongekwalificeerde "wird abgeraten" (4).
  if (/(?:nicht dringend notwendige[nr]?|touristische[nr]?) reisen[^.]{0,90}wird abgeraten/.test(first)) return 3;
  if (/wird abgeraten/.test(first)) return 4;
  if (/aufmerksamkeit zu schenken|erh[öo]hte vorsicht|besondere vorsicht/.test(first)) return 2;
  if (/grunds[äa]tzlich als sicher/.test(first)) return 1;
  // Vangnet: begint de Einschätzung met specifieke tips i.p.v. de kopformule
  // (bijv. Egypte), zoek dan de MILDE formules in de hele tekst. Dit kan nooit
  // over-escaleren (alleen groen/geel toevoegen), dus een zwaar "abgeraten"
  // wordt hier bewust NIET aangevuld — dat zou een land ten onrechte kunnen
  // verlagen.
  if (/aufmerksamkeit zu schenken|erh[öo]hte vorsicht|besondere vorsicht/.test(t)) return 2;
  if (/grunds[äa]tzlich als sicher/.test(t)) return 1;
  return null;
}

/** Regionaal maximum uit de volledige landtekst (nooit lager dan landelijk). */
export function classifyChRegionalMax(fullText, national) {
  const t = norm(fullText);
  let reg = national || 1;
  // Regionale "von Reisen … wird abgeraten" (do-not-travel-zone) → 4.
  if (reg < 4 && /von reisen in (?:die|das|den|folgende|bestimmte|einzelne)[^.]{0,90}wird abgeraten/.test(t)) reg = 4;
  // Regionale "nicht dringend notwendige Reisen … wird abgeraten" → 3.
  else if (reg < 3 && /(?:nicht dringend notwendige[nr]?|touristische[nr]?) reisen in[^.]{0,90}wird abgeraten/.test(t)) reg = 3;
  return reg;
}

/**
 * @returns {null | {level, color, levelLabel, regionalMaxLevel, regionalColor,
 *   hasRegionalWarnings}}
 */
export function assessChAdvisory(grundText, fullText) {
  const level = classifyChNational(grundText);
  if (level == null) return null;
  const regionalMaxLevel = classifyChRegionalMax(fullText || grundText, level);
  return {
    level,
    color: levelToColor(level),
    levelLabel: SEVERITY_LABELS[level] || null,
    regionalMaxLevel,
    regionalColor: levelToColor(regionalMaxLevel),
    hasRegionalWarnings: regionalMaxLevel > level,
  };
}
