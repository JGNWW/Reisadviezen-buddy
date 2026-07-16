/**
 * Zuid-Korea — Ministry of Foreign Affairs (0404.go.kr, 해외안전여행).
 * Landen hebben een eigen numeriek ID (src/data/kr-map.json, gebouwd door
 * scripts/build-kr-map.mjs op basis van de Engelse naam op elke pagina).
 *
 * De detailpagina is server-gerenderd en bevat:
 *   - ul.info-02: (waarschuwing, gebied)-paren — 여행금지/출국권고/여행자제/
 *     여행유의/특별여행주의보 per gebied (전 지역 = hele land). Interpretatie
 *     gebeurt in de engine (structured kind 'kr_alert_zones').
 *   - <textarea>-elementen met HTML-escaped landinformatie in vaste secties
 *     (테러정세, 사건사고, 자연재해, 교통, 대사관 …) — de thema-inhoud.
 *   - 공관 안전공지: recente veiligheidsmeldingen van de ambassade.
 *
 * Let op de WAF: die eist een browser-User-Agent én de volledige
 * browser-Accept-header (getTextWithHeaders), anders volgt een 503.
 */
import { parse } from 'node-html-parser';
import { getTextWithHeaders } from '../lib/fetch.js';
import { htmlToText } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { analyzeAdvisory } from '../analysis/analysis-engine.js';

const SITE = 'https://www.0404.go.kr';
const KR_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

export const meta = { id: 'kr', label: 'Zuid-Korea (MOFA)', flag: '🇰🇷', lang: 'ko' };

// Vertaalslag voor de textarea-categorieën (vaste tab-namen van de site).
const TEXTAREA_CATEGORY = {
  telNoInfo: '연락처 (contact)', bscInfo: '기본정보 (basisinformatie)',
  incdntInfo: '사건·사고 (incidenten)', dptentcnyInfo: '출입국 (in- en uitreis)',
  loclCltrInfo: '현지 문화 (lokale cultuur)', trfInfo: '교통 (verkeer)', etcInfo: '기타 (overig)',
};

const unescapeHtml = (s) => String(s || '')
  .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
  .replaceAll('&#39;', "'").replaceAll('&nbsp;', ' ').replaceAll('&amp;', '&');

export async function getAdvisory(id) {
  if (!id) return null;
  const url = `${SITE}/ntnSafetyInfo/${id}/detail`;
  let html = await getTextWithHeaders(url, KR_HEADERS);
  if (!html) return null;
  // Uitgecommentarieerde template-voorbeelden (bijv. een Gaza-regel op elke
  // pagina) zouden anders als echte waarschuwingszones meekomen.
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  const root = parse(html);

  const nameKo = htmlToText(root.querySelector('h4.country-name')?.innerHTML || '').trim() || null;
  const nameEn = htmlToText(root.querySelector('.name-en')?.innerHTML || '').trim() || null;

  // (waarschuwing, gebied)-paren.
  const zones = [];
  for (const li of root.querySelectorAll('ul.info-02 li')) {
    const tag = li.querySelector('.box-tag-01');
    if (!tag) continue;
    const alert = htmlToText(tag.innerHTML).trim();
    const area = htmlToText(li.innerHTML).replace(alert, '').trim();
    if (alert) zones.push({ alert, area });
  }

  const themes = [];
  if (zones.length) {
    themes.push({
      category: '여행경보', heading: '여행경보 (reiswaarschuwing)',
      themeId: classifyTheme('여행경보', ''),
      html: null,
      text: zones.map((z) => `${z.alert}: ${z.area || '전 지역'}`).join('\n'),
      url,
    });
  }

  // Ambassade-veiligheidsmeldingen (server-gerenderd op de pagina).
  const notices = [];
  for (const a of root.querySelectorAll(`a[href*="/bbs/embsyNtc/"]`)) {
    const t = htmlToText(a.innerHTML).replace(/\s+/g, ' ').trim();
    if (t && t.length > 10 && !notices.includes(t)) notices.push(t);
  }
  if (notices.length) {
    themes.push({
      category: '안전공지', heading: '공관 안전공지 (veiligheidsmeldingen ambassade)',
      themeId: classifyTheme('안전공지', notices.join(' ')),
      html: null, text: notices.slice(0, 10).join('\n'), url,
    });
  }

  // Landinformatie uit de HTML-escaped textarea's, gesplitst op h3-koppen.
  for (const ta of root.querySelectorAll('textarea')) {
    const taId = ta.getAttribute('id') || '';
    if (!(taId in TEXTAREA_CATEGORY)) continue;
    const inner = unescapeHtml(ta.innerHTML);
    const partsHtml = inner.split(/<h3 class="tit">/).slice(inner.includes('<h3 class="tit">') ? 1 : 0);
    if (inner && !inner.includes('<h3 class="tit">')) {
      const text = htmlToText(inner);
      if (text.length > 40) {
        themes.push({
          category: TEXTAREA_CATEGORY[taId], heading: TEXTAREA_CATEGORY[taId],
          themeId: classifyTheme(TEXTAREA_CATEGORY[taId], text), html: null, text, url,
        });
      }
      continue;
    }
    for (const part of partsHtml) {
      const heading = htmlToText(part.slice(0, part.indexOf('</h3>'))).trim();
      const text = htmlToText(part.slice(part.indexOf('</h3>') + 5));
      if (!heading || text.length < 40) continue;
      themes.push({
        category: TEXTAREA_CATEGORY[taId], heading,
        themeId: classifyTheme(heading, text), html: null, text, url,
      });
    }
  }
  if (!themes.length) return null;

  const assessment = analyzeAdvisory({
    sections: themes,
    lang: 'ko',
    structured: { kind: 'kr_alert_zones', value: zones },
    countryName: nameKo,
  });

  // Recentste meldingsdatum als versheidssignaal.
  const dates = notices.map((n) => (n.match(/(\d{4})-(\d{2})-(\d{2})/) || [])[0]).filter(Boolean).sort();
  const lastModified = dates.length ? dates[dates.length - 1] : null;

  return {
    source: meta.id,
    sourceLabel: meta.label,
    flag: meta.flag,
    name: nameEn || nameKo,
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
