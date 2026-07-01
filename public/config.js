/**
 * Configuratie voor Reisadviezen-buddy (frontend).
 *
 * PROXY: de URL van je Cloudflare Worker (zie worker/). Buitenlandse
 * reisadviezen en kaarten worden hier live opgehaald. Laat leeg om alleen de
 * Nederlandse data te tonen. Je kunt de proxy ook zonder code instellen via de
 * URL-parameter ?proxy=... of via het instellingenveld in de tool.
 */
window.REISADVIEZEN_CONFIG = {
  // Bijv. 'https://reisadviezen-buddy-proxy.jouwnaam.workers.dev'
  PROXY: '',

  // Buitenlandse bronnen die de proxy ondersteunt. `lang` = brontaal (voor
  // automatische vertaling naar Nederlands).
  SOURCES: [
    { id: 'uk', label: 'Verenigd Koninkrijk (FCDO)', flag: '🇬🇧', lang: 'en', default: true },
    { id: 'us', label: 'Verenigde Staten (State Dept)', flag: '🇺🇸', lang: 'en', default: true },
    { id: 'ca', label: 'Canada (Global Affairs)', flag: '🇨🇦', lang: 'en', default: true },
    { id: 'ie', label: 'Ierland (DFA)', flag: '🇮🇪', lang: 'en', default: true },
    { id: 'fr', label: 'Frankrijk (France Diplomatie)', flag: '🇫🇷', lang: 'fr', default: true },
    // Volgende fase: Spanje, Japan (API), Australië (via publieke proxy).
  ],
};
