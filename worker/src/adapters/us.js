/**
 * Verenigde Staten — State Department (travel.state.gov).
 *
 * De per-land HTML-pagina's zitten achter Akamai en geven datacenter-IP's
 * (Cloudflare Workers én GitHub-runners) een harde 403 — waardoor de VS in de
 * vergelijking structureel ontbrak, ook in het snapshot-vangnet. De officiële
 * RSS-feed met álle reisadviezen is daarentegen NIET geblokkeerd en bevat per
 * land het niveau (in de titel), de adviestekst (in de description) en de
 * canonieke URL. We halen die feed één keer op (±760 kB, gecachet per isolate)
 * en zoeken het land op via de ISO3- of slug-verwijzing in de item-link.
 */
import { htmlToText, splitByHeadings } from '../lib/html.js';
import { getText } from '../lib/fetch.js';
import { classifyTheme } from '../lib/themes.js';
import { analyzeAdvisory } from '../analysis/analysis-engine.js';

const RSS = 'https://travel.state.gov/_res/rss/TAsTWs.xml';

export const meta = { id: 'us', label: 'Verenigde Staten (State Dept)', flag: '🇺🇸', lang: 'en' };

const decodeEntities = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, '’').replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();

// De feed bevat alle 220 landen; één ophaling per isolate-leven volstaat en
// scheelt bij een uitdraai van 15 landen 14 identieke downloads. Korte TTL
// zodat een niveauwijziging binnen het kwartier doorkomt.
let _cache = { at: 0, items: null };
async function rssItems() {
  if (_cache.items && Date.now() - _cache.at < 15 * 60 * 1000) return _cache.items;
  let xml;
  try { xml = await getText(RSS); } catch { xml = null; }
  if (!xml) return _cache.items; // hik: hou de vorige cache (mogelijk null)
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const seg = m[1];
    const g = (re) => { const x = seg.match(re); return x ? x[1] : ''; };
    items.push({
      title: decodeEntities(g(/<title>([\s\S]*?)<\/title>/)),
      link: g(/<link>([\s\S]*?)<\/link>/).trim(),
      descHtml: decodeEntities(g(/<description>([\s\S]*?)<\/description>/)),
      pub: g(/<pubDate>([\s\S]*?)<\/pubDate>/).trim(),
    });
  }
  _cache = { at: Date.now(), items };
  return items;
}

/**
 * @param slug  de VS-mapping uit countries.json (bijv. "oman", "qatar")
 * @param ctx   {iso, en} — ISO3 en Engelse landnaam, voor het matchen
 */
export async function getAdvisory(slug, ctx = {}) {
  const items = await rssItems();
  if (!items || !items.length) return null;
  const iso = String(ctx.iso || '').toLowerCase();
  const en = String(ctx.en || '').toLowerCase();
  const sl = String(slug || '').toLowerCase();

  // Match op de item-link: sommige landen gebruiken destination.{iso3}.html,
  // andere {slug}-travel-advisory.html. De titelnaam is de laatste terugval.
  const hit = items.find((it) => {
    const link = it.link.toLowerCase();
    return (iso && link.includes(`destination.${iso}.html`)) ||
      (sl && link.includes(`/${sl}-travel-advisory.html`)) ||
      (en && it.title.toLowerCase().startsWith(`${en} - level`));
  });
  if (!hit) return null;

  const url = hit.link;
  const lastModified = hit.pub && !isNaN(Date.parse(hit.pub)) ? new Date(hit.pub).toISOString() : null;

  // De description is samenvattende HTML; splits op eventuele koppen, anders
  // één blok. De engine haalt regionale "Some areas / Do not travel to"-details
  // uit deze tekst.
  const themes = [];
  const secs = splitByHeadings(hit.descHtml).filter((s) => s.text && s.text.length > 30);
  if (secs.length) {
    for (const s of secs) themes.push({
      category: 'Travel advisory', heading: s.heading || 'Country summary',
      themeId: classifyTheme(s.heading || 'safety security', s.text), html: s.html, text: s.text, url,
    });
  } else {
    const text = htmlToText(hit.descHtml);
    if (text) themes.push({ category: 'Travel advisory', heading: 'Country summary', themeId: classifyTheme('safety security', text), html: hit.descHtml, text, url });
  }

  // Landelijk niveau uit de titel ("<Land> - Level N: <label>"): die bevat de
  // "Level N"-formulering die de engine als gestructureerd bewijs herkent.
  const assessment = analyzeAdvisory({
    sections: themes,
    lang: 'en',
    structured: { kind: 'us_level_heading', value: hit.title },
    countryName: ctx.en || sl.replace(/-/g, ' '),
  });

  return {
    source: meta.id,
    sourceLabel: meta.label,
    flag: meta.flag,
    name: hit.title.split(' - ')[0] || null,
    url,
    lastModified,
    updateNote: null,
    level: assessment.level,
    color: assessment.color,
    levelLabel: assessment.levelLabel,
    regionalMaxLevel: assessment.regionalMaxLevel,
    hasRegionalWarnings: assessment.hasRegionalWarnings,
    regionalBreakdown: assessment.regionalBreakdown,
    regionalCoverage: assessment.regionalCoverage,
    regions: assessment.regions,
    confidence: assessment.confidence,
    assessmentStatus: assessment.assessmentStatus,
    hasMap: false,
    themes,
    fullText: themes.map((t) => t.text).join('\n'),
  };
}
