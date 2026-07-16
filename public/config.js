/**
 * Configuratie voor Reisadviezen-buddy (frontend).
 *
 * PROXY: de URL van je Cloudflare Worker (zie worker/). Buitenlandse
 * reisadviezen en kaarten worden hier live opgehaald. Laat leeg om alleen de
 * Nederlandse data te tonen. Je kunt de proxy ook zonder code instellen via de
 * URL-parameter ?proxy=... of via het instellingenveld in de tool.
 */
window.REISADVIEZEN_CONFIG = {
  PROXY: 'https://reisadviezen-buddy-proxy.nederlander.workers.dev',

  // Buitenlandse bronnen die de proxy ondersteunt. `lang` = brontaal (voor
  // automatische vertaling naar Nederlands).
  SOURCES: [
    { id: 'uk', label: 'Verenigd Koninkrijk (FCDO)', flag: '🇬🇧', lang: 'en', default: true },
    { id: 'us', label: 'Verenigde Staten (State Dept)', flag: '🇺🇸', lang: 'en', default: true },
    { id: 'ca', label: 'Canada (Global Affairs)', flag: '🇨🇦', lang: 'en', default: true },
    { id: 'ie', label: 'Ierland (DFA)', flag: '🇮🇪', lang: 'en', default: true },
    { id: 'fr', label: 'Frankrijk (France Diplomatie)', flag: '🇫🇷', lang: 'fr', default: true },
    { id: 'au', label: 'Australië (Smartraveller)', flag: '🇦🇺', lang: 'en', default: true },
    { id: 'es', label: 'Spanje (Exteriores)', flag: '🇪🇸', lang: 'es', default: true },
    { id: 'de', label: 'Duitsland (Auswärtiges Amt)', flag: '🇩🇪', lang: 'de', default: true },
    { id: 'nz', label: 'Nieuw-Zeeland (SafeTravel)', flag: '🇳🇿', lang: 'en', default: true },
    { id: 'dk', label: 'Denemarken (Udenrigsministeriet)', flag: '🇩🇰', lang: 'da', default: true },
    // Japan wordt direct opgehaald (geen reader nodig): MOFA blokkeert geen
    // datacenter-IP's en publiceert vaste niveaus (レベル1-4).
    { id: 'jp', label: 'Japan (MOFA)', flag: '🇯🇵', lang: 'ja', default: true },
    // Italië: statische JSON-API achter de SPA, rechtstreeks op ISO3.
    { id: 'it', label: 'Italië (Viaggiare Sicuri)', flag: '🇮🇹', lang: 'it', default: true },
    // Finland: server-gerenderd op ISO2, vast "Turvallisuustaso"-niveauveld.
    { id: 'fi', label: 'Finland (Ulkoministeriö)', flag: '🇫🇮', lang: 'fi', default: true },
    // Zuid-Korea: eigen land-ID's (kr-map.json), vaste 여행경보-stappen per gebied.
    { id: 'kr', label: 'Zuid-Korea (MOFA)', flag: '🇰🇷', lang: 'ko', default: true },
    // Noorwegen: via de reader-proxy (site blokkeert datacenter-IP's);
    // slug/id-mapping uit de Wayback-CDX (no-map.json).
    { id: 'no', label: 'Noorwegen (Utenriksdept.)', flag: '🇳🇴', lang: 'no', default: true },
    // Oostenrijk: Sicherheitsstufe-box (4-puntsschaal, met (regional)-
    // kwalificatie); direct met reader-fallback.
    { id: 'at', label: 'Oostenrijk (BMEIA)', flag: '🇦🇹', lang: 'de', default: true },
    // Zwitserland: klassieke Duitstalige EDA-URL's (server-gerenderd, in
    // tegenstelling tot de nieuwe SPA); tekstueel niveau ("wird abgeraten").
    { id: 'ch', label: 'Zwitserland (EDA)', flag: '🇨🇭', lang: 'de', default: true },
  ],
};
