// Handmatige integratietest: draait elke adapter tegen een echt land.
// Gebruik: node worker/test-adapters.mjs [ISO3]
import { readFileSync } from 'node:fs';
import * as uk from './src/adapters/uk.js';
import * as us from './src/adapters/us.js';
import * as canada from './src/adapters/canada.js';
import * as ireland from './src/adapters/ireland.js';

const countries = JSON.parse(readFileSync(new URL('../server/data/countries.json', import.meta.url)));
const iso = (process.argv[2] || 'ETH').toUpperCase();
const rec = countries[iso];
console.log(`Land: ${rec.nl} (${iso}) — bronnen:`, JSON.stringify(rec.sources));

const adapters = [
  ['uk', uk, rec.sources.uk],
  ['us', us, rec.sources.us],
  ['ca', canada, rec.sources.ca],
  ['ie', ireland, rec.sources.ie],
];

for (const [name, mod, id] of adapters) {
  if (!id) { console.log(`\n[${name}] geen koppeling`); continue; }
  try {
    const t0 = Date.now();
    const a = await mod.getAdvisory(id);
    const ms = Date.now() - t0;
    if (!a) { console.log(`\n[${name}] null (${ms}ms)`); continue; }
    console.log(`\n[${name}] ${a.sourceLabel} (${ms}ms)`);
    console.log(`  niveau=${a.level} kleur=${a.color} label="${a.levelLabel || ''}"`);
    console.log(`  themes=${a.themes.length}  hasMap=${a.hasMap} mapUrl=${a.mapUrl || (mod.resolveMapUrl ? '(via resolve)' : '-')}`);
    console.log('  koppen:', a.themes.slice(0, 8).map((t) => `${t.heading}→${t.themeId || '?'}`).join(' | '));
    if (mod.resolveMapUrl && !a.mapUrl) {
      const mu = await mod.resolveMapUrl(id).catch((e) => 'ERR:' + e.message);
      console.log('  resolveMapUrl:', mu);
    }
  } catch (e) {
    console.log(`\n[${name}] FOUT: ${e.message}`);
  }
}
