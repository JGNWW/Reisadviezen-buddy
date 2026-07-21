/**
 * PROEF (wegwerp): kan het "kaartenmaker"-idee (kleur uit de kaart afleiden)
 * werken voor Frankrijk? France Diplomatie toont per land een zonekaart
 * (rouge/orange/jaune/…) op de veiligheidspagina. We hebben géén globale
 * projectie nodig — per land één kaart is genoeg.
 *
 * Dit script rendert de securite-pagina met een echte Chromium (in CI, want
 * de sandbox mag niet naar buiten) en rapporteert per land:
 *   - welk kaart-element rendert (SVG / canvas / img);
 *   - bij SVG: de fill-kleuren van de zone-paden (exacte hex → histogram);
 *   - bij raster: een pixel-histogram van het kaart-element;
 *   - een screenshot van het kaart-element (artifact) voor handmatige check.
 *
 * Draait via .github/workflows/fr-map-probe.yml. Puur diagnostisch:
 * schrijft niets naar data/latest.
 *
 *   cd worker && node scripts/fr-map-probe.mjs
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'fr-probe-out');

const SITE = 'https://www.diplomatie.gouv.fr';
const url = (slug) => `${SITE}/fr/information-par-pays/${slug}/conseils-aux-voyageurs-securite`;

// Testlanden: twee zware (Irak/Oekraïne), twee gemengde (Mali/Thailand),
// en één "veilig" ijkpunt (Japan). Frankrijk zelf heeft geen advieskaart.
const TARGETS = [
  ['IRQ', 'irak'], ['UKR', 'ukraine'], ['MLI', 'mali'],
  ['THA', 'thailande'], ['JPN', 'japon'],
];

/** Alles wat naar een kaart ruikt in de gerenderde DOM opsnorren. */
async function inspect(page) {
  return page.evaluate(() => {
    const norm = (c) => (c || '').toLowerCase().replace(/\s+/g, '');
    const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };

    // 1) SVG-kaarten: fill-histogram over path/polygon/rect.
    const svgs = [...document.querySelectorAll('svg')].map((svg) => {
      const shapes = [...svg.querySelectorAll('path,polygon,rect,g')];
      const fills = {};
      for (const s of shapes) {
        const f = norm(getComputedStyle(s).fill) || norm(s.getAttribute('fill'));
        if (!f || f === 'none' || f === 'rgba(0,0,0,0)') continue;
        fills[f] = (fills[f] || 0) + 1;
      }
      return { shapes: shapes.length, fills, rect: rectOf(svg), cls: svg.getAttribute('class') || '', id: svg.id || '' };
    }).filter((s) => s.shapes > 0);

    // 2) canvas & img die een kaart kunnen zijn.
    const canvases = [...document.querySelectorAll('canvas')].map((c) => ({ rect: rectOf(c), cls: c.getAttribute('class') || '' }));
    const imgs = [...document.querySelectorAll('img')]
      .filter((i) => /carte|map|zone|vigilance/i.test((i.src || '') + ' ' + (i.alt || '') + ' ' + (i.className || '')))
      .map((i) => ({ src: i.src, alt: i.alt, rect: rectOf(i) }));

    // 3) containers met kaart-achtige klassen (Leaflet/mapbox/eigen widget).
    const mapish = [...document.querySelectorAll('[class*="carte" i],[class*="map" i],[id*="carte" i],[id*="map" i],[class*="leaflet" i]')]
      .map((e) => ({ tag: e.tagName.toLowerCase(), cls: e.getAttribute('class') || '', id: e.id || '', rect: rectOf(e) }))
      .filter((e) => e.rect.w > 80 && e.rect.h > 80).slice(0, 8);

    return { svgs, canvases, imgs, mapish, title: document.title };
  });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'fr-FR', viewport: { width: 1400, height: 1200 },
  });
  const page = await ctx.newPage();
  const report = {};

  for (const [iso, slug] of TARGETS) {
    const u = url(slug);
    try {
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 });
      // cookie-consent wegklikken indien aanwezig
      for (const sel of ['#tarteaucitronPersonalize2', 'button#tarteaucitronAllAllowed', 'button:has-text("Accepter")', 'button:has-text("Tout accepter")']) {
        try { const b = await page.$(sel); if (b) { await b.click({ timeout: 1500 }); break; } } catch { /* geen consent */ }
      }
      // de kaart-widget mag laden
      try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch { /* ok */ }
      await page.waitForTimeout(3500);

      const info = await inspect(page);
      report[iso] = { url: u, ...info };

      // Screenshot: het grootste kaart-achtige element, anders de hele pagina.
      const candidates = [...info.svgs, ...info.canvases, ...info.mapish]
        .filter((c) => c.rect && c.rect.w > 120 && c.rect.h > 120)
        .sort((a, b) => (b.rect.w * b.rect.h) - (a.rect.w * a.rect.h));
      const shot = path.join(OUT, `${iso}.png`);
      if (candidates.length) {
        const c = candidates[0];
        await page.screenshot({ path: shot, clip: { x: Math.max(0, c.rect.x), y: Math.max(0, c.rect.y), width: Math.min(1400, c.rect.w), height: Math.min(1200, c.rect.h) } }).catch(() => page.screenshot({ path: shot, fullPage: false }));
      } else {
        await page.screenshot({ path: shot, fullPage: false });
      }

      const svgSummary = info.svgs.map((s) => `svg(${s.shapes} vormen, ${Object.keys(s.fills).length} kleuren) ${s.rect.w}x${s.rect.h}`).join('; ') || 'geen';
      console.log(`\n=== ${iso} (${slug}) ===`);
      console.log(`  titel: ${info.title}`);
      console.log(`  SVG's: ${svgSummary}`);
      for (const s of info.svgs) {
        const top = Object.entries(s.fills).sort((a, b) => b[1] - a[1]).slice(0, 12);
        if (top.length) console.log(`    fills: ${top.map(([k, v]) => `${k}×${v}`).join('  ')}`);
      }
      console.log(`  canvas: ${info.canvases.length}  img(kaart): ${info.imgs.length}  map-containers: ${info.mapish.length}`);
      for (const m of info.mapish) console.log(`    container <${m.tag} class="${m.cls.slice(0, 60)}"> ${m.rect.w}x${m.rect.h}`);
      for (const i of info.imgs) console.log(`    img ${i.rect.w}x${i.rect.h} src=${i.src.slice(0, 90)}`);
    } catch (e) {
      report[iso] = { url: u, error: String(e.message).slice(0, 120) };
      console.log(`\n=== ${iso} (${slug}) === FOUT: ${String(e.message).slice(0, 120)}`);
    }
    await page.waitForTimeout(1200);
  }

  writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  console.log('\nProef klaar — screenshots + report.json in worker/fr-probe-out/ (artifact).');
}

main().catch((e) => { console.error(e); process.exit(1); });
