/**
 * Lokale preview-server voor de statische build in ./docs.
 *
 * Reisadviezen-buddy is een statische site (bedoeld voor GitHub Pages). Deze
 * server serveert alleen de gebouwde bestanden zodat je het resultaat lokaal
 * kunt bekijken. Bouw eerst met `npm run build`.
 */
import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS = join(__dirname, '..', 'docs');
const PORT = process.env.PORT || 3000;

if (!existsSync(join(DOCS, 'index.html'))) {
  console.error('Geen build gevonden in ./docs. Draai eerst: npm run build');
  process.exit(1);
}

const app = express();
app.use(express.static(DOCS));
app.listen(PORT, () => {
  console.log(`Preview van de statische build op http://localhost:${PORT}`);
});
