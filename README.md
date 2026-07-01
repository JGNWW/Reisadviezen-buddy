# Reisadviezen-buddy 🧭

Een tool voor redacteuren van **NederlandWereldwijd** om het Nederlandse
reisadvies voor een land te vergelijken met het reisadvies van andere landen
over datzelfde land. Vergelijkbaar met [advisoryatlas.com](https://advisoryatlas.com/),
maar dan vanuit Nederlands perspectief.

De Nederlandse teksten, kleurcodes en kaarten komen uit de
[open data feed van NederlandWereldwijd](https://www.nederlandwereldwijd.nl/open-data)
(licentie CC0). Als buitenlandse bron gebruikt de tool op dit moment het
**Verenigd Koninkrijk (FCDO)** via de GOV.UK Content API.

> **Statische site.** Reisadviezen-buddy is een statische website: bij het
> bouwen wordt alle data opgehaald en als JSON weggeschreven, waarna alles in de
> browser draait. Daardoor is de tool gratis te hosten op **GitHub Pages**
> (zie [Hosten op GitHub Pages](#hosten-op-github-pages)).

## Wat kan de tool?

1. **Reisadvies vergelijken** – vul een land in (bijv. *Ethiopië*) en zie naast
   elkaar wat NederlandWereldwijd zegt en wat andere landen zeggen.
2. **Kleurcode-vergelijking** – welke kleurcode geeft Nederland, en welke geeft
   het andere land (vertaald naar de Nederlandse groen/geel/oranje/rood-schaal,
   met de originele formulering erbij). De gedetailleerde NederlandWereldwijd-kaart
   wordt getoond.
3. **Vergelijking per thema** – op basis van de **koppenstructuur van
   NederlandWereldwijd** (de kop *In het kort* wordt bewust overgeslagen).
   Nederlandse subkoppen én de koppen van het buitenlandse advies worden op een
   canonieke themalijst geplaatst zodat ze naast elkaar staan.
4. **Ontbrekende thema's** – een aparte lijst met thema's die andere landen wél
   behandelen en NederlandWereldwijd niet. Aanvullingen binnen een gedeeld thema
   staan gewoon in de themavergelijking naast elkaar.
5. **Zoeken op thema/zoekwoord** – bijv. *verkiezingen*:
   - in alle **Nederlandse** reisadviezen (per land zie je wat er staat);
   - in **buitenlandse** reisadviezen (alle landen of één specifiek land);
   - **vergelijkend** (NL ↔ buitenland) op hetzelfde zoekwoord.

## Lokaal draaien

Vereist Node.js ≥ 18.

```bash
npm install
npm run build     # haalt alle reisadviezen op en genereert ./docs (± 15 s)
npm run preview   # serveert ./docs op http://localhost:3000
```

### Overige commando's

```bash
npm test                # unit-tests voor de vergelijkings- en zoeklogica
npm run build:countries # vernieuwt de land-mapping (ISO3 → NL/EN + FCDO-slug)
```

## Hosten op GitHub Pages

De repo bevat een workflow (`.github/workflows/deploy.yml`) die de site bouwt en
publiceert. Eenmalig instellen:

1. Push de code naar GitHub (naar de standaardbranch, bijv. `main`).
2. Ga in de repo naar **Settings → Pages** en zet **Source** op
   **GitHub Actions**.
3. De workflow draait automatisch bij elke push naar de standaardbranch, en
   daarnaast **elke dag** om de reisadviezen te verversen. Je kunt hem ook
   handmatig starten via **Actions → Build en publiceer naar GitHub Pages →
   Run workflow**.

Daarna staat de tool op `https://<gebruikersnaam>.github.io/<repo-naam>/`.
De frontend gebruikt relatieve paden, dus het werkt ook onder zo'n submap.

> De gepubliceerde `docs/`-map wordt door de workflow gebouwd en hoeft niet in
> git te staan (staat in `.gitignore`). Wil je liever "Deploy from branch"
> gebruiken? Haal `docs/` uit `.gitignore`, commit de build en zet de Pages-source
> op die branch/map.

## Hoe het werkt

```
public/            Frontend (vanilla JS, geen build-stap) — wordt naar docs/ gekopieerd
server/
  scripts/
    build-static.js   Bouwt de statische site + data naar ./docs
    build-countries.js Genereert de land-mapping
  sources/
    nl.js          Client + normalisatie NederlandWereldwijd open data
    uk.js          Client + normalisatie FCDO (GOV.UK Content API)
  lib/
    themes.js      Canonieke thema-taxonomie + classifier
    compare.js     Thema- en kleurvergelijking, ontbrekende thema's
    colors.js      Kleurcode-extractie (NL) en -benadering (buitenland)
    countries.js   Land-lookup en bronkoppelingen
    html.js        HTML→tekst, splitsen op koppen, snippets
  data/
    countries.json Gegenereerde land-mapping (in de repo gebakken)
  index.js         Lokale preview-server voor ./docs
docs/              Gegenereerde statische site (build-output, niet in git)
```

Bij `npm run build` worden alle reisadviezen opgehaald, genormaliseerd naar één
gedeelde vorm (kleur + een lijst thema-blokken met een canoniek `themeId`), en
per land weggeschreven als kant-en-klare vergelijking (`docs/data/compare/<iso>.json`)
plus twee zoekindexen (`docs/data/search/{nl,foreign}.json`). Kaarten worden
**niet** gedownload: de frontend hotlinkt ze rechtstreeks vanaf de open data
(cross-origin `<img>` werkt zonder CORS).

Doordat de vergelijkingslaag bron-onafhankelijk is, is een nieuw land eenvoudig
toe te voegen: schrijf een `sources/<land>.js` die dezelfde genormaliseerde
structuur teruggeeft en registreer die in `build-static.js`.

## Kanttekeningen

- De data op de site is een **momentopname** van de laatste build. De workflow
  ververst dagelijks; met "Run workflow" kun je direct verversen.
- De kleurcode van een buitenlands advies is een **benadering** op de
  Nederlandse schaal, afgeleid van de gebruikte formuleringen. De originele
  tekst en link staan er altijd bij.
- Buitenlandse reisadviezen zijn Engelstalig; zoek in die scope dus op een
  Engelse term (bijv. *election* i.p.v. *verkiezingen*).
- De thema-indeling gebruikt een trefwoord-classificatie. Blokken die nergens
  duidelijk op passen komen onder *Overige / niet ingedeeld*.
