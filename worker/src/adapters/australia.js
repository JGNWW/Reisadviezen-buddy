/**
 * Australië — Smartraveller (smartraveller.gov.au).
 * Smartraveller blokkeert datacenter-IP's, dus we halen de pagina op via de
 * publieke reader-proxy (r.jina.ai). Niveau uit het "overall advice level";
 * thema's uit de kopstructuur.
 */
import { parse } from 'node-html-parser';
import { getViaReader } from '../lib/fetch.js';
import { splitByHeadings, absolutiseLinks, htmlToText } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { analyzeAdvisory } from '../analysis/analysis-engine.js';
import { parseHumanDate } from '../lib/dates.js';

const SITE = 'https://www.smartraveller.gov.au';

export const meta = { id: 'au', label: 'Australië (Smartraveller)', flag: '🇦🇺', lang: 'en' };

export async function getAdvisory(id) {
  if (!id) return null;
  // id = { continent, slug }
  const { continent, slug } = typeof id === 'string' ? { continent: null, slug: id } : id;
  const url = continent ? `${SITE}/destinations/${continent}/${slug}` : `${SITE}/destinations/${slug}`;
  const html = await getViaReader(url, 'html');
  if (!html) return null;

  const root = parse(html);

  // Overall advice level: het element met class/id 'overall-advice-level';
  // val terug op de zin met "overall". De adapter selecteert alleen de TEKST,
  // de betekenis (niveau 1..4 + label) bepaalt de analyse-engine.
  const overall = root.querySelector('[id*="overall-advice-level" i], [class*="overall-advice-level" i]');
  const overallText = overall?.textContent || htmlToText(html).match(/[^.]*\boverall\b[^.]*\./i)?.[0] || '';

  // "Updated: 25 June 2026" is de datum van de laatste inhoudelijke wijziging;
  // "Still current at" verspringt ook bij een review zonder wijziging en is
  // daarom bewust NIET gebruikt.
  const updMatch = htmlToText(html).match(/Updated:?\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i);
  const lastModified = updMatch ? parseHumanDate(updMatch[1]) : null;

  const KNOWN = /^(latest update|safety|security|health|local laws|travel|local contacts|full advice|terrorism|crime|civil unrest|natural disasters|climate|getting around)/i;
  const NAV = /^(global alert|main navigation|police|ambulance|fire|advice levels|read more|subscribe|sign up|follow|get help|emergency|before you go|explore|footer|smartraveller|search|related|about|contact|newsletter|share)/i;
  const themes = splitByHeadings(absolutiseLinks(root.innerHTML, SITE))
    .filter((s) => s.heading && s.text && s.text.length > 60)
    .map((s) => ({ category: s.heading, heading: s.heading, themeId: classifyTheme(s.heading, s.text), html: s.html, text: s.text }))
    // Houd alleen herkenbare advies-secties of blokken die op een thema mappen.
    .filter((t) => !NAV.test(t.heading.trim()) && (t.themeId || KNOWN.test(t.heading.trim())));

  // Smartravellers eigen samenvatting van de recentste wijziging.
  const latest = themes.find((t) => /^latest update/i.test(t.heading.trim()));
  const updateNote = latest ? latest.text.slice(0, 400) : null;

  const assessment = analyzeAdvisory({
    sections: themes,
    lang: 'en',
    structured: { kind: 'au_overall_text', value: overallText },
    countryName: slug ? slug.replace(/-/g, ' ') : null,
  });

  return {
    source: meta.id,
    sourceLabel: meta.label,
    flag: meta.flag,
    name: null,
    url,
    lastModified,
    updateNote,
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
