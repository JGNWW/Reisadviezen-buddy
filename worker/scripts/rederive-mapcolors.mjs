/**
 * Her-leidt de kaart-kleurwaardering (worker/data/mapcolors/*.json) opnieuw af
 * uit de reeds bemonsterde pixel-shares, met de HUIDIGE deriveMapAssessment.
 *
 * Nut: na een wijziging in de afleidregels (map-palette.js) hoeven we niet te
 * wachten op een volledige her-bemonstering (Playwright + ~175 kaarten
 * downloaden) om de bestaande data te corrigeren — de shares liggen al vast.
 * De map-colors CI ververst later alsnog met verse samples; dit geeft direct
 * de juiste uitkomst.
 *
 * Draaien: cd worker && node scripts/rederive-mapcolors.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { deriveMapAssessment } from '../src/analysis/map-palette.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', 'data', 'mapcolors');

let changed = 0;
const flips = [];
for (const f of readdirSync(DIR)) {
  if (!f.endsWith('.json')) continue;
  const file = path.join(DIR, f);
  const d = JSON.parse(readFileSync(file, 'utf8'));
  let fileChanged = false;
  for (const [sid, mc] of Object.entries(d.sources || {})) {
    if (!mc?.shares || !mc.landPixels) continue;
    // Alleen bronnen wier basislijn de Worker ook echt gebruikt (trustBaseline)
    // herschrijven — voor de overige bronnen telt enkel regionalMax, en die
    // verandert niet door de uniform-kleur-regel. Zo blijft de diff klein en
    // beperkt tot wat de uitkomst raakt; de map-colors CI ververst de rest.
    if (!mc.trustBaseline) continue;
    // Tel-benadering terug uit de (genormaliseerde) shares × landPixels.
    const counts = {
      rood: mc.shares.rood * mc.landPixels,
      oranje: mc.shares.oranje * mc.landPixels,
      geel: mc.shares.geel * mc.landPixels,
      wit: mc.shares.wit * mc.landPixels,
    };
    const a = deriveMapAssessment(counts);
    if (!a) continue;
    const before = mc.baselineLevel;
    if (a.baselineLevel === before && a.regionalMaxLevel === mc.regionalMaxLevel) continue;
    fileChanged = true;
    if (a.baselineLevel !== before) flips.push(`${d.iso3}/${sid}: basislijn ${before} → ${a.baselineLevel} (${a.color})`);
    mc.baselineLevel = a.baselineLevel;
    mc.regionalMaxLevel = a.regionalMaxLevel;
    mc.color = a.color;
    mc.regionalColor = a.regionalColor;
    mc.levelLabel = a.levelLabel;
    mc.hasRegionalWarnings = a.hasRegionalWarnings;
  }
  if (fileChanged) { writeFileSync(file, JSON.stringify(d)); changed++; }
}

console.log(`rederive-mapcolors: ${changed} bestand(en) bijgewerkt, ${flips.length} basislijn-wijziging(en).`);
for (const l of flips.sort()) console.log('  ' + l);
