# Reisadviezen-buddy — live proxy (Cloudflare Worker)

Deze Worker haalt op verzoek **buitenlandse reisadviezen en kaarten** live op,
normaliseert ze naar dezelfde vorm als de Nederlandse data en geeft ze met
CORS-headers terug, zodat de statische frontend (GitHub Pages) ze kan gebruiken.

Ondersteunde bronnen: 🇬🇧 VK (FCDO), 🇺🇸 VS (State Dept), 🇨🇦 Canada (Global
Affairs), 🇮🇪 Ierland (DFA). Australië/Frankrijk/Spanje/Japan volgen later.

## Endpoints

| Endpoint | Beschrijving |
| --- | --- |
| `GET /advisory/:iso?sources=uk,us,ca,ie` | Genormaliseerde adviezen (niveau/kleur + thema's) van de gevraagde bronnen |
| `GET /map/:source/:iso` | De kaartafbeelding van die bron (live opgehaald/gescrapet, geproxyd) |
| `GET /health` | Status + ondersteunde bronnen |

`:iso` is de ISO 3166-1 alpha-3 code (bijv. `ETH`).

## Deployen naar Cloudflare (gratis)

1. Maak een gratis account op [Cloudflare](https://dash.cloudflare.com/sign-up).
2. Installeer de dependencies en deploy:
   ```bash
   cd worker
   npm install
   npx wrangler login      # opent de browser om in te loggen
   npx wrangler deploy
   ```
3. Wrangler geeft na afloop een URL, bijvoorbeeld:
   ```
   https://reisadviezen-buddy-proxy.<jouw-subdomein>.workers.dev
   ```
4. Zet die URL in de frontend: open de tool, klik op **⚙** rechtsboven, plak de
   URL en klik **Opslaan** (of gebruik `?proxy=<url>` in de adresbalk, of vul
   `PROXY` in `public/config.js` in vóór de build).

## Lokaal draaien

```bash
cd worker
npm install
npx wrangler dev            # Cloudflare-runtime op http://localhost:8787
# of, zonder wrangler, een simpele Node-wrapper:
node local-server.mjs       # http://localhost:8787
```

Test daarna met bijvoorbeeld:
```
http://localhost:8787/health
http://localhost:8787/advisory/ETH?sources=uk,us,ca,ie
http://localhost:8787/map/uk/ETH
```

## Structuur

```
src/
  index.js            Router (advisory/map/health) + CORS
  adapters/
    uk.js             FCDO — GOV.UK Content API + kaart-scrape
    us.js             State Dept — niveau + samenvatting (scrape)
    canada.js         Global Affairs — niveau (JSON) + secties + regiokaart
    ireland.js        DFA — niveau + thema's (scrape)
  lib/
    fetch.js          fetch-helpers met User-Agent
    html.js           HTML→tekst, splitsen op koppen (op elke diepte), links
    themes.js         Canonieke thema-taxonomie + classifier
    levels.js         Niveaus 1–4 ↔ NL-kleuren (groen/geel/oranje/rood)
  data/countries.json ISO → bron-identifiers (gegenereerd; zie build:countries)
test-adapters.mjs     Integratietest van de adapters tegen echte data
test-worker.mjs       Test van de fetch-handler
```

## Een bron toevoegen

Schrijf `src/adapters/<bron>.js` met `meta` en `async getAdvisory(id)` die de
genormaliseerde vorm teruggeeft (`{ source, sourceLabel, flag, level, color,
levelLabel, url, themes:[{category,heading,themeId,html,text}], hasMap,
mapUrl }`), optioneel `resolveMapUrl(id)`. Registreer de bron in `src/index.js`
(`ADAPTERS`), voeg de land-identifiers toe in `server/scripts/build-countries.js`
en de bron in `public/config.js`.
