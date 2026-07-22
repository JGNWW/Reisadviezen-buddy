/**
 * ONTDEKKING v3 (wegwerp): plain fetch geeft 403, maar een echte browser
 * rendert de volledige crisis-pagina (~1,5M tekens, alle landen). Deze probe
 * laadt met Chromium en dumpt de per-land DOM-structuur zodat we een parser
 * kunnen bouwen: voor een paar landen het kop-element (tag/class), de
 * blok-tekst en welke standaardformule erin staat + het totale aantal
 * landsecties.
 */
import { chromium } from 'playwright';

const URL_DE = 'https://www.eda.admin.ch/crisis/de/reisehinweise';
const PHRASES = [
  [/von reisen (in dieses land |dringend )?wird abgeraten|wird von reisen abgeraten/i, 4, 'abgeraten→rood'],
  [/von (nicht dringend notwendigen|touristischen) reisen wird abgeraten/i, 3, 'nicht-dringend→oranje'],
  [/der pers[öo]nlichen sicherheit ist (erh[öo]hte |grosse )?aufmerksamkeit zu schenken/i, 2, 'aufmerksamkeit→geel'],
  [/grunds[äa]tzlich als sicher/i, 1, 'sicher→groen'],
];

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

  // Structuur onderzoeken vanuit de gerenderde DOM.
  const info = await page.evaluate((names) => {
    const out = { total: {}, samples: [] };
    // Tel kandidaat-containers per selector (welke groepeert de landen?).
    for (const sel of ['.panel', '.accordion-item', '.accordion__item', 'article', 'section', 'details', 'li.country', '[id^="country"]', '.country']) {
      out.total[sel] = document.querySelectorAll(sel).length;
    }
    // Voor een paar testlanden: vind het kop-element en het omringende blok.
    const walkUp = (el) => {
      let n = el;
      for (let i = 0; i < 6 && n; i++) {
        if (/panel|accordion|country|item|card|section|details/i.test(n.className || '') || /country/i.test(n.id || '') || n.tagName === 'DETAILS' || n.tagName === 'SECTION') return n;
        n = n.parentElement;
      }
      return el.parentElement || el;
    };
    for (const name of names) {
      // Zoek een element waarvan de eigen tekst (kort) exact de landnaam is.
      const cand = [...document.querySelectorAll('h1,h2,h3,h4,h5,a,button,summary,span,div,strong')]
        .find((e) => (e.textContent || '').trim() === name && (e.textContent || '').trim().length < 40);
      if (!cand) { out.samples.push({ name, found: false }); continue; }
      const block = walkUp(cand);
      out.samples.push({
        name, found: true,
        headTag: cand.tagName.toLowerCase(), headClass: (cand.className || '').slice(0, 60),
        blockTag: block.tagName.toLowerCase(), blockClass: (block.className || '').slice(0, 80), blockId: (block.id || '').slice(0, 40),
        blockText: (block.innerText || '').replace(/\s+/g, ' ').slice(0, 700),
      });
    }
    return out;
  }, ['Afghanistan', 'Thailand', 'Japan', 'Ukraine', 'Deutschland']);

  console.log('Container-tellingen (welke selector groepeert landen?):');
  for (const [sel, n] of Object.entries(info.total)) console.log(`  ${sel}: ${n}`);

  for (const s of info.samples) {
    console.log(`\n===== ${s.name} =====`);
    if (!s.found) { console.log('  kop niet gevonden'); continue; }
    console.log(`  kop: <${s.headTag} class="${s.headClass}">`);
    console.log(`  blok: <${s.blockTag} class="${s.blockClass}" id="${s.blockId}">`);
    const hit = PHRASES.find(([re]) => re.test(s.blockText));
    console.log(`  formule in blok: ${hit ? hit[2] : 'geen'}`);
    console.log(`  bloktekst: ${s.blockText}`);
  }

  await browser.close();
  console.log('\nProbe klaar.');
}

main().catch((e) => { console.error(e); process.exit(1); });
