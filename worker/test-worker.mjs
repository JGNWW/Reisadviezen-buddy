// Test de Worker-fetch-handler in Node (Node 22 heeft Request/Response/fetch).
import worker from './src/index.js';

async function call(path) {
  const res = await worker.fetch(new Request('https://proxy.local' + path));
  return res;
}

// /health
let res = await call('/health');
console.log('/health', res.status, await res.clone().json());

// /advisory/ETH
res = await call('/advisory/ETH?sources=uk,us,ca,ie');
const data = await res.json();
console.log('\n/advisory/ETH', res.status, '| CORS:', res.headers.get('access-control-allow-origin'));
for (const s of data.sources) {
  if (s.unavailable) console.log(`  ${s.source}: (geen koppeling)`);
  else if (s.error) console.log(`  ${s.source}: FOUT ${s.error}`);
  else console.log(`  ${s.source}: niveau=${s.level} kleur=${s.color} themes=${s.themes.length} mapProxy=${s.mapProxy || '-'}`);
}

// /map/ca/ETH  (Canada heeft een kaart)
res = await call('/map/ca/ETH');
console.log('\n/map/ca/ETH', res.status, 'type=', res.headers.get('content-type'), 'CORS=', res.headers.get('access-control-allow-origin'));
const buf = new Uint8Array(await res.arrayBuffer());
console.log('  bytes:', buf.length, '(PNG magic:', buf[0] === 0x89 && buf[1] === 0x50, ')');

// /map/uk/ETH (UK kaart via scrape)
res = await call('/map/uk/ETH');
console.log('/map/uk/ETH', res.status, 'type=', res.headers.get('content-type'));
