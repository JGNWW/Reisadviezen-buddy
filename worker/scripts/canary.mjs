/**
 * Wekelijkse live-canary: haalt per bron een paar landen op van de échte site
 * en controleert de invarianten (niveau geldig of eerlijk onzeker, voldoende
 * thema's, schone koppen). Vult de offline contracttests aan: die bewaken de
 * parseerlogica, deze bewaakt of de bron zelf nog levert.
 *
 * Twee dingen zaten hier eerder mis.
 *
 * Ten eerste dekte de canary tien van de zeventien adapters: Japan, Italië,
 * Finland, Korea, Noorwegen, Oostenrijk en Zwitserland hadden helemaal geen
 * live controle. Nu doen alle zeventien mee.
 *
 * Ten tweede stonden de testlanden vast op Nepal en Marokko. Daarmee vind je
 * per definitie geen fout bij land 137 — en dat is precies het soort fout dat
 * hier thuishoort: Nieuw-Zeeland serveerde voor "moldova-republic-of" een
 * lege pagina zonder ooit een foutcode te geven. Naast één vast ankerland
 * (Nepal, bij alle bronnen gekoppeld, zodat een echte regressie meteen
 * opvalt) rouleren er daarom twee landen mee, verschoven per dag én per bron.
 *
 * Exitcode 1 zodra een bron voor ÁLLE testlanden faalt (één misser kan een
 * netwerk-hik zijn). Bronnen die geautomatiseerd ophalen structureel weren
 * (Australië via de reader, Zwitserland en Noorwegen) tellen als
 * waarschuwing, niet als fout.
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
import * as japan from '../src/adapters/japan.js';
import * as italy from '../src/adapters/italy.js';
import * as finland from '../src/adapters/finland.js';
import * as southkorea from '../src/adapters/southkorea.js';
import * as norway from '../src/adapters/norway.js';
import * as austria from '../src/adapters/austria.js';
import * as switzerland from '../src/adapters/switzerland.js';
import countries from '../src/data/countries.json' with { type: 'json' };
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setReaderKey, setCorsProxy } from '../src/lib/fetch.js';

setReaderKey(process.env.JINA_KEY);
setCorsProxy(process.env.CORS_PROXY_URL);

const ADAPTERS = {
  uk, us, ca: canada, ie: ireland, fr: france, au: australia, es: spain, de: germany,
  nz: newzealand, dk: denmark, jp: japan, it: italy, fi: finland, kr: southkorea,
  no: norway, at: austria, ch: switzerland,
};
// Bronnen die geautomatiseerd ophalen weren: rapporteren, maar niet op falen
// laten breken. Australië kan alleen via de reader-proxy (eigen limieten),
// eda.admin.ch geeft een kale fetch 403 en leunt op de browser-capture, en
// regjeringen.no zet op élk verzoek een Cloudflare-botcheck.
const WARN_ONLY = new Set(['au', 'ch', 'no']);
// Vast ankerland: bij alle bronnen gekoppeld en stabiel, dus een echte
// regressie in de parseerlogica valt meteen op.
const ANKERLAND = 'NPL';
// … plus twee roterende landen, zodat de canary door de lijst wandelt in
// plaats van eeuwig dezelfde twee te bevragen.
const ROULEREND = 2;
const TIMEOUT_MS = 45000;
const CODE_HEADING = /querySelector|shadowRoot|innerHTML|function\s*\(|=>|[{};$]|document\.|window\./;
// Maximale kopllengte. De grens stond op 140 en dat is te krap gebleken zodra
// alle bronnen meedoen: Denemarken zet zijn gebiedsopsomming ín de kop ("Vi
// fraråder alle rejser til: Nordlige og nordøstlige delstater Adamawa, Borno,
// …", 264 tekens bij Nigeria). Dat is een echte kop, geen ingeslikte alinea.
// De code-patronen hierboven vangen het geval waar het om gaat — een kop die
// eigenlijk JavaScript of markup is — en de lengte is daar slechts een grove
// dubbelcheck bij.
const MAX_KOP = 300;

const withTimeout = (p, ms) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout na ${ms / 1000}s`)), ms)),
]);

/**
 * Invarianten per opgehaald advies. Wat hier géén fout mag zijn is net zo
 * belangrijk als wat het wél is: nu álle zeventien bronnen meedoen komen er
 * antwoordvormen langs die de oude tien niet kenden, en een canary die daarop
 * afgaat wordt binnen een maand genegeerd.
 *   • 'none' = de bron publiceert voor dit land aantoonbaar niets (Denemarken
 *     zegt letterlijk "Vi har ingen rejsevejledning", de FCDO heeft voor 145
 *     landen geen waarschuwing). Geen niveau en geen secties horen daarbij.
 *   • Japan geeft voor rustige landen niveau 1 met "危険情報なし" en nul
 *     secties. Een uitgesproken niveau ís het antwoord; het aantal secties
 *     zegt dan niets.
 */
function validate(adv) {
  if (!adv) return 'getAdvisory gaf null';
  if (adv.assessmentStatus === 'none') return null;
  const heeftNiveau = adv.level >= 1 && adv.level <= 4;
  if (!heeftNiveau && adv.assessmentStatus !== 'uncertain') return `ongeldig niveau: ${adv.level}`;
  // Zonder niveau moet er op zijn minst adviestekst staan, anders is het een
  // lege pagina die zich voordoet als een advies.
  if (!heeftNiveau && (adv.themes?.length || 0) < 3) return `geen niveau en te weinig thema's: ${adv.themes?.length || 0}`;
  const bad = (adv.themes || []).find((t) => t.heading && (t.heading.length > MAX_KOP || CODE_HEADING.test(t.heading)));
  if (bad) return `verdachte kop: ${bad.heading.slice(0, 60)}…`;
  return null;
}

/** Dagnummer sinds 1970 — verspringt één keer per etmaal, ongeacht het uur. */
const dagnummer = (d = new Date()) => Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000);

/**
 * De testlanden voor één bron: het ankerland plus `ROULEREND` landen die met
 * de dag opschuiven. De versprong per bron voorkomt dat alle zeventien
 * bronnen dezelfde landen pakken — dan zou een bronspecifieke fout alsnog
 * buiten beeld blijven.
 */
export function testLanden(isos, dag, aantal, versprong = 0, anker = null) {
  const pool = isos.filter((i) => i !== anker);
  const uit = anker && isos.includes(anker) ? [anker] : [];
  if (!pool.length) return uit;
  const n = Math.min(aantal, pool.length);
  const start = ((dag * n + versprong) % pool.length + pool.length) % pool.length;
  for (let i = 0; i < n; i++) uit.push(pool[(start + i) % pool.length]);
  return uit;
}

async function main() {
const dag = dagnummer();
let hardFailures = 0;
for (const [i, [sid, adapter]] of Object.entries(ADAPTERS).entries()) {
  const gekoppeld = Object.entries(countries).filter(([, r]) => r.sources?.[sid]).map(([iso]) => iso);
  // Versprong per bron = de eigen vensterbreedte: bron 0 pakt landen 0-1,
  // bron 1 de landen 2-3, enzovoort. Zo bevragen niet alle zeventien bronnen
  // dezelfde landen, en met vensters van 2 op lijsten van 150+ landen vallen
  // ze ook niet op elkaar terug.
  const testLijst = testLanden(gekoppeld, dag, ROULEREND, i * ROULEREND, ANKERLAND);
  const results = [];
  for (const iso of testLijst) {
    const rec = countries[iso];
    const id = rec?.sources?.[sid];
    if (!id) { results.push(`${iso}: geen koppeling`); continue; }
    try {
      const adv = await withTimeout(adapter.getAdvisory(id, { iso, en: rec.en, nl: rec.nl }), TIMEOUT_MS);
      const problem = validate(adv);
      results.push(problem ? `${iso}: ${problem}` : null);
    } catch (e) {
      // Noorwegen rapporteert per laag waarom het misging; dat is nuttig in het
      // logboek van de adapter, maar hier maakt het de canary-uitvoer
      // onleesbaar. Eerste zin volstaat.
      results.push(`${iso}: ${String(e.message).split(' (')[0].slice(0, 120)}`);
    }
  }
  const problems = results.filter(Boolean);
  const allFailed = testLijst.length > 0 && problems.length === testLijst.length;
  const mark = problems.length === 0 ? '✅' : allFailed ? (WARN_ONLY.has(sid) ? '⚠️ (weert ophalen)' : '❌') : '⚠️';
  console.log(`${mark} ${sid} [${testLijst.join(',')}]: ${problems.length ? problems.join(' | ') : 'ok'}`);
  if (allFailed && !WARN_ONLY.has(sid)) hardFailures++;
}

if (hardFailures) {
  console.error(`\n${hardFailures} bron(nen) falen volledig op live data.`);
  process.exit(1);
}
console.log('\nCanary geslaagd.');
}

// Alleen draaien als dit script zélf wordt aangeroepen; de tests importeren
// testLanden hieruit en moeten niet de hele live-canary meestarten.
const rechtstreeks = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (rechtstreeks) await main();
