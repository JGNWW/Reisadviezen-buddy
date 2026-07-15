/**
 * Zin-classifier — kent aan elke zin één hoofdklasse toe:
 *
 *   national-recommendation   advies dat het hele land betreft
 *   regional-recommendation   advies voor specifieke gebieden
 *   elsewhere                 "elders"/"rest van het land"-advies (dit ís de
 *                             landelijke basislijn bij regionale afwijkingen)
 *   exception                 losse uitzonderings-clausule zonder eigen advies
 *   recommendation            advies zonder herkenbare scope
 *   warning                   risicobeschrijving zonder adviesformulering
 *   summary                   samenvattende zin (alleen binnen een als
 *                             samenvatting aangemerkte sectie)
 *   header                    kop-achtig fragment
 *   other                     al het overige
 *
 * De classifier interpreteert zelf niets: ernst komt uit de ernst-detector,
 * scope uit de scope-detector. Vlaggen (isException, isElsewhere) blijven
 * naast de hoofdklasse beschikbaar — een regionale aanbeveling MET
 * uitzondering blijft een regionale aanbeveling.
 */
import { findSeverity } from './severity-detector.js';
import { detectScope } from './scope-detector.js';

const RISK_WORDS = {
  en: /terroris|kidnap|armed (conflict|group)|violent crime|civil unrest|landmines?|unexploded|piracy|banditry|insurgen|militant|shelling|drone attack/i,
  fr: /terroris|enl[eè]vement|conflit arm[ée]|criminalit[ée]|mines|piraterie|groupes? arm[ée]s?/i,
  es: /terroris|secuestro|conflicto armado|criminalidad|minas|grupos? armados?/i,
  da: /terror|kidnapning|v[æa]bnede? konflikt|kriminalitet|miner/i,
  de: /terror|entf[üu]hrung|bewaffnet|kriminalit[äa]t|minen|anschl[äa]ge/i,
  ja: /テロ|誘拐|強盗|殺人|武装|地雷|治安|襲撃|爆発/,
};

export function classifySentence(sentence, lang = 'en', opts = {}) {
  const text = String(sentence || '').trim();
  const severity = findSeverity(text, lang);
  const scope = detectScope(text, lang, opts);
  const words = text.split(/\s+/).length;

  let kind = 'other';
  // Kop-heuristiek: kort én zonder zinseinde. Japans telt zonder spaties als
  // "1 woord", dus de eindteken-check moet ook 。！？ kennen — anders zou
  // elke Japanse zin als kop worden weggefilterd.
  if (!severity && words <= 8 && !/[.!?。！？]$/.test(text)) kind = 'header';
  else if (severity && scope.isElsewhere) kind = 'elsewhere';
  else if (severity && scope.scope === 'regional') kind = 'regional-recommendation';
  else if (severity && (scope.scope === 'national' || scope.scope === 'mixed')) kind = 'national-recommendation';
  else if (severity) kind = 'recommendation';
  else if (scope.isException) kind = 'exception';
  else if ((RISK_WORDS[lang] || RISK_WORDS.en).test(text)) kind = 'warning';
  else if (opts.sectionRole === 'summary') kind = 'summary';

  return { text, kind, severity, scope };
}
