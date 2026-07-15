/**
 * Japan — Ministry of Foreign Affairs (MOFA), 海外安全ホームページ
 * (anzen.mofa.go.jp). MOFA hanteert vier vaste niveaus die 1-op-1 op onze
 * schaal passen:
 *
 *   レベル1 十分注意してください            (1, groen-achtig: opletten)
 *   レベル2 不要不急の渡航は止めてください   (2)
 *   レベル3 渡航は止めてください（渡航中止勧告）(3)
 *   レベル4 退避してください（退避勧告）      (4)
 *
 * De landenpagina (pcinfectionspothazardinfo_{num}.html — {num} is MOFA's
 * eigen 3-cijferige landnummer uit src/data/mofa-jp.json) toont het
 * 【危険レベル】-blok met per gebied een niveau (●全土 = hele land,
 * ●その他の地域 = elders); de gekoppelde detailpagina
 * (pchazardspecificinfo_*.html) bevat de volledige adviestekst (概況,
 * 地域情勢, …). Niveau-interpretatie gebeurt — zoals bij alle bronnen — in
 * de analyse-engine (structured kind 'jp_hazard_levels').
 */
import { parse } from 'node-html-parser';
import { getText } from '../lib/fetch.js';
import { htmlToText } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { analyzeAdvisory } from '../analysis/analysis-engine.js';

const SITE = 'https://www.anzen.mofa.go.jp';

export const meta = { id: 'jp', label: 'Japan (MOFA)', flag: '🇯🇵', lang: 'ja' };

/** "2025年08月13日" → "2025-08-13" (ISO), of null. */
function jaDate(text) {
  const m = String(text || '').match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}

/**
 * Splitst de detailtekst op MOFA's volbrede genummerde pseudo-koppen
 * ("１　概況", "２　地域情勢別危険情報", …). De koppen staan als gewone
 * tekstregel in een <br>-gescheiden blok, niet als HTML-heading.
 */
function splitJaSections(text) {
  const lines = String(text || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const sections = [];
  let cur = { heading: null, lines: [] };
  for (const line of lines) {
    if (/^[１２３４５６７８９0-9０-９]{1,2}[　.．\s]/.test(line) && line.length <= 40 && !line.includes('。')) {
      if (cur.lines.length) sections.push(cur);
      cur = { heading: line.replace(/^[１２３４５６７８９0-9０-９]{1,2}[　.．\s]+/, '').trim(), lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  if (cur.lines.length) sections.push(cur);
  return sections
    .map((s) => ({ heading: s.heading, text: s.lines.join('\n') }))
    .filter((s) => s.text.length > 30);
}

export async function getAdvisory(num) {
  if (!num) return null;
  const url = `${SITE}/info/pcinfectionspothazardinfo_${num}.html`;
  const html = await getText(url);
  if (!html) return null;
  const root = parse(html);

  const name = htmlToText(root.querySelector('h1.prefName')?.innerHTML || '')
    .split(/危険/)[0].trim() || null;

  // 危険情報-samenvatting: 【危険レベル】+【ポイント】 (in het kikendetail-blok).
  const kiken = root.querySelector('#kikendetail');
  const kikenText = kiken ? htmlToText(kiken.innerHTML) : '';
  const noHazard = /危険情報は出ておりません/.test(kikenText) || (!kikenText.includes('危険レベル') && !kikenText.includes('レベル'));
  const lastModified = jaDate(kikenText);

  const themes = [];
  if (kikenText && !noHazard) {
    themes.push({
      category: '危険情報', heading: '危険情報（概要）',
      themeId: classifyTheme('safety security', kikenText),
      html: null, text: kikenText.slice(0, 8000), url,
    });
  }

  // Detailpagina met de volledige adviestekst (indien gelinkt).
  const detailHref = kiken?.querySelector('a[href*="pchazardspecificinfo"]')?.getAttribute('href') || null;
  if (detailHref) {
    try {
      const detailUrl = new URL(detailHref, SITE).href;
      const detailHtml = await getText(detailUrl);
      if (detailHtml) {
        const detailRoot = parse(detailHtml);
        const blocks = detailRoot.querySelectorAll('.overviewBox .block-text, .overviewBox');
        // De hele adviestekst zit in één <br>-gescheiden blok; de genummerde
        // pseudo-koppen ("１　概況") staan op eigen regels. htmlToText plet
        // alle witruimte, dus <br> eerst via een sentinel naar regeleinden.
        const rawHtml = (blocks[0] || detailRoot).innerHTML.replace(/<br\s*\/?>/gi, ' @@NL@@ ');
        const bodyText = htmlToText(rawHtml).split('@@NL@@').map((l) => l.trim()).join('\n');
        for (const s of splitJaSections(bodyText)) {
          themes.push({
            category: '詳細', heading: s.heading || '詳細',
            themeId: classifyTheme(s.heading || 'safety security', s.text),
            html: null, text: s.text, url: detailUrl,
          });
        }
      }
    } catch { /* detail is verrijking; samenvatting volstaat */ }
  }

  const assessment = analyzeAdvisory({
    sections: themes,
    lang: 'ja',
    structured: { kind: 'jp_hazard_levels', value: noHazard ? '危険情報は出ておりません' : kikenText },
    countryName: name,
  });

  return {
    source: meta.id,
    sourceLabel: meta.label,
    flag: meta.flag,
    name,
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
