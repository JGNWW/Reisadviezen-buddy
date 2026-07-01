# Reisadviezen-buddy 🧭

Een tool voor redacteuren van **NederlandWereldwijd** om het Nederlandse
reisadvies voor een land te vergelijken met het reisadvies van andere landen
over datzelfde land. Vergelijkbaar met [advisoryatlas.com](https://advisoryatlas.com/),
maar dan vanuit Nederlands perspectief.

De Nederlandse teksten, kleurcodes en kaarten komen rechtstreeks uit de
[open data feed van NederlandWereldwijd](https://www.nederlandwereldwijd.nl/open-data)
(licentie CC0). Als buitenlandse bron gebruikt de tool op dit moment het
**Verenigd Koninkrijk (FCDO)** via de GOV.UK Content API.

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

## Snel starten

Vereist Node.js ≥ 18.

```bash
npm install
npm start
# open http://localhost:3000
```

De poort is instelbaar via `PORT` (standaard `3000`).

### Overige commando's

```bash
npm test               # unit-tests voor de vergelijkings- en zoeklogica
npm run build:countries # vernieuwt de land-mapping (ISO3 → NL/EN + FCDO-slug)
```

## Hoe het werkt

```
public/            Frontend (vanilla JS, geen build-stap)
server/
  index.js         Express-server + API-endpoints
  sources/
    nl.js          Client + normalisatie NederlandWereldwijd open data
    uk.js          Client + normalisatie FCDO (GOV.UK Content API)
  lib/
    themes.js      Canonieke thema-taxonomie + classifier
    compare.js     Thema- en kleurvergelijking, ontbrekende thema's
    search.js      Zoekindex + zoeken (NL / buitenland)
    colors.js      Kleurcode-extractie (NL) en -benadering (buitenland)
    countries.js   Land-lookup en bronkoppelingen
    html.js        HTML→tekst, splitsen op koppen, snippets
  data/
    countries.json Gegenereerde land-mapping (in de repo gebakken)
```

Beide bronnen worden genormaliseerd naar dezelfde vorm (kleur + een lijst
thema-blokken met een canoniek `themeId`). Daardoor kan de vergelijkingslaag
bron-onafhankelijk werken en zijn nieuwe landen eenvoudig toe te voegen: schrijf
een `sources/<land>.js` die dezelfde genormaliseerde structuur teruggeeft en
registreer die in `server/index.js`.

### API-endpoints

| Endpoint | Beschrijving |
| --- | --- |
| `GET /api/countries` | Alle landen met een NL-reisadvies |
| `GET /api/sources` | Beschikbare buitenlandse bronnen |
| `GET /api/themes` | Canonieke themalijst |
| `GET /api/nl/:land` | Genormaliseerd NL-reisadvies |
| `GET /api/nl/:land/map?type=standard\|legend` | NL-kaart (geproxyd) |
| `GET /api/compare/:land?sources=uk` | Volledige vergelijking |
| `GET /api/search?q=…&scope=nl\|foreign\|both&country=…` | Zoeken |

## Kanttekeningen

- De kleurcode van een buitenlands advies is een **benadering** op de
  Nederlandse schaal, afgeleid van de gebruikte formuleringen. De originele
  tekst en link staan er altijd bij.
- Buitenlandse reisadviezen zijn Engelstalig; zoek in die scope dus op een
  Engelse term (bijv. *election* i.p.v. *verkiezingen*).
- De thema-indeling gebruikt een trefwoord-classificatie. Blokken die nergens
  duidelijk op passen komen onder *Overige / niet ingedeeld*.
