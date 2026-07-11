/**
 * Wekelijkse live-canary: haalt per bron twee vaste landen op van de échte
 * site en controleert de invarianten (niveau geldig of eerlijk onzeker,
 * voldoende thema's, schone koppen). Vult de offline contracttests aan:
 * die bewaken de parseerlogica, deze bewaakt of de bron zelf nog levert.
 *
 * Exitcode 1 zodra een bron voor BEIDE testlanden faalt (één misser kan een
 * netwerk-hik zijn). De reader-bron Australië telt als waarschuwing, niet
 * als fout — de publieke reader-proxy heeft eigen limieten.
 *
 * Draaien: cd worker && node scripts/canary.mjs
 */
import * as uk from '../src/adapters/uk.js';
import * as us from '../src/adapters/us.js';
import * as canada from '../src/adapters/canada.js';
import * as ireland from '../src/adapters/ireland.js';
import * as france from '../src/adapters/france.js';
import * as australia from '../src/adapters/australia.js';
import * as spain from '../src/adapters/spain.js';
import * as germany from '../src/adapters/germany.js';
import * as newzealand from '../src/adapters/newzealand.js';
import * as denmark from '../src/adapters/denmark.js';
import countries from '../src/data/countries.json' with { type: 'json' };
import { setReaderKey, setCorsProxy } from '../src/lib/fetch.js';

setReaderKey(process.env.JINA_KEY);
setCorsProxy(process.env.CORS_PROXY_URL);

const ADAPTERS = { uk, us, ca: canada, ie: ireland, fr: france, au: australia, es: spain, de: germany, nz: newzealand, dk: denmark };
// Reader-gebaseerde bronnen: rapporteren maar niet op falen laten breken.
const WARN_ONLY = new Set(['au']);
const TEST_COUNTRIES = ['NPL', 'MAR']; // stabiel én bij alle bronnen gekoppeld
const TIMEOUT_MS = 45000;
const CODE_HEADING = /querySelector|shadowRoot|innerHTML|function\s*\(|=>|[{};$]|document\.|window\./;

const withTimeout = (p, ms) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout na ${ms / 1000}s`)), ms)),
]);

function validate(adv) {
  if (!adv) return 'getAdvisory gaf null';
  if (adv.assessmentStatus !== 'uncertain') {
    if (!(adv.level >= 1 && adv.level <= 4)) return `ongeldig niveau: ${adv.level}`;
  }
  if (!adv.themes || adv.themes.length < 3) return `te weinig thema's: ${adv.themes?.length || 0}`;
  const bad = adv.themes.find((t) => t.heading.length > 140 || CODE_HEADING.test(t.heading));
  if (bad) return `verdachte kop: ${bad.heading.slice(0, 60)}…`;
  return null;
}

let hardFailures = 0;
for (const [sid, adapter] of Object.entries(ADAPTERS)) {
  const results = [];
  for (const iso of TEST_COUNTRIES) {
    const id = countries[iso]?.sources?.[sid];
    if (!id) { results.push(`${iso}: geen koppeling`); continue; }
    try {
      const adv = await withTimeout(adapter.getAdvisory(id), TIMEOUT_MS);
      const problem = validate(adv);
      results.push(problem ? `${iso}: ${problem}` : null);
    } catch (e) {
      results.push(`${iso}: ${e.message}`);
    }
  }
  const problems = results.filter(Boolean);
  const allFailed = problems.length === TEST_COUNTRIES.length;
  const mark = problems.length === 0 ? '✅' : allFailed ? (WARN_ONLY.has(sid) ? '⚠️ (reader)' : '❌') : '⚠️';
  console.log(`${mark} ${sid}: ${problems.length ? problems.join(' | ') : 'ok'}`);
  if (allFailed && !WARN_ONLY.has(sid)) hardFailures++;
}

if (hardFailures) {
  console.error(`\n${hardFailures} bron(nen) falen volledig op live data.`);
  process.exit(1);
}
console.log('\nCanary geslaagd.');
