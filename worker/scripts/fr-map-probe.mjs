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

    const canvases = [...document.querySelectorAll('canvas')].map((c) => ({ rect: rectOf(c), cls: c.getAttribute('class') || '' }));

    // 2) ALLE afbeeldingen ≥120px (ongeacht src/alt) — de zonekaart kan een
    // gewone <img> met generieke src zijn.
    const allImgs = [...document.querySelectorAll('img')]
      .map((i) => ({ src: i.currentSrc || i.src, alt: i.alt || '', cls: i.getAttribute('class') || '', loading: i.getAttribute('loading') || '', rect: rectOf(i) }))
      .filter((i) => i.rect.w >= 120 && i.rect.h >= 120);

    // 3) CSS background-image-divs die groot genoeg zijn voor een kaart.
    const bgs = [...document.querySelectorAll('div,figure,section,article,span')]
      .map((e) => ({ e, bg: getComputedStyle(e).backgroundImage }))
      .filter((x) => x.bg && x.bg !== 'none' && /url\(/i.test(x.bg))
      .map((x) => ({ bg: x.bg.slice(0, 120), cls: x.e.getAttribute('class') || '', rect: rectOf(x.e) }))
      .filter((x) => x.rect.w >= 120 && x.rect.h >= 120).slice(0, 10);

    // 4) iframes (ingesloten kaartwidget).
    const iframes = [...document.querySelectorAll('iframe')].map((f) => ({ src: f.src, rect: rectOf(f) }));

    // 5) De DOM rond een "vigilance"/"zone"-kop: wat staat daar aan beeld?
    let vigilance = null;
    const head = [...document.querySelectorAll('h1,h2,h3,h4')].find((h) => /vigilance|zones?\b/i.test(h.innerText || ''));
    if (head) {
      const scope = head.closest('section,article,div') || head.parentElement;
      vigilance = {
        heading: (head.innerText || '').slice(0, 80),
        imgs: [...(scope?.querySelectorAll('img') || [])].map((i) => ({ src: (i.currentSrc || i.src || '').slice(0, 120), alt: (i.alt || '').slice(0, 60), rect: rectOf(i) })),
        html: (scope?.innerHTML || '').replace(/\s+/g, ' ').slice(0, 400),
      };
    }

    return { svgs, canvases, allImgs, bgs, iframes, vigilance, title: document.title };
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
      // de kaart-widget mag laden; scroll om lazy-load te triggeren
      try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch { /* ok */ }
      await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); } window.scrollTo(0, 0); });
      await page.waitForTimeout(2500);

      const info = await inspect(page);
      report[iso] = { url: u, ...info };

      // Volledige pagina-screenshot voor handmatige controle.
      await page.screenshot({ path: path.join(OUT, `${iso}.png`), fullPage: true }).catch(() => {});

      console.log(`\n=== ${iso} (${slug}) ===`);
      console.log(`  titel: ${info.title}`);
      console.log(`  SVG's met fills: ${info.svgs.length}  canvas: ${info.canvases.length}  iframes: ${info.iframes.length}`);
      for (const s of info.svgs) {
        const top = Object.entries(s.fills).sort((a, b) => b[1] - a[1]).slice(0, 12);
        console.log(`    svg ${s.rect.w}x${s.rect.h} fills: ${top.map(([k, v]) => `${k}×${v}`).join('  ')}`);
      }
      console.log(`  afbeeldingen ≥120px: ${info.allImgs.length}`);
      for (const i of info.allImgs) console.log(`    img ${i.rect.w}x${i.rect.h} alt="${i.alt.slice(0, 40)}" src=${i.src.slice(0, 100)}`);
      console.log(`  background-image divs: ${info.bgs.length}`);
      for (const b of info.bgs) console.log(`    bg ${b.rect.w}x${b.rect.h} class="${b.cls.slice(0, 40)}" ${b.bg}`);
      if (info.vigilance) {
        console.log(`  "vigilance"-kop: "${info.vigilance.heading}" — ${info.vigilance.imgs.length} img(s) in sectie`);
        for (const i of info.vigilance.imgs) console.log(`    zone-img ${i.rect.w}x${i.rect.h} alt="${i.alt}" src=${i.src}`);
      } else {
        console.log('  geen "vigilance"/"zone"-kop gevonden');
      }
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
