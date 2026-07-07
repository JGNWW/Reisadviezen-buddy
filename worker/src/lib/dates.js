/**
 * Zet door mensen geschreven datums uit de bronpagina's ("June 12, 2026",
 * "07 avril 2026", "29 de mayo de 2026") om naar ISO (yyyy-mm-dd), zodat
 * de wijzigingsdetectie datums van verschillende bronnen kan vergelijken.
 * Geeft null terug bij twijfel — een verkeerd geparste datum zou een valse
 * "bron heeft bijgewerkt"-melding opleveren.
 */
const MONTHS = {
  // Engels
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  // Frans (genormaliseerd, zonder accenten)
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  // Spaans
  enero: 1, febrero: 2, marzo: 3, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  // 'abril' (ES) == 'april' (EN); 'abril' apart:
  abril: 4,
};

const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Herkent "12 June 2026", "June 12, 2026", "07 avril 2026" en
 * "29 de mayo de 2026" in de meegegeven tekst; pakt de EERSTE match.
 */
export function parseHumanDate(text) {
  if (!text) return null;
  const t = strip(String(text));
  // dag maand jaar (evt. met "de" ertussen, Spaans)
  let m = t.match(/\b(\d{1,2})\s+(?:de\s+)?([a-z]+)\s+(?:de\s+)?(\d{4})\b/);
  if (m && MONTHS[m[2]]) return iso(m[3], MONTHS[m[2]], m[1]);
  // maand dag, jaar (Engels/VS)
  m = t.match(/\b([a-z]+)\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (m && MONTHS[m[1]]) return iso(m[3], MONTHS[m[1]], m[2]);
  return null;
}

function iso(y, mo, d) {
  const day = Number(d), month = Number(mo), year = Number(y);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
