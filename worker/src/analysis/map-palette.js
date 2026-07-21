/**
 * Kaart-kleurwaardering — leidt een niveau/kleur af uit de kleurverdeling van
 * een officiële zonekaart (France Diplomatie "fcv", FCDO-kaart, e.d.).
 *
 * Veel bronnen publiceren per land een kaart met gekleurde zones. De kleur-
 * conventie is overal gelijk aan de onze:
 *
 *   wit / geen kleur = normale waakzaamheid   → niveau 1 (groen)
 *   geel             = verhoogde waakzaamheid  → niveau 2 (geel)
 *   oranje           = alleen noodzakelijke reizen → niveau 3 (oranje)
 *   rood             = niet reizen             → niveau 4 (rood)
 *
 * De pixels worden elders (in de sampler) op tint geclassificeerd; hier komt
 * alleen de tel-uitslag binnen. Zee (blauw) en kader/tekst/grenzen
 * (grijs/zwart) tellen niet mee als "land".
 *
 * Twee uitkomsten, passend op ons datamodel (landelijk niveau wordt NOOIT
 * opgekrikt door een regionale zone):
 *   - landelijke basislijn: het niveau dat het gros van het land beslaat;
 *   - regionaal maximum: de zwaarste zone die noemenswaardig voorkomt.
 *
 * Randgevoeligheid: bij "dunne" landen met veel witte marge rondom telt die
 * marge als wit. Daarom bepalen we de basislijn cumulatief van zwaar→licht
 * (≥50%): witte marge kan het niveau alleen omláág trekken, nooit ten onrechte
 * omhoog — conform ons "nationaal niveau nooit escaleren"-principe.
 */
import { levelToColor } from '../lib/levels.js';
import { SEVERITY_LABELS } from './severity-detector.js';

export const ZONE_THRESHOLD = 0.015;   // min. land-aandeel om een zone mee te tellen
export const BASELINE_MAJORITY = 0.5;  // cumulatief (zwaar→licht) ≥ dit → basislijn
export const MIN_LAND_PIXELS = 4000;   // minder land-pixels → te onbetrouwbaar

/**
 * @param {{rood:number,oranje:number,geel:number,groen?:number,wit:number,blauw?:number,grijs?:number}} counts
 *        Pixel-tellingen per tint-klasse (bemonsterd, dus niet de volle resolutie).
 * @param {{zoneThreshold?:number, baselineMajority?:number, minLandPixels?:number}} [opts]
 * @returns {null | {baselineLevel:number, regionalMaxLevel:number, color:string,
 *   regionalColor:string, levelLabel:string|null, hasRegionalWarnings:boolean,
 *   landPixels:number, shares:{rood:number,oranje:number,geel:number,wit:number}}}
 */
export function deriveMapAssessment(counts, opts = {}) {
  const c = { rood: 0, oranje: 0, geel: 0, groen: 0, wit: 0, blauw: 0, grijs: 0, ...counts };
  const wit = c.wit + c.groen; // groen komt op deze kaarten zelden voor; telt als normaal
  const land = c.rood + c.oranje + c.geel + wit;
  if (land < (opts.minLandPixels ?? MIN_LAND_PIXELS)) return null;

  const sh = { rood: c.rood / land, oranje: c.oranje / land, geel: c.geel / land, wit: wit / land };

  // Regionaal maximum: zwaarste kleur met een noemenswaardig land-aandeel.
  const zT = opts.zoneThreshold ?? ZONE_THRESHOLD;
  let regionalMaxLevel = 1;
  if (sh.rood >= zT) regionalMaxLevel = 4;
  else if (sh.oranje >= zT) regionalMaxLevel = 3;
  else if (sh.geel >= zT) regionalMaxLevel = 2;

  // Landelijke basislijn: hoogste niveau L waarvoor het cumulatieve aandeel
  // van L en zwaarder ≥ meerderheid is.
  const cum4 = sh.rood;
  const cum3 = cum4 + sh.oranje;
  const cum2 = cum3 + sh.geel;
  const maj = opts.baselineMajority ?? BASELINE_MAJORITY;
  let baselineLevel = 1;
  if (cum4 >= maj) baselineLevel = 4;
  else if (cum3 >= maj) baselineLevel = 3;
  else if (cum2 >= maj) baselineLevel = 2;

  const regional = Math.max(regionalMaxLevel, baselineLevel);
  return {
    baselineLevel,
    regionalMaxLevel: regional,
    color: levelToColor(baselineLevel),
    regionalColor: levelToColor(regional),
    levelLabel: SEVERITY_LABELS[baselineLevel] || null,
    hasRegionalWarnings: regional > baselineLevel,
    landPixels: land,
    shares: sh,
  };
}
