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

      // KERN: de zonekaart (fcv-JPG) pixel-samplen. Het beeld staat op
      // dezelfde origin als de pagina → canvas.getImageData tainted niet.
      // We classificeren elke pixel op tint (HSV) i.p.v. exacte hex, want
      // JPEG-compressie verschuift kleuren licht.
      const mapImg = (info.vigilance?.imgs || []).find((i) => /\/cav\//i.test(i.src)) || info.allImgs[0];
      let pixels = null;
      if (mapImg) {
        pixels = await page.evaluate((src) => {
          const el = [...document.querySelectorAll('img')].find((i) => (i.currentSrc || i.src) === src);
          if (!el || !el.naturalWidth) return { error: 'img niet vindbaar/geladen' };
          const w = el.naturalWidth, h = el.naturalHeight;
          const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
          const cx = cv.getContext('2d'); cx.drawImage(el, 0, 0);
          let data; try { data = cx.getImageData(0, 0, w, h).data; } catch (e) { return { error: 'taint: ' + e.message }; }
          const cls = { rood: 0, oranje: 0, geel: 0, groen: 0, wit: 0, blauw: 0, grijs: 0, overig: 0 };
          let total = 0;
          for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
            const i = (y * w + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
            if (a < 128) continue; total++;
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
            const v = mx / 255, s = mx === 0 ? 0 : d / mx;
            let hh = 0; if (d !== 0) { if (mx === r) hh = 60 * (((g - b) / d) % 6); else if (mx === g) hh = 60 * ((b - r) / d + 2); else hh = 60 * ((r - g) / d + 4); } if (hh < 0) hh += 360;
            if (s < 0.18) { if (v > 0.82) cls.wit++; else cls.grijs++; continue; }
            if (hh >= 185 && hh <= 255) { cls.blauw++; continue; }
            if (hh < 20 || hh >= 345) cls.rood++;
            else if (hh < 45) cls.oranje++;
            else if (hh < 70) cls.geel++;
            else if (hh < 170) cls.groen++;
            else cls.overig++;
          }
          return { w, h, total, cls };
        }, mapImg.src);
      }
      report[iso] = { url: u, mapSrc: mapImg?.src || null, pixels, vigilance: info.vigilance?.heading || null };

      // De geanalyseerde kaart als los bestand in het artifact (exacte input).
      try {
        const resp = await fetch(mapImg.src);
        if (resp.ok) writeFileSync(path.join(OUT, `${iso}-fcv.jpg`), Buffer.from(await resp.arrayBuffer()));
      } catch { /* download optioneel */ }
      await page.screenshot({ path: path.join(OUT, `${iso}-page.png`), fullPage: true }).catch(() => {});

      console.log(`\n=== ${iso} (${slug}) ===`);
      console.log(`  titel: ${info.title}`);
      console.log(`  zonekaart: ${mapImg ? mapImg.src : 'NIET GEVONDEN'}`);
      if (pixels?.error) console.log(`  pixel-analyse FOUT: ${pixels.error}`);
      else if (pixels) {
        const c = pixels.cls, t = pixels.total || 1;
        const pct = (n) => `${(100 * n / t).toFixed(1)}%`;
        // "land" = alles behalve zee (blauw) en kader/tekst (grijs/wit-buiten).
        const land = c.rood + c.oranje + c.geel + c.groen + c.wit;
        const lp = (n) => `${(100 * n / (land || 1)).toFixed(1)}%`;
        console.log(`  totaal ${pixels.w}x${pixels.h} · rood ${pct(c.rood)}  oranje ${pct(c.oranje)}  geel ${pct(c.geel)}  wit ${pct(c.wit)}  blauw(zee) ${pct(c.blauw)}  grijs ${pct(c.grijs)}`);
        console.log(`  land-relatief: rood ${lp(c.rood)}  oranje ${lp(c.oranje)}  geel ${lp(c.geel)}  wit ${lp(c.wit)}`);
        // Afgeleide kleur: ergste zone boven drempel = regionaal maximum;
        // grootste land-klasse = landelijke basislijn.
        const T = 0.015 * land;
        const regMax = c.rood > T ? 'ROOD' : c.oranje > T ? 'ORANJE' : c.geel > T ? 'GEEL' : 'GROEN/normaal';
        const base = Object.entries({ wit: c.wit, geel: c.geel, oranje: c.oranje, rood: c.rood }).sort((a, b) => b[1] - a[1])[0][0];
        console.log(`  → regionaal max: ${regMax}   landelijke basislijn (dominante land-klasse): ${base}`);
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
