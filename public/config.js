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
  ],
};
