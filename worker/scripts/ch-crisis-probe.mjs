/**
 * ONTDEKKING (wegwerp): het EDA "crisis"-portaal
 * (eda.admin.ch/crisis/de/reisehinweise) is een SPA. Als het een JSON-API
 * achter zich heeft met de per-land Reisehinweise (met de standaardformules
 * "von Reisen wird abgeraten" = rood, "grundsätzlich als sicher" = groen,
 * "grosse Aufmerksamkeit" = geel), kunnen we Zwitserland alsnog ophalen.
 *
 * Dit probe:
 *  1) opent het portaal met Chromium en logt ELKE netwerk-respons
 *     (url, status, content-type, grootte);
 *  2) bewaart JSON/tekst-bodies die naar reisadvies ruiken (bevatten een
 *     landnaam of een van de standaardformules) — dat verraadt de data-API;
 *  3) meldt of de pagina überhaupt rendert vanaf een datacenter-IP (de
 *     landpagina's blokkeerden dat eerder).
 *
 * Puur diagnostisch. Draait via ch-crisis-probe.yml.
 */
import { chromium } from 'playwright';

const START = 'https://www.eda.admin.ch/crisis/de/reisehinweise';
const HINT = /abgeraten|grundsätzlich als sicher|grosse Aufmerksamkeit|reisehinweis|traveladvice|afghanistan|ukraine|thailand/i;

async function main() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'de-CH',
    viewport: { width: 1400, height: 1000 },
  });
  const page = await ctx.newPage();

  const seen = [];
  const bodies = [];
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      const ct = resp.headers()['content-type'] || '';
      if (/image|font|\.css|\.woff|analytics|gtm|google/i.test(ct + url)) return;
      const rec = { url: url.slice(0, 130), status: resp.status(), ct: ct.slice(0, 40) };
      seen.push(rec);
      // Bewaar JSON/tekst-bodies die naar reisadvies ruiken.
      if (/json|text\/plain|xml/i.test(ct) || /api|data|advice|hinweis|country|land/i.test(url)) {
        const body = await resp.text().catch(() => '');
        if (body && (HINT.test(body) || /json/i.test(ct))) {
          bodies.push({ url: url.slice(0, 160), ct, len: body.length, sample: body.slice(0, 600) });
        }
      }
    } catch { /* negeren */ }
  });

  console.log(`Openen: ${START}`);
  try {
    await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    console.log(`goto faalde: ${String(e.message).slice(0, 80)}`);
  }
  try { await page.waitForLoadState('networkidle', { timeout: 20000 }); } catch { /* ok */ }
  await page.waitForTimeout(4000);

  const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const title = await page.title().catch(() => '');
  console.log(`\nTitel: ${title}`);
  console.log(`Zichtbare tekst: ${bodyText.length} tekens`);
  console.log(`Bevat standaardformule? ${/abgeraten|grundsätzlich als sicher|grosse Aufmerksamkeit/i.test(bodyText) ? 'JA' : 'nee'}`);
  console.log(`Botcheck/blok? ${/just a moment|attention required|verifying|zugriff verweigert|access denied/i.test(bodyText) ? 'JA' : 'nee'}`);

  console.log(`\n=== ${seen.length} netwerk-responses (niet-asset) ===`);
  for (const r of seen.slice(0, 60)) console.log(`  [${r.status}] ${r.ct}  ${r.url}`);

  console.log(`\n=== ${bodies.length} kandidaat data-bodies ===`);
  for (const b of bodies.slice(0, 12)) {
    console.log(`\n  → ${b.url}\n    ct=${b.ct} len=${b.len}\n    ${b.sample.replace(/\s+/g, ' ')}`);
  }

  await browser.close();
  console.log('\nProbe klaar.');
}

main().catch((e) => { console.error(e); process.exit(1); });
