/**
 * Zelfherstel voor kapotte bron-koppelingen: past de hoge-zekerheid-suggesties
 * uit mapping-health.json (score >= 0.8, alleen slug-bronnen VK/Ierland) toe
 * op server/data/slug-overrides.json, regenereert de mapping en verifieert
 * elke fix LIVE (haalt het advies echt op en eist >= 3 thema's). Alleen
 * geverifieerde fixes blijven staan; de rest wordt teruggedraaid.
 *
 * Output: één regel "FIX <bron> <ISO3>: <oud> -> <nieuw>" per geslaagde fix —
 * de workflow telt die regels en opent er een PR mee. Exitcode 1 alleen als
 * het toepassen zelf misgaat (dan geen PR, wel het gewone issue).
 *
 * Draaien: node worker/scripts/apply-mapping-fixes.mjs   (vanuit de repo-root
 * of vanuit worker/ — paden zijn scriptrelatief)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const HEALTH = path.join(__dirname, '..', 'data', 'mapping-health.json');
const OVERRIDES_FILE = path.join(ROOT, 'server', 'data', 'slug-overrides.json');
const MIN_SCORE = 0.8;
// Alleen bronnen waar de koppeling een slug is die we zó kunnen vervangen én
// die we direct (zonder reader-proxy) kunnen verifiëren.
const FIXABLE = new Set(['uk', 'ie']);

const health = JSON.parse(readFileSync(HEALTH, 'utf8'));
const candidates = [];
for (const [sid, s] of Object.entries(health.sources || {})) {
  if (!FIXABLE.has(sid) || s.error) continue;
  for (const b of s.broken || []) {
    if (b.suggestie && b.score >= MIN_SCORE) candidates.push({ sid, ...b });
  }
}
if (!candidates.length) {
  console.log('Geen hoge-zekerheid-fixes beschikbaar.');
  process.exit(0);
}

// 1. Suggesties toepassen op het overrides-bestand.
const overrides = JSON.parse(readFileSync(OVERRIDES_FILE, 'utf8'));
const original = JSON.stringify(overrides, null, 2);
for (const c of candidates) {
  (overrides[c.sid] ||= {})[c.iso3] = c.suggestie;
}
writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2) + '\n');

// 2. Mapping regenereren (schrijft server/data + worker/src/data).
execSync('npm run build:countries', { cwd: ROOT, stdio: 'inherit' });

// 3. Elke fix live verifiëren via de echte adapter.
const { default: countries } = await import('../src/data/countries.json', { with: { type: 'json' } });
const adapters = {
  uk: await import('../src/adapters/uk.js'),
  ie: await import('../src/adapters/ireland.js'),
};
// Identiteitscheck: als de bron een landnaam meelevert, moet die op het
// bedoelde land lijken — anders zou een verkeerde maar wél bestaande pagina
// (dominican-republic i.p.v. czechia) door de verificatie glippen.
function dice2(a, b) {
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const ga = grams(a), gb = grams(b);
  let ov = 0;
  for (const [g, n] of ga) ov += Math.min(n, gb.get(g) || 0);
  return (2 * ov) / (a.length - 1 + b.length - 1);
}
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]+/g, ' ').trim();

const verified = [];
const failed = [];
for (const c of candidates) {
  try {
    const id = countries[c.iso3]?.sources?.[c.sid];
    const adv = await adapters[c.sid].getAdvisory(id);
    if (!adv || (adv.themes?.length || 0) < 3) {
      failed.push({ ...c, reden: `advies leeg (${adv?.themes?.length || 0} thema's)` });
      continue;
    }
    const enName = norm(countries[c.iso3]?.en);
    if (adv.name && enName && dice2(norm(adv.name), enName) < 0.35 && !norm(adv.name).includes(enName.split(' ')[0])) {
      failed.push({ ...c, reden: `paginanaam "${adv.name}" lijkt niet op "${countries[c.iso3]?.en}"` });
      continue;
    }
    verified.push(c);
  } catch (e) {
    failed.push({ ...c, reden: e.message });
  }
}

// 4. Niet-geverifieerde fixes terugdraaien en opnieuw genereren.
if (failed.length) {
  const cleaned = JSON.parse(original);
  for (const c of verified) (cleaned[c.sid] ||= {})[c.iso3] = c.suggestie;
  writeFileSync(OVERRIDES_FILE, JSON.stringify(cleaned, null, 2) + '\n');
  if (verified.length) execSync('npm run build:countries', { cwd: ROOT, stdio: 'inherit' });
  else execSync('git checkout -- server/data worker/src/data', { cwd: ROOT });
  for (const f of failed) console.log(`OVERGESLAGEN ${f.sid} ${f.iso3}: "${f.suggestie}" niet geverifieerd (${f.reden})`);
}
for (const c of verified) console.log(`FIX ${c.sid} ${c.iso3} (${c.land}): "${c.id}" -> "${c.suggestie}" [score ${c.score}, live geverifieerd]`);
console.log(`\n${verified.length} fix(es) toegepast, ${failed.length} overgeslagen.`);
