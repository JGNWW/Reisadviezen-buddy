/**
 * Oostenrijk — Bundesministerium für europäische und internationale
 * Angelegenheiten (bmeia.gv.at, "Reiseinformation").
 * URL-vorm: /reise-services/reiseinformation/land/{slug} — Duitse landnamen
 * (mapping in countries.json via scripts/build-at-map.mjs, sluglijst uit de
 * Wayback-CDX omdat de site datacenter-IP's blokkeert).
 *
 * De pagina toont een "Sicherheitsstufe"-box (eigen 4-puntsschaal, met
 * "(regional)"-kwalificatie — geïnterpreteerd in de engine, structured kind
 * 'at_security_box') en Bootstrap-accordeonsecties (Aktuelle Hinweise,
 * Sicherheit & Kriminalität, Gesundheit, …) als thema-inhoud.
 *
 * Ophalen: eerst direct (met CORS-proxy-fallback); als de site blokkeert
 * via de reader-proxy.
 */
import { parse } from 'node-html-parser';
import { getText, getViaReader } from '../lib/fetch.js';
import { htmlToText, absolutiseLinks } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { analyzeAdvisory } from '../analysis/analysis-engine.js';

const SITE = 'https://www.bmeia.gv.at';

export const meta = { id: 'at', label: 'Oostenrijk (BMEIA)', flag: '🇦🇹', lang: 'de' };

// Accordeonsecties zonder adviesinhoud (vertegenwoordigingen/adressen).
const SKIP_HEADING = /vertretungen|vertrauensan|vertrauensarzt|auslandsservice/i;

/**
 * URL van de per-land Reisewarnstufen-kaart (een statische PNG onder
 * /fileadmin/_processed_/…csm_Reisewarnstufen_{Land}… of …csm_Einzelansicht_
 * {Land}…). De map-colors CI leidt hier het regionale maximum uit af (de kaart
 * is los gecropt, dus alleen de zones zijn betrouwbaar, niet de basislijn).
 * Geeft null als er geen kaart is (bijv. een veilig land zonder waarschuwing)
 * — dan blijft de tekst-afgeleide kleur staan.
 */
export async function resolveMapUrl(slug) {
  if (!slug) return null;
  const url = `${SITE}/reise-services/reiseinformation/land/${slug}`;
  let html = null;
  try { html = await getText(url); } catch { html = await getViaReader(url, 'html'); }
  if (!html) return null;
  const root = parse(html);
  let src = root.querySelectorAll('img')
    .map((im) => im.getAttribute('src') || '')
    .find((s) => /csm_(reisewarnstufen|einzelansicht)/i.test(s) && /\.(png|jpe?g)(\?|$)/i.test(s)) || null;
  if (src && src.startsWith('/')) src = SITE + src;
  return src;
}

export async function getAdvisory(slug) {
  if (!slug) return null;
  const url = `${SITE}/reise-services/reiseinformation/land/${slug}`;
  let html = null;
  try {
    html = await getText(url);
  } catch {
    html = await getViaReader(url, 'html');
  }
  if (!html) return null;
  const root = parse(html);

  // Sicherheitsstufe-box (landelijk niveau + (regional)-kwalificatie). De
  // stufe-waarde staat als SIBLING naast de .country-security-div, dus we
  // nemen een ruwe pagina-slice vanaf de box i.p.v. alleen de div-inhoud.
  const iBox = html.indexOf('country-security');
  const boxText = iBox >= 0 ? html.slice(iBox, iBox + 4000) : html.slice(0, 20000);

  // Accordeonsecties: .card met h4-titel + .panel-collapse-inhoud.
  const themes = [];
  for (const card of root.querySelectorAll('.card')) {
    const title = htmlToText(card.querySelector('h4 a, h4')?.innerHTML || '').replace(/\s+/g, ' ').trim();
    const body = card.querySelector('.panel-collapse');
    if (!title || !body || SKIP_HEADING.test(title)) continue;
    const bodyHtml = absolutiseLinks(body.innerHTML, SITE);
    const text = htmlToText(bodyHtml);
    if (text.length < 40) continue;
    themes.push({
      category: title,
      heading: title,
      themeId: classifyTheme(title, text),
      html: bodyHtml,
      text,
      url,
    });
  }
  // De Sicherheitsstufe-samenvatting zelf ook als eerste thema tonen
  // (bevat de Reisewarnung-regel en de "gilt für"-toelichting).
  const boxSummary = iBox >= 0 ? htmlToText(boxText) : '';
  if (boxSummary.length > 60) {
    themes.unshift({
      category: 'Sicherheitsstufe', heading: 'Sicherheitsstufe',
      themeId: classifyTheme('sicherheit', boxSummary),
      html: null, text: boxSummary.slice(0, 6000), url,
    });
  }
  if (!themes.length) return null;

  const assessment = analyzeAdvisory({
    sections: themes,
    lang: 'de',
    structured: { kind: 'at_security_box', value: boxText },
    countryName: htmlToText(root.querySelector('h1')?.innerHTML || '').split(/[( ]/)[0].trim() || null,
  });

  // "Stand 15.07.2026 (Unverändert gültig seit: 08.04.2026)".
  const dm = html.match(/g[üu]ltig seit:?\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/i) || html.match(/Stand\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/i);
  const lastModified = dm ? `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}` : null;

  return {
    source: meta.id,
    sourceLabel: meta.label,
    flag: meta.flag,
    name: null,
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
