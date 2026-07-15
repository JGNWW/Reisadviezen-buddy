/**
 * Documentparser — stap 1 van de generieke analyse-pijplijn.
 *
 *   Rauwe HTML → secties → alinea's → zinnen
 *
 * De rest van de pijplijn (classifier, scope, ernst, regio's) werkt
 * uitsluitend op zinnen; dit bestand is de enige plek die tekst opknipt.
 * Zinsplitsing is bewust conservatief: afkortingen ("U.S.", "approx.",
 * "z.B.") en decimale getallen ("10.5 km") mogen een zin niet breken,
 * omdat een half afgeknipte zin verderop verkeerd ge-scoped zou worden.
 */
import { splitByHeadings } from '../lib/html.js';

// Afkortingen die op een punt eindigen maar geen zinseinde zijn. Dekking:
// en/fr/es/de/da — de brontalen van de ondersteunde bronnen.
const ABBREV = /\b(?:approx|etc|e\.g|i\.e|vs|st|no|mr|mrs|ms|dr|prof|gen|lt|col|u\.s|u\.k|a\.m|p\.m|env|p\.?\s?ej|sr|sra|bzw|z\.\s?b|ca|inkl|nr|bl\.a|f\.eks|hhv|evt|mio)\.$/i;

/**
 * Splitst platte tekst in zinnen. Retourneert een array strings (getrimd,
 * lege en één-tekens-fragmenten weggelaten).
 */
export function splitSentences(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const out = [];
  let buf = '';
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    buf += ch;
    if (ch === '.' || ch === '!' || ch === '?') {
      const prev = clean[i - 1] || '';
      const next = clean[i + 1] || '';
      if (ch === '.' && ABBREV.test(buf)) continue; // afkorting
      if (ch === '.' && /\d/.test(prev) && /\d/.test(next)) continue; // decimaal getal
      if (next && next !== ' ') continue; // punt midden in een woord/URL
      out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter((s) => s.length > 1);
}

/**
 * Normaliseert adapter-secties ({heading, text}) naar de documentvorm van de
 * pijplijn: per sectie alinea's (op regeleinden, voor zover aanwezig na
 * htmlToText) en een platte zinnenlijst.
 */
export function parseSections(sections) {
  return (sections || [])
    .filter((s) => s && (s.heading || s.text))
    .map((s) => {
      const text = String(s.text || '').trim();
      const paragraphs = text
        .split(/\n+/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => ({ text: p, sentences: splitSentences(p) }));
      return {
        heading: s.heading ? String(s.heading).trim() : null,
        text,
        paragraphs,
        sentences: paragraphs.flatMap((p) => p.sentences),
      };
    });
}

/** Rauwe HTML → documentvorm (via de bestaande kopsplitser). */
export function parseHtml(html) {
  return parseSections(splitByHeadings(html));
}
