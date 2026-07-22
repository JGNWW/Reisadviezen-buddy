/**
 * ONTDEKKING (wegwerp): welke bronnen publiceren per land een gekleurde
 * risicokaart waar de pixel-methode (zoals bij France) op toepasbaar is?
 *
 * Voor elke bron × testland: haal via de bestaande adapter de landpagina-URL
 * (en een eventueel al-herkende mapUrl) op, render de pagina met Chromium,
 * verzamel de afbeeldingen ≥140px, en pixel-sample de grootste kandidaat.
 * Rapporteer per bron de kleurverdeling zodat we kunnen zien of er een
 * gekleurde kaart is die per land varieert (rood voor Afghanistan, groen voor
 * Japan) — dat onderscheidt een risicokaart van een locator/decoratie.
 *
 * Puur diagnostisch; schrijft niets naar data/.
 *
 *   cd worker && SOURCES=ca,au,ie node scripts/map-discovery.mjs
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import countries from '../src/data/countries.json' with { type: 'json' };
import * as uk from '../src/adapters/uk.js';
import * as us from '../src/adapters/us.js';
import * as canada from '../src/adapters/canada.js';
import * as ireland from '../src/adapters/ireland.js';
import * as australia from '../src/adapters/australia.js';
import * as spain from '../src/adapters/spain.js';
import * as germany from '../src/adapters/germany.js';
import * as newzealand from '../src/adapters/newzealand.js';
import * as denmark from '../src/adapters/denmark.js';
import * as japan from '../src/adapters/japan.js';
import * as italy from '../src/adapters/italy.js';
import * as finland from '../src/adapters/finland.js';
import * as southkorea from '../src/adapters/southkorea.js';
import * as austria from '../src/adapters/austria.js';
import { sampleMapImage } from './lib/sample-map.mjs';

// Alle bronnen behalve fr/uk (al gedaan) en no/ch (botcheck — geen zin).
const ADAPTERS = {
  us, ca: canada, ie: ireland, au: australia, es: spain, de: germany,
  nz: newzealand, dk: denmark, jp: japan, it: italy, fi: finland,
  kr: southkorea, at: austria,
};

// Testlanden: één zwaar-rood, één gemengd, één "normaal" — zo zien we of de
// kaartkleur per land verschilt (= echte risicokaart) of niet (= decoratie).
const TESTS = ['AFG', 'THA', 'JPN'];

/** Verzamel afbeeldingen ≥140px uit de gerenderde pagina. */
async function pageImages(page) {
  return page.evaluate(() => {
    const rectOf = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
    return [...document.querySelectorAll('img')]
      .map((i) => ({ src: i.currentSrc || i.src, alt: (i.alt || '').slice(0, 40), ...rectOf(i) }))
      .filter((i) => i.src && i.w >= 140 && i.h >= 140 && !/^data:/.test(i.src))
      .sort((a, b) => b.w * b.h - a.w * a.h)
      .slice(0, 6);
  });
}

function pct(cls) {
  const land = cls.rood + cls.oranje + cls.geel + cls.groen + cls.wit;
  const t = land || 1;
  return `rood ${(100 * cls.rood / t).toFixed(0)}% oranje ${(100 * cls.oranje / t).toFixed(0)}% geel ${(100 * cls.geel / t).toFixed(0)}% groen ${(100 * cls.groen / t).toFixed(0)}% wit ${(100 * cls.wit / t).toFixed(0)}% | zee ${cls.blauw} grijs ${cls.grijs}`;
}

async function main() {
  const onlyS = (process.env.SOURCES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const sources = Object.keys(ADAPTERS).filter((s) => !onlyS.length || onlyS.includes(s));

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1400, height: 1200 },
  });
  const page = await ctx.newPage();

  for (const sid of sources) {
    console.log(`\n======== ${sid} (${ADAPTERS[sid].meta?.label || sid}) ========`);
    for (const iso of TESTS) {
      const rec = countries[iso];
      const slug = rec?.sources?.[sid];
      if (!slug) { console.log(`  ${iso}: geen mapping`); continue; }
      let adv = null;
      try { adv = await ADAPTERS[sid].getAdvisory(slug, { iso, en: rec.en, nl: rec.nl }); }
      catch (e) { console.log(`  ${iso}: getAdvisory faalde (${String(e.message).slice(0, 50)})`); }

      const pageUrl = adv?.url || null;
      const mapUrl = adv?.mapUrl || null;
      let imgs = [];
      if (pageUrl) {
        try {
          await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
          await page.waitForTimeout(2500);
          imgs = await pageImages(page);
        } catch (e) { console.log(`  ${iso}: render faalde (${String(e.message).slice(0, 40)})`); }
      }
      // Kandidaat om te samplen: expliciete mapUrl, anders de grootste img.
      const candidate = mapUrl || imgs[0]?.src || null;
      console.log(`  ${iso}: pagina=${pageUrl ? 'ok' : 'geen'}  mapUrl=${mapUrl ? 'JA' : 'nee'}  imgs≥140px=${imgs.length}`);
      for (const im of imgs.slice(0, 4)) console.log(`      img ${im.w}x${im.h} alt="${im.alt}" ${im.src.slice(0, 95)}`);
      if (candidate) {
        const s = await sampleMapImage(page, candidate);
        if (s.error) console.log(`      → sample fout: ${s.error}`);
        else console.log(`      → sample ${s.w}x${s.h}: ${pct(s.cls)}`);
      }
      await page.waitForTimeout(600);
    }
  }

  await browser.close();
  console.log('\nOntdekking klaar.');
}

main().catch((e) => { console.error(e); process.exit(1); });
