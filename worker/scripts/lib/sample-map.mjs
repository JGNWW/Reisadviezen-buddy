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
 * @returns {Promise<{w:number,h:number,cls:object} | {error:string}>}
 */
export async function sampleMapImage(page, imageUrl) {
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

  return page.evaluate(async (src) => {
    const img = new Image();
    const ok = await new Promise((res) => { img.onload = () => res(true); img.onerror = () => res(false); img.src = src; });
    if (!ok || !img.naturalWidth) return { error: 'decode-fout' };
    const w = img.naturalWidth, h = img.naturalHeight;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
    let data;
    try { data = cx.getImageData(0, 0, w, h).data; } catch (e) { return { error: 'taint: ' + e.message }; }
    // Tint-classificatie (HSV) i.p.v. exacte hex: JPEG-compressie verschuift
    // kleuren licht, tinten blijven stabiel. Zelfde grenzen als de proef.
    const cls = { rood: 0, oranje: 0, geel: 0, groen: 0, wit: 0, blauw: 0, grijs: 0 };
    const hist = new Map(); // gekwantiseerde kleur-histogram voor diagnose
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 128) continue;
      const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
      hist.set(key, (hist.get(key) || 0) + 1);
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, v = mx / 255, s = mx === 0 ? 0 : d / mx;
      let hh = 0;
      if (d !== 0) { if (mx === r) hh = 60 * (((g - b) / d) % 6); else if (mx === g) hh = 60 * ((b - r) / d + 2); else hh = 60 * ((r - g) / d + 4); }
      if (hh < 0) hh += 360;
      if (s < 0.18) { if (v > 0.82) cls.wit++; else cls.grijs++; continue; }
      if (hh >= 185 && hh <= 255) { cls.blauw++; continue; }
      if (hh < 20 || hh >= 345) cls.rood++;
      else if (hh < 45) cls.oranje++;
      else if (hh < 70) cls.geel++;
      else if (hh < 170) cls.groen++;
    }
    // Top-kleuren (gemiddelde RGB per bucket) voor diagnose/kalibratie.
    const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => {
      const r = ((k >> 6) & 7) * 32 + 16, g = ((k >> 3) & 7) * 32 + 16, b = (k & 7) * 32 + 16;
      return { rgb: [r, g, b], n };
    });
    return { w, h, cls, top };
  }, dataUrl);
}
