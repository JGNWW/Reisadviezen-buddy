/**
 * ONTDEKKING v2 (wegwerp): het EDA crisis-portaal
 * (eda.admin.ch/crisis/de/reisehinweise) serveert ALLE landen-Reisehinweise in
 * één HTML-pagina (~1,9 MB) en is NIET datacenter-geblokkeerd. Deze probe:
 *  1) test of een PLAIN fetch (zonder browser) de volle pagina teruggeeft —
 *     dan kan de Worker/CI 'm direct ophalen;
 *  2) toont de per-land markup zodat we een parser kunnen bouwen: voor een
 *     paar landen de omringende HTML + welke standaardformule ernaast staat.
 */
const URL_DE = 'https://www.eda.admin.ch/crisis/de/reisehinweise';

// EDA-standaardformules → niveau (Nederlandse kleurschaal 1–4).
const PHRASES = [
  [/von reisen (in dieses land |dringend )?wird abgeraten|wird von reisen abgeraten/i, 4, 'abgeraten (rood)'],
  [/von (nicht dringend notwendigen |touristischen )reisen wird abgeraten/i, 3, 'nicht dringend notwendige reizen (oranje)'],
  [/der pers[öo]nlichen sicherheit ist (erh[öo]hte |grosse )?aufmerksamkeit zu schenken/i, 2, 'grosse Aufmerksamkeit (geel)'],
  [/grunds[äa]tzlich als sicher/i, 1, 'grundsätzlich sicher (groen)'],
];

async function main() {
  let html = null;
  let status = null;
  try {
    const r = await fetch(URL_DE, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'de-CH,de;q=0.9',
      },
    });
    status = r.status;
    html = await r.text();
  } catch (e) {
    console.log(`PLAIN fetch faalde: ${String(e.message).slice(0, 100)}`);
    return;
  }
  console.log(`PLAIN fetch: status ${status}, ${html.length} tekens HTML`);
  console.log(`Bevat standaardformule (raw HTML)? ${/abgeraten|grundsätzlich als sicher|grosse Aufmerksamkeit/i.test(html) ? 'JA' : 'nee'}`);
  console.log(`Onderhoud/Wartung-pagina? ${/wartungsarbeiten/i.test(html.slice(0, 3000)) && html.length < 50000 ? 'JA (kort)' : 'nee (volle inhoud)'}`);

  // Hoe vaak komen de standaardformules voor (ruwe indicatie van #landen)?
  for (const [re, lvl, label] of PHRASES) {
    const m = html.match(new RegExp(re.source, 'gi'));
    console.log(`  formule "${label}" (niveau ${lvl}): ${m ? m.length : 0}x`);
  }

  // Structuur: dump ~700 tekens rond een paar testlanden zodat we het
  // herhalende per-land-blok herkennen (kop/anchor/id).
  for (const name of ['Afghanistan', 'Thailand', 'Japan', 'Ukraine']) {
    const i = html.indexOf(`>${name}<`) >= 0 ? html.indexOf(`>${name}<`) : html.indexOf(name);
    console.log(`\n===== ${name} (index ${i}) =====`);
    if (i < 0) { console.log('  niet gevonden'); continue; }
    const around = html.slice(Math.max(0, i - 350), i + 900).replace(/\s+/g, ' ');
    console.log('  ' + around);
    // Welke formule staat in dit venster?
    const win = html.slice(i, i + 2500);
    const hit = PHRASES.find(([re]) => re.test(win));
    console.log(`  → dichtstbijzijnde formule: ${hit ? hit[2] : 'geen in 2500 tekens'}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
