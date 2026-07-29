/**
 * Tests voor de kaart-URL van Oostenrijk (BMEIA).
 *
 * BMEIA publiceert per land een kaart met de Reisewarnstufen, maar de
 * bestandsnaam bevat de Duitse landnaam én soms een datum
 * ("Algerien_Reisewarnstufen_30062026.png"), dus hij valt niet te
 * construeren — hij moet uit de pagina komen. De adapter zette hasMap
 * hardcoded op false, waardoor die kaart nooit in de tool verscheen terwijl
 * hij er wel was.
 *
 * Er bestaan twee vormen op de pagina: de losse volle kaart onder
 * /Reiseinfos_Karten/ en de door TYPO3 verkleinde variant (csm_…). De volle
 * kaart heeft voorrang.
 *
 * Draaien: cd worker && node --test test/austria-map.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMapUrl } from '../src/adapters/austria.js';

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });
const serveer = (html) => { globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => html }); };

test('de volle kaart wordt gevonden en absoluut gemaakt', async () => {
  serveer('<img src="/fileadmin/user_upload/Zentrale/Kultur/Reiseinfos_Karten/Algerien_Reisewarnstufen_30062026.png">');
  assert.equal(
    await resolveMapUrl('algerien'),
    'https://www.bmeia.gv.at/fileadmin/user_upload/Zentrale/Kultur/Reiseinfos_Karten/Algerien_Reisewarnstufen_30062026.png',
  );
});

test('de volle kaart wint van de verkleinde variant', async () => {
  serveer('<img src="/fileadmin/_processed_/csm_Reisewarnstufen_Mexiko_abc.png">'
    + '<img src="/fileadmin/user_upload/Zentrale/Kultur/Reiseinfos_Karten/Reisewarnstufen_Mexiko.png">');
  assert.match(await resolveMapUrl('mexiko'), /Reiseinfos_Karten\/Reisewarnstufen_Mexiko\.png$/);
});

test('alleen een verkleinde variant is ook goed', async () => {
  serveer('<img src="/fileadmin/_processed_/csm_Einzelansicht_Kolumbien_xyz.jpg">');
  assert.match(await resolveMapUrl('kolumbien'), /csm_Einzelansicht_Kolumbien/);
});

test('geen kaart op de pagina → null (niet elk land heeft er een)', async () => {
  serveer('<p>Keine besonderen Hinweise.</p><img src="/fileadmin/logo.png">');
  assert.equal(await resolveMapUrl('frankreich'), null);
});

test('zonder slug wordt er niet eens gefetcht', async () => {
  let geraakt = false;
  globalThis.fetch = async () => { geraakt = true; return { ok: true, text: async () => '' }; };
  assert.equal(await resolveMapUrl(''), null);
  assert.equal(geraakt, false);
});
