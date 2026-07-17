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
 */

// Categorieën, uitgelijnd op de NL-reisadviesthema's. Patronen dekken
// en/fr/es — de gangbare perstalen in de gecureerde bronnenlijst.
export const NEWS_CATEGORIES = [
  { id: 'conflict', label: 'Conflict & terrorisme', icon: '⚔️',
    re: /\b(war|armed (conflict|group|men)|militia|rebels?|insurgen|terror|attack(s|ed)?|airstrike|drone (strike|attack)|clash(es)?|fighting|offensive|troops|military operation|al.?shabaab|adf\b|fano\b|gunmen|massacre|ceasefire|peace (talks|deal|agreement)|hostilit|guerre|conflit arm[ée]|attaque|combats|rebelles|guerra|ataque|enfrentamiento|guerrilla)\b/i },
  { id: 'politiek', label: 'Politiek & onrust', icon: '🏛️',
    re: /\b(elections?|protest(s|ers)?|demonstrat|opposition|parliament|coup\b|riots?|unrest|curfew|state of emergency|crackdown|detained|bail\b|impeach|media shutdown|press freedom|dissolv|électio|manifestation|émeute|couvre-feu|opposant|elecci[oó]n|protesta|disturbios|toque de queda|oposici[oó]n)\b/i },
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
const NOISE = /today in history|on this day|^search results|^\s*(world|international|opinion|editorial|commentary|column|sport|sports|entertainment|celebrity|lifestyle|horoscope|obituar)\b\s*[:\-–]|horoscope|crossword|^photos?:|^in pictures/i;

// Sportnieuws gebruikt oorlogstaal ("World Cup clash", "survives attack",
// "ready for war") en vervuilt daarmee vooral de conflictcategorie —
// tijdens het WK 2026 empirisch in tientallen landen tegelijk. Woorden die
// óók in echt nieuws voorkomen (race, marathon, mundial) staan er bewust
// niet in.
const SPORT = /\b(world cup|fifa|uefa|concacaf|champions league|premier league|la liga|serie a|bundesliga|cricket|rugby|nba|nfl|kick-?off|matchday|line-?up confirmed|quarter-?finals?|semi-?finals?|last-16|last-32|round of 16|footballer|goalkeeper|midfielder|striker|peloton|vuelta|tour de france|giro d.italia|grand prix|motogp|formula (1|one)|grand slam|wimbledon|paralympics?|final lap|podium|friendly match|head-to-head|copa am[eé]rica)\b/i;

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
  if (!t || t.length < 15 || NOISE.test(t) || SPORT.test(t)) return null;
  for (const c of NEWS_CATEGORIES) if (c.re.test(t)) return c.id;
  return null;
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
