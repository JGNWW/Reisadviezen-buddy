# Reisadviezen-buddy — live proxy (Cloudflare Worker)

Deze Worker haalt op verzoek **buitenlandse reisadviezen en kaarten** live op,
normaliseert ze naar dezelfde vorm als de Nederlandse data en geeft ze met
CORS-headers terug, zodat de statische frontend (GitHub Pages) ze kan gebruiken.

Ondersteunde bronnen: 🇬🇧 VK (FCDO), 🇺🇸 VS (State Dept), 🇨🇦 Canada (Global
Affairs), 🇮🇪 Ierland (DFA), 🇫🇷 Frankrijk (France Diplomatie), 🇦🇺 Australië
(Smartraveller), 🇪🇸 Spanje (Exteriores). Japan is nog open (de anzen.mofa-SPA
rendert niet landspecifiek via de reader).

Australië blokkeert datacenter-IP's en wordt daarom via de publieke
reader-proxy `r.jina.ai` opgehaald. Zet een (gratis) jina.ai-key voor
betrouwbaarheid: `npx wrangler secret put JINA_KEY`.

### Fallback-proxy (optioneel)

Alle overige bronnen gebruiken een directe fetch, met een optionele generieke
proxy als fallback wanneer die directe fetch faalt (bijv. als een bron ooit
Cloudflare-IP's gaat blokkeren). Dit is bewust **niet** hardcoded: je zet je
eigen proxy-URL als Worker-secret, zodat de waarde nergens in de repo of in
gedeelde code terechtkomt.

```bash
npx wrangler secret put CORS_PROXY_URL
# plak je proxy-URL wanneer daarom gevraagd wordt (bijv. je eigen
# passthrough-Worker, gebruik: <jouw-proxy>/?<doel-url>)
```

Zonder deze secret werkt alles gewoon met alleen de directe fetch.

### Optioneel: humanitaire context (ReliefWeb)

Voor het `/context/:iso`-endpoint (humanitaire situatierapporten per land) is
een gratis ReliefWeb-appname nodig. Vraag er een aan op
<https://apidoc.reliefweb.int/parameters#appname> en zet die als secret:

```bash
npx wrangler secret put RELIEFWEB_APP
```

Zonder deze secret geeft het endpoint `{ available:false }` terug en toont de
frontend simpelweg geen contextblok.

## Endpoints

| Endpoint | Beschrijving |
| --- | --- |
| `GET /advisory/:iso?sources=uk,us,ca,ie,fr` | Genormaliseerde adviezen (niveau/kleur + thema's) van de gevraagde bronnen |
| `GET /advisory/:iso?...&translate=nl` | Vertaalt niet-Engelse bronnen naar Nederlands (voegt `headingNl`/`textNl` toe en herclassificeert de thema's) |
| `GET /context/:iso` | Humanitaire context (ReliefWeb, VN-OCHA). Alleen actief met de optionele secret `RELIEFWEB_APP` (gratis appname, aan te vragen bij apidoc.reliefweb.int); anders `{ available:false }` |
| `GET /map/:source/:iso` | De kaartafbeelding van die bron (live opgehaald/gescrapet, geproxyd) |
| `GET /translate?to=nl&from=auto&q=...` | Losse vertaling (o.a. voor het vertalen van zoektermen) |
| `GET /health` | Status + ondersteunde bronnen |

`:iso` is de ISO 3166-1 alpha-3 code (bijv. `ETH`). Vertaling gebruikt het
gratis publieke Google-translate-endpoint (geen key); makkelijk te vervangen in
`src/lib/translate.js`.

## Deployen — via GitHub (aanbevolen, geen installatie nodig)

De workflow `.github/workflows/deploy-worker.yml` deployt de Worker automatisch
bij elke wijziging in `worker/` op `main`, en is ook handmatig te starten. Je
hoeft hiervoor niets op je eigen computer te installeren.

### Eenmalig instellen

1. **Cloudflare-account** — maak een gratis account op
   [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) (als je
   die nog niet hebt).

2. **API-token maken** (in de Cloudflare-website, geen CLI nodig):
   - Ga naar [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens).
   - Klik **Create Token** → kies het sjabloon **"Edit Cloudflare Workers"**.
   - Rond de wizard af en **kopieer de token** (je ziet 'm maar één keer).

3. **Account-ID opzoeken**:
   - Ga naar [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages**.
   - Rechts op die pagina staat je **Account ID** — kopieer die.

4. **Beide waarden als GitHub-secret zetten** (in de repo op GitHub.com, niet lokaal):
   - Ga naar de repo → **Settings** → **Secrets and variables** → **Actions**.
   - Klik **New repository secret**, maak er twee aan:
     | Name | Value |
     | --- | --- |
     | `CLOUDFLARE_API_TOKEN` | de token uit stap 2 |
     | `CLOUDFLARE_ACCOUNT_ID` | de account-ID uit stap 3 |

5. **Deploy starten**: de workflow draait automatisch zodra deze instellingen
   staan en er iets in `worker/` wijzigt op `main`. Wil je 'm nu meteen
   draaien? Ga naar de repo → **Actions** → **"Deploy proxy (Cloudflare
   Worker)"** → **Run workflow**.

6. **De Worker-URL vinden**: open de afgeronde run in **Actions** en zoek in de
   log naar een regel als:
   ```
   Published reisadviezen-buddy-proxy (...)
     https://reisadviezen-buddy-proxy.<jouw-subdomein>.workers.dev
   ```
   (Of kijk op [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers
   & Pages** → de Worker staat in de lijst met zijn URL.)

7. **Koppel de URL aan de tool**: open de site, klik **⚙** rechtsboven, plak de
   URL en klik **Opslaan**. Wil je dat de URL voor iedereen standaard aanstaat
   (i.p.v. dat elke bezoeker 'm zelf moet invullen)? Vul `PROXY` in
   `public/config.js` in en commit die wijziging.

### Worker-secrets zetten (ook via de website, geen CLI)

De optionele secrets (`JINA_KEY`, `CORS_PROXY_URL`, zie hierboven) zet je
rechtstreeks in de Cloudflare-website, zonder wrangler:
- Ga naar **dash.cloudflare.com** → **Workers & Pages** → open de Worker
  `reisadviezen-buddy-proxy` → tab **Settings** → **Variables and Secrets**.
- Klik **Add** → naam (`JINA_KEY` of `CORS_PROXY_URL`) → waarde → zet het type
  op **Secret** (versleuteld, niet zichtbaar na opslaan) → **Deploy**.

## Deployen — handmatig vanaf je eigen computer (alternatief)

Heb je liever geen GitHub Actions, dan kan het ook lokaal (vereist Node.js):

```bash
cd worker
npm install
npx wrangler login      # opent de browser om in te loggen
npx wrangler deploy
npx wrangler secret put JINA_KEY        # optioneel
npx wrangler secret put CORS_PROXY_URL  # optioneel
```

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
