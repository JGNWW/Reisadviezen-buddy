/**
 * Snapshot van buitenlandse reisadviezen — houdt bij welke landen een
 * wijziging kregen bij VK/VS/Canada/Ierland/Frankrijk/Australië/Spanje,
 * en wat die wijziging inhield. Dit gaat NIET over de Nederlandse
 * reisadviezen (die worden door NederlandWereldwijd zelf bijgehouden) —
 * alleen over de buitenlandse bronnen.
 *
 * Detectie in twee lagen:
 *  1. De eigen "laatst bijgewerkt"-datum van de bron (elke bron publiceert
 *     er een) + waar beschikbaar de eigen wijzigingsnotitie (VK publiceert
 *     bijv. letterlijk "FCDO now advises against ..." per update).
 *  2. Inhoudsvergelijking per sectie via zin-vingerafdrukken: toegevoegde
 *     en gewijzigde zinnen worden LETTERLIJK getoond (de nieuwe tekst is
 *     bij detectie voorhanden); van verwijderde zinnen is alleen het
 *     aantal bekend (de oude tekst wordt bewust niet opgeslagen om de
 *     repository klein te houden — de wijzigingsnotitie van de bron dekt
 *     verwijderingen doorgaans).
 *
 * Kleur-/regiowijzigingen worden alleen nog gemeld als er óók bewijs van
 * een echte bron-update is (datum of inhoud gewijzigd): een afgeleide
 * kleur die "verandert" terwijl de brontekst identiek bleef, is per
 * definitie extractieruis (het eerdere valse Nigeria/Australië-geval).
 *
 * Draait dagelijks via .github/workflows/snapshot-changes.yml en commit:
 *   worker/data/history/<ISO3>.json       compacte geschiedenis per land
 *   worker/data/fingerprints/<ISO3>.json  zin-vingerafdrukken (alleen laatste)
 *   worker/data/recent-changes.json       gesorteerde lijst recente wijzigingen
 *
 * Bij een fout voor een bron blijft het vorige snapshot staan — een
 * netwerk-hik mag nooit als wijziging of verdwijning gerapporteerd worden.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import countries from '../src/data/countries.json' with { type: 'json' };
import * as uk from '../src/adapters/uk.js';
import * as us from '../src/adapters/us.js';
import * as canada from '../src/adapters/canada.js';
import * as ireland from '../src/adapters/ireland.js';
import * as france from '../src/adapters/france.js';
import * as australia from '../src/adapters/australia.js';
import * as spain from '../src/adapters/spain.js';
import * as germany from '../src/adapters/germany.js';
import * as newzealand from '../src/adapters/newzealand.js';
import * as denmark from '../src/adapters/denmark.js';
import { setReaderKey, setCorsProxy } from '../src/lib/fetch.js';
import { translate } from '../src/lib/translate.js';

setReaderKey(process.env.JINA_KEY);
setCorsProxy(process.env.CORS_PROXY_URL);

const ADAPTERS = { uk, us, ca: canada, ie: ireland, fr: france, au: australia, es: spain, de: germany, nz: newzealand, dk: denmark };
const SOURCE_LANG = { uk: 'en', us: 'en', ca: 'en', ie: 'en', au: 'en', fr: 'fr', es: 'es', de: 'de', nz: 'en', dk: 'da' };
const LEVEL_COLOR = ['', 'groen', 'geel', 'oranje', 'rood'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const FINGERPRINT_DIR = path.join(DATA_DIR, 'fingerprints');
const CHANGES_FILE = path.join(DATA_DIR, 'recent-changes.json');
const SOURCE_DATES_FILE = path.join(DATA_DIR, 'source-dates.json');
const MAX_ENTRIES_PER_COUNTRY = 60;
// Wijzigingen blijven 3 maanden raadpleegbaar (de periode-kiezer in de
// frontend gaat tot 92 dagen terug); de cap is een vangnet tegen ontsporing.
const RETENTION_DAYS = 92;
const MAX_CHANGES = 2000;
const CONCURRENCY = 5;
const MAX_SECTIONS_PER_CHANGE = 8;
const MAX_ADDED_PER_SECTION = 5;
const MAX_SENTENCE_LEN = 260;
const MAX_TRANSLATE_CALLS = 60; // dagcap; daarboven blijven originelen staan

/** Normaliseert datumvormen ("2026-07-01T14:00:27Z", "2026-06-30 09:07:49") naar yyyy-mm-dd. */
function normDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** Compacte, diff-vriendelijke vorm — alleen wat nodig is om wijzigingen te herkennen. */
function compact(adv) {
  return {
    level: adv.level ?? null,
    color: adv.color ?? null,
    regionalMaxLevel: adv.regionalMaxLevel ?? null,
    hasRegionalWarnings: !!adv.hasRegionalWarnings,
    assessmentStatus: adv.assessmentStatus ?? null,
    lastModified: normDate(adv.lastModified),
    updateNote: adv.updateNote ? String(adv.updateNote).slice(0, 400) : null,
    regionalBreakdown: (adv.regionalBreakdown || []).map((r) => ({ region: r.region, level: r.level })),
  };
}

// ---- Zin-vingerafdrukken ---------------------------------------------------

// Zinnen die routinematig verspringen zonder inhoudelijke wijziging
// (dynamische datumregels e.d.) horen niet in de vingerafdruk.
const NOISE_SENTENCE = /(vigentes a \d|toujours valable|still current at|last updated?:|date issued:|derni[eè]re mise [aà] jour|última actualización)/i;

function sentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 25 && !NOISE_SENTENCE.test(s));
}

const hash = (s) => createHash('sha1').update(s.toLowerCase()).digest('hex').slice(0, 10);
const headingKey = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Koppen die eruitzien als code (gelekte scripts/widgets) of onrealistisch
// lang zijn, horen niet in de vingerafdruk — dat is extractieruis, geen
// adviessectie. (Voorbeeld uit de praktijk: de chat-widget van travel.state.gov
// die HTML in JS-strings opbouwt.)
const CODE_HEADING = /querySelector|shadowRoot|innerHTML|function\s*\(|=>|[{};$]|document\.|window\./;
const validHeading = (h) => h && h.length <= 140 && !CODE_HEADING.test(h);

/**
 * Groepeert de secties van een advies per (genormaliseerde) kop, met de
 * unieke zinnen als set. Dezelfde kop komt op bronpagina's vaak meermaals
 * voor (VK: overzicht + detailpagina; Canada: "Useful links" onder elk
 * onderwerp) — zonder deze samenvoeging zou de diff heen en weer flappen
 * tussen de varianten.
 */
function groupSections(adv) {
  const groups = new Map(); // headingKey -> { heading, sentences: Map<hash, zin> }
  for (const t of adv.themes || []) {
    if (!t.heading || !t.text || !validHeading(t.heading)) continue;
    const key = headingKey(t.heading);
    let g = groups.get(key);
    if (!g) { g = { heading: t.heading, sentences: new Map() }; groups.set(key, g); }
    for (const s of sentences(t.text)) g.sentences.set(hash(s), s);
  }
  return groups;
}

/** Vingerafdruk van een advies: per (samengevoegde) sectie de kop + zin-hashes (geen tekst). */
function fingerprint(adv) {
  return [...groupSections(adv).values()].map((g) => ({ h: g.heading, s: [...g.sentences.keys()] }));
}

/**
 * Vergelijkt de oude vingerafdruk met het nieuwe advies. De nieuwe tekst is
 * voorhanden, dus toegevoegde/gewijzigde zinnen worden letterlijk
 * teruggegeven; van verdwenen zinnen alleen het aantal. Retourneert naast de
 * secties ook ongecapte totalen — nodig om ophaal-degradatie te herkennen.
 */
function diffContent(oldFp, adv) {
  const oldByHeading = new Map(oldFp.map((s) => [headingKey(s.h), new Set(s.s)]));
  const changed = [];
  const seen = new Set();
  let totalAdded = 0;
  let totalRemoved = 0;

  for (const [key, g] of groupSections(adv)) {
    seen.add(key);
    const oldHashes = oldByHeading.get(key);
    if (!oldHashes) {
      if (g.sentences.size) {
        totalAdded += g.sentences.size;
        changed.push({
          heading: g.heading, isNew: true, removedCount: 0,
          added: [...g.sentences.values()].slice(0, MAX_ADDED_PER_SECTION).map((s) => s.slice(0, MAX_SENTENCE_LEN)),
        });
      }
      continue;
    }
    const added = [...g.sentences.entries()].filter(([h]) => !oldHashes.has(h)).map(([, s]) => s);
    const removedCount = [...oldHashes].filter((h) => !g.sentences.has(h)).length;
    if (added.length || removedCount) {
      totalAdded += added.length;
      totalRemoved += removedCount;
      changed.push({
        heading: g.heading, isNew: false, removedCount,
        added: added.slice(0, MAX_ADDED_PER_SECTION).map((s) => s.slice(0, MAX_SENTENCE_LEN)),
      });
    }
  }

  // Verdwenen secties.
  for (const s of oldFp) {
    if (!seen.has(headingKey(s.h))) {
      totalRemoved += s.s.length;
      changed.push({ heading: s.h, isNew: false, removed: true, removedCount: s.s.length, added: [] });
    }
  }
  return { sections: changed.slice(0, MAX_SECTIONS_PER_CHANGE), totalAdded, totalRemoved, sectionsChanged: changed.length };
}

/**
 * Herkent een gedegradeerde/onvolledige ophaling: er verdwijnen (veel)
 * zinnen uit meerdere secties tegelijk zonder dat er ook maar één zin
 * bijkomt. Een echte redactionele wijziging voegt vrijwel altijd iets toe
 * of herformuleert; "alles-weg-niets-erbij" over de hele pagina betekent in
 * de praktijk dat de bron die run een uitgeklede pagina teruggaf (bijv. een
 * reader-proxy die accordions dicht rendert). In dat geval: geen wijziging
 * melden en de oude — volledige — vingerafdruk bewaren als vergelijkingsbasis.
 */
function looksDegraded(diff, oldFp, adv) {
  if (!diff.sectionsChanged || diff.totalAdded > 0) return false;
  if (diff.sectionsChanged >= 3) return true;
  const oldTotal = oldFp.reduce((n, s) => n + s.s.length, 0);
  const newTotal = [...groupSections(adv).values()].reduce((n, g) => n + g.sentences.size, 0);
  return oldTotal > 0 && newTotal < oldTotal * 0.7;
}

// ---- Niveau-/regiodiff (alleen gemeld bij bewijs van echte update) ---------

function regionKeyOf(region) {
  return region.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function diffLevels(before, after) {
  const changes = [];
  const okBefore = (before.assessmentStatus ?? 'ok') === 'ok' && before.level != null;
  const okAfter = (after.assessmentStatus ?? 'ok') === 'ok' && after.level != null;

  if (okBefore && okAfter && before.level !== after.level) {
    changes.push({
      kind: after.level > before.level ? 'up' : 'down',
      description: `Landelijk niveau gewijzigd van ${before.color || 'onbekend'} naar ${after.color || 'onbekend'}.`,
    });
  }

  const beforeMap = new Map((before.regionalBreakdown || []).map((r) => [regionKeyOf(r.region), r]));
  const afterMap = new Map((after.regionalBreakdown || []).map((r) => [regionKeyOf(r.region), r]));
  for (const [key, r] of afterMap) {
    const prev = beforeMap.get(key);
    if (!prev) {
      changes.push({ kind: 'regional-new', description: `Nieuwe regionale vermelding: "${r.region}" (${LEVEL_COLOR[r.level] || '?'}).` });
    } else if (prev.level !== r.level) {
      changes.push({
        kind: r.level > prev.level ? 'regional-up' : 'regional-down',
        description: `Regionale vermelding "${r.region}" gewijzigd van ${LEVEL_COLOR[prev.level] || '?'} naar ${LEVEL_COLOR[r.level] || '?'}.`,
      });
    }
  }
  for (const [key, r] of beforeMap) {
    if (!afterMap.has(key)) changes.push({ kind: 'regional-removed', description: `Regionale vermelding "${r.region}" komt niet meer voor.` });
  }
  return changes;
}

// ---- Vertaling (best effort, gecapt) ---------------------------------------

let translateBudget = MAX_TRANSLATE_CALLS;
async function toDutch(text, from) {
  if (!text || from === 'nl' || translateBudget <= 0) return null;
  translateBudget--;
  try {
    const r = await translate(text, 'nl', from);
    return r.text || null;
  } catch {
    return null;
  }
}

// ---- Bron-brede onderdrukking ----------------------------------------------

const BULK_MIN = 20;

/**
 * Als één bron op één datum bij tientallen landen tegelijk een
 * inhoudswijziging-zonder-datumbewijs meldt, is dat vrijwel zeker een
 * template-/ophaalwijziging van de bronsite — geen tientallen echte
 * adviesupdates (praktijkvoorbeeld: 229 Australië-"wijzigingen" op één dag).
 * Die individuele meldingen worden vervangen door één bulkmelding.
 * Datum-gedreven meldingen blijven altijd staan.
 */
function collapseBulk(changes) {
  const isContentOnly = (c) => c.kind === 'update' &&
    (c.evidence ? c.evidence === 'content' : /zonder nieuwe brondatum/.test(c.description || ''));
  const groups = new Map(); // "source|date" -> meldingen
  for (const c of changes) {
    if (!isContentOnly(c)) continue;
    const k = `${c.source}|${c.date}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const drop = new Set();
  const bulkByKey = new Map();
  for (const [key, list] of groups) {
    if (list.length < BULK_MIN) continue;
    for (const c of list) drop.add(c);
    const first = list[0];
    bulkByKey.set(key, {
      date: first.date, source: first.source, sourceLabel: first.sourceLabel, flag: first.flag,
      kind: 'bulk', count: list.length,
      description: `Bron-brede inhoudswijziging bij ${list.length} landen tegelijk — vrijwel zeker een site-/template-aanpassing of ophaalverschil, geen ${list.length} losse adviesupdates. De individuele meldingen zijn onderdrukt.`,
    });
  }
  if (!bulkByKey.size && !changes.some((c) => c.kind === 'bulk')) return changes;
  // Bestaande bulkmeldingen van eerdere runs voor dezelfde bron+datum samenvoegen.
  const rest = changes.filter((c) => {
    if (drop.has(c)) return false;
    if (c.kind !== 'bulk') return true;
    const key = `${c.source}|${c.date}`;
    const cur = bulkByKey.get(key);
    if (!cur || c.count > cur.count) bulkByKey.set(key, cur ? { ...c, count: Math.max(c.count, cur.count) } : c);
    return false;
  });
  return [...bulkByKey.values(), ...rest];
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx], idx);
      }
    })
  );
}

async function main() {
  mkdirSync(HISTORY_DIR, { recursive: true });
  mkdirSync(FINGERPRINT_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);

  let entries = Object.entries(countries).filter(
    ([, rec]) => rec.sources && Object.values(rec.sources).some(Boolean)
  );
  // Handig voor handmatig testen: SNAPSHOT_LIMIT=3 node scripts/snapshot-foreign.mjs
  if (process.env.SNAPSHOT_LIMIT) entries = entries.slice(0, Number(process.env.SNAPSHOT_LIMIT));

  const priorChanges = existsSync(CHANGES_FILE)
    ? JSON.parse(readFileSync(CHANGES_FILE, 'utf8')).changes || []
    : [];
  // Door de bron gemelde "laatst bijgewerkt"-datums per land/bron. Wordt
  // elke run volledig ververst (mislukte fetches behouden de vorige waarde),
  // zodat de frontend ook vóór de start van de monitoring kan tonen welke
  // landen in een gekozen periode een update kregen.
  const sourceDates = existsSync(SOURCE_DATES_FILE)
    ? JSON.parse(readFileSync(SOURCE_DATES_FILE, 'utf8')).dates || {}
    : {};
  const newChanges = [];
  let checked = 0;
  let failed = 0;

  await mapLimit(entries, CONCURRENCY, async ([iso3, rec]) => {
    const histFile = path.join(HISTORY_DIR, `${iso3}.json`);
    const fpFile = path.join(FINGERPRINT_DIR, `${iso3}.json`);
    const hist = existsSync(histFile) ? JSON.parse(readFileSync(histFile, 'utf8')) : { iso3, entries: [] };
    const fps = existsSync(fpFile) ? JSON.parse(readFileSync(fpFile, 'utf8')) : { iso3, sources: {} };
    const lastEntry = hist.entries[hist.entries.length - 1] || null;
    // Begin bij het vorige snapshot; bronnen die dit keer mislukken behouden hun laatste bekende staat.
    const nextSnapshot = { ...(lastEntry?.sources || {}) };
    let changedAny = false;
    let fetchedAny = false;

    for (const [sid, adapter] of Object.entries(ADAPTERS)) {
      const id = rec.sources[sid];
      if (!id) continue;
      checked++;
      let adv = null;
      try {
        adv = await adapter.getAdvisory(id);
      } catch {
        adv = null;
      }
      if (!adv) { failed++; continue; } // tijdelijke fout: vorige staat behouden, geen diff
      fetchedAny = true;

      const after = compact(adv);
      const before = lastEntry?.sources?.[sid];
      nextSnapshot[sid] = after;
      if (after.lastModified) {
        (sourceDates[iso3] ||= {})[sid] = after.lastModified;
      }

      const newFp = fingerprint(adv);
      const oldFp = fps.sources[sid] || null;

      if (!before) { fps.sources[sid] = newFp; continue; } // eerste keer voor deze bron: niets om mee te vergelijken

      const dateChanged = !!(before.lastModified && after.lastModified && before.lastModified !== after.lastModified);
      const diff = oldFp ? diffContent(oldFp, adv) : { sections: [], totalAdded: 0, totalRemoved: 0, sectionsChanged: 0 };

      // Gedegradeerde ophaling: oude vingerafdruk behouden zodat een latere
      // volledige ophaling weer tegen de goede basis vergelijkt. Een
      // datum-wijziging (laag 1) blijft wél gewoon gemeld.
      const degraded = oldFp && looksDegraded(diff, oldFp, adv);
      fps.sources[sid] = degraded ? oldFp : newFp;
      if (degraded) {
        // Ook de compacte staat (niveau/kleur) van een uitgeklede pagina is
        // onbetrouwbaar: behoud de vorige, neem alleen de brondatum over
        // zodat een datumwijziging niet elke run opnieuw gemeld wordt.
        nextSnapshot[sid] = { ...before, lastModified: after.lastModified || before.lastModified };
      }

      const contentChanged = !degraded && diff.sectionsChanged > 0;
      if (!dateChanged && !contentChanged) continue;

      changedAny = true;
      const lang = SOURCE_LANG[sid] || 'en';
      const noteNl = after.updateNote && lang !== 'en' ? await toDutch(after.updateNote, lang) : null;
      // Toegevoegde zinnen van niet-Engelse bronnen ook vertalen (gecapt).
      const sectionsOut = [];
      for (const sec of (contentChanged ? diff.sections : [])) {
        const out = { ...sec };
        if (lang !== 'en' && sec.added.length) {
          out.addedNl = [];
          for (const s of sec.added) out.addedNl.push((await toDutch(s, lang)) || s);
        }
        sectionsOut.push(out);
      }
      newChanges.push({
        date: today,
        iso3,
        countryNl: rec.nl,
        source: sid,
        sourceLabel: adapter.meta.label,
        flag: adapter.meta.flag,
        kind: 'update',
        evidence: dateChanged ? 'date' : 'content',
        description: dateChanged
          ? `Advies bijgewerkt door de bron (${before.lastModified} → ${after.lastModified}).`
          : 'Inhoud van het advies gewijzigd (zonder nieuwe brondatum).',
        sourceDate: after.lastModified || null,
        updateNote: after.updateNote || null,
        updateNoteNl: noteNl,
        sections: sectionsOut.length ? sectionsOut : null,
      });

      // Kleur-/regiowijzigingen alleen mét dit update-bewijs melden: zonder
      // gewijzigde brontekst is een "veranderde" afgeleide kleur per
      // definitie extractieruis. Bij een gedegradeerde ophaling is ook de
      // niveau-extractie onbetrouwbaar — dan overslaan.
      for (const d of (degraded ? [] : diffLevels(before, after))) {
        newChanges.push({
          date: today, iso3, countryNl: rec.nl, source: sid,
          sourceLabel: adapter.meta.label, flag: adapter.meta.flag, ...d,
        });
      }
    }

    if (!lastEntry || changedAny) {
      hist.entries.push({ date: today, sources: nextSnapshot });
      if (hist.entries.length > MAX_ENTRIES_PER_COUNTRY) hist.entries = hist.entries.slice(-MAX_ENTRIES_PER_COUNTRY);
      writeFileSync(histFile, JSON.stringify(hist));
    } else if (fetchedAny) {
      // Geen wijziging: geen nieuwe datumregel, maar wél de vergelijkings-
      // basis in place verversen. Zonder dit zouden velden die na een
      // formaatuitbreiding zijn toegevoegd (lastModified, updateNote) bij
      // ongewijzigde landen nooit in de basis belanden — waardoor een
      // latere datum-wijziging onvergelijkbaar en dus onzichtbaar blijft.
      lastEntry.sources = nextSnapshot;
      writeFileSync(histFile, JSON.stringify(hist));
    }
    if (fetchedAny) writeFileSync(fpFile, JSON.stringify(fps));
  });

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  // collapseBulk ook over eerdere runs: zo wordt bestaande ruis in
  // recent-changes.json bij de eerstvolgende run met terugwerkende kracht
  // samengevouwen tot bulkmeldingen.
  const allChanges = collapseBulk([...newChanges, ...priorChanges])
    .filter((c) => c.date >= cutoff)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, MAX_CHANGES);
  writeFileSync(CHANGES_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), changes: allChanges }));
  writeFileSync(SOURCE_DATES_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), dates: sourceDates }));

  console.log(`Snapshot klaar: ${entries.length} landen, ${checked} bron-aanvragen (${failed} mislukt/overgeslagen), ${newChanges.length} wijziging(en) gevonden vandaag.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
