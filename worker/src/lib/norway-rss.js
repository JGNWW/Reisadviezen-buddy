/**
 * De reisadvies-RSS van het Noorse Utenriksdepartementet.
 *
 * regjeringen.no zet een Cloudflare-challenge voor élk verzoek van een
 * datacenter-IP: curl, de reader-proxy, de reader met browser-engine en een
 * volledige headless Chromium stuiten er allemaal op. Daardoor staat Noorwegen
 * in geen enkel landbestand en ontbreekt de bron volledig in Recente
 * wijzigingen.
 *
 * De feed is een omweg die geen adviespagina hoeft te openen. Per item staat
 * er precies genoeg in:
 *   guid        het paginanummer, en dat is exact de id-helft van onze
 *               mapping "slug/id" — dus direct koppelbaar aan een ISO3;
 *   pubDate     wannéér Noorwegen het advies bijwerkte;
 *   description een samenvatting van een paar regels, genoeg om een categorie
 *               aan te hangen.
 * Het is een rollend venster van de honderd recentste wijzigingen, wat voor
 * "wat is er de afgelopen dagen veranderd" ruim voldoende is.
 *
 * Wat er NIET in staat is de volledige adviestekst en de kleurcode. Deze module
 * levert daarom bewust geen niveau: een samenvatting die zich voordoet als een
 * volledig advies zou de vergelijking vervuilen.
 */

const veld = (blok, naam) => {
  const m = blok.match(new RegExp(`<${naam}[^>]*>([\\s\\S]*?)</${naam}>`));
  return m ? m[1] : '';
};

// Feeds gebruiken vaak CDATA en dubbel-geëscapete HTML in de description.
const ontdoe = (s) =>
  String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;[^&]*?&gt;/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Leest de feed uit tot losse items.
 * @param {string} xml
 * @returns {{guid:string,slug:string|null,title:string,country:string,link:string,date:string|null,summary:string}[]}
 */
export function parseNorwayFeed(xml) {
  const items = [...String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  return items.map((blok) => {
    const link = ontdoe(veld(blok, 'link'));
    const titel = ontdoe(veld(blok, 'title'));
    const ruw = veld(blok, 'pubDate');
    const d = ruw ? new Date(ruw) : null;
    // Niet elk land heeft dezelfde adresvorm: naast reiseinfo_{slug}/id{n}
    // bestaan bahrain_reiseinfo/id…, qatar_reiseinformasjon/id… en
    // reiseinformasjon-for-ghana/id…. Vandaar dat de slug uit de link komt en
    // niet uit een zelfbedacht patroon.
    const m = link.match(/velg-land\/([^/]+)\/id(\d+)/i);
    return {
      guid: ontdoe(veld(blok, 'guid')) || (m ? m[2] : ''),
      slug: m ? m[1] : null,
      title: titel,
      // "Tonga - reiseinformasjon" → "Tonga"
      country: titel.replace(/\s*[-–]\s*reiseinformasjon\s*$/i, '').trim(),
      link,
      date: d && !isNaN(d) ? d.toISOString().slice(0, 10) : null,
      summary: ontdoe(veld(blok, 'description')),
    };
  });
}

/**
 * Koppelt feed-items aan ISO3-codes via de bestaande no-mapping ("slug/id").
 * Er wordt op het id gematcht en niet op de naam: namen verschillen per taal,
 * een paginanummer niet.
 * @param {ReturnType<typeof parseNorwayFeed>} items
 * @param {Record<string, {sources?: {no?: string}}>} countries
 */
export function matchToCountries(items, countries) {
  const perId = new Map();
  for (const [iso, rec] of Object.entries(countries || {})) {
    const m = rec?.sources?.no;
    if (m) perId.set(String(m).split('/')[1], iso);
  }
  const gekoppeld = [];
  const ongekoppeld = [];
  for (const it of items) {
    const iso = perId.get(it.guid);
    if (iso) gekoppeld.push({ ...it, iso3: iso });
    else ongekoppeld.push(it);
  }
  return { gekoppeld, ongekoppeld };
}

/**
 * Vergelijkt de feed met de vorige stand en levert de wijzigingen op.
 * Een land telt als gewijzigd wanneer de datum verschuift óf de samenvatting
 * anders wordt; onbekende landen (nog nooit gezien) leveren geen melding op,
 * want dan is er niets om mee te vergelijken en zou de eerste run honderd
 * "wijzigingen" produceren.
 * @param {{iso3:string,date:string|null,summary:string}[]} nu
 * @param {Record<string,{date:string|null,summary:string}>} vorige
 */
export function diffFeed(nu, vorige = {}) {
  const wijzigingen = [];
  const volgende = { ...vorige };
  for (const it of nu) {
    const oud = vorige[it.iso3];
    volgende[it.iso3] = { date: it.date, summary: it.summary };
    if (!oud) continue; // eerste keer: stil vastleggen
    const datumAnders = !!(it.date && oud.date && it.date !== oud.date);
    const tekstAnders = it.summary !== oud.summary;
    if (!datumAnders && !tekstAnders) continue;
    wijzigingen.push({
      iso3: it.iso3,
      date: it.date,
      evidence: datumAnders ? 'date' : 'content',
      description: datumAnders
        ? `Advies bijgewerkt door de bron (${oud.date} → ${it.date}).`
        : 'Samenvatting van het advies gewijzigd (zonder nieuwe brondatum).',
      summary: it.summary,
      previousSummary: oud.summary,
    });
  }
  return { wijzigingen, volgende };
}
