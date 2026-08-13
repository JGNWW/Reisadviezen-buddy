/**
 * Ierland — Department of Foreign Affairs (ireland.ie).
 *
 * Het advies stond eerder op dfa.ie, waar het niveau als CSS-class
 * ("security-status high-caution") in de HTML zat. DFA is verhuisd naar
 * ireland.ie; dfa.ie bestaat nog steeds en geeft gewoon een pagina terug,
 * maar met een BEVROREN, oude stand — Jordanië stond daar nog op "High Degree
 * of Caution" terwijl ireland.ie al "Avoid Non-Essential Travel" zei. Dat is
 * de oorzaak van de verkeerde kleurcodes: niets faalde zichtbaar, we lazen
 * alleen een verouderde site.
 *
 * Op ireland.ie is die class er niet meer; de status staat er uitsluitend als
 * tekst ("Security Status … Avoid Non-Essential Travel"). Vandaar dat het
 * niveau nu uit de tekst komt, met een legenda-uitsluiting: de pagina toont de
 * vier niveaus ook als uitleglijstje achter elkaar, en dat is geen status.
 */
import { parse } from 'node-html-parser';
import { getText } from '../lib/fetch.js';
import { htmlToText, splitByHeadings, absolutiseLinks } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { analyzeAdvisory } from '../analysis/analysis-engine.js';

const SITE = 'https://www.ireland.ie';
const BASE = `${SITE}/en/dfa/overseas-travel/advice`;

export const meta = { id: 'ie', label: 'Ierland (DFA)', flag: '🇮🇪', lang: 'en' };

// De vier statuslabels, zwaarste eerst. De class-modifiers blijven de sleutels
// zodat de analyse-engine (kind 'ie_security_status') ongewijzigd blijft.
const IE_LABELS = [
  [/do not travel/i, 'do-not'],
  [/avoid non[-\s]?essential travel/i, 'avoid'],
  [/high degree of caution/i, 'high-caution'],
  [/normal precautions/i, 'normal'],
];

/**
 * Leest de status uit de paginatekst. De pagina noemt "Security Status" meer
 * dan eens: één keer als uitleglijstje dat álle vier de niveaus achter elkaar
 * opsomt, en één keer als de echte status van dit land. Het lijstje herken je
 * daaraan dat er direct achter het eerste label meteen een tweede volgt —
 * daarom wordt zo'n voorkomen overgeslagen in plaats van meegeteld.
 */
export function statusFromText(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  for (const m of t.matchAll(/Security Status/gi)) {
    const venster = t.slice(m.index + 'Security Status'.length, m.index + 165);
    const treffers = IE_LABELS
      .map(([re, mod]) => { const hit = venster.match(re); return hit ? { mod, at: hit.index, len: hit[0].length } : null; })
      .filter(Boolean)
      .sort((a, b) => a.at - b.at);
    if (!treffers.length) continue;
    const eerste = treffers[0];
    // Legenda: meteen achter het eerste label staat er nog een.
    const erna = venster.slice(eerste.at + eerste.len).trimStart();
    if (IE_LABELS.some(([re]) => re.test(erna.slice(0, 30)))) continue;
    return eerste.mod;
  }
  return null;
}

/**
 * Wijzigingsdatum uit de head van ireland.ie:
 *   <meta property="website:modified_time" content="2026-04-23T14:09:48+01:00" />
 * De offset is de Ierse; we houden de kalenderdatum van de bron zelf aan in
 * plaats van die naar UTC om te rekenen, anders verspringt een avondupdate een
 * dag. Lege content ("") komt voor bij het published_time-broertje, vandaar de
 * lengtecontrole.
 */
export function lastModifiedFromHtml(html) {
  // Attribuutvolgorde binnen de tag ligt niet vast, dus eerst de juiste tag
  // afbakenen en pas daarna content eruit halen.
  const tag = String(html || '').match(/<meta\b[^>]*\bwebsite:modified_time\b[^>]*>/i);
  const inhoud = tag?.[0].match(/\bcontent=["']([^"']*)["']/i);
  const datum = (inhoud?.[1] || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return datum ? datum[1] : null;
}

export async function getAdvisory(slug) {
  if (!slug) return null;
  const url = `${BASE}/${slug}/`;
  const html = await getText(url);
  if (!html) return null;

  const root = parse(html);
  const main = root.querySelector('main') || root;

  const status = statusFromText(main.text);

  // ireland.ie zet geen zíchtbare wijzigingsdatum op de landpagina, maar wel
  // een meta-tag in de head. Die stond hier op null met als gevolg dat de
  // "Bijgewerkt"-kolom terugviel op source-dates.json — en dáár kwam nooit een
  // nieuwe Ierse datum bij, want dat bestand wordt alleen gevuld met wat de
  // adapter teruggeeft. Wat er stond waren dus de dfa.ie-datums van vóór de
  // verhuizing: Libanon bleef op 17-11-2022 staan terwijl ireland.ie
  // 23-04-2026 meldt. Niets faalde zichtbaar — dezelfde val als bij de bron
  // zelf, één laag verderop.
  const lastModified = lastModifiedFromHtml(html);
  const sections = splitByHeadings(absolutiseLinks(main.innerHTML, SITE))
    .filter((s) => s.heading && s.text && s.text.length > 20)
    // Boilerplate van het nieuwe platform (inhoudsopgave, verzekeringsblok,
    // socialmedia-kaartjes) is geen landadvies. Ook het statuskopje zelf valt
    // af: dat is het niveau, niet een thema.
    .filter((s) => !/^(security status|share|related|contact|overview$|contents$|get travel and medical insurance|citizens registration|travel insurance tips|@|do not travel$|avoid non-?essential travel$|high degree of caution$|normal precautions$)/i.test(s.heading.trim()));

  const themes = sections.map((s) => ({
    category: s.heading,
    heading: s.heading,
    themeId: classifyTheme(s.heading, s.text),
    html: s.html,
    text: s.text,
  }));

  // DFA's eigen mededeling over de recentste wijziging. Op dfa.ie heette dit
  // blok "Latest Travel Alert", op ireland.ie kortweg "Travel Alert".
  const alert = themes.find((t) => /^(latest )?travel alert/i.test(t.heading.trim()));
  const updateNote = alert ? alert.text.slice(0, 400) : null;

  const assessment = analyzeAdvisory({
    sections: themes,
    lang: 'en',
    structured: { kind: 'ie_security_status', value: status },
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
