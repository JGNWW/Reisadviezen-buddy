/**
 * map-colors — leidt per land de kleurcode af uit de officiële zonekaart van
 * bronnen die zo'n kaart publiceren, en schrijft dat naar
 * worker/data/mapcolors/{ISO3}.json. De Worker gebruikt dit als
 * kleur-override zodat de kleurwaardering strookt met wat de bron zélf op de
 * kaart tekent (preciezer dan tekst-parsing).
 *
 * Bronnen met een per-land zonekaart:
 *   fr — France Diplomatie "carte des zones de vigilance" (altijd aanwezig).
 *   uk — FCDO toont een kaart wanneer er "advise against travel"-gebieden
 *        zijn; bij een normaal land is er geen kaart (dan slaan we 'm over).
 *
 * Decoderen kan de Worker niet (geen image-decoder); daarom draait dit in
 * GitHub Actions met Playwright-Chromium (map-colors.yml), wekelijks +
 * handmatig. Een mislukte/onbetrouwbare bemonstering laat de vorige waarde
 * intact (degraded-guard).
 *
 * Handmatig: cd worker && COUNTRIES=IRQ,UKR,THA SOURCES=fr,uk node scripts/map-colors.mjs
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import countries from '../src/data/countries.json' with { type: 'json' };
import * as france from '../src/adapters/france.js';
import * as uk from '../src/adapters/uk.js';
import * as canada from '../src/adapters/canada.js';
import * as austria from '../src/adapters/austria.js';
import { deriveMapAssessment } from '../src/analysis/map-palette.js';
import { sampleMapImage } from './lib/sample-map.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'data', 'mapcolors');

// Bronnen die per land een gekleurde zonekaart publiceren. resolveMapUrl(slug)
// → kaart-URL|null.
//
// trustBaseline: mag de uit de kaart afgeleide landelijke basislijn de
// bronkleur overschrijven?
//   fr — ja: de France-kaart is strak op het land gecropt, dus de
//        kleurverdeling geeft de landelijke basislijn betrouwbaar weer.
//   uk/ca/at — nee: deze kaarten zijn een losse "sheet"/regionale uitsnede met
//        veel witte marge (het land beslaat maar een deel van het beeld),
//        waardoor de basislijn structureel te laag uitvalt. De (verzadigde)
//        zones zijn wél betrouwbaar, dus de kaart verhoogt bij deze bronnen
//        alleen het regionale maximum; de landelijke kleur blijft die van de
//        bron zelf (UK alert_status, Canada advisory-state, AT Sicherheitsstufe).
//
// Onderzocht maar NIET bruikbaar (geen per-land gekleurde statische kaart):
//   es — één vaste wereldkaart (identiek voor elk land);
//   de/fi/nz — alleen decoratieve foto's/logo's;
//   it — interactieve Leaflet met OSM-tegels (zones zijn vector-overlays);
//   us/ie/jp/dk — geen statische kaartafbeelding (JS-gerenderd/SPA);
//   kr — bron blokkeert datacenter-IP's (niet te bemonsteren in CI).
const MAP_SOURCES = {
  fr: { adapter: france, label: 'France Diplomatie', trustBaseline: true },
  uk: { adapter: uk, label: 'FCDO', trustBaseline: false },
  ca: { adapter: canada, label: 'Canada (GAC)', trustBaseline: false },
  at: { adapter: austria, label: 'Oostenrijk (BMEIA)', trustBaseline: false },
};

const round = (n) => Math.round(n * 1000) / 1000;

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const onlyC = (process.env.COUNTRIES || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const onlyS = (process.env.SOURCES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const sources = Object.keys(MAP_SOURCES).filter((s) => !onlyS.length || onlyS.includes(s));
  const isoList = Object.keys(countries).filter((k) => /^[A-Z]{3}$/.test(k))
    .filter((iso) => !onlyC.length || onlyC.includes(iso));
  const today = new Date().toISOString().slice(0, 10);

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();

  const stats = { saved: 0, geen_kaart: 0, mislukt: 0, behouden: 0, nomapping: 0 };
  for (const iso of isoList) {
    const rec = countries[iso];
    const file = path.join(OUT_DIR, `${iso}.json`);
    const doc = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { iso3: iso, updatedAt: null, sources: {} };
    let changed = false;

    for (const sid of sources) {
      const slug = rec.sources?.[sid];
      if (!slug) { stats.nomapping++; continue; }
      try {
        const mapUrl = await MAP_SOURCES[sid].adapter.resolveMapUrl(slug);
        if (!mapUrl) { stats.geen_kaart++; console.log(`  ${iso}/${sid}: geen kaart`); continue; }

        const sample = await sampleMapImage(page, mapUrl, process.env.DIAG_GRID ? { grid: 32 } : {});
        if (sample.error) { stats.mislukt++; console.log(`  ${iso}/${sid}: bemonstering faalde (${sample.error}) — vorige blijft`); continue; }

        const a = deriveMapAssessment(sample.cls);
        if (!a) { stats.mislukt++; console.log(`  ${iso}/${sid}: te weinig land-pixels — vorige blijft`); continue; }

        doc.sources[sid] = {
          baselineLevel: a.baselineLevel,
          regionalMaxLevel: a.regionalMaxLevel,
          color: a.color,
          regionalColor: a.regionalColor,
          levelLabel: a.levelLabel,
          hasRegionalWarnings: a.hasRegionalWarnings,
          trustBaseline: !!MAP_SOURCES[sid].trustBaseline,
          shares: { rood: round(a.shares.rood), oranje: round(a.shares.oranje), geel: round(a.shares.geel), wit: round(a.shares.wit) },
          landPixels: a.landPixels,
          mapUrl,
          capturedAt: today,
        };
        doc.updatedAt = today;
        changed = true;
        stats.saved++;
        console.log(`  ${iso}/${sid}: ${a.color}${a.hasRegionalWarnings ? ` (regio ${a.regionalColor})` : ''} · basis niveau ${a.baselineLevel}`);
        if (process.env.DIAG) {
          const sh = a.shares;
          console.log(`    ↳ ${mapUrl}`);
          console.log(`    ↳ aandeel: rood ${(sh.rood * 100).toFixed(1)}% oranje ${(sh.oranje * 100).toFixed(1)}% geel ${(sh.geel * 100).toFixed(1)}% wit ${(sh.wit * 100).toFixed(1)}%`);
          console.log(`    ↳ top-kleuren: ${(sample.top || []).map((t) => `rgb(${t.rgb.join(',')})×${t.n}`).join('  ')}`);
          if (sample.gridStr) console.log(`    ↳ plattegrond (R=rood O=oranje G=geel g=groen .=wit ~=zee/blauw #=grijs):\n${sample.gridStr.split('\n').map((l) => '      ' + l).join('\n')}`);
        }
      } catch (e) {
        stats.behouden++;
        console.log(`  ${iso}/${sid}: fout (${String(e.message).slice(0, 60)}) — vorige blijft`);
      }
      await page.waitForTimeout(400); // hoffelijk naar de bronsites
    }
    if (changed) writeFileSync(file, JSON.stringify(doc));
  }

  await browser.close();
  console.log(`\nmap-colors klaar: ${stats.saved} opgeslagen, ${stats.geen_kaart} zonder kaart, ${stats.mislukt} onbruikbaar, ${stats.behouden} fout/behouden, ${stats.nomapping} zonder mapping.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
