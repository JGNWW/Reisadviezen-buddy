# Reisadviezen-buddy 🧭

Een tool voor redacteuren van **NederlandWereldwijd** om het Nederlandse
reisadvies voor een land te vergelijken met de reisadviezen van andere landen
over datzelfde land. Vergelijkbaar met [advisoryatlas.com](https://advisoryatlas.com/),
maar dan vanuit Nederlands perspectief.

De Nederlandse teksten, kleurcodes en kaarten komen uit de
[open data feed van NederlandWereldwijd](https://www.nederlandwereldwijd.nl/open-data)
(CC0). De buitenlandse reisadviezen komen **live** van:
🇬🇧 VK (FCDO) · 🇺🇸 VS (State Dept) · 🇨🇦 Canada (Global Affairs) · 🇮🇪 Ierland (DFA) ·
🇫🇷 Frankrijk (France Diplomatie) · 🇦🇺 Australië (Smartraveller) · 🇪🇸 Spanje (Exteriores).
(Japan is nog open.) Niet-Engelse bronnen worden automatisch naar het Nederlands vertaald.

## Architectuur

De tool bestaat uit twee delen:

1. **Statische site** (GitHub Pages) — bevat de Nederlandse data (per land, een
   zoekindex en een landen­overzicht) en de hele frontend. Bouwt met een
   dagelijkse GitHub Action.
2. **Live proxy** (Cloudflare Worker, map `worker/`) — haalt op verzoek de
   buitenlandse adviezen en kaarten op, normaliseert ze naar dezelfde vorm en
   geeft ze met CORS terug. Nodig omdat een browser de meeste overheidssites
   niet rechtstreeks mag scrapen (CORS) en de NL open data geen CORS toestaat.

```
Browser ── statische NL-data (Pages) ──► NL-reisadvies + zoeken
   │
   └────── live proxy (Worker) ────────► buitenlandse adviezen + kaarten (op verzoek)
```

## Functies

1. **Reisadvies vergelijken** — vul een land in en zie NederlandWereldwijd naast
   het VK, VS, Canada en Ierland.
2. **Kleurcode-vergelijking + divergentie** — elke bron op de Nederlandse
   groen/geel/oranje/rood-schaal (benadering, met de originele formulering), en
   een **divergentie-highlight** die laat zien waar de landen het (on)eens zijn.
3. **Kaarten** — de gedetailleerde NL-kaart, plus buitenlandse kaarten die je
   **op klik** live via de proxy inlaadt.
4. **Vergelijking per thema** — op basis van de koppenstructuur van
   NederlandWereldwijd (de kop *In het kort* wordt overgeslagen); alle bronnen
   worden op een canonieke themalijst geplaatst.
5. **Ontbrekende thema's** — wat andere landen wél behandelen en NL niet.
6. **Werklijst** — waar wijkt NL af van de internationale consensus (mediaan
   van de buitenlandse bronnen), gesorteerd op grootte van de afwijking.
7. **Zoeken op thema/zoekwoord** — in alle Nederlandse reisadviezen, en per land
   live in de buitenlandse reisadviezen. Een Nederlandse zoekterm wordt
   automatisch naar het Engels (en de brontaal) vertaald, zodat ook anderstalige
   adviezen doorzocht worden.
8. **Automatische vertaling** — anderstalige bronnen (bijv. Frankrijk) worden
   standaard in het Nederlands getoond; met de taalknop (Nederlands · English ·
   Origineel) schakel je naar Engels of de originele brontaal.
9. **Datumscanner** — doorzoekt de Nederlandse reisadviezen op datums in de
   *tekst* die in het verleden liggen (mogelijk verouderde inhoud). De metadata
   “laatst gewijzigd”/“geldig op” wordt bewust genegeerd.

## Snel starten

Vereist Node.js ≥ 18.

```bash
# 1) Statische site (NL-data + frontend)
npm install
npm run build       # genereert ./docs
npm run preview     # http://localhost:3000

# 2) Live proxy (buitenlandse bronnen) — zie worker/README.md
cd worker && npm install && node local-server.mjs   # http://localhost:8787
```

Open daarna `http://localhost:3000/?proxy=http://localhost:8787` (of stel de
proxy-URL in via de ⚙-knop in de tool).

### Overige commando's

```bash
npm test                 # unit-tests (NL-logica)
npm run build:countries  # vernieuwt de land-mapping (ISO → bron-identifiers)
cd worker && npm test    # integratietest van de adapters tegen echte data
```

## Hosten

### Statische site op GitHub Pages
De workflow `.github/workflows/deploy.yml` bouwt en publiceert de site (en
ververst de NL-data dagelijks). Eenmalig: **Settings → Pages → Source:
GitHub Actions**. De site komt op `https://<gebruiker>.github.io/<repo>/`.

### Proxy op Cloudflare Workers
Zie **[worker/README.md](worker/README.md)** voor het volledige stappenplan —
deployen kan volledig via GitHub (Actions + repository-secrets), zonder iets
lokaal te installeren. Zet daarna de Worker-URL in de tool via de ⚙-knop (of in
`public/config.js` vóór de build). Zonder proxy werkt de tool ook, maar dan alleen met de
Nederlandse data.

## Projectstructuur

```
public/            Frontend (vanilla JS) — config.js bevat de proxy-URL
server/
  scripts/build-static.js     Genereert de statische site (./docs)
  scripts/build-countries.js  Genereert de land-mapping per bron
  sources/nl.js               NederlandWereldwijd open data
  lib/                        Thema-taxonomie, kleuren, HTML-helpers
worker/            Cloudflare Worker (live proxy) — eigen README
docs/              Build-output (niet in git)
```

## Kanttekeningen

- De buitenlandse kleurcode is een **benadering** op de Nederlandse schaal,
  afgeleid van het gebruikte risiconiveau/de formulering. De originele tekst en
  link staan er altijd bij.
- De thema-indeling gebruikt een trefwoord-classificatie; niet-ingedeelde
  blokken komen onder *Overige*.
- Buitenlandse reisadviezen zijn Engelstalig; zoek in die scope op een Engelse
  term (bijv. *election* i.p.v. *verkiezingen*).
- Scraping van overheidssites is inherent wat fragieler dan een API; wijzigt een
  site zijn HTML, dan moet de betreffende adapter in `worker/src/adapters/`
  bijgewerkt worden.
