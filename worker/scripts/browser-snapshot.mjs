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
    // Denemarken publiceert lang niet voor elk land een advies; voor ruim
    // negentig landen staat er een geldige pagina met "Vi har ingen
    // rejsevejledning for X". Dat is een antwoord, geen storing — het hoort
    // niet als mislukte ophaling geteld te worden en er valt niets te wachten.
    noAdvisoryText: /vi har ingen rejsevejledning/i,
  },
  no: {
    label: 'Noorwegen (Utenriksdept.)', flag: '🇳🇴', lang: 'no',
    // Cloudflare stuurt na een paar seconden zelf door — áls hij je doorlaat.
    // Alleen hier wachten we die kans af; bij de andere bronnen betekent een
    // blokkade meteen stoppen, want daar valt niets af te wachten.
    challengeWait: 25000,
    // mapping = "slug/nummer" → …/reiseinfo_{slug}/id{nummer}/ (zie norway.js)
    url: (m) => `https://www.regjeringen.no/no/tema/utenrikssaker/reiseinformasjon/velg-land/reiseinfo_${m.split('/')[0]}/id${m.split('/')[1] || ''}/`,
    readyText: /utenriksdepartementet|reiseinformasjon|innreise/i,
  },
  ch: {
    label: 'Zwitserland (EDA)', flag: '🇨🇭', lang: 'de',
    // mapping = "land/reisehinweise-fuer{land}.html". EDA verhuisde de
    // reisehinweise van /vertretungen-und-reisehinweise/ naar
    // /laender-reise-information/ — de oude URL viel terug op de generieke
    // overzichtspagina. Bij een generieke landing volgt hieronder een
    // zelfherstel-stap (link op naam zoeken).
    url: (m) => `https://www.eda.admin.ch/eda/de/home/laender-reise-information/${m}`,
    readyText: /reisehinweise|einschätzung|sicherheitslage|grundsätzliche/i,
    // Herken de generieke overzichtspagina zodat we die niet als advies opslaan.
    //
    // "Auswahl Länder und Territorien" staat er bewust bij: dát is de pagina
    // waar de directe URL sinds de verhuizing op uitkomt — de landenkiezer met
    // 203 zoekresultaten. Zonder die term sloeg de zelfherstel-stap hieronder
    // nooit aan en werd elke Zwitserse capture afgekeurd als "te weinig tekst
    // (552)", steeds datzelfde getal.
    genericText: /allgemeine reiseinformationen|reisehinweise kurz erklärt|auswahl länder und territorien|suchergebnisse/i,
    // Zelfherstel: op de index de link vinden die het land noemt.
    indexUrl: 'https://www.eda.admin.ch/eda/de/home/laender-reise-information.html',
  },
};

// Signalen dat we op een botcheck/lege pagina zitten — nooit opslaan.
//
// Let op de taalonafhankelijke termen. De Engelse zinnen alleen volstonden
// niet: Cloudflare vertaalt zijn wachtkamer mee met de browsertaal, en met een
// Deense locale kwam er "Et øjeblik ... Udfører sikkerhedsverificering" terug.
// Dat matchte nergens op, waardoor een blokkade als "te weinig tekst" werd
// geteld en de teller "0 botcheck" liet zien terwijl álles geblokkeerd was.
// "Ray ID" en "cf-chl" staan er in elke taal, en de challenge-pagina heeft
// altijd een element met id "challenge-".
const BLOCKED = /just a moment|performing security verification|attention required|access denied|cf-chl|verifying you are|robot|ray id|sikkerhedsverificering|sikkerhetsverifisering|sicherheitsüberprüfung|verifica di sicurezza|un momento|et øjeblik|ett ögonblick|einen moment/i;
const MIN_TEXT = 1200; // minder tekst dan dit is geen echt reisadvies

// De Cloudflare-wachtkamer zet zijn tekst in een iframe. document.body.innerText
// ziet daardoor alleen het omhulsel eromheen — vandaar dat een geblokkeerde
// Noorse pagina steeds als "te weinig tekst (265)" langskwam in plaats van als
// botcheck. De <title> ("Just a moment...") verraadt hem wél.

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
    return {
      sections: secs,
      title: document.title || '',
      fullText: (root.innerText || '').replace(/\s+/g, ' ').trim(),
    };
  });
}

const ACCEPT_LANG = { dk: 'da-DK,da;q=0.9', no: 'nb-NO,nb;q=0.9,no;q=0.8', ch: 'de-CH,de;q=0.9' };

async function captureOne(page, sid, iso, mapping) {
  const cfg = SOURCES[sid];
  await page.setExtraHTTPHeaders({ 'Accept-Language': ACCEPT_LANG[sid] || 'en-US,en;q=0.9' });
  let url = cfg.url(mapping);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // Zelfherstel bij URL-drift (EDA): landde de directe URL op de generieke
  // overzichtspagina, zoek dan op de index de link die dit land noemt en
  // navigeer daarheen. De landnaam (Duits) staat in de mapping-slug.
  let zelfherstel = null; // reden waarom de zelfherstel-stap niets opleverde
  if (cfg.genericText && cfg.indexUrl) {
    const bodyNow = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (cfg.genericText.test(bodyNow)) {
      const slug = String(mapping).split('/')[0]; // bijv. "irak"
      try {
        await page.goto(cfg.indexUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        // De landenlijst is een glossarium dat zijn resultaten nalaadt; een
        // vaste 1,5 seconde was soms te kort. Wachten tot er echt links staan.
        await page.waitForFunction(
          () => document.querySelectorAll('a[href*="laender-reise-information"]').length > 30,
          null, { timeout: 15000 },
        ).catch(() => {});
        const vondst = await page.evaluate((s) => {
          const links = [...document.querySelectorAll('a[href]')]
            .map((x) => x.getAttribute('href') || '')
            .filter((h) => /laender-reise-information|reisehinweise/i.test(h));
          const kaal = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
          const doel = kaal(s);
          const hit = links.find((h) => kaal(h).includes(doel))
            || links.find((h) => doel.length > 5 && kaal(h).includes(doel.slice(0, 6)));
          const alle = [...document.querySelectorAll('a[href]')].map((x) => x.getAttribute('href') || '');
          return {
            hit,
            aantal: links.length,
            voorbeeld: links.slice(0, 4),
            // Nul landlinks op een pagina met 203 zoekresultaten betekent dat
            // ze geen gewone <a> zijn. Laat zien wat er dan wél staat.
            totaal: alle.length,
            steekproef: alle.filter((h) => h && !h.startsWith('#')).slice(0, 6),
          };
        }, slug);
        if (vondst.hit) {
          url = new URL(vondst.hit, cfg.indexUrl).href;
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        } else {
          zelfherstel = `geen link voor "${slug}" · ${vondst.aantal} landlinks van ${vondst.totaal} links totaal · steekproef: ${(vondst.steekproef || []).join(' | ') || '(geen)'}`;
        }
      } catch (e) { zelfherstel = `index-zoektocht faalde: ${String(e.message).slice(0, 50)}`; }
    }
  }
  // SPA's en botchecks hebben even nodig; wacht tot het "klaar"-signaal in de
  // paginatekst staat (max ~20s), anders geven we op.
  //
  // Die 20 seconden zijn de duurste regel van dit script: juist bij een pagina
  // die tóch niets oplevert wordt de wachttijd altijd vólgemaakt. Bij 226
  // landen maal drie bronnen liep de run daardoor over de 120 minuten
  // job-timeout heen. Staat er na een korte eerste blik een harde blokkade,
  // dan heeft wachten geen zin en stoppen we meteen.
  let vroeg = await page.evaluate(() => `${document.title} ${document.body.innerText || ''}`.slice(0, 400)).catch(() => '');
  if (BLOCKED.test(vroeg) && cfg.challengeWait) {
    await page.waitForFunction(
      (re) => !new RegExp(re, 'i').test(`${document.title} ${document.body.innerText || ''}`.slice(0, 400)),
      BLOCKED.source, { timeout: cfg.challengeWait, polling: 1000 },
    ).catch(() => {});
    vroeg = await page.evaluate(() => `${document.title} ${document.body.innerText || ''}`.slice(0, 400)).catch(() => '');
  }
  if (BLOCKED.test(vroeg)) return { ok: false, reason: 'botcheck', monster: `«vroeg» ${vroeg.slice(0, 220)}` };
  if (cfg.noAdvisoryText && cfg.noAdvisoryText.test(vroeg)) return { ok: false, reason: 'bron publiceert hier geen advies' };
  try {
    await page.waitForFunction(
      (re) => new RegExp(re, 'i').test(document.body.innerText || ''),
      cfg.readyText.source, { timeout: 20000 },
    );
  } catch { /* readyText niet gezien — checks hieronder beslissen */ }
  await page.waitForTimeout(1500);

  const { sections, title, fullText } = await extractSections(page);
  // Uitsnede meesturen: bij een afgekeurde capture is "te weinig tekst" alleen
  // een getal, en dan is niet te zien wát er dan wél stond.
  const monster = `«${title}»${zelfherstel ? ` [zelfherstel: ${zelfherstel}]` : ''} ${fullText.slice(0, 200)}`;
  if (BLOCKED.test(fullText) || BLOCKED.test(title)) return { ok: false, reason: 'botcheck', monster };
  if (cfg.genericText && cfg.genericText.test(fullText) && !cfg.readyText.test(fullText.replace(cfg.genericText, ''))) {
    return { ok: false, reason: 'generieke pagina (geen landadvies)', monster };
  }
  if (fullText.length < MIN_TEXT) return { ok: false, reason: `te weinig tekst (${fullText.length})`, monster };

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

/**
 * Eenmalige peiling: is de Noorse reisadvies-RSS vanaf déze machine te halen?
 *
 * regjeringen.no blokkeert datacenter-IP's op de adviespagina's zelf, maar het
 * blijkt pad-uitzonderingen te hebben: /no/rss/Rss/ komt wél langs de
 * Cloudflare-check (al geeft dat endpoint een lege feed terug). De echte
 * reisadvies-feed staat op /no/aktuelt/rss/ en is vanaf een Anthropic-IP 403,
 * ook als je je netjes als feedlezer meldt. Een GitHub-runner is een ander IP
 * en dat pad is daar nog nooit geprobeerd.
 *
 * Levert het items op, dan hebben we zonder één adviespagina te openen wél in
 * beeld welk land wanneer is bijgewerkt — precies wat Recente wijzigingen nodig
 * heeft. Faalt het, dan weten we dat ook, en kost het één regel logboek.
 */
async function peilNoorseRss() {
  const feeds = [
    ['aktuelt (gefilterd)', 'https://www.regjeringen.no/no/aktuelt/rss/id2581966/?documenttype=reiseinformasjon&ownerid=833&term='],
    ['aktuelt (ongefilterd)', 'https://www.regjeringen.no/no/aktuelt/rss/id2581966/'],
    ['gewhitelist pad', 'https://www.regjeringen.no/no/rss/Rss/id2581966/?documenttype=reiseinformasjon&ownerid=833&term='],
  ];
  for (const [naam, url] of feeds) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'ReisadviezenBuddy/1.0 (+https://github.com/JGNWW/Reisadviezen-buddy)',
          Accept: 'application/rss+xml, application/xml;q=0.9',
        },
      });
      const tekst = await res.text();
      const items = (tekst.match(/<item>/g) || []).length;
      const eerste = (tekst.match(/<item>[\s\S]*?<title>([^<]*)<\/title>/) || [])[1] || '';
      const datum = (tekst.match(/<item>[\s\S]*?<pubDate>([^<]*)<\/pubDate>/) || [])[1] || '';
      console.log(`RSS ${naam}: ${res.status} · ${tekst.length} bytes · ${items} items${eerste ? ` · eerste: "${eerste.slice(0, 60)}" (${datum})` : ''}`);
    } catch (e) {
      console.log(`RSS ${naam}: fout — ${String(e.message).slice(0, 60)}`);
    }
  }
}

async function main() {
  mkdirSync(LATEST_DIR, { recursive: true });
  await peilNoorseRss();
  const only = (process.env.COUNTRIES || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const isoList = Object.keys(countries).filter((k) => /^[A-Z]{3}$/.test(k))
    .filter((iso) => !only.length || only.includes(iso));
  const today = new Date().toISOString().slice(0, 10);

  // channel 'chromium' start de volledige Chromium met de nieuwe headless-modus.
  // Zonder die optie pakt Playwright chrome-headless-shell: een uitgeklede
  // build die zich op tientallen punten anders gedraagt dan een echte browser
  // en door Cloudflare als zodanig herkend wordt. Lukt de volledige build niet
  // (niet geïnstalleerd), dan gewoon de standaard — dan werkt de rest nog.
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chromium', args: ['--no-sandbox'] });
    console.log('browser: volledige Chromium (channel chromium)');
  } catch (e) {
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    console.log(`browser: standaard headless — volledige build niet beschikbaar (${String(e.message).slice(0, 60)})`);
  }
  // De useragent moet bij de binary passen. Er stond Chrome/126 terwijl de
  // runner inmiddels 151 draait; zo'n verschil tussen wat je zegt te zijn en
  // wat je bent, is zelf een botsignaal.
  const versie = (browser.version() || '').match(/(\d+)/)?.[1] || '131';
  const ctx = await browser.newContext({
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${versie}.0.0.0 Safari/537.36`,
    // Nederlands als neutrale grondtaal; per bron wordt de juiste
    // Accept-Language hieronder gezet. Eerder stond hier voor álle drie de
    // bronnen 'da-DK', dus vroeg de capture een Noorse en een Zwitserse pagina
    // in het Deens op.
    locale: 'nl-NL',
    viewport: { width: 1280, height: 900 },
  });
  console.log(`browserversie: ${browser.version()}`);
  const page = await ctx.newPage();

  const stats = { saved: 0, kept: 0, blocked: 0, nomapping: 0, geenadvies: 0 };
  // Hooguit twee uitsnedes per bron: genoeg om te zien wat er misgaat, zonder
  // het logboek vol te zetten met 226 keer hetzelfde.
  const getoond = new Map();
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
          stats[r.reason === 'botcheck' ? 'blocked'
            : r.reason.startsWith('bron publiceert') ? 'geenadvies' : 'kept']++;
          console.log(`  ${iso}/${sid}: overslaan (${r.reason}) — vorige snapshot blijft`);
          const n = getoond.get(sid) || 0;
          if (r.monster && n < 2) { getoond.set(sid, n + 1); console.log(`      wat er stond: ${r.monster}`); }
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
  console.log(`\nBrowser-snapshot klaar: ${stats.saved} opgeslagen, ${stats.kept} behouden/gefaald, ${stats.blocked} botcheck, ${stats.geenadvies} bron heeft hier geen advies, ${stats.nomapping} zonder mapping.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
