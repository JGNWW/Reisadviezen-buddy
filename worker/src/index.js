/**
 * Reisadviezen-buddy — live proxy (Cloudflare Worker).
 *
 * Haalt op verzoek buitenlandse reisadviezen en kaarten op, normaliseert ze
 * naar dezelfde vorm als de statische NL-data, en geeft ze met CORS terug zodat
 * de statische frontend (GitHub Pages) ze kan gebruiken.
 *
 * Endpoints:
 *   GET /advisory/:iso?sources=uk,us,ca,ie   → { country, sources: [...] }
 *   GET /map/:source/:iso                     → de kaartafbeelding (geproxyd)
 *   GET /health                               → status
 */
import countries from './data/countries.json' with { type: 'json' };
import * as uk from './adapters/uk.js';
import * as us from './adapters/us.js';
import * as canada from './adapters/canada.js';
import * as ireland from './adapters/ireland.js';
import * as france from './adapters/france.js';
import * as australia from './adapters/australia.js';
import { translate, translateBlocks } from './lib/translate.js';
import { classifyTheme } from './lib/themes.js';
import { setReaderKey } from './lib/fetch.js';

const ADAPTERS = { uk, us, ca: canada, ie: ireland, fr: france, au: australia };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });

/** Bepaalt de bron-identifier van een land voor een bepaalde bron. */
function sourceId(iso, source) {
  return countries[iso]?.sources?.[source] ?? null;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    setReaderKey(env?.JINA_KEY); // optioneel: hogere limieten voor de reader-proxy

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    try {
      // /health
      if (parts[0] === 'health') {
        return json({ ok: true, sources: Object.keys(ADAPTERS), countries: Object.keys(countries).length });
      }

      // /advisory/:iso?sources=uk,us,ca,ie
      if (parts[0] === 'advisory' && parts[1]) {
        const iso = parts[1].toUpperCase();
        const rec = countries[iso];
        if (!rec) return json({ error: 'Onbekend land' }, 404);

        const requested = (url.searchParams.get('sources') || Object.keys(ADAPTERS).join(','))
          .split(',')
          .map((s) => s.trim())
          .filter((s) => ADAPTERS[s]);
        const translateTo = url.searchParams.get('translate'); // bijv. 'nl'

        const results = await Promise.all(
          requested.map(async (s) => {
            const id = sourceId(iso, s);
            if (!id) return { source: s, unavailable: true, label: ADAPTERS[s].meta.label };
            try {
              const adv = await ADAPTERS[s].getAdvisory(id);
              if (!adv) return { source: s, unavailable: true, label: ADAPTERS[s].meta.label };
              adv.mapProxy = adv.hasMap ? `/map/${s}/${iso}` : null;
              adv.lang = ADAPTERS[s].meta.lang || 'en';
              // Vertaal niet-Engelstalige bronnen op verzoek naar NL (Engels
              // laten we origineel: het is redelijk leesbaar en scheelt veel
              // vertaalcalls).
              if (translateTo && adv.lang !== translateTo && adv.lang !== 'en' && adv.themes?.length) {
                try {
                  const blocks = await translateBlocks(adv.themes, translateTo, adv.lang);
                  // Herclassificeer op de vertaalde (NL) tekst zodat niet-Engelse
                  // bronnen alsnog op de juiste thema's terechtkomen.
                  adv.themes = blocks.map((b) => ({
                    ...b,
                    themeId: b.themeId || classifyTheme(b.headingNl || '', b.textNl || ''),
                  }));
                  adv.translated = translateTo;
                } catch { /* origineel behouden bij fout */ }
              }
              return adv;
            } catch (e) {
              return { source: s, error: String(e.message || e), label: ADAPTERS[s].meta.label };
            }
          })
        );

        return json(
          { country: { iso3: iso, nl: rec.nl, en: rec.en }, sources: results },
          200,
          { 'Cache-Control': 'public, max-age=1800' }
        );
      }

      // /translate?to=nl&from=auto&q=...
      if (parts[0] === 'translate') {
        const q = url.searchParams.get('q') || '';
        const to = url.searchParams.get('to') || 'nl';
        const from = url.searchParams.get('from') || 'auto';
        if (!q) return json({ error: 'q ontbreekt' }, 400);
        const r = await translate(q, to, from);
        return json(r, 200, { 'Cache-Control': 'public, max-age=86400' });
      }

      // /map/:source/:iso
      if (parts[0] === 'map' && parts[1] && parts[2]) {
        const source = parts[1];
        const iso = parts[2].toUpperCase();
        const adapter = ADAPTERS[source];
        if (!adapter) return json({ error: 'Onbekende bron' }, 404);
        const id = sourceId(iso, source);
        if (!id) return json({ error: 'Geen koppeling' }, 404);

        let mapUrl = null;
        if (adapter.resolveMapUrl) mapUrl = await adapter.resolveMapUrl(id);
        if (!mapUrl) {
          const adv = await adapter.getAdvisory(id).catch(() => null);
          mapUrl = adv?.mapUrl || null;
        }
        if (!mapUrl) return json({ error: 'Geen kaart beschikbaar' }, 404);

        const img = await fetch(mapUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (ReisadviezenBuddy)' } });
        if (!img.ok) return json({ error: `Kaart ${img.status}` }, 502);
        return new Response(img.body, {
          status: 200,
          headers: {
            'Content-Type': img.headers.get('content-type') || 'image/png',
            'Cache-Control': 'public, max-age=3600',
            ...CORS,
          },
        });
      }

      return json({ error: 'Niet gevonden', endpoints: ['/advisory/:iso', '/map/:source/:iso', '/health'] }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
};
