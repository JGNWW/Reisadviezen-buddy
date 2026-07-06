// Lokale ontwikkel-wrapper: draait de Worker-fetch-handler op een Node http-poort
// zodat de frontend hem kan gebruiken via ?proxy=http://localhost:8787
import { createServer } from 'node:http';
import worker from './src/index.js';

const PORT = process.env.PORT || 8787;

createServer(async (req, res) => {
  const url = `http://localhost:${PORT}${req.url}`;
  try {
    // Geef env door (o.a. secrets voor de reader-/CORS-proxy) net als Cloudflare doet.
    const response = await worker.fetch(new Request(url, { method: req.method }), {
      JINA_KEY: process.env.JINA_KEY,
      CORS_PROXY_URL: process.env.CORS_PROXY_URL,
    });
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    const buf = Buffer.from(await response.arrayBuffer());
    res.end(buf);
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
}).listen(PORT, () => console.log(`Lokale worker op http://localhost:${PORT}`));
