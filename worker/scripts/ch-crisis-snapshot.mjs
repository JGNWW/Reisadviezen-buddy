/**
 * ch-crisis — herstelt Zwitserland (EDA) via het crisis-portaal.
 *
 * De per-land EDA-pagina's blokkeren datacenter-IP's, maar het crisis-portaal
 * (eda.admin.ch/crisis/de/reisehinweise) niet: dat serveert ALLE landen in één
 * pagina, elk in een <div id="_ta_{ISO2}"> met de standaardformules ("… wird
 * abgeraten" = rood, "grundsätzlich als sicher" = groen, "Aufmerksamkeit zu
 * schenken" = geel). Een plain fetch geeft 403, dus dit draait met een echte
 * Chromium (in CI) — één render levert ~200 landen.
 *
 * Per land bepalen we het landelijke niveau uit de "Grundsätzliche
 * Einschätzung" en het regionale maximum uit de volledige tekst
 * (src/analysis/ch-classify.js), en schrijven dat als vangnet naar
 * worker/data/latest/{ISO3}.json onder 'ch' — dezelfde snapshot die de Worker
 * al serveert wanneer live ophalen faalt. Een land zonder herkenbare formule
 * laat de vorige snapshot intact (degraded-guard).
 *
 * Draait via ch-crisis.yml (wekelijks + handmatig).
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import countries from '../src/data/countries.json' with { type: 'json' };
import * as switzerland from '../src/adapters/switzerland.js';
import { classifyTheme } from '../src/lib/themes.js';
import { assessChAdvisory } from '../src/analysis/ch-classify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LATEST_DIR = path.join(__dirname, '..', 'data', 'latest');
const CRISIS_URL = 'https://www.eda.admin.ch/crisis/de/reisehinweise';

// ISO2 → ISO3 (uit countries.json).
const ISO2_TO_ISO3 = {};
for (const [iso3, rec] of Object.entries(countries)) {
  if (rec && rec.iso2) ISO2_TO_ISO3[String(rec.iso2).toUpperCase()] = iso3;
}

/** "1/22/2026 10:15:00 AM" → "2026-01-22". */
function parseEditedDate(s) {
  const m = (s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

async function main() {
  mkdirSync(LATEST_DIR, { recursive: true });
  const only = (process.env.COUNTRIES || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const today = new Date().toISOString().slice(0, 10);

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'de-CH', viewport: { width: 1400, height: 1000 },
  });
  const page = await ctx.newPage();
  await page.goto(CRISIS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  try { await page.waitForLoadState('networkidle', { timeout: 25000 }); } catch { /* ok */ }
  await page.waitForTimeout(3500);

  // Alle per-land-blokken uit de gerenderde DOM halen.
  const blocks = await page.evaluate(() => {
    const H = 'Grundsätzliche Einschätzung';
    return [...document.querySelectorAll('div[id^="_ta_"]')].map((el) => {
      const iso2 = el.id.replace(/^_ta_/, '').toUpperCase();
      const full = (el.innerText || '').replace(/\s+/g, ' ').trim();
      const dm = full.match(/Zuletzt editiert:\s*([\d/:\sAPM]+?)(?:\s{2,}|Grundsätzliche|$)/i);
      const gi = full.indexOf(H);
      const grund = gi >= 0 ? full.slice(gi + H.length, gi + H.length + 1000).trim() : '';
      return { iso2, date: dm ? dm[1].trim() : null, grund, full: full.slice(0, 9000) };
    });
  });

  const stats = { saved: 0, geen_formule: 0, geen_iso: 0, behouden: 0 };
  const byIso = {};
  for (const b of blocks) {
    const iso = ISO2_TO_ISO3[b.iso2];
    if (!iso) { stats.geen_iso++; continue; }
    if (only.length && !only.includes(iso)) continue;
    const a = assessChAdvisory(b.grund, b.full);
    if (!a) { stats.geen_formule++; if (process.env.DIAG) console.log(`  ${iso} (${b.iso2}): geen formule — overslaan`); continue; }
    byIso[iso] = { ...a, date: parseEditedDate(b.date), grund: b.grund, full: b.full };
  }

  for (const [iso, a] of Object.entries(byIso)) {
    const file = path.join(LATEST_DIR, `${iso}.json`);
    const latest = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { iso3: iso, fetchedAt: {}, sources: {} };
    // Degraded-guard: een resultaat mét niveau vervangt gerust; we hebben altijd
    // een niveau hier (assessChAdvisory gaf non-null).
    const rec = countries[iso];
    const themes = [
      { category: 'Grundsätzliche Einschätzung', heading: 'Grundsätzliche Einschätzung', themeId: classifyTheme('sicherheit', a.grund), text: a.grund, url: switzerland.sourceUrl(rec.sources?.ch) },
      { category: 'Reisehinweise (EDA)', heading: 'Reisehinweise (EDA)', themeId: classifyTheme('reisehinweise', a.full), text: a.full, url: switzerland.sourceUrl(rec.sources?.ch) },
    ];
    latest.sources.ch = {
      source: 'ch', sourceLabel: 'Zwitserland (EDA)', flag: '🇨🇭',
      name: rec.en || null, url: switzerland.sourceUrl(rec.sources?.ch),
      lastModified: a.date, updateNote: null,
      level: a.level, color: a.color, levelLabel: a.levelLabel,
      regionalMaxLevel: a.regionalMaxLevel, hasRegionalWarnings: a.hasRegionalWarnings,
      regionalBreakdown: [], regionalCoverage: null, regions: null,
      confidence: 'high', assessmentStatus: 'ok',
      hasMap: false, lang: 'de', themes, capturedWith: 'crisis',
    };
    latest.fetchedAt.ch = today;
    writeFileSync(file, JSON.stringify(latest));
    stats.saved++;
    if (process.env.DIAG) console.log(`  ${iso} (${a.color}${a.hasRegionalWarnings ? `, regio ${a.regionalColor}` : ''}) · ${a.grund.slice(0, 90)}`);
  }

  await browser.close();
  console.log(`\nch-crisis klaar: ${stats.saved} opgeslagen, ${stats.geen_formule} zonder formule, ${stats.geen_iso} onbekende ISO2, blokken: ${blocks.length}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
