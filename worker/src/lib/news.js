/**
 * Lokaal nieuws per land — pure functies voor het /news/:iso-endpoint.
 *
 * Berichten komen per outlet uit Google News RSS (met een site:-filter en
 * when:30d): één stabiel formaat voor elk land, terwijl de kranten hun
 * eigen RSS-feeds voor datacenter-IP's blokkeren (Daily Monitor, Addis
 * Standard en New Vision gaven alle drie een 403 — empirisch vastgesteld).
 *
 * Classificatie gebeurt op koppen, naar de categorieën die ook in de
 * Nederlandse reisadviezen terugkomen. Wat nergens op matcht (sport,
 * entertainment, economie) valt bewust weg — dit is een reisadvies-filter,
 * geen nieuwslezer. Kruisbevestiging (zelfde nieuws bij meerdere van de
 * drie outlets) markeert wat lokaal als belangrijk geldt.
 *
 * Daarnaast filtert splitByGeo op PLAATS: gaat de kop wel over dít land?
 */
import GEO_TERMS from '../data/geo-terms.json' with { type: 'json' };

// Categorieën, uitgelijnd op de NL-reisadviesthema's. Patronen dekken
// en/fr/es — de gangbare perstalen in de gecureerde bronnenlijst.
export const NEWS_CATEGORIES = [
  { id: 'conflict', label: 'Conflict & terrorisme', icon: '⚔️',
    re: /\b(war|armed (conflict|group|men)|militia|rebels?|insurgen|terror|attack(s|ed)?|airstrike|drone (strike|attack)|clash(es)?|fighting|offensive|troops|military operation|al.?shabaab|adf\b|fano\b|gunmen|massacre|ceasefire|peace (talks|deal|agreement)|hostilit|guerre|conflit arm[ée]|attaque|combats|rebelles|guerra|ataque|enfrentamiento|guerrilla)\b/i },
  { id: 'politiek', label: 'Politiek & onrust', icon: '🏛️',
    re: /\b(elections?|polls?\b|no[- ]confidence|protest(s|ers)?|demonstrat|opposition|parliament|coup\b|riots?|unrest|curfew|state of emergency|crackdown|detained|bail\b|impeach|media shutdown|press freedom|dissolv|électio|manifestation|émeute|couvre-feu|opposant|elecci[oó]n|protesta|disturbios|toque de queda|oposici[oó]n)\b/i },
  { id: 'natuurgeweld', label: 'Natuurgeweld & klimaat', icon: '🌋',
    re: /\b(floods?|flooding|landslides?|earthquakes?|drought|storms?|cyclone|hurricane|typhoon|volcan|eruption|heavy rains?|el ni[nñ]o|famine|locusts?|wildfires?|heatwave|inondation|s[ée]isme|s[ée]cheresse|ouragan|inundaci[oó]n|terremoto|sequ[ií]a|hurac[aá]n|deslizamiento)\b/i },
  { id: 'reizen', label: 'Reizen & inreis', icon: '✈️',
    re: /\b(visas?\b|passports?|airports?|airlines?|flights?|border (clos|reopen|cross|post)|immigration|entry (requirement|rule|ban)|travel (ban|advisory|restriction)|airspace|tourism|tourists?|road (clos|accident|crash)|highway|railway|train (crash|derail)|bus (crash|accident)|ferry|a[ée]roport|fronti[eè]re|visa\b|aeropuerto|frontera|carretera|accidente)\b/i },
  { id: 'gezondheid', label: 'Gezondheid', icon: '🩺',
    re: /\b(outbreak|cholera|ebola|marburg|measles|malaria|mpox|dengue|epidemic|pandemi|vaccin|health emergency|disease|[ée]pid[ée]mie|paludisme|rougeole|brote|epidemia|sarampi[oó]n)\b/i },
  { id: 'criminaliteit', label: 'Criminaliteit', icon: '🚨',
    re: /\b(kidnap|abduct|robber|carjack|smuggl|traffick|gangs?\b|armed men rob|extortion|ransom|enl[eè]vement|braquage|bandit|secuestro|extorsi[oó]n|sicario|asalto)\b/i },
];

// Ruis die geen actueel binnenlands reisadvies-nieuws is: jubileumstukken,
// buitenland-/opinierubrieken, zoek- en servicepagina's.
const NOISE = /today in history|on this day|^search results|^\s*(world|international|opinion|editorial|commentary|column|sport|sports|entertainment|celebrity|lifestyle|horoscope|obituar|spotlight)\b\s*[:\-–|]|horoscope|crossword|^photos?:|^in pictures|\bepisode \d+\b|\bwin (a book|free )?tickets?\b/i;

// Spam-/videokoppen eindigen vaak op een ID tussen haakjes: "(kdBAxlakl4)".
// Bewust hoofdlettergevoelig met beide kasten verplicht, zodat officiële
// rapportcodes als "(MDRBO022)" (ReliefWeb/DREF) níét wegvallen.
const JUNK_ID = /\((?=[A-Za-z0-9]{8,}\))(?=[^)]*[a-z])(?=[^)]*[A-Z])[A-Za-z0-9]+\)\s*$/;

// Sportnieuws gebruikt oorlogstaal ("World Cup clash", "survives attack",
// "ready for war") en vervuilt daarmee vooral de conflictcategorie —
// tijdens het WK 2026 empirisch in tientallen landen tegelijk. Woorden die
// óók in echt nieuws voorkomen (race, marathon, mundial) staan er bewust
// niet in.
const SPORT = /\b(world cups?|fifa|uefa|concacaf|w?afcon|champions league|premier league|la liga|serie a|bundesliga|football|cricket|rugby|nba|nfl|kick-?off|matchday|line-?up confirmed|quarter-?finals?|semi-?finals?|last-16|last-32|round of 16|group stage|play-?offs?|extra time|penalty shootout|footballer|goalkeeper|midfielder|striker|star-studded|national team|player ratings|goal drought|mbapp[eé]|ronaldo|messi|haaland|fans|cycling|cyclists?|peloton|vuelta|tour de france|giro d.italia|classica|grand prix|motogp|formula (1|one)|grand slam|wimbledon|paralympics?|final lap|podium|friendly (match|against)|head-to-head|copa am[eé]rica)\b|^results\b|\b(efficient|dangerous|creative) in attack\b|\battack look\w*\b/i;

/** Parseert Google News RSS naar [{title, link, date, ts}]. */
export function parseNewsRss(xml) {
  const items = [];
  for (const m of String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const seg = m[1];
    const t = seg.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const l = seg.match(/<link\s*\/?>([^<]+)/) || seg.match(/<link>([\s\S]*?)<\/link>/);
    const d = seg.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const src = seg.match(/<source[^>]*>([\s\S]*?)<\/source>/);
    if (!t) continue;
    // Google News plakt " - Outlet" achter de kop; die voeren we zelf al als veld.
    const title = t[1].replace(/\s*-\s*[^-]+$/, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, '’').replace(/&quot;/g, '"').trim();
    const ts = d ? Date.parse(d[1]) : NaN;
    items.push({
      title,
      link: l ? l[1].trim() : null,
      date: Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : null,
      ts: Number.isFinite(ts) ? ts : 0,
      // Outlet-naam uit de <source>-tag — nodig voor de landenquery-terugval
      // (gemengde bronnen), waar de outlet per item verschilt.
      sourceName: src ? src[1].replace(/&amp;/g, '&').trim() : null,
    });
  }
  return items;
}

/** Categorie-id voor een kop, of null (= niet reisadvies-relevant). */
export function classifyNews(title) {
  const t = String(title || '');
  if (!t || t.length < 15 || NOISE.test(t) || SPORT.test(t) || JUNK_ID.test(t)) return null;
  for (const c of NEWS_CATEGORIES) if (c.re.test(t)) return c.id;
  return null;
}

// ---- Geofilter: gaat deze kop wel over dít land? -------------------------
// De categorieën hierboven filteren op ONDERWERP, nooit op PLAATS. Daardoor
// belandde een NYT-kop over Groenland onder België (de landenquery matcht de
// artikeltekst, wij lezen alleen de kop) en vulden Afghaanse outlets hun
// conflictrubriek met Oekraïne en Mexico (een site:-query garandeert een
// lokale krant, geen lokaal onderwerp). geo-terms.json levert per land de
// herkenningswoorden; zie scripts/build-geo-terms.mjs.

let _matcher = null;
/** Bouwt (eenmalig) de landherkenner: langste term eerst, zodat "South Sudan"
 *  wint van "Sudan" en "American Samoa" van "Samoa". */
function matcher() {
  if (_matcher) return _matcher;
  const owners = new Map(); // term (lowercase) -> [{ iso, strong }]
  for (const [iso, e] of Object.entries(GEO_TERMS)) {
    const strongSet = new Set(e.veto || []);
    for (const t of e.self || []) {
      const k = t.toLowerCase();
      if (!owners.has(k)) owners.set(k, []);
      owners.get(k).push({ iso, strong: strongSet.has(t) });
    }
  }
  const terms = [...owners.keys()].sort((a, b) => b.length - a.length);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // \b werkt niet na een punt ("U.S."), dus sluiten we af op een niet-letter.
  const re = new RegExp(`(?<![\\p{L}])(${terms.map(esc).join('|')})(?![\\p{L}])`, 'giu');
  _matcher = { re, owners };
  return _matcher;
}

/**
 * Bepaalt of een kop over `iso` gaat:
 *   'self'  — het land (of zijn demonym/hoofdstad/alias) staat in de kop
 *   'other' — er staat aantoonbaar een ánder land in, en dit land niet
 *   'none'  — geen enkel land herkenbaar (bij een lokale krant is dat normaal:
 *             "Explosion rocks capital" noemt het eigen land zelden)
 * Alleen 'sterke' termen mogen beschuldigen; dubbelzinnige woorden (Georgia,
 * Jordan, Chad, Turkey) tellen wel mee om te behouden, nooit om af te wijzen.
 */
export function geoVerdict(title, iso) {
  const t = String(title || '');
  // ReliefWeb-achtige koppen beginnen met de ISO3-code ("LAO: Flood - 07-2026").
  // Alleen hélemaal vooraan mét dubbele punt: los zijn die codes veel te
  // gevaarlijk (AND, ARE, CAN, COG zijn ook gewone woorden).
  if (new RegExp(`^${iso}\\s*:`, 'i').test(t.trim())) return 'self';
  const { re, owners } = matcher();
  re.lastIndex = 0;
  let other = false;
  for (const m of t.matchAll(re)) {
    const cands = owners.get(m[1].toLowerCase()) || [];
    if (cands.some((c) => c.iso === iso)) return 'self';
    if (cands.some((c) => c.strong)) other = true;
  }
  return other ? 'other' : 'none';
}

/**
 * Is de outlet zelf van dit land? "Cook Islands News" en "The Namibian"
 * verraden dat in hun naam. Bij de gemengde landenquery wisselt de outlet per
 * item, en juist bij kleine landen komt het meeste nieuws dan tóch van de
 * lokale krant — die schrijft "Teen tourist rescued from cross-island track"
 * zonder het land te noemen. Zulke items mogen we niet wegzetten enkel omdat
 * het bewijs in de kop ontbreekt.
 */
function localOutlet(outlet, iso) {
  const e = GEO_TERMS[iso];
  if (!e || !outlet) return false;
  const o = String(outlet).toLowerCase();
  return (e.self || []).some((t) => t.length > 3 && o.includes(t.toLowerCase()));
}

/**
 * Splitst items in wat over dit land gaat en wat vermoedelijk niet.
 * Bewust asymmetrisch, want lokale kranten noemen hun eigen land zelden:
 *   - gecureerde outlet: alleen wegzetten bij hard tegenbewijs ('other').
 *   - landenquery (gemengde, wereldwijde media): positief bewijs vereist,
 *     want daar matchte Google op de artikeltekst en zegt de kop niets.
 * Niets wordt weggegooid — 'demoted' toont de frontend apart en ingeklapt,
 * zodat een terecht bericht nooit stil verdwijnt.
 */
export function splitByGeo(items, iso, curated) {
  const onTopic = [];
  const demoted = [];
  for (const it of items) {
    const v = geoVerdict(it.title, iso);
    // Een outlet uit het land zelf krijgt dezelfde coulance als een gecureerde
    // bron, ook binnen de landenquery.
    const lenient = curated || localOutlet(it.outlet, iso);
    const off = lenient ? v === 'other' : v !== 'self';
    (off ? demoted : onTopic).push({ ...it, geo: v });
  }
  return { onTopic, demoted };
}

const STOP = new Set('the and for with from that this over after into amid says say will been were their them they have has had des les dans pour avec sur une del las los para con por que'.split(' '));
function tokens(title) {
  return new Set(String(title).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)));
}

/**
 * Markeert kruisbevestigd nieuws: items van VERSCHILLENDE outlets die
 * genoeg betekenisvolle woorden delen, krijgen multi=true (+ de namen van
 * de bevestigende outlets). Zelfde-outlet-overlap telt niet (vervolgstukken).
 */
export function markCorroborated(items) {
  const toks = items.map((it) => tokens(it.title));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[i].outlet === items[j].outlet) continue;
      let shared = 0;
      for (const w of toks[i]) if (toks[j].has(w)) shared++;
      const denom = Math.min(toks[i].size, toks[j].size) || 1;
      if (shared >= 3 && shared / denom >= 0.4) {
        items[i].multi = true; items[j].multi = true;
        (items[i].alsoAt ||= new Set()).add(items[j].outlet);
        (items[j].alsoAt ||= new Set()).add(items[i].outlet);
      }
    }
  }
  return items;
}

/**
 * Bouwt het eindoverzicht: per categorie de belangrijkste items —
 * kruisbevestigd eerst, dan nieuwste; max `perCat`; hoogstens 2 per outlet
 * per categorie (spreiding); kruisbevestigde duplicaten ontdubbeld (de
 * nieuwste versie blijft).
 */
export function buildNewsOverview(allItems, perCat = 5) {
  markCorroborated(allItems);
  const byCat = {};
  for (const it of allItems) {
    const cat = classifyNews(it.title);
    if (cat) (byCat[cat] ||= []).push(it);
  }
  const out = {};
  for (const c of NEWS_CATEGORIES) {
    const list = (byCat[c.id] || []).sort((a, b) => (b.multi ? 1 : 0) - (a.multi ? 1 : 0) || b.ts - a.ts);
    const chosen = [];
    const perOutlet = {};
    const seenToks = [];
    for (const it of list) {
      if (chosen.length >= perCat) break;
      if ((perOutlet[it.outlet] || 0) >= 2) continue;
      // Ontdubbel kruisbevestigde kopieën van hetzelfde nieuws.
      const tk = tokens(it.title);
      const dup = seenToks.some((prev) => {
        let s = 0; for (const w of tk) if (prev.has(w)) s++;
        return s >= 3 && s / (Math.min(tk.size, prev.size) || 1) >= 0.4;
      });
      if (dup) continue;
      seenToks.push(tk);
      perOutlet[it.outlet] = (perOutlet[it.outlet] || 0) + 1;
      chosen.push({
        title: it.title, link: it.link, date: it.date, outlet: it.outlet,
        multi: !!it.multi, alsoAt: it.alsoAt ? [...it.alsoAt] : undefined,
        titleNl: it.titleNl,
      });
    }
    if (chosen.length) out[c.id] = { label: c.label, icon: c.icon, items: chosen };
  }
  return out;
}
