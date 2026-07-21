/**
 * Browser-snapshots voor bronnen die serverside niet op te halen zijn:
 *
 *   dk — um.dk is een React-SPA; de inhoud komt uit een auth-vergrendelde
 *        API en staat dus niet in de kale HTML (alleen een browser ziet 'm).
 *   no — regjeringen.no zet een Cloudflare-botcheck voor élk verzoek;
 *        een echte Chromium komt daar (soms) wel doorheen.
 *   ch — eda.admin.ch levert datacenter-clients een lege/generieke pagina;
 *        met een echte browser is de kans op de echte inhoud het grootst.
 *
 * Draait in GitHub Actions (browser-snapshot.yml) met Playwright-Chromium:
 * rendert de pagina, leest de zichtbare tekst + koppenstructuur, laat de
 * bestaande analyse-engine er het niveau uit halen en schrijft het resultaat
 * in worker/data/latest/{ISO3}.json — hetzelfde vangnet dat de Worker al
 * serveert wanneer live ophalen faalt. Een mislukte of verdachte capture
 * (botcheck, te weinig tekst) laat de vorige snapshot intact.
 *
 * Handmatig: cd worker && COUNTRIES=BHR,IRQ node scripts/browser-snapshot.mjs
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import countries from '../src/data/countries.json' with { type: 'json' };
import { analyzeAdvisory } from '../src/analysis/analysis-engine.js';
import { classifyTheme } from '../src/lib/themes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LATEST_DIR = path.join(__dirname, '..', 'data', 'latest');

// Per bron: URL uit de bestaande mapping, taal, en een "klaar"-signaal.
const SOURCES = {
  dk: {
    label: 'Denemarken (Udenrigsministeriet)', flag: '🇩🇰', lang: 'da',
    url: (m) => `https://um.dk/rejse-og-ophold/rejse-til-udlandet/rejsevejledninger/${m}`,
    // SPA: wachten tot de app echt inhoud heeft neergezet.
    readyText: /rejsevejledning|sikkerhed|indrejse/i,
  },
  no: {
    label: 'Noorwegen (Utenriksdept.)', flag: '🇳🇴', lang: 'no',
    // mapping = "slug/nummer" → …/reiseinfo_{slug}/id{nummer}/ (zie norway.js)
    url: (m) => `https://www.regjeringen.no/no/tema/utenrikssaker/reiseinformasjon/velg-land/reiseinfo_${m.split('/')[0]}/id${m.split('/')[1] || ''}/`,
    readyText: /utenriksdepartementet|reiseinformasjon|innreise/i,
  },
  ch: {
    label: 'Zwitserland (EDA)', flag: '🇨🇭', lang: 'de',
    // mapping = "land/reisehinweise-fuer{land}.html" (zie switzerland.js)
    url: (m) => `https://www.eda.admin.ch/eda/de/home/vertretungen-und-reisehinweise/${m}`,
    readyText: /reisehinweise|einschätzung|sicherheit/i,
  },
};

// Signalen dat we op een botcheck/lege pagina zitten — nooit opslaan.
const BLOCKED = /just a moment|performing security verification|attention required|access denied|cf-chl|verifying you are|robot/i;
const MIN_TEXT = 1200; // minder tekst dan dit is geen echt reisadvies

/** Kopstructuur uit de gerenderde DOM → secties voor de analyse-engine. */
async function extractSections(page) {
  return page.evaluate(() => {
    const root = document.querySelector('main') || document.body;
    const heads = [...root.querySelectorAll('h1,h2,h3')];
    const secs = [];
    for (let i = 0; i < heads.length; i++) {
      const h = heads[i];
      let text = '';
      for (let n = h.nextElementSibling; n && !/^H[1-3]$/.test(n.tagName); n = n.nextElementSibling) {
        // koppen op lagere niveaus + inhoud gewoon meenemen als tekst
        text += ' ' + (n.innerText || '');
      }
      text = text.replace(/\s+/g, ' ').trim();
      if (text.length > 30) secs.push({ heading: (h.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140), text });
    }
    return { sections: secs, fullText: (root.innerText || '').replace(/\s+/g, ' ').trim() };
  });
}

async function captureOne(page, sid, iso, mapping) {
  const cfg = SOURCES[sid];
  const url = cfg.url(mapping);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  // SPA's en botchecks hebben even nodig; wacht tot het "klaar"-signaal in de
  // paginatekst staat (max ~20s), anders geven we op.
  try {
    await page.waitForFunction(
      (re) => new RegExp(re, 'i').test(document.body.innerText || ''),
      cfg.readyText.source, { timeout: 20000 },
    );
  } catch { /* readyText niet gezien — checks hieronder beslissen */ }
  await page.waitForTimeout(1500);

  const { sections, fullText } = await extractSections(page);
  if (BLOCKED.test(fullText) || fullText.length < MIN_TEXT) {
    return { ok: false, reason: BLOCKED.test(fullText) ? 'botcheck' : `te weinig tekst (${fullText.length})` };
  }

  const themes = sections.map((s) => ({
    category: s.heading, heading: s.heading,
    themeId: classifyTheme(s.heading, s.text), text: s.text.slice(0, 20000),
  }));
  const assessment = analyzeAdvisory({
    sections: themes, lang: cfg.lang, countryName: countries[iso]?.en || iso,
  });

  return {
    ok: true,
    adv: {
      source: sid, sourceLabel: cfg.label, flag: cfg.flag,
      name: countries[iso]?.en || null, url,
      lastModified: null, updateNote: null,
      level: assessment.level, color: assessment.color, levelLabel: assessment.levelLabel,
      regionalMaxLevel: assessment.regionalMaxLevel, hasRegionalWarnings: !!assessment.hasRegionalWarnings,
      regionalBreakdown: assessment.regionalBreakdown || [], regionalCoverage: assessment.regionalCoverage ?? null,
      regions: assessment.regions || null, confidence: assessment.confidence ?? null,
      assessmentStatus: assessment.assessmentStatus ?? null,
      hasMap: false, lang: cfg.lang, themes,
      capturedWith: 'browser',
    },
  };
}

async function main() {
  mkdirSync(LATEST_DIR, { recursive: true });
  const only = (process.env.COUNTRIES || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const isoList = Object.keys(countries).filter((k) => /^[A-Z]{3}$/.test(k))
    .filter((iso) => !only.length || only.includes(iso));
  const today = new Date().toISOString().slice(0, 10);

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'da-DK',
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();

  const stats = { saved: 0, kept: 0, blocked: 0, nomapping: 0 };
  for (const iso of isoList) {
    const rec = countries[iso];
    const file = path.join(LATEST_DIR, `${iso}.json`);
    const latest = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { iso3: iso, fetchedAt: {}, sources: {} };
    let changed = false;

    for (const sid of Object.keys(SOURCES)) {
      const mapping = rec.sources?.[sid];
      if (!mapping) { stats.nomapping++; continue; }
      try {
        const r = await captureOne(page, sid, iso, mapping);
        if (!r.ok) {
          stats[r.reason === 'botcheck' ? 'blocked' : 'kept']++;
          console.log(`  ${iso}/${sid}: overslaan (${r.reason}) — vorige snapshot blijft`);
          continue;
        }
        // Verdedigingslinie: een capture zonder niveau mag een eerdere mét
        // niveau nooit overschrijven (zelfde degraded-principe als snapshot-foreign).
        const prev = latest.sources[sid];
        if (prev && prev.level != null && r.adv.level == null) {
          stats.kept++;
          console.log(`  ${iso}/${sid}: nieuw=zonder niveau, oud=met — oude blijft`);
          continue;
        }
        latest.sources[sid] = r.adv;
        latest.fetchedAt[sid] = today;
        changed = true;
        stats.saved++;
        console.log(`  ${iso}/${sid}: ${r.adv.color || 'onzeker'}${r.adv.level ? ` (${r.adv.level})` : ''} · ${r.adv.themes.length} secties`);
      } catch (e) {
        stats.kept++;
        console.log(`  ${iso}/${sid}: fout (${String(e.message).slice(0, 60)}) — vorige blijft`);
      }
      await page.waitForTimeout(1200); // hoffelijk naar de bronsites
    }
    if (changed) writeFileSync(file, JSON.stringify(latest));
  }

  await browser.close();
  console.log(`\nBrowser-snapshot klaar: ${stats.saved} opgeslagen, ${stats.kept} behouden/gefaald, ${stats.blocked} botcheck, ${stats.nomapping} zonder mapping.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
