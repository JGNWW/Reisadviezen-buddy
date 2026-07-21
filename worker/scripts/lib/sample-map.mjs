/**
 * Kaart-bemonstering voor de map-colors CI-job.
 *
 * Cloudflare Workers kunnen geen afbeeldingen decoderen; daarom gebeurt de
 * pixel-analyse hier, in GitHub Actions, met een echte Chromium. We halen de
 * kaart-bytes serverside op, zetten ze om naar een data:-URL (die tainten de
 * canvas NIET, in tegenstelling tot een cross-origin <img>), tekenen ze op een
 * canvas en tellen per pixel de tint-klasse. De telling gaat vervolgens naar
 * deriveMapAssessment (src/analysis/map-palette.js) voor het niveau/kleur.
 */

/**
 * @param {import('playwright').Page} page  een (leeg) Chromium-tabblad
 * @param {string} imageUrl                 URL van de zonekaart
 * @param {{grid?:number}} [opts]           grid: rasterbreedte voor een ASCII-plattegrond (diagnose)
 * @returns {Promise<{w:number,h:number,cls:object,top:object[],gridStr:string|null} | {error:string}>}
 */
export async function sampleMapImage(page, imageUrl, opts = {}) {
  let resp;
  try {
    resp = await fetch(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (ReisadviezenBuddy map-sampler)' } });
  } catch (e) {
    return { error: 'fetch: ' + String(e.message).slice(0, 60) };
  }
  if (!resp.ok) return { error: `img ${resp.status}` };
  const ct = (resp.headers.get('content-type') || 'image/jpeg').split(';')[0];
  const b64 = Buffer.from(await resp.arrayBuffer()).toString('base64');
  const dataUrl = `data:${ct};base64,${b64}`;

  return page.evaluate(async ({ src, grid }) => {
    const img = new Image();
    const ok = await new Promise((res) => { img.onload = () => res(true); img.onerror = () => res(false); img.src = src; });
    if (!ok || !img.naturalWidth) return { error: 'decode-fout' };
    const w = img.naturalWidth, h = img.naturalHeight;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
    let data;
    try { data = cx.getImageData(0, 0, w, h).data; } catch (e) { return { error: 'taint: ' + e.message }; }

    const cls = { rood: 0, oranje: 0, geel: 0, groen: 0, wit: 0, blauw: 0, grijs: 0 };
    const hist = new Map(); // gekwantiseerde kleur-histogram voor diagnose
    const G = grid || 0;
    const gridCells = G ? Array.from({ length: G * G }, () => ({ rood: 0, oranje: 0, geel: 0, groen: 0, wit: 0, blauw: 0, grijs: 0 })) : null;

    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 128) continue;
      const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
      hist.set(key, (hist.get(key) || 0) + 1);

      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, v = mx / 255;
      let pix;
      if (d < 10) {
        // Vrijwel vlakke kleur (r≈g≈b): geen bruikbare tint, alleen op waarde.
        pix = v > 0.82 ? 'wit' : 'grijs';
      } else {
        const s = d / mx;
        let hh = 0;
        if (mx === r) hh = 60 * (((g - b) / d) % 6);
        else if (mx === g) hh = 60 * ((b - r) / d + 2);
        else hh = 60 * ((r - g) / d + 4);
        if (hh < 0) hh += 360;
        // Zee/water: France's kaartsjabloon gebruikt een vast lichtcyaan
        // (rgb≈208,240,240 · tint≈180°) voor water — óók bij lage verzadiging,
        // dus vóór de algemene 0.18-afkap gecontroleerd. Dit is GEEN "normaal
        // land" en telt dus niet mee als wit: anders lijken kustlanden en
        // kleine landen met veel zee/buurlanden in beeld ten onrechte
        // grotendeels "normaal" (bleek de directe oorzaak bij Libanon).
        if (hh >= 150 && hh <= 260) pix = 'blauw';
        else if (s < 0.18) pix = v > 0.82 ? 'wit' : 'grijs';
        else if (hh < 20 || hh >= 345) pix = 'rood';
        else if (hh < 45) pix = 'oranje';
        // France's oudere kaartsjabloon kleurt "geen bijzondere waakzaamheid"
        // in dof olijf (waarde≈0.81); alleen fel/helder geel (waarde≥0.88) is
        // échte "vigilance renforcée".
        else if (hh < 70) pix = v >= 0.88 ? 'geel' : 'wit';
        else pix = 'groen'; // hh 70–150, buiten het zee-bereik
      }
      cls[pix]++;
      if (gridCells) {
        const gx = Math.min(G - 1, Math.floor((x / w) * G));
        const gy = Math.min(G - 1, Math.floor((y / h) * G));
        gridCells[gy * G + gx][pix]++;
      }
    }

    // Top-kleuren (gemiddelde RGB per bucket) voor diagnose/kalibratie.
    const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => {
      const r = ((k >> 6) & 7) * 32 + 16, g = ((k >> 3) & 7) * 32 + 16, b = (k & 7) * 32 + 16;
      return { rgb: [r, g, b], n };
    });

    let gridStr = null;
    if (gridCells) {
      const CH = { rood: 'R', oranje: 'O', geel: 'G', groen: 'g', wit: '.', blauw: '~', grijs: '#' };
      const rows = [];
      for (let gy = 0; gy < G; gy++) {
        let row = '';
        for (let gx = 0; gx < G; gx++) {
          const c = gridCells[gy * G + gx];
          const topCell = Object.entries(c).sort((a2, b2) => b2[1] - a2[1])[0];
          row += topCell && topCell[1] > 0 ? CH[topCell[0]] : ' ';
        }
        rows.push(row);
      }
      gridStr = rows.join('\n');
    }

    return { w, h, cls, top, gridStr };
  }, { src: dataUrl, grid: opts.grid || 0 });
}
