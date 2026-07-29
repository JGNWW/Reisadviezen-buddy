'use strict';

// ==========================================================================
// Uitdraai-model — de rekenkern achter Excel en PDF.
//
// Bewust DOM-vrij en zonder afhankelijkheden: app.js verzamelt de ruwe data
// per land (een "dataset"), dit bestand vormt daar de bladen en pagina's uit,
// en app.js zet het om naar cellen of print-HTML. Zo is de vorm van de
// uitdraai in Node te testen zonder browser (worker/test/export-model.test.mjs).
//
// Datasetvorm (alles al opgemaakt/vertaald door app.js):
//   {
//     sources: [{ id, label, short }],
//     countries: [{
//       iso3, name,
//       nl:      { color, level, extras: [kleur], regional: bool, date, url },
//       sources: [{ id, label, short, color, level, status, levelLabel,
//                   extras: [kleur], regional: bool, date, stale, snapshotDate,
//                   colorSource, url }],
//       themes:  [{ id, label, entries: [{ sourceId, label, color, level,
//                                          status, text, url }] }],
//       changes: [{ label, date, heading, sentence }],
//     }],
//   }
//
// status: 'ok' · 'uncertain' (niet vast te stellen) · 'none' (bron publiceert
// geen kleurcode) · 'na' (bron deze keer niet opgehaald).
// ==========================================================================

(function (global) {
  const COLOR_LABELS = { groen: 'Groen', geel: 'Geel', oranje: 'Oranje', rood: 'Rood' };
  const COLOR_LEVEL = { groen: 1, geel: 2, oranje: 3, rood: 4 };
  const GEEN_KLEURCODE = 'Kleurcode ontbreekt';

  /** Leesbare kleurtekst voor een cel — nooit leeg, want een leeg vakje leest
   *  als "vergeten" terwijl "geen kleurcode" een echt antwoord van de bron is. */
  function colorText(cell) {
    if (!cell || cell.status === 'na') return 'Niet opgehaald';
    if (cell.status === 'none') return GEEN_KLEURCODE;
    if (cell.status === 'uncertain') return 'Onzeker';
    if (!cell.color) return '—';
    return COLOR_LABELS[cell.color] || cell.color;
  }

  /** Kort teken voor in de matrixcel: het niveaucijfer, of een symbool als er
   *  geen niveau is. Zwart-wit geprint blijft dit leesbaar — anders dan kleur. */
  function cellMark(cell) {
    if (!cell || cell.status === 'na') return '·';
    if (cell.status === 'none') return '—';
    if (cell.status === 'uncertain') return '?';
    const lvl = cell.level != null ? cell.level : COLOR_LEVEL[cell.color];
    return lvl ? String(lvl) : '–';
  }

  /**
   * Kapt een brontekst af op een zinsgrens in plaats van midden in een woord.
   * Geeft hooguit `maxSentences` zinnen en `maxChars` tekens; is er meer, dan
   * eindigt de tekst op " …". De volledige tekst staat altijd in Excel.
   */
  function clipSentences(text, maxSentences = 3, maxChars = 520) {
    const full = String(text || '').replace(/\s+/g, ' ').trim();
    if (!full) return '';
    // Zinsgrens: westerse leestekens én de Oost-Aziatische punt (bronnen JP/KR).
    const parts = full.split(/(?<=[.!?…。！？])\s+/);
    let out = '';
    for (const p of parts.slice(0, maxSentences)) {
      const next = out ? `${out} ${p}` : p;
      if (out && next.length > maxChars) break;
      out = next;
      if (out.length >= maxChars) break;
    }
    if (!out) out = parts[0] || full;
    if (out.length > maxChars) return out.slice(0, maxChars).replace(/\s+\S*$/, '') + ' …';
    return out.length < full.length ? out + ' …' : out;
  }

  /** Namen samenvatten: hooguit `max` labels, daarna "+n meer". */
  function names(list, max = 3) {
    if (list.length <= max) return list.join(', ');
    return `${list.slice(0, max).join(', ')} +${list.length - max} meer`;
  }

  /**
   * Grootste afwijking van een land t.o.v. NederlandWereldwijd, als één zin.
   * Strenger weegt zwaarder dan milder — dat is waar een redacteur naar zoekt.
   */
  function deviationLabel(nlLevel, cells) {
    const scored = cells.filter((c) => c.status === 'ok' && c.level != null && nlLevel != null);
    const bits = [];
    if (scored.length) {
      const up = scored.filter((c) => c.level > nlLevel);
      const down = scored.filter((c) => c.level < nlLevel);
      if (up.length) {
        const worst = Math.max(...up.map((c) => c.level));
        const who = names(up.filter((c) => c.level === worst).map((c) => c.short));
        bits.push(worst === 4 ? `${who}: niet reizen` : `${who} strenger`);
      }
      if (down.length) {
        const best = Math.min(...down.map((c) => c.level));
        bits.push(`${names(down.filter((c) => c.level === best).map((c) => c.short))} milder`);
      }
    }
    if (bits.length) return bits.join(', ');
    const none = cells.filter((c) => c.status === 'none');
    if (none.length) return `${names(none.map((c) => c.short))}: geen kleurcode`;
    return scored.length ? 'Eensgezind' : '—';
  }

  /**
   * Telling per kleurcode over een rij broncellen: hoeveel bronnen hanteren
   * welke kleur. Alles wat geen kleurcode oplevert — de bron publiceert er geen,
   * we konden hem niet vaststellen, of hij was niet op te halen — valt onder
   * `geen`, zodat de vijf getallen altijd optellen tot het aantal bronnen.
   */
  function distribution(cells) {
    const out = { groen: 0, geel: 0, oranje: 0, rood: 0, geen: 0 };
    for (const c of cells || []) {
      if (c && c.status === 'ok' && c.color && out[c.color] != null) out[c.color]++;
      else out.geen++;
    }
    return out;
  }

  /** Niveau van een cel (1–4), of null als de bron geen kleurcode geeft. */
  function cellLevel(c) {
    if (!c || c.status !== 'ok') return null;
    return c.level != null ? c.level : (COLOR_LEVEL[c.color] || null);
  }

  /**
   * Mediaan van de bronnen die wél een niveau geven; null als niemand dat doet.
   * Bij een even aantal het gemiddelde van de twee middelste, afgerond — dat
   * houdt de uitkomst op de vier-punts-schaal.
   */
  function medianLevel(cells) {
    const levels = (cells || []).map(cellLevel).filter((l) => l != null).sort((a, b) => a - b);
    if (!levels.length) return null;
    const mid = Math.floor(levels.length / 2);
    return levels.length % 2 ? levels[mid] : Math.round((levels[mid - 1] + levels[mid]) / 2);
  }

  /** Hoeveel bronnen zijn strenger, milder of gelijk aan NederlandWereldwijd. */
  function versusNl(cells, nlLevel) {
    const res = { strenger: 0, milder: 0, gelijk: 0, beoordeeld: 0 };
    for (const c of cells || []) {
      const lvl = cellLevel(c);
      if (lvl == null) continue;
      res.beoordeeld++;
      if (nlLevel == null) continue;
      if (lvl > nlLevel) res.strenger++;
      else if (lvl < nlLevel) res.milder++;
      else res.gelijk++;
    }
    return res;
  }

  /**
   * Blad/pagina 1: landen × bronnen met kleurcodes, plus per land de grootste
   * afwijking. Levert ook de telling per kleurcode voor het voorblad.
   */
  function overviewMatrix(ds) {
    const sources = ds.sources || [];
    const header = ['Land', 'NL (NWW)', ...sources.map((s) => s.label), 'Grootste afwijking t.o.v. NL', 'NL bijgewerkt'];
    const tally = { groen: 0, geel: 0, oranje: 0, rood: 0, onbekend: 0 };
    const body = (ds.countries || []).map((c) => {
      const bySource = new Map((c.sources || []).map((s) => [s.id, s]));
      const cells = sources.map((meta) => {
        const s = bySource.get(meta.id);
        if (!s) return { id: meta.id, short: meta.short, label: meta.label, status: 'na' };
        return {
          id: meta.id, short: meta.short, label: meta.label,
          color: s.color || null,
          level: s.level != null ? s.level : (COLOR_LEVEL[s.color] || null),
          status: s.status || 'ok',
          regional: !!s.regional,
        };
      });
      const nlLevel = c.nl?.level != null ? c.nl.level : (COLOR_LEVEL[c.nl?.color] || null);
      if (c.nl?.color && tally[c.nl.color] != null) tally[c.nl.color]++; else tally.onbekend++;
      return {
        iso3: c.iso3,
        country: c.name,
        nl: { color: c.nl?.color || null, level: nlLevel, status: c.nl?.color ? 'ok' : 'na', regional: !!c.nl?.regional, short: 'NL', label: 'NederlandWereldwijd' },
        cells,
        // Hoeveel bronnen hanteren welke kleurcode — op het scherm en in de PDF
        // één smalle kolom met vijf vakjes, in Excel vijf sorteerbare kolommen.
        dist: distribution(cells),
        median: medianLevel(cells),
        deviation: deviationLabel(nlLevel, cells),
        date: c.nl?.date || '—',
      };
    });
    return { header, body, tally };
  }

  /**
   * Blad "Per bron per thema": één rij per land × bron × thema. Lang in plaats
   * van breed — dát is de vorm waarop je in Excel kunt filteren en draaien.
   */
  function longRows(ds) {
    const out = [];
    for (const c of ds.countries || []) {
      const bySource = new Map((c.sources || []).map((s) => [s.id, s]));
      for (const t of c.themes || []) {
        for (const e of t.entries || []) {
          const s = e.sourceId === 'nl' ? null : bySource.get(e.sourceId);
          out.push({
            land: c.name,
            bron: e.label,
            bronId: e.sourceId,
            thema: t.label,
            niveau: e.status === 'ok' && e.level != null ? e.level : null,
            kleur: colorText(e),
            tekst: e.text,
            bijgewerkt: (e.sourceId === 'nl' ? c.nl?.date : s?.date) || '',
            herkomst: e.sourceId === 'nl' ? 'statisch' : herkomst(s),
            url: e.url || (e.sourceId === 'nl' ? c.nl?.url : s?.url) || '',
          });
        }
      }
    }
    return out;
  }

  function herkomst(s) {
    if (!s) return '';
    if (s.status === 'na') return 'niet opgehaald';
    return s.stale ? `snapshot${s.snapshotDate ? ' ' + s.snapshotDate : ''}` : 'live';
  }

  /**
   * Blad "Afwijkingen": alleen de regels waar een bron van NederlandWereldwijd
   * afwijkt, met de richting erbij. Dat is de werklijst uit de uitdraai.
   */
  function divergenceRows(ds) {
    const out = [];
    for (const c of ds.countries || []) {
      const nlLevel = c.nl?.level != null ? c.nl.level : (COLOR_LEVEL[c.nl?.color] || null);
      for (const s of c.sources || []) {
        if (s.status === 'na') continue;
        if (s.status === 'none' || s.status === 'uncertain') {
          out.push({
            land: c.name, bron: s.label, nl: colorText(c.nl ? { status: 'ok', color: c.nl.color } : null),
            bronKleur: colorText(s), richting: s.status === 'none' ? 'geen kleurcode' : 'onzeker',
            verschil: null, bijgewerkt: s.date || '', herkomst: herkomst(s), url: s.url || '',
          });
          continue;
        }
        const lvl = s.level != null ? s.level : COLOR_LEVEL[s.color];
        if (lvl == null || nlLevel == null || lvl === nlLevel) continue;
        out.push({
          land: c.name, bron: s.label, nl: colorText({ status: 'ok', color: c.nl.color }),
          bronKleur: colorText(s), richting: lvl > nlLevel ? 'strenger' : 'milder',
          verschil: lvl - nlLevel, bijgewerkt: s.date || '', herkomst: herkomst(s), url: s.url || '',
        });
      }
    }
    // Zwaarste afwijking eerst: dat is waar je als redacteur begint.
    out.sort((a, b) => (b.verschil || 0) - (a.verschil || 0));
    return out;
  }

  /**
   * Blad/voorblad "Verantwoording": per bron hoe vaak hij live binnenkwam en
   * hoe vaak uit het snapshot-vangnet, met de oudste bijwerkdatum. Zonder dit
   * weet de lezer niet hoe hard de vergelijking is.
   */
  function provenanceRows(ds) {
    const rows = [];
    const countries = ds.countries || [];
    for (const meta of ds.sources || []) {
      let live = 0, snap = 0, na = 0, geen = 0;
      const dates = [];
      for (const c of countries) {
        const s = (c.sources || []).find((x) => x.id === meta.id);
        if (!s || s.status === 'na') { na++; continue; }
        if (s.stale) snap++; else live++;
        if (s.status === 'none') geen++;
        if (s.date) dates.push(s.date);
      }
      rows.push({
        bron: meta.label, live, snapshot: snap, nietOpgehaald: na, geenKleurcode: geen,
        bijgewerkt: dates.length ? dates.sort().slice(-1)[0] : '',
      });
    }
    return rows;
  }

  const API = {
    COLOR_LABELS, COLOR_LEVEL, GEEN_KLEURCODE,
    colorText, cellMark, clipSentences, deviationLabel,
    distribution, cellLevel, medianLevel, versusNl,
    overviewMatrix, longRows, divergenceRows, provenanceRows, herkomst,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.ExportModel = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
