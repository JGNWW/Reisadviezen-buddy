/**
 * Diepe mapping-controle: prikt per land bij de bron zelf.
 *
 * De wekelijkse bewaking (verify-mappings.mjs) vergelijkt tegen een index en is
 * daarom goedkoop, maar slechts vier bronnen publiceren zo'n index. Voor de
 * rest is er maar één manier om zeker te weten of een koppeling klopt: het
 * adres opvragen en kijken wat er terugkomt. Dat zijn ruim duizend verzoeken,
 * dus dit script draait met de hand en niet elke week.
 *
 * Aanleiding: Israël ontbrak bij vier bronnen omdat die het samen met de
 * Palestijnse gebieden behandelen en dus een andere slug gebruiken. Zulke
 * fouten vallen niet op — de bron verdwijnt gewoon stil uit de vergelijking.
 *
 * Per bron staat hieronder hoe het adres wordt opgebouwd en waaraan je ziet
 * dat de pagina echt bestaat. Dat laatste is niet overal een 404: um.dk en
 * safetravel.govt.nz geven een 200 met "Page not found" in de titel.
 *
 * Draaien:  cd worker && node scripts/audit-mappings.mjs [bron ...]
 * Rapport:  worker/data/mapping-audit.json
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import countries from '../src/data/countries.json' with { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'data', 'mapping-audit.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PAUZE = 250; // ms tussen verzoeken — hoffelijk naar de bronsites

const wacht = (ms) => new Promise((r) => setTimeout(r, ms));
const titelVan = (html) => ((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();

/**
 * Bronnen die per land bevraagd moeten worden.
 *   id      haal de mapping uit het landrecord (null = niet gekoppeld)
 *   url     bouw het adres
 *   goed    is dit een echte adviespagina?
 * De bronnen mét index staan bewust niet in deze lijst; die doet
 * verify-mappings.mjs goedkoper.
 */
const BRONNEN = {
  fr: {
    naam: 'Frankrijk (France Diplomatie)',
    id: (r) => r.sources.fr,
    url: (s) => `https://www.diplomatie.gouv.fr/fr/information-par-pays/${s}/conseils-aux-voyageurs-securite`,
    goed: (res, html) => res.ok && !/page non trouv/i.test(titelVan(html)),
  },
  es: {
    naam: 'Spanje (Exteriores)',
    id: (r) => r.sources.es,
    url: (s) => `https://www.exteriores.gob.es/es/ServiciosAlCiudadano/Paginas/Detalle-recomendaciones-de-viaje.aspx?trc=${encodeURIComponent(s)}`,
    goed: (res, html) => res.ok && html.length > 20000 && !/no se encontr|error/i.test(titelVan(html)),
  },
  at: {
    naam: 'Oostenrijk (BMEIA)',
    id: (r) => r.sources.at,
    url: (s) => `https://www.bmeia.gv.at/reise-services/reiseinformation/land/${s}`,
    goed: (res, html) => res.ok && !/nicht gefunden|fehler 404/i.test(titelVan(html)),
  },
  fi: {
    naam: 'Finland (Ulkoministeriö)',
    id: (r) => r.sources.fi,
    url: (s) => `https://um.fi/matkustustiedote/-/c/${String(s).toUpperCase()}`,
    goed: (res, html) => res.ok && html.length > 20000,
  },
  it: {
    naam: 'Italië (Viaggiare Sicuri)',
    id: (r) => r.sources.it,
    url: (s) => `https://www.viaggiaresicuri.it/schede_paese/${String(s).toUpperCase()}.json`,
    goed: (res, html) => res.ok && html.trim().startsWith('{'),
  },
  kr: {
    naam: 'Zuid-Korea (MOFA)',
    id: (r) => r.sources.kr,
    url: (s) => `https://www.0404.go.kr/ntnSafetyInfo/${s}/detail`,
    goed: (res, html) => res.ok && html.length > 50000,
  },
  jp: {
    naam: 'Japan (MOFA)',
    id: (r) => r.sources.jp,
    url: (s) => `https://www.anzen.mofa.go.jp/info/pcinfectionspothazardinfo_${s}.html`,
    goed: (res, html) => res.ok && html.length > 5000,
  },
};

async function haal(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en;q=0.8' }, redirect: 'follow' });
    return { res, html: await res.text() };
  } catch (e) {
    return { res: { ok: false, status: 0 }, html: '', fout: String(e.message).slice(0, 60) };
  }
}

async function controleer(sid) {
  const b = BRONNEN[sid];
  const kapot = [];
  const ongekoppeld = [];
  let gecontroleerd = 0;
  const lijst = Object.entries(countries);
  for (const [iso3, rec] of lijst) {
    if (!rec.sources || !(sid in rec.sources)) continue;
    const id = b.id(rec);
    if (!id) { ongekoppeld.push({ iso3, land: rec.nl, en: rec.en }); continue; }
    gecontroleerd++;
    const url = b.url(id);
    const { res, html, fout } = await haal(url);
    if (!b.goed(res, html)) {
      kapot.push({ iso3, land: rec.nl, en: rec.en, id, status: res.status, titel: titelVan(html).slice(0, 60), fout: fout || null });
      console.log(`   ✗ ${iso3} (${rec.nl}) "${id}" → ${res.status} ${titelVan(html).slice(0, 45)}`);
    }
    await wacht(PAUZE);
  }
  return { naam: b.naam, gecontroleerd, kapot, ongekoppeldAantal: ongekoppeld.length, ongekoppeld };
}

async function main() {
  const gevraagd = process.argv.slice(2).filter((a) => BRONNEN[a]);
  const bronnen = gevraagd.length ? gevraagd : Object.keys(BRONNEN);
  const rapport = { generatedAt: new Date().toISOString(), sources: {} };
  for (const sid of bronnen) {
    console.log(`\n=== ${sid} — ${BRONNEN[sid].naam} ===`);
    rapport.sources[sid] = await controleer(sid);
    const r = rapport.sources[sid];
    console.log(`   ${r.gecontroleerd} gecontroleerd · ${r.kapot.length} kapot · ${r.ongekoppeldAantal} niet gekoppeld`);
    writeFileSync(OUT, JSON.stringify(rapport, null, 2)); // tussentijds bewaren
  }
  const totaal = Object.values(rapport.sources).reduce((n, r) => n + r.kapot.length, 0);
  console.log(`\nKlaar: ${totaal} kapotte koppeling(en). Rapport: ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
