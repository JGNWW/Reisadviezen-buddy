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
import { parseNewsRss, buildNewsOverview } from '../src/lib/news.js';
import { translateBlocks } from '../src/lib/translate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NEWS_DIR = path.join(__dirname, '..', 'data', 'news');

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' };

async function fetchFeed(site) {
  const feed = `https://news.google.com/rss/search?q=${encodeURIComponent(`site:${site} when:30d`)}&hl=en-US&gl=US&ceid=US:en`;
  const r = await fetch(feed, { headers: UA });
  if (!r.ok) throw new Error(`feed ${r.status} ${site}`);
  return parseNewsRss(await r.text());
}

async function main() {
  mkdirSync(NEWS_DIR, { recursive: true });
  let entries = Object.entries(newsSources).filter(([iso]) => /^[A-Z]{3}$/.test(iso));
  if (process.env.NEWS_LIMIT) entries = entries.slice(0, Number(process.env.NEWS_LIMIT));

  let written = 0;
  let kept = 0;
  for (const [iso, outlets] of entries) {
    const perOutlet = [];
    let anyOk = false;
    for (const o of outlets) {
      try {
        const items = await fetchFeed(o.site);
        perOutlet.push(...items.map((it) => ({ ...it, outlet: o.name })));
        anyOk = true;
      } catch { /* outlet overslaan; anyOk bewaakt het geheel */ }
      await new Promise((r) => setTimeout(r, 400));
    }
    const file = path.join(NEWS_DIR, `${iso}.json`);
    if (!anyOk) { if (existsSync(file)) kept++; continue; } // vorige versie behouden

    const categories = buildNewsOverview(perOutlet, 5);
    // NL-vertaling van de gekozen koppen — één gebatchte call per land.
    const items = Object.values(categories).flatMap((c) => c.items);
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
      sources: outlets.map((o) => o.name),
      days: 30,
      categories,
    }));
    written++;
  }
  console.log(`Nieuws verzameld: ${written} landen geschreven, ${kept} behouden (feeds faalden), van ${entries.length}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
