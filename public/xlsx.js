'use strict';

// ==========================================================================
// Minimale, dependency-vrije XLSX-schrijver (OOXML + store-only ZIP).
// Genoeg voor nette redactie-uitdraaien: gekleurde cellen, vette koppen,
// tekstterugloop, kolombreedtes, bevroren kopregel, samengevoegde cellen en
// meerdere bladen. Geen externe bibliotheek, geen build-stap.
//
// Gebruik:
//   const blob = buildXlsx([
//     { name: 'Blad 1', cols: [24, 14, 14], freeze: 1,
//       merges: ['A3:C3'],
//       rows: [ [ {v:'Land', t:'header'}, {v:'VK', t:'header'} ],
//               [ {v:'Kenia', t:'country'}, {v:'Groen', t:'cc_groen'} ] ] },
//   ]);
//   // blob → download via een <a href=URL.createObjectURL(blob)>.
//
// Celstijlen (t): header, country, band, text, plain, num,
//   cc_groen, cc_geel, cc_oranje, cc_rood (gekleurde kleurcode-cellen).
// ==========================================================================

(function (global) {
  // ---- XML-escaping ------------------------------------------------------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

  // ---- Stijltabel: namen → index in cellXfs (zie styles.xml hieronder) ---
  const STYLE_INDEX = {
    plain: 0, header: 1, cc_groen: 2, cc_geel: 3, cc_oranje: 4, cc_rood: 5,
    text: 6, country: 7, band: 8, num: 9, title: 10,
  };

  const STYLES_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="4">' +
      '<font><sz val="11"/><name val="Calibri"/></font>' +               // 0 default
      '<font><b/><sz val="11"/><name val="Calibri"/></font>' +           // 1 bold
      '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>' + // 2 bold white
      '<font><b/><sz val="14"/><color rgb="FF154273"/><name val="Calibri"/></font>' + // 3 title blue
    '</fonts>' +
    '<fills count="8">' +
      '<fill><patternFill patternType="none"/></fill>' +                 // 0 (verplicht)
      '<fill><patternFill patternType="gray125"/></fill>' +              // 1 (verplicht)
      '<fill><patternFill patternType="solid"><fgColor rgb="FFEFF3F7"/></patternFill></fill>' + // 2 header
      '<fill><patternFill patternType="solid"><fgColor rgb="FFD7ECC6"/></patternFill></fill>' + // 3 groen
      '<fill><patternFill patternType="solid"><fgColor rgb="FFFBF3BA"/></patternFill></fill>' + // 4 geel
      '<fill><patternFill patternType="solid"><fgColor rgb="FFF8DDB8"/></patternFill></fill>' + // 5 oranje
      '<fill><patternFill patternType="solid"><fgColor rgb="FFF3C0C0"/></patternFill></fill>' + // 6 rood
      '<fill><patternFill patternType="solid"><fgColor rgb="FF154273"/></patternFill></fill>' + // 7 band blauw
    '</fills>' +
    '<borders count="2">' +
      '<border><left/><right/><top/><bottom/><diagonal/></border>' +     // 0 geen
      '<border><left style="thin"><color rgb="FFD5D9DD"/></left><right style="thin"><color rgb="FFD5D9DD"/></right>' +
        '<top style="thin"><color rgb="FFD5D9DD"/></top><bottom style="thin"><color rgb="FFD5D9DD"/></bottom><diagonal/></border>' + // 1 dun
    '</borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="11">' +
      // 0 plain
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1"><alignment vertical="top"/></xf>' +
      // 1 header
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>' +
      // 2 cc groen
      '<xf numFmtId="0" fontId="1" fillId="3" borderId="1" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>' +
      // 3 cc geel
      '<xf numFmtId="0" fontId="1" fillId="4" borderId="1" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>' +
      // 4 cc oranje
      '<xf numFmtId="0" fontId="1" fillId="5" borderId="1" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>' +
      // 5 cc rood
      '<xf numFmtId="0" fontId="1" fillId="6" borderId="1" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center"/></xf>' +
      // 6 text (wrap, top)
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1"><alignment vertical="top" wrapText="1"/></xf>' +
      // 7 country (bold)
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="1" applyFont="1" applyBorder="1"><alignment vertical="top"/></xf>' +
      // 8 band (bold white on blue)
      '<xf numFmtId="0" fontId="2" fillId="7" borderId="1" applyFont="1" applyFill="1" applyBorder="1"><alignment vertical="center"/></xf>' +
      // 9 num
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1"><alignment horizontal="center" vertical="top"/></xf>' +
      // 10 title
      '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" applyFont="1"><alignment vertical="center"/></xf>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  // ---- Kolomletter uit 0-index (0→A, 26→AA) ------------------------------
  function colLetter(n) {
    let s = '';
    n += 1;
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
    return s;
  }

  // ---- Eén worksheet-XML -------------------------------------------------
  function sheetXml(sheet) {
    const rows = sheet.rows || [];
    let maxCols = 0;
    for (const r of rows) maxCols = Math.max(maxCols, r.length);

    let cols = '';
    if (sheet.cols && sheet.cols.length) {
      cols = '<cols>' + sheet.cols.map((w, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>';
    }

    let freeze = '';
    if (sheet.freeze) {
      const y = sheet.freeze;
      freeze = '<sheetViews><sheetView workbookViewId="0">' +
        `<pane ySplit="${y}" topLeftCell="A${y + 1}" activePane="bottomLeft" state="frozen"/>` +
        '<selection pane="bottomLeft"/></sheetView></sheetViews>';
    }

    let body = '';
    rows.forEach((row, ri) => {
      const r = ri + 1;
      let cells = '';
      row.forEach((cell, ci) => {
        if (cell == null) return;
        const ref = colLetter(ci) + r;
        const s = STYLE_INDEX[cell.t] ?? 0;
        if (typeof cell.v === 'number' && Number.isFinite(cell.v)) {
          cells += `<c r="${ref}" s="${s}"><v>${cell.v}</v></c>`;
        } else {
          const v = esc(cell.v);
          if (v === '') cells += `<c r="${ref}" s="${s}"/>`;
          else cells += `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${v}</t></is></c>`;
        }
      });
      const ht = sheet.rowHeights && sheet.rowHeights[ri]
        ? ` ht="${sheet.rowHeights[ri]}" customHeight="1"` : '';
      body += `<row r="${r}"${ht}>${cells}</row>`;
    });

    const merges = (sheet.merges && sheet.merges.length)
      ? `<mergeCells count="${sheet.merges.length}">` +
        sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('') + '</mergeCells>'
      : '';

    const dim = rows.length ? `A1:${colLetter(Math.max(0, maxCols - 1))}${rows.length}` : 'A1';

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<dimension ref="${dim}"/>` + freeze + cols +
      `<sheetData>${body}</sheetData>` + merges +
      '</worksheet>';
  }

  // ---- CRC32 (voor de ZIP-headers) ---------------------------------------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ---- Store-only ZIP (geen compressie: simpel en ruim snel genoeg) ------
  function zip(files) {
    const enc = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    const u16 = (n) => [n & 0xFF, (n >>> 8) & 0xFF];
    const u32 = (n) => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const data = f.data instanceof Uint8Array ? f.data : enc.encode(f.data);
      const crc = crc32(data);
      const local = [].concat(
        u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length),
        u16(nameBytes.length), u16(0));
      chunks.push(new Uint8Array(local), nameBytes, data);
      const localLen = local.length + nameBytes.length + data.length;

      central.push([].concat(
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length),
        u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0),
        u32(offset)), nameBytes);
      offset += localLen;
    }

    const centralStart = offset;
    let centralLen = 0;
    const centralChunks = [];
    for (let i = 0; i < central.length; i += 2) {
      const head = new Uint8Array(central[i]);
      centralChunks.push(head, central[i + 1]);
      centralLen += head.length + central[i + 1].length;
    }
    const end = [].concat(
      u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(centralLen), u32(centralStart), u16(0));

    const parts = [...chunks, ...centralChunks, new Uint8Array(end)];
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.length; }
    return out;
  }

  // ---- Publieke API ------------------------------------------------------
  function buildXlsx(sheets) {
    const names = sheets.map((s, i) => s.name || `Blad${i + 1}`);
    const sheetsXml = sheets.map((s) => sheetXml(s));

    const contentTypes =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      '</Types>';

    const rootRels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';

    const workbook =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets>' +
      names.map((n, i) => `<sheet name="${esc(n).slice(0, 31)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
      '</sheets></workbook>';

    const workbookRels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      '</Relationships>';

    const files = [
      { name: '[Content_Types].xml', data: contentTypes },
      { name: '_rels/.rels', data: rootRels },
      { name: 'xl/workbook.xml', data: workbook },
      { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
      { name: 'xl/styles.xml', data: STYLES_XML },
      ...sheetsXml.map((xml, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml })),
    ];
    return new Blob([zip(files)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }

  global.buildXlsx = buildXlsx;
})(typeof window !== 'undefined' ? window : globalThis);
