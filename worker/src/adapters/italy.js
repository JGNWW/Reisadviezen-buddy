/**
 * Italië — Viaggiare Sicuri (Ministero degli Affari Esteri / Unità di Crisi).
 * De site is een SPA, maar de data erachter is een statische JSON-API,
 * rechtstreeks op ISO3:
 *
 *   /schede_paese/lista_nazioni.json   alle landen (Codice-3 = ISO3)
 *   /schede_paese/{ISO3}.json          de landkaart ("scheda paese")
 *
 * Elke scheda bevat sectiegroepen (infoPrimopiano, infoSicurezza,
 * infoSituazioneSanitaria, infoMobilita, infoRequisitiIngresso, …) met
 * `nodi` (titel + HTML-inhoud) en een `updateDate`. Italië publiceert geen
 * numeriek niveau; het oordeel komt tekstueel uit formuleringen als
 * "sconsigliati a qualsiasi titolo" (4) — zie de it-patronen in de
 * ernst-detector. Kalme landen hebben vaak géén adviesformulering; dan is
 * "uncertain" het eerlijke antwoord (liever te weinig dan gegokt).
 */
import { getJson } from '../lib/fetch.js';
import { htmlToText } from '../lib/html.js';
import { classifyTheme } from '../lib/themes.js';
import { analyzeAdvisory } from '../analysis/analysis-engine.js';

const SITE = 'https://www.viaggiaresicuri.it';

export const meta = { id: 'it', label: 'Italië (Viaggiare Sicuri)', flag: '🇮🇹', lang: 'it' };

// Ankersecties: hier staat de adviesformulering (indien aanwezig).
const ANCHOR_HEADING = /aree di particolare cautela|avvertenz|indicazioni generali/i;

// Sectiegroepen in weergavevolgorde; Cronologia (wijzigingslog) is geen thema.
const GROUPS = ['infoPrimopiano', 'infoSicurezza', 'infoSituazioneSanitaria', 'infoMobilita', 'infoRequisitiIngresso', 'infoGenerali'];

export async function getAdvisory(iso3) {
  if (!iso3) return null;
  const d = await getJson(`${SITE}/schede_paese/${String(iso3).toUpperCase()}.json`);
  if (!d) return null;

  const url = `${SITE}/find-country/country/${String(iso3).toUpperCase()}`;
  const themes = [];
  for (const g of GROUPS) {
    const group = d[g];
    if (!group?.nodi) continue;
    const nodes = Object.values(group.nodi)
      .filter((n) => n && n.titolo && n.contenuto)
      .sort((a, b) => (a.ordinamento ?? 0) - (b.ordinamento ?? 0));
    for (const n of nodes) {
      const text = htmlToText(n.contenuto);
      if (!text || text.length < 30) continue;
      themes.push({
        category: group.titolo || g,
        heading: n.titolo,
        themeId: classifyTheme(n.titolo, text),
        html: n.contenuto,
        text,
        url,
      });
    }
  }
  if (!themes.length) return null;

  // "Cronologia aggiornamenti" bevat de wijzigingslog; de eerste regel is de
  // recentste ("18/05/2026 - Revisione generale").
  const cron = d.infoCronologiaAggiornamenti?.nodi
    ? htmlToText(Object.values(d.infoCronologiaAggiornamenti.nodi)[0]?.contenuto || '')
    : '';
  const note = (cron.match(/\d{2}\/\d{2}\/\d{4}\s*[-–]\s*([^\d]{3,120}?)(?=\d{2}\/\d{2}\/\d{4}|$)/) || [])[1];

  // Leeg "Aree di particolare cautela"-veld = affirmatief "geen
  // waarschuwingsgebieden" (alleen doorslaggevend als er nergens een
  // adviesformulering staat — die afweging maakt de engine).
  const cautionText = themes
    .filter((t) => /aree di particolare cautela/i.test(t.heading || ''))
    .map((t) => t.text).join('\n');
  const fullText = themes.map((t) => t.text).join('\n');

  const assessment = analyzeAdvisory({
    sections: themes,
    lang: 'it',
    structured: { kind: 'it_caution_areas', value: { cautionText, fullText } },
    anchorHeadingRe: ANCHOR_HEADING,
    countryName: null,
  });

  return {
    source: meta.id,
    sourceLabel: meta.label,
    flag: meta.flag,
    name: null,
    url,
    lastModified: d.updateDate ? String(d.updateDate).slice(0, 10) : null,
    updateNote: note ? note.trim() : null,
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
