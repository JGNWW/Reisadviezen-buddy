/**
 * Mapping-bewaking: valideert de land→bron-koppelingen, zodat hernoemingen
 * (gov.uk: czech-republic → czechia, swaziland → eswatini) en verkeerde namen
 * niet maandenlang stil falen.
 *
 * Twee sporen, want geen enkele bron laat zich met één truc controleren.
 *
 * SPOOR 1 — indexcontrole (goedkoop: één call per bron, dekt álle landen).
 * Werkt zodra een bron zelf een volledige landenlijst publiceert:
 *   VK          gov.uk content-API (slugs)
 *   Duitsland   Auswärtiges Amt open data (ISO3)
 *   Canada      data.international.gc.ca (ISO2)
 *   Ierland     A-Z-pagina (slugs)
 *   Spanje      Recomendaciones-de-viaje (Spaanse landnamen)
 *   Denemarken  rejsevejledninger-keuzelijst (slugs)
 *   Italië      lista_nazioni.json (ISO3)
 *   Finland     matkustustiedotteet-index (ISO2)
 *   Nieuw-Zeeland  safetravel-sitemap (slugs)
 * Voor kapotte slugs wordt de dichtstbijzijnde geldige gesuggereerd
 * (bigram-overeenkomst) — vaak direct de juiste override.
 *
 * SPOOR 2 — inhoudssteekproef (duur: één ophaling per land, dus roterend).
 * Een index vangt niet alles. Exteriores.gob.es antwoordt op een onbekende
 * landnaam met HTTP 200 en een stubpagina in plaats van 404, en de VS,
 * Frankrijk, Australië, Nieuw-Zeeland, Japan, Korea, Noorwegen, Oostenrijk en
 * Zwitserland publiceren helemaal geen bruikbare index. Daarom haalt spoor 2
 * per bron een handvol landen écht op en kijkt of er een advies uit komt.
 * De steekproef schuift elke dag op, zodat elke koppeling vanzelf een keer
 * aan de beurt komt in plaats van dat dezelfde twee landen eeuwig getest
 * worden.
 *
 * Schrijft worker/data/mapping-health.json; exitcode is altijd 0 (de
 * workflow beslist over issue/alarm op basis van de JSON).
 *
 * Draaien: cd worker && node scripts/verify-mappings.mjs
 *          STEEKPROEF=0 om spoor 2 over te slaan (alleen de goedkope index).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import countries from '../src/data/countries.json' with { type: 'json' };
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
import { setReaderKey, setCorsProxy } from '../src/lib/fetch.js';

setReaderKey(process.env.JINA_KEY);
setCorsProxy(process.env.CORS_PROXY_URL);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'data', 'mapping-health.json');

const UK_INDEX = 'https://www.gov.uk/api/content/foreign-travel-advice';
const DE_INDEX = 'https://www.auswaertiges-amt.de/opendata/travelwarning';
const CA_INDEX = 'https://data.international.gc.ca/travel-voyage/index-alpha-eng.json';
const IE_AZ = 'https://www.ireland.ie/en/dfa/overseas-travel/advice/';
const ES_INDEX = 'https://www.exteriores.gob.es/es/ServiciosAlCiudadano/Paginas/Recomendaciones-de-viaje.aspx';
const DK_INDEX = 'https://um.dk/rejse-og-ophold/rejse-til-udlandet/rejsevejledninger';
const IT_INDEX = 'https://www.viaggiaresicuri.it/schede_paese/lista_nazioni.json';
const FI_INDEX = 'https://um.fi/matkustustiedotteet';
// SafeTravel geeft op /destinations een 503 aan datacenter-IP's, maar de
// sitemap is gewoon leesbaar en bevat alle landpagina's.
const NZ_SITEMAP = 'https://www.safetravel.govt.nz/sitemap.xml';
const UA = 'Mozilla/5.0 (compatible; ReisadviezenBuddy/1.0)';

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

/** Dice-coëfficiënt op bigrammen, voor slug-suggesties. */
function dice(a, b) {
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const ga = grams(a), gb = grams(b);
  let ov = 0;
  for (const [g, n] of ga) ov += Math.min(n, gb.get(g) || 0);
  return (2 * ov) / (a.length - 1 + b.length - 1);
}
const normalise = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Beste vervangende slug: match op de oude slug ÉN op de Engelse landnaam.
 * Dat laatste vangt hernoemingen waar de nieuwe naam totaal anders is
 * (czech-republic → czechia matcht via de landnaam "Czechia" perfect).
 */
function suggest(slug, enName, validSet) {
  const keys = [String(slug).toLowerCase(), normalise(enName)].filter((k) => k.length >= 2);
  let best = null, score = 0.55;
  for (const cand of validSet) {
    const s = Math.max(...keys.map((k) => dice(k, cand)));
    if (s > score) { best = cand; score = s; }
  }
  // Score gaat mee in het rapport: de auto-fix pakt alleen hoge zekerheid op.
  return best ? { slug: best, score: Math.round(score * 100) / 100 } : null;
}

/**
 * Welk land past het best bij deze slug? Gebruikt voor de wederzijdse toets
 * hierboven: past de slug beter bij een ánder land, dan is het geen gat maar
 * een verwarring.
 */
function besteKandidaat(slug) {
  let best = null, score = 0;
  for (const [iso3, rec] of Object.entries(countries)) {
    const s = dice(normalise(rec.en), String(slug).toLowerCase());
    if (s > score) { score = s; best = iso3; }
  }
  return best;
}

/**
 * @param {(v:string)=>string} [sleutel] Normalisatie vóór het vergelijken.
 *   Spanje koppelt op de landnaam zelf ("Arabia Saudí"), en die staat in de
 *   index met plus-tekens, hoofdletters en soms een spatie erachter
 *   ("Bahamas "). Vergelijken op een platte sleutel voorkomt vals alarm;
 *   de suggestie is altijd de exacte vorm van de bron.
 */
async function checkAgainstSet(sid, extract, validSet, sleutel = (v) => String(v)) {
  const broken = [];
  const ontbrekend = [];
  let checked = 0;
  const gebruikt = new Set();
  // Platte sleutel -> exacte vorm zoals de bron hem schrijft.
  const opSleutel = new Map([...validSet].map((v) => [sleutel(v), v]));
  for (const [iso3, rec] of Object.entries(countries)) {
    const id = extract(rec);
    if (!id) {
      // Geen koppeling. Dat is vaak terecht (ireland.ie heeft geen pagina voor
      // Aruba), maar niet altijd: Israël stond bij Ierland op null terwijl de
      // pagina gewoon bestond, en Tsjechië, de Filipijnen en Iran ook. Zulke
      // gaten vallen niet op — de bron ontbreekt dan gewoon in de vergelijking.
      // Daarom hier de omgekeerde vraag: heeft de bron dit land wél?
      const gok = suggest('', rec.en, validSet);
      // Wederzijdse toets. Een eenzijdige gelijkenis is hier levensgevaarlijk:
      // Gambia lijkt op "zambia" en de Amerikaanse Maagdeneilanden op
      // "virgin-islands-uk". Zo'n suggestie overnemen levert het reisadvies van
      // een ánder land op, en dat valt niet op — er staat gewoon een advies.
      // Daarom telt een voorstel alleen als dit land óók de beste kandidaat is
      // vóór die slug, van alle 226.
      if (gok && gok.score >= 0.85 && besteKandidaat(gok.slug) === iso3) {
        ontbrekend.push({ iso3, land: rec.nl, en: rec.en, suggestie: gok.slug, score: gok.score, bron: sid });
      }
      continue;
    }
    checked++;
    const exact = opSleutel.get(sleutel(id));
    gebruikt.add(exact ?? id);
    if (!exact) {
      const s = suggest(id, rec.en, validSet);
      broken.push({ iso3, land: rec.nl, en: rec.en, id, suggestie: s?.slug || null, score: s?.score || null, bron: sid });
    }
  }
  // Wat de bron aanbiedt en door niemand gebruikt wordt. Puur informatief: het
  // gaat vaak om regio's en samenvoegingen die wij niet als land kennen.
  const ongebruikt = [...validSet].filter((v) => !gebruikt.has(v));
  return { checked, broken, ontbrekend, ongebruiktAantal: ongebruikt.length, ongebruikt: ongebruikt.slice(0, 40) };
}

const ADAPTERS = {
  uk, us, ca: canada, ie: ireland, fr: france, au: australia, es: spain, de: germany,
  nz: newzealand, dk: denmark, jp: japan, it: italy, fi: finland, kr: southkorea,
  no: norway, at: austria, ch: switzerland,
};

/** Platte vergelijkingssleutel: kleine letters, zonder diakrieten en leestekens. */
const plat = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '');

// Hoeveel landen per bron per run écht opgehaald worden. 6 × 17 = ruim honderd
// ophalingen; genoeg om binnen een maand elke koppeling een keer te raken
// (de traagste bron heeft ~220 landen, dus ~37 runs), zonder een bron te
// overvragen.
const STEEKPROEF_PER_BRON = 6;
const STEEKPROEF_TIMEOUT_MS = 45000;
// Bronnen die een geautomatiseerde ophaling structureel blokkeren. Die falen
// hier per definitie; ze meedoen zou het rapport permanent rood maken en de
// echte signalen verdrinken. Ze worden wél gerapporteerd, als 'geblokkeerd'.
const GEBLOKKEERD = new Set(['no']);

const metTimeout = (p, ms) => Promise.race([
  p,
  new Promise((_, af) => setTimeout(() => af(new Error(`timeout na ${ms / 1000}s`)), ms)),
]);

/**
 * Welke landen zijn deze run aan de beurt? Deterministisch op de dag, en per
 * bron met een eigen versprong, zodat niet elke bron dezelfde landen pakt.
 * Zo wandelt de steekproef door de hele lijst in plaats van eeuwig op
 * dezelfde twee landen te blijven hangen — precies het gat waardoor een fout
 * bij land 137 nooit gevonden werd.
 */
export function kiesSteekproef(isos, dagnummer, aantal, versprong = 0) {
  if (!isos.length) return [];
  const n = Math.min(aantal, isos.length);
  const start = ((dagnummer * n + versprong) % isos.length + isos.length) % isos.length;
  return Array.from({ length: n }, (_, i) => isos[(start + i) % isos.length]);
}

/** Dagnummer sinds 1970 — verspringt één keer per etmaal, ongeacht tijdzone-uur. */
const dagnummer = (d = new Date()) => Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000);

// Minimale tekstomvang van een echte adviespagina. De Spaanse stubpagina komt
// met ~1500 tekens ruis binnen; een echt advies zit ruim daarboven.
const MIN_ADVIESTEKST = 400;

/**
 * Beoordeelt één opgehaald advies.
 *
 * Waar het om gaat: een stubpagina komt als HTTP 200 binnen en ziet er voor
 * elke statuscontrole gezond uit. Alleen de inhoud verraadt hem.
 *
 * Even belangrijk is wat hier GEEN fout is, want een rapport dat vals alarm
 * slaat wordt niet meer gelezen:
 *   • een uitgesproken oordeel is een geldig antwoord, ook zonder secties —
 *     Japan geeft voor rustige landen niveau 1 met "危険情報なし" en nul
 *     secties, Denemarken zegt met zoveel woorden "geen reisadvies";
 *   • "eerlijk onzeker" mét adviestekst is een oordeelskwestie, geen
 *     koppelingsfout.
 *
 * @returns {null|string} null = in orde, anders de reden.
 */
export function beoordeelOphaling(adv) {
  if (!adv) return 'geen advies teruggegeven';
  if (adv.assessmentStatus === 'none') return null;
  if (adv.level != null) return null;
  const themas = adv.themes?.length || 0;
  const tekens = (adv.themes || []).reduce((n, t) => n + (t?.text?.length || 0), 0);
  if (themas === 0) return "pagina zonder niveau en zonder inhoud (0 thema's) — mogelijk een stubpagina";
  if (tekens < MIN_ADVIESTEKST) return `pagina zonder niveau en nauwelijks tekst (${tekens} tekens) — mogelijk een stubpagina`;
  return null;
}

// Transportfouten. Die zeggen iets over het netwerk of over botbeleid, niet
// over de koppeling — apart houden, anders verdrinkt een echte vondst in de
// 503'jes van een drukke runner.
const ONBEREIKBAAR = /\b(4\d\d|5\d\d)\b|timeout|botcheck|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i;

/** Leesbare vorm van een koppeling; Australië en Canada koppelen met een object. */
export function toonId(id) {
  if (id && typeof id === 'object') return Object.values(id).filter((v) => v != null).join('/');
  return String(id);
}

/** Spoor 2: haalt per bron een roterend handjevol landen echt op. */
async function steekproef() {
  const dag = dagnummer();
  const uit = { dag, perBron: {}, verdacht: [], onbereikbaar: [] };
  const bronnen = Object.keys(ADAPTERS);
  for (const [i, sid] of bronnen.entries()) {
    const isos = Object.entries(countries).filter(([, r]) => r.sources?.[sid]).map(([iso]) => iso);
    const gekozen = kiesSteekproef(isos, dag, STEEKPROEF_PER_BRON, i * 7);
    const rij = { gekoppeld: isos.length, getest: gekozen.length, ok: 0, verdacht: 0, onbereikbaar: 0, geblokkeerd: GEBLOKKEERD.has(sid) };
    for (const iso of gekozen) {
      const rec = countries[iso];
      let reden = null;
      let transport = false;
      try {
        const adv = await metTimeout(
          ADAPTERS[sid].getAdvisory(rec.sources[sid], { iso, en: rec.en, nl: rec.nl }),
          STEEKPROEF_TIMEOUT_MS,
        );
        reden = beoordeelOphaling(adv);
      } catch (e) {
        reden = String(e?.message || e).slice(0, 160);
        transport = ONBEREIKBAAR.test(reden);
      }
      if (!reden) { rij.ok++; continue; }
      const post = { bron: sid, iso3: iso, land: rec.nl, id: toonId(rec.sources[sid]), reden, geblokkeerd: rij.geblokkeerd };
      if (transport) { rij.onbereikbaar++; uit.onbereikbaar.push(post); }
      else { rij.verdacht++; uit.verdacht.push(post); }
    }
    uit.perBron[sid] = rij;
  }
  return uit;
}

/**
 * Trekt de meldingen van spoor 1 na met één echte ophaling.
 *
 * Een index is niet altijd volledig: um.dk heeft voor Amerikaans-Samoa wél een
 * werkende pagina, maar zet die niet in de keuzelijst. Zo'n koppeling als
 * "kapot" melden leert de lezer het rapport te negeren, en dat is precies hoe
 * een échte melding straks over het hoofd wordt gezien. Haalt de koppeling
 * gewoon een advies op, dan blijft ze staan — met een aantekening.
 */
async function verifieerKapot(result) {
  for (const [sid, r] of Object.entries(result.sources)) {
    if (r.error || !r.broken?.length || !ADAPTERS[sid]) continue;
    const blijft = [];
    for (const b of r.broken) {
      const rec = countries[b.iso3];
      let reden = 'niet te controleren';
      let transport = false;
      // Eén herkansing: een 503 van een drukke bron is geen koppelingsfout.
      for (let poging = 0; poging < 2; poging++) {
        transport = false;
        try {
          const adv = await metTimeout(
            ADAPTERS[sid].getAdvisory(rec.sources[sid], { iso: b.iso3, en: rec.en, nl: rec.nl }),
            STEEKPROEF_TIMEOUT_MS,
          );
          reden = beoordeelOphaling(adv);
          break;
        } catch (e) {
          reden = String(e?.message || e).slice(0, 160);
          transport = ONBEREIKBAAR.test(reden);
          if (!transport) break;
        }
      }
      if (!reden) (r.buitenIndex ||= []).push({ ...b, opmerking: 'niet in de index, maar levert wel een advies' });
      else if (transport) (r.onbevestigd ||= []).push({ ...b, ophaalfout: reden });
      else blijft.push({ ...b, ophaalfout: reden });
    }
    r.broken = blijft;
  }
}

async function main() {
  const result = { generatedAt: new Date().toISOString(), sources: {} };

  // VK: alle geldige slugs uit de content-API.
  try {
    const idx = await getJson(UK_INDEX);
    const slugs = new Set((idx?.links?.children || [])
      .map((l) => (l.base_path || '').replace('/foreign-travel-advice/', ''))
      .filter(Boolean));
    result.sources.uk = await checkAgainstSet('uk', (r) => r.sources.uk, slugs);
  } catch (e) { result.sources.uk = { error: e.message }; }

  // Duitsland: alle ISO3-codes uit de open-data-index.
  try {
    const idx = await getJson(DE_INDEX);
    const iso3s = new Set(Object.values(idx?.response || {})
      .filter((v) => v && typeof v === 'object' && v.iso3CountryCode)
      .map((v) => v.iso3CountryCode.toUpperCase()));
    result.sources.de = await checkAgainstSet('de', (r) => r.sources.de, iso3s);
  } catch (e) { result.sources.de = { error: e.message }; }

  // Canada: alle ISO2-codes uit de index.
  try {
    const idx = await getJson(CA_INDEX);
    const iso2s = new Set(Object.keys(idx?.data || {}));
    result.sources.ca = await checkAgainstSet('ca', (r) => r.sources.ca?.iso2, iso2s);
  } catch (e) { result.sources.ca = { error: e.message }; }

  // Ierland: alle slugs van de A-Z-pagina.
  try {
    const html = await getText(IE_AZ);
    const slugs = new Set([...html.matchAll(/\/overseas-travel\/advice\/([a-z0-9-]+)\//g)].map((m) => m[1]));
    result.sources.ie = await checkAgainstSet('ie', (r) => r.sources.ie, slugs);
  } catch (e) { result.sources.ie = { error: e.message }; }

  // Spanje: de landnaam uit de eigen aanbevelingenlijst. Dit is de controle
  // die "Jordán" jarenlang had moeten vangen — de site antwoordt op een
  // onbekende naam met 200 en een stubpagina, dus alleen de index verraadt het.
  try {
    const html = await getText(ES_INDEX);
    const namen = new Set([...html.matchAll(/trc=([^"'&<>]+)/gi)]
      .map((m) => decodeURIComponent(m[1]).replace(/\+/g, ' ').trim())
      .filter(Boolean));
    result.sources.es = await checkAgainstSet('es', (r) => r.sources.es, namen, plat);
  } catch (e) { result.sources.es = { error: e.message }; }

  // Denemarken: de slugs uit de keuzelijst op de overzichtspagina.
  try {
    const html = await getText(DK_INDEX);
    const slugs = new Set([...html.matchAll(/data-href="[^"]*rejsevejledninger\/([^/"]+)/gi)].map((m) => m[1].toLowerCase()));
    result.sources.dk = await checkAgainstSet('dk', (r) => r.sources.dk, slugs, (v) => String(v).toLowerCase());
  } catch (e) { result.sources.dk = { error: e.message }; }

  // Italië: ISO3 uit de landenlijst achter Viaggiare Sicuri.
  try {
    const lijst = await getJson(IT_INDEX);
    const iso3s = new Set((Array.isArray(lijst) ? lijst : [])
      .map((n) => String(n?.['Codice-3'] || '').toUpperCase()).filter(Boolean));
    result.sources.it = await checkAgainstSet('it', (r) => r.sources.it, iso3s, (v) => String(v).toUpperCase());
  } catch (e) { result.sources.it = { error: e.message }; }

  // Finland: ISO2 uit de tiedote-index (/matkustustiedote/-/c/XX).
  try {
    const html = await getText(FI_INDEX);
    const iso2s = new Set([...html.matchAll(/\/c\/([A-Z]{2})\b/g)].map((m) => m[1]));
    result.sources.fi = await checkAgainstSet('fi', (r) => r.sources.fi, iso2s, (v) => String(v).toUpperCase());
  } catch (e) { result.sources.fi = { error: e.message }; }

  // Nieuw-Zeeland: slugs uit de sitemap. De slug is daar de landnaam, en die
  // werd afgeleid uit de Engelse ISO-naam — met "moldova-republic-of",
  // "iran-islamic-republic-of" en "taiwan-province-of-china" tot gevolg. Die
  // pagina's bestaan gewoon, maar zonder advies erin, dus geen enkele
  // statuscontrole zag er iets van.
  try {
    const xml = await getText(NZ_SITEMAP);
    const slugs = new Set([...xml.matchAll(/destinations\/([^<\s]+)/gi)]
      .map((m) => decodeURIComponent(m[1]).toLowerCase()));
    result.sources.nz = await checkAgainstSet('nz', (r) => r.sources.nz, slugs, (v) => decodeURIComponent(String(v)).toLowerCase());
  } catch (e) { result.sources.nz = { error: e.message }; }

  // Meldingen van spoor 1 natrekken met één echte ophaling, zodat een
  // onvolledige index geen vals alarm oplevert.
  await verifieerKapot(result);

  // Spoor 2: roterende inhoudssteekproef over álle bronnen.
  if (process.env.STEEKPROEF !== '0') {
    result.steekproef = await steekproef();
  }

  let totalBroken = 0;
  let totalOntbrekend = 0;
  for (const [sid, r] of Object.entries(result.sources)) {
    if (r.error) { console.log(`⚠️ ${sid}: index niet op te halen (${r.error})`); continue; }
    totalBroken += r.broken.length;
    totalOntbrekend += r.ontbrekend.length;
    const buiten = (r.buitenIndex?.length ? `, ${r.buitenIndex.length} buiten de index maar werkend` : '')
      + (r.onbevestigd?.length ? `, ${r.onbevestigd.length} niet na te trekken` : '');
    console.log(`${r.broken.length ? '❌' : '✅'} ${sid}: ${r.checked} gecontroleerd, ${r.broken.length} kapot, ${r.ontbrekend.length} ontbrekend${buiten}, ${r.ongebruiktAantal} ongebruikt bij de bron`);
    for (const b of r.broken) {
      console.log(`   kapot     ${b.iso3} (${b.land}): "${toonId(b.id)}"${b.ophaalfout ? ` — ${b.ophaalfout}` : ''}${b.suggestie ? ` → suggestie: "${b.suggestie}"` : ''}`);
    }
    for (const m of r.ontbrekend) {
      console.log(`   ontbreekt ${m.iso3} (${m.land}): geen koppeling, bron heeft "${m.suggestie}" (${m.score})`);
    }
    for (const b of r.buitenIndex || []) {
      console.log(`   buiten index ${b.iso3} (${b.land}): "${toonId(b.id)}" staat niet in de lijst maar levert wel een advies`);
    }
    for (const b of r.onbevestigd || []) {
      console.log(`   onbevestigd  ${b.iso3} (${b.land}): "${toonId(b.id)}" staat niet in de lijst; natrekken lukte niet (${b.ophaalfout})`);
    }
  }
  result.totalBroken = totalBroken;
  result.totalOntbrekend = totalOntbrekend;

  if (result.steekproef) {
    const sp = result.steekproef;
    // Geblokkeerde bronnen apart houden: die falen per definitie en zouden het
    // rapport permanent rood maken.
    const echt = sp.verdacht.filter((v) => !v.geblokkeerd);
    result.totalVerdacht = echt.length;
    console.log(`\nInhoudssteekproef (dag ${sp.dag}, ${STEEKPROEF_PER_BRON} landen per bron):`);
    for (const [sid, r] of Object.entries(sp.perBron)) {
      const merk = r.geblokkeerd ? '⛔' : r.verdacht ? '❌' : r.onbereikbaar ? '⚠️' : '✅';
      const staart = r.geblokkeerd ? ' (bron blokkeert geautomatiseerd ophalen — telt niet mee)'
        : r.onbereikbaar ? ` (${r.onbereikbaar} niet bereikbaar — netwerk/botbeleid, geen koppelingsfout)` : '';
      console.log(`${merk} ${sid}: ${r.ok}/${r.getest} in orde${staart}`);
    }
    for (const v of echt) {
      console.log(`   verdacht  ${v.bron}/${v.iso3} (${v.land}): "${v.id}" — ${v.reden}`);
    }
  }

  writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`\nRapport: ${OUT} (${totalBroken} kapotte, ${totalOntbrekend} ontbrekende koppeling(en)`
    + `${result.totalVerdacht != null ? `, ${result.totalVerdacht} verdachte ophaling(en)` : ''}).`);
}

// Alleen draaien als dit script zélf wordt aangeroepen. De tests importeren
// de beoordelingsfuncties hieruit; zonder deze controle ging bij elke
// testrun de volledige live-controle mee (bijna drie minuten, en honderden
// verzoeken aan de bronnen).
const rechtstreeks = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (rechtstreeks) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
