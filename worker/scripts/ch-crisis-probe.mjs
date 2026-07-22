/**
 * ONTDEKKING v4 (wegwerp): de list-group-<li> zijn slechts de landen-index
 * (naam-links). Waar staat de adviestekst (standaardformules)? En wat is de
 * per-land URL/href? Deze probe:
 *  - dumpt de href van een paar landen-links (URL-patroon);
 *  - telt de standaardformules in de gerenderde tekst;
 *  - lokaliseert het element dat "grundsätzlich als sicher" bevat + de
 *    dichtstbijzijnde landkop, en telt hoeveel zulke blokken er zijn.
 */
import { chromium } from 'playwright';

const URL_DE = 'https://www.eda.admin.ch/crisis/de/reisehinweise';

async function main() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'de-CH', viewport: { width: 1400, height: 1000 },
  });
  const page = await ctx.newPage();
  await page.goto(URL_DE, { waitUntil: 'domcontentloaded', timeout: 45000 });
  try { await page.waitForLoadState('networkidle', { timeout: 20000 }); } catch { /* ok */ }
  await page.waitForTimeout(3000);

  const info = await page.evaluate(() => {
    const out = {};
    // 1) hrefs van de landen-index-links.
    const links = [...document.querySelectorAll('li.list-group-item a[href]')];
    out.linkCount = links.length;
    out.sampleLinks = links.slice(0, 6).map((a) => ({ txt: (a.textContent || '').trim().slice(0, 24), href: a.getAttribute('href') }));
    // Specifiek Afghanistan/Thailand.
    for (const name of ['Afghanistan', 'Thailand']) {
      const a = links.find((x) => (x.textContent || '').trim() === name);
      out['href_' + name] = a ? a.getAttribute('href') : null;
    }

    // 2) formule-tellingen in de volledige gerenderde tekst.
    const txt = document.body.innerText || '';
    out.textLen = txt.length;
    out.counts = {
      abgeraten: (txt.match(/wird abgeraten/gi) || []).length,
      aufmerksamkeit: (txt.match(/aufmerksamkeit zu schenken/gi) || []).length,
      sicher: (txt.match(/grunds[äa]tzlich als sicher/gi) || []).length,
    };

    // 3) lokaliseer een blok dat een formule bevat + dichtstbijzijnde landkop.
    const walkHeading = (el) => {
      // zoek opwaarts/achterwaarts naar een kop of sterke tekst met landnaam
      let n = el;
      for (let i = 0; i < 8 && n; i++) {
        const h = n.querySelector?.('h1,h2,h3,h4') || null;
        if (h && (h.textContent || '').trim().length < 40) return { via: 'child', tag: n.tagName.toLowerCase(), cls: (n.className || '').slice(0, 60), heading: h.textContent.trim() };
        n = n.parentElement;
      }
      return null;
    };
    const all = [...document.querySelectorAll('body *')];
    const withPhrase = all.filter((e) => {
      const t = e.textContent || '';
      return /grunds[äa]tzlich als sicher|wird abgeraten|aufmerksamkeit zu schenken/i.test(t) && t.length < 4000 && e.children.length < 30;
    });
    out.phraseBlocks = withPhrase.length;
    const first = withPhrase[0];
    if (first) {
      out.firstBlock = {
        tag: first.tagName.toLowerCase(), cls: (first.className || '').slice(0, 70), id: (first.id || '').slice(0, 40),
        text: (first.textContent || '').replace(/\s+/g, ' ').slice(0, 500),
        heading: walkHeading(first),
      };
    }
    return out;
  });

  console.log(JSON.stringify(info, null, 2));
  await browser.close();
  console.log('\nProbe klaar.');
}

main().catch((e) => { console.error(e); process.exit(1); });
