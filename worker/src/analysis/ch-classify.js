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

/** Landelijk niveau uit de "Grundsätzliche Einschätzung"-tekst. */
export function classifyChNational(grundText) {
  const t = norm(grundText);
  if (!t) return null;
  // Volgorde: eerst de "nicht dringend/touristisch"-vorm (3), anders de
  // ongekwalificeerde landelijke "wird abgeraten" (4) — zodat een 3-zin niet
  // per ongeluk als 4 telt.
  if (/(?:von )?(?:nicht dringend notwendige[nr]?|touristische[nr]?) reisen[^.]{0,90}wird abgeraten/.test(t)) return 3;
  if (/von reisen (?:nach [^.,;]{0,40}|in dieses land|in das land)[^.]{0,90}wird abgeraten/.test(t)
    || /von reisen[^.]{0,10}(?:und von aufenthalten|jeder art)[^.]{0,50}wird abgeraten/.test(t)) return 4;
  if (/aufmerksamkeit zu schenken|erh[öo]hte vorsicht|besondere vorsicht/.test(t)) return 2;
  if (/grunds[äa]tzlich als sicher/.test(t)) return 1;
  // Vangnet: staat er ergens een landelijke "wird abgeraten" zonder scope?
  if (/wird abgeraten/.test(t) && !/region|provinz|gebiet|landesteil|grenz/.test(t)) {
    return /nicht dringend|touristisch/.test(t) ? 3 : 4;
  }
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
