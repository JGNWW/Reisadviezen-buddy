/**
 * Reisadviezen-buddy — live proxy (Cloudflare Worker).
 *
 * Haalt op verzoek buitenlandse reisadviezen en kaarten op, normaliseert ze
 * naar dezelfde vorm als de statische NL-data, en geeft ze met CORS terug zodat
 * de statische frontend (GitHub Pages) ze kan gebruiken.
 *
 * (Deploy-trigger: de deploy voor de deeplink-fix faalde eenmalig op een
 * tijdelijke GitHub-Actions-storing; deze regel forceert een nieuwe deploy.)
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
import * as spain from './adapters/spain.js';
import * as germany from './adapters/germany.js';
import * as newzealand from './adapters/newzealand.js';
import * as denmark from './adapters/denmark.js';
import { translate, translateBlocks } from './lib/translate.js';
import { classifyTheme } from './lib/themes.js';
import { setReaderKey, setCorsProxy } from './lib/fetch.js';

const ADAPTERS = { uk, us, ca: canada, ie: ireland, fr: france, au: australia, es: spain, de: germany, nz: newzealand, dk: denmark };

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

// Vangnet: de 6-uurlijkse snapshot-workflow schrijft per land het laatste
// volledige advies naar worker/data/latest/ (publieke repo). Als een bron
// live niet lukt (bot-blokkade, rate-limit, storing) serveren we die versie
// met stale-markering — een bron verdwijnt zo nooit uit de vergelijking.
const SNAPSHOT_BASE = 'https://raw.githubusercontent.com/JGNWW/Reisadviezen-buddy/main/worker/data/latest';

async function snapshotFallback(iso, sid) {
  try {
    const r = await fetch(`${SNAPSHOT_BASE}/${iso}.json`, {
      headers: { 'User-Agent': 'ReisadviezenBuddy/1.0' },
      cf: { cacheTtl: 900, cacheEverything: true },
    });
    if (!r.ok) return null;
    const d = await r.json();
    const entry = d?.sources?.[sid];
    if (!entry || !entry.themes?.length) return null;
    return {
      ...entry,
      stale: true,
      snapshotDate: d.fetchedAt?.[sid] || null,
      mapProxy: entry.hasMap ? `/map/${sid}/${iso}` : null,
    };
  } catch {
    return null;
  }
}

/** Vertaalt (indien gevraagd) de thema's van een advies naar de doeltaal. */
async function applyTranslation(adv, translateTo) {
  if (!translateTo || adv.lang === translateTo || !adv.themes?.length) return adv;
  try {
    const blocks = await translateBlocks(adv.themes, translateTo, adv.lang);
    // Herclassificeer op de vertaalde (NL) tekst zodat niet-Engelse bronnen
    // alsnog op de juiste thema's terechtkomen.
    adv.themes = blocks.map((b) => ({
      ...b,
      themeId: b.themeId || classifyTheme(b.headingNl || '', b.textNl || ''),
    }));
    adv.translated = translateTo;
  } catch { /* origineel behouden bij fout */ }
  return adv;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    setReaderKey(env?.JINA_KEY); // optioneel: hogere limieten voor de reader-proxy
    setCorsProxy(env?.CORS_PROXY_URL); // optioneel: fallback-proxy als directe fetch faalt

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
              // Vertaal op verzoek naar de doeltaal. Alleen bronnen die al in
              // de doeltaal zijn slaan we over (Engelse bron + translate=en, of
              // een NL-doel dat toevallig al klopt). Zo wordt bij 'Nederlands'
              // óók de Engelstalige bron (UK/US/…) naar het NL vertaald.
              return await applyTranslation(adv, translateTo);
            } catch (e) {
              // Live mislukt → laatste snapshot serveren (met stale-markering)
              // in plaats van de bron te laten verdwijnen.
              const snap = await snapshotFallback(iso, s);
              if (snap) {
                snap.lang = snap.lang || ADAPTERS[s].meta.lang || 'en';
                return await applyTranslation(snap, translateTo);
              }
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

      // /context/:iso — humanitaire context (ReliefWeb, VN-OCHA). Alleen actief
      // als de repository-secret RELIEFWEB_APP is gezet. ReliefWebs eigen
      // documentatie suggereert dat elke zelfgekozen appname-string volstaat,
      // maar de live API test-verifieerbaar niet: die geeft een harde 403
      // "You are not using an approved appname" terug tenzij de appname
      // vooraf bij ReliefWeb is goedgekeurd (aanvragen via
      // apidoc.reliefweb.int/parameters#appname) — dus wél een echte,
      // vooraf-goedgekeurde waarde nodig, niet zomaar een vrije tekst.
      if (parts[0] === 'context' && parts[1]) {
        const iso = parts[1].toUpperCase();
        const app = env?.RELIEFWEB_APP;
        // Korte cache (i.p.v. de 24u van de succes-respons): dit is alleen een
        // env-var-check, geen dure upstream-call, en een net geactiveerde
        // RELIEFWEB_APP-secret mag niet een dag lang "onbeschikbaar" blijven
        // ogen door een gecachete respons van vóór de configuratie.
        if (!app) return json({ available: false }, 200, { 'Cache-Control': 'public, max-age=300' });

        // `sort[]=date:desc` is een shortcut voor date.created (wanneer het
        // record werd aangemaakt), NIET voor actualiteit — dat verklaarde
        // waarom afgesloten rampen van jaren terug boven een lopende crisis
        // konden staan. date.changed (laatst bijgewerkt) is de betere proxy
        // voor "meest actueel". Daarnaast filteren we eerst op status
        // alert/current (lopende/dreigende situaties); alleen als een land
        // geen enkele lopende crisis heeft, vallen we terug op alle rampen
        // (incl. past) zodat het blokje niet onterecht leeg blijft.
        const disastersUrl = (statusFilter) => 'https://api.reliefweb.int/v2/disasters'
          + `?appname=${encodeURIComponent(app)}`
          + '&filter[operator]=AND'
          + '&filter[conditions][0][field]=primary_country.iso3'
          + `&filter[conditions][0][value]=${iso}`
          + statusFilter
          + '&sort[]=date.changed:desc&limit=4'
          + '&fields[include][]=name&fields[include][]=url&fields[include][]=date&fields[include][]=status';
        const activeStatusFilter = '&filter[conditions][1][field]=status'
          + '&filter[conditions][1][value][]=alert'
          + '&filter[conditions][1][value][]=current'
          + '&filter[conditions][1][operator]=OR';

        const fetchDisasters = async (statusFilter) => {
          const r = await fetch(disastersUrl(statusFilter), { headers: { 'User-Agent': 'ReisadviezenBuddy/1.0' } });
          if (!r.ok) return { ok: false, status: r.status };
          const d = await r.json();
          const items = (d?.data || []).map((x) => ({
            name: x.fields?.name || null,
            url: x.fields?.url || null,
            date: (x.fields?.date?.changed || x.fields?.date?.created)
              ? String(x.fields.date.changed || x.fields.date.created).slice(0, 10) : null,
            status: x.fields?.status || null,
          })).filter((x) => x.name);
          return { ok: true, items };
        };

        try {
          let res = await fetchDisasters(activeStatusFilter);
          if (!res.ok) return json({ available: true, items: [], note: `ReliefWeb ${res.status}` }, 200);
          if (!res.items.length) {
            res = await fetchDisasters('');
            if (!res.ok) return json({ available: true, items: [], note: `ReliefWeb ${res.status}` }, 200);
          }
          return json({ available: true, items: res.items }, 200, { 'Cache-Control': 'public, max-age=21600' });
        } catch (e) {
          return json({ available: true, items: [], note: String(e.message || e) }, 200);
        }
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

      return json({ error: 'Niet gevonden', endpoints: ['/advisory/:iso', '/context/:iso', '/map/:source/:iso', '/health'] }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
};
