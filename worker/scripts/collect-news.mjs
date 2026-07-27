/**
 * Verzamelt het lokaal-nieuwsoverzicht per land (top-3 lokale bronnen,
 * laatste 30 dagen) en schrijft het naar worker/data/news/{ISO3}.json.
 *
 * Draait in de snapshot-workflow (GitHub Actions): Google News geeft
 * Cloudflare Workers een harde 503, maar is vanaf gewone runners gewoon
 * bereikbaar — de Worker serveert daarom deze gecommitte bestanden
 * (zelfde patroon als het latest/-vangnet). Koppen worden hier alvast
 * naar het Nederlands vertaald (één gebatchte call per land).
 *
 * Resilient: als voor een land geen enkele feed lukt, blijft het vorige
 * bestand staan — een netwerk-hik mag het nieuwsblok niet leegmaken.
 *
 * Handmatig draaien: cd worker && node scripts/collect-news.mjs
 *   (NEWS_LIMIT=3 voor een testrun met drie landen)
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import newsSources from '../src/data/news-sources.json' with { type: 'json' };
import countries from '../src/data/countries.json' with { type: 'json' };
import { parseNewsRss, buildNewsOverview, splitByGeo } from '../src/lib/news.js';
import { translateBlocks } from '../src/lib/translate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NEWS_DIR = path.join(__dirname, '..', 'data', 'news');

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' };

// Landen zonder gecureerde top-3 krijgen een landenquery (gemengde bronnen).
// Dubbelzinnige landnamen worden met de hoofdstad verankerd — "Georgia"
// alleen levert vooral de Amerikaanse staat op (empirisch getest; mét
// Tbilisi erbij zijn de resultaten Georgisch).
const QUERY_OVERRIDE = {
  GEO: '"Georgia" Tbilisi', JOR: '"Jordan" Amman', TCD: '"Chad" N\'Djamena',
  NER: '"Niger" Niamey', TUR: '"Turkey" Ankara', GIN: '"Guinea" Conakry',
  // Congo-Brazzaville verdronk in nieuws over DR Congo (Ebola, oostelijke
  // conflicten); de buurman moet er expliciet uit gefilterd worden.
  COG: '("Republic of the Congo" OR Brazzaville) -"DR Congo" -"DRC" -"Democratic Republic"',
  DMA: '"Dominica" -"Dominican Republic"',
  PSE: '"Palestinian territories" OR "West Bank" OR Gaza', MCO: '"Monaco" principality',
};

async function fetchRss(query) {
  const feed = `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:30d`)}&hl=en-US&gl=US&ceid=US:en`;
  const r = await fetch(feed, { headers: UA });
  if (!r.ok) throw new Error(`feed ${r.status}`);
  return parseNewsRss(await r.text());
}

async function main() {
  mkdirSync(NEWS_DIR, { recursive: true });
  let entries = Object.entries(countries).filter(([iso]) => /^[A-Z]{3}$/.test(iso));
  if (process.env.NEWS_LIMIT) entries = entries.slice(0, Number(process.env.NEWS_LIMIT));

  let written = 0;
  let kept = 0;
  const geoStats = []; // [iso, opTopic, afgevoerd] — zie de samenvatting onderaan
  for (const [iso, rec] of entries) {
    const curated = newsSources[iso];
    const perOutlet = [];
    let anyOk = false;
    let sources;
    let mixed = false;

    if (Array.isArray(curated)) {
      // Gecureerde top-3: één feed per outlet, outletnaam vast.
      sources = curated.map((o) => o.name);
      for (const o of curated) {
        try {
          const items = await fetchRss(`site:${o.site}`);
          perOutlet.push(...items.map((it) => ({ ...it, outlet: o.name })));
          anyOk = true;
        } catch { /* outlet overslaan; anyOk bewaakt het geheel */ }
        await new Promise((r) => setTimeout(r, 400));
      }
    } else {
      // Terugval: landenquery over alle door Google geïndexeerde media;
      // de outlet per item komt uit de <source>-tag van de feed.
      mixed = true;
      sources = ['Google News (gemengde bronnen)'];
      try {
        const q = QUERY_OVERRIDE[iso] || `"${rec.en}"`;
        const items = await fetchRss(q);
        perOutlet.push(...items.map((it) => ({ ...it, outlet: it.sourceName || 'Google News' })));
        anyOk = true;
      } catch { /* anyOk blijft false */ }
      await new Promise((r) => setTimeout(r, 400));
    }

    const file = path.join(NEWS_DIR, `${iso}.json`);
    if (!anyOk) { if (existsSync(file)) kept++; continue; } // vorige versie behouden

    // Geofilter: gaat de kop wel over dít land? Wat vermoedelijk niet, gooien
    // we niet weg maar zetten we apart ('demoted') — de frontend toont dat
    // ingeklapt onderaan, zodat een terecht bericht nooit stil verdwijnt.
    const { onTopic, demoted: offItems } = splitByGeo(perOutlet, iso, !mixed);
    geoStats.push([iso, onTopic.length, offItems.length]);

    const categories = buildNewsOverview(onTopic, 5);
    // Hoogstens een handvol twijfelgevallen tonen, langs dezelfde categorie-
    // en ontdubbelzeef, daarna platgeslagen tot één lijst.
    const demoted = Object.values(buildNewsOverview(offItems, 2))
      .flatMap((c) => c.items.map((it) => ({ ...it, cat: c.label })))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, 6);

    // NL-vertaling van de gekozen koppen — één gebatchte call per land.
    const items = [...Object.values(categories).flatMap((c) => c.items), ...demoted];
    if (items.length) {
      try {
        const blocks = await translateBlocks(items.map((it) => ({ heading: it.title })), 'nl', 'auto');
        items.forEach((it, i) => {
          const nl = blocks[i]?.headingNl;
          if (nl && nl !== it.title) it.titleNl = nl;
        });
      } catch { /* koppen blijven onvertaald bij fout */ }
    }
    writeFileSync(file, JSON.stringify({
      generatedAt: new Date().toISOString(),
      sources,
      mixed,
      days: 30,
      categories,
      demoted,
    }));
    written++;
  }
  console.log(`Nieuws verzameld: ${written} landen geschreven, ${kept} behouden (feeds faalden), van ${entries.length}.`);

  // Geofilter-rapport: hoeveel is er per land afgevoerd als "gaat vermoedelijk
  // niet over dit land"? Zo zie je zwart-op-wit of de gazetteer scherp genoeg
  // is — een land waar bijna álles wegvalt mist waarschijnlijk gewoon een
  // naamvariant of demonym in geo-terms.json.
  const totOn = geoStats.reduce((n, s) => n + s[1], 0);
  const totOff = geoStats.reduce((n, s) => n + s[2], 0);
  if (totOn + totOff) {
    console.log(`Geofilter: ${totOff} van ${totOn + totOff} items afgevoerd (${Math.round((totOff / (totOn + totOff)) * 100)}%).`);
    const scheef = geoStats
      .filter(([, on, off]) => on + off >= 10 && off / (on + off) >= 0.7)
      .sort((a, b) => b[2] / (b[1] + b[2]) - a[2] / (a[1] + a[2]));
    if (scheef.length) {
      console.log('LET OP — landen waar >=70% wegvalt (controleer geo-terms.json):');
      for (const [iso, on, off] of scheef.slice(0, 15)) {
        console.log(`  ${iso}: ${off}/${on + off} afgevoerd (${Math.round((off / (on + off)) * 100)}%)`);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
