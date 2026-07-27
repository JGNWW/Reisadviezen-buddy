/**
 * Bouwt worker/src/data/geo-terms.json: per land de woorden waaraan je in een
 * nieuwskop herkent dát het over dat land gaat — korte naam, demonym en
 * hoofdstad.
 *
 * Waarom: het lokale nieuws werd tot nu toe alleen op ONDERWERP gefilterd
 * (conflict, gezondheid, …), nooit op PLAATS. Een Belgische landenquery leverde
 * daardoor een NYT-stuk over Groenland op, en Afghaanse outlets vulden de
 * conflictcategorie met Oekraïne en Mexico. Zie news.js (geoVerdict) voor de
 * regel die deze termen gebruikt.
 *
 * Twee soorten termen, bewust gescheiden:
 *   - self : alles waaraan we "dit gaat over dit land" mogen aflezen (ruim).
 *   - veto : alleen termen waarmee we een kop mogen AFWIJZEN omdat hij
 *            aantoonbaar over een ánder land gaat (streng). Afgeleide,
 *            niet-geverifieerde demonyms komen hier bewust niet in: een fout
 *            in deze lijst kost een terecht bericht, en dat weegt zwaarder dan
 *            een gemist filtermoment.
 *
 * Dubbelzinnige woorden (Georgia = ook een Amerikaanse staat, Jordan/Chad =
 * ook voornamen, Turkey = ook een vogel) staan als weak: ze tellen wel mee om
 * een kop te behouden, nooit om er een af te wijzen.
 *
 * Draaien: cd worker && node scripts/build-geo-terms.mjs
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import countries from '../src/data/countries.json' with { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'src', 'data', 'geo-terms.json');

// iso3: [korte naam (leeg = neem countries.json), demonym, hoofdstad]
// Demonym leeg = geen betrouwbare vorm; dan wordt er niets afgeleid gebruikt
// voor het veto (wel voor self, zie DERIVE hieronder).
const T = {
  AFG: ['Afghanistan', 'Afghan', 'Kabul'], ALB: ['Albania', 'Albanian', 'Tirana'],
  DZA: ['Algeria', 'Algerian', 'Algiers'], AND: ['Andorra', 'Andorran', 'Andorra la Vella'],
  AGO: ['Angola', 'Angolan', 'Luanda'], AIA: ['Anguilla', 'Anguillian', 'The Valley'],
  ATG: ['Antigua and Barbuda', 'Antiguan', "St John's"], ARG: ['Argentina', 'Argentine', 'Buenos Aires'],
  ARM: ['Armenia', 'Armenian', 'Yerevan'], ABW: ['Aruba', 'Aruban', 'Oranjestad'],
  AUS: ['Australia', 'Australian', 'Canberra'], AUT: ['Austria', 'Austrian', 'Vienna'],
  AZE: ['Azerbaijan', 'Azerbaijani', 'Baku'], BHS: ['Bahamas', 'Bahamian', 'Nassau'],
  BHR: ['Bahrain', 'Bahraini', 'Manama'], BGD: ['Bangladesh', 'Bangladeshi', 'Dhaka'],
  BRB: ['Barbados', 'Barbadian', 'Bridgetown'], BLR: ['Belarus', 'Belarusian', 'Minsk'],
  BEL: ['Belgium', 'Belgian', 'Brussels'], BLZ: ['Belize', 'Belizean', 'Belmopan'],
  BEN: ['Benin', 'Beninese', 'Porto-Novo'], BTN: ['Bhutan', 'Bhutanese', 'Thimphu'],
  BOL: ['Bolivia', 'Bolivian', 'La Paz'], BIH: ['Bosnia and Herzegovina', 'Bosnian', 'Sarajevo'],
  BWA: ['Botswana', 'Motswana', 'Gaborone'], BRA: ['Brazil', 'Brazilian', 'Brasilia'],
  BRN: ['Brunei', 'Bruneian', 'Bandar Seri Begawan'], BGR: ['Bulgaria', 'Bulgarian', 'Sofia'],
  BFA: ['Burkina Faso', 'Burkinabe', 'Ouagadougou'], BDI: ['Burundi', 'Burundian', 'Gitega'],
  CPV: ['Cabo Verde', 'Cape Verdean', 'Praia'], KHM: ['Cambodia', 'Cambodian', 'Phnom Penh'],
  CMR: ['Cameroon', 'Cameroonian', 'Yaounde'], CAN: ['Canada', 'Canadian', 'Ottawa'],
  CYM: ['Cayman Islands', 'Caymanian', 'George Town'], CAF: ['Central African Republic', '', 'Bangui'],
  TCD: ['Chad', 'Chadian', "N'Djamena"], CHL: ['Chile', 'Chilean', 'Santiago'],
  CHN: ['China', 'Chinese', 'Beijing'], COL: ['Colombia', 'Colombian', 'Bogota'],
  COM: ['Comoros', 'Comorian', 'Moroni'], COG: ['Republic of the Congo', 'Congolese', 'Brazzaville'],
  COD: ['Democratic Republic of the Congo', '', 'Kinshasa'], COK: ['Cook Islands', '', 'Avarua'],
  CRI: ['Costa Rica', 'Costa Rican', 'San Jose'], CIV: ["Cote d'Ivoire", 'Ivorian', 'Yamoussoukro'],
  HRV: ['Croatia', 'Croatian', 'Zagreb'], CUB: ['Cuba', 'Cuban', 'Havana'],
  CUW: ['Curacao', '', 'Willemstad'], CYP: ['Cyprus', 'Cypriot', 'Nicosia'],
  CZE: ['Czechia', 'Czech', 'Prague'], DNK: ['Denmark', 'Danish', 'Copenhagen'],
  DJI: ['Djibouti', 'Djiboutian', 'Djibouti'], DMA: ['Dominica', 'Dominican', 'Roseau'],
  DOM: ['Dominican Republic', '', 'Santo Domingo'], ECU: ['Ecuador', 'Ecuadorian', 'Quito'],
  EGY: ['Egypt', 'Egyptian', 'Cairo'], SLV: ['El Salvador', 'Salvadoran', 'San Salvador'],
  GNQ: ['Equatorial Guinea', '', 'Malabo'], ERI: ['Eritrea', 'Eritrean', 'Asmara'],
  EST: ['Estonia', 'Estonian', 'Tallinn'], SWZ: ['Eswatini', 'Swazi', 'Mbabane'],
  ETH: ['Ethiopia', 'Ethiopian', 'Addis Ababa'], FRO: ['Faroe Islands', 'Faroese', 'Torshavn'],
  FJI: ['Fiji', 'Fijian', 'Suva'], FIN: ['Finland', 'Finnish', 'Helsinki'],
  FRA: ['France', 'French', 'Paris'], GUF: ['French Guiana', '', 'Cayenne'],
  PYF: ['French Polynesia', '', 'Papeete'], GAB: ['Gabon', 'Gabonese', 'Libreville'],
  GMB: ['Gambia', 'Gambian', 'Banjul'], GEO: ['Georgia', 'Georgian', 'Tbilisi'],
  DEU: ['Germany', 'German', 'Berlin'], GHA: ['Ghana', 'Ghanaian', 'Accra'],
  GRC: ['Greece', 'Greek', 'Athens'], GRL: ['Greenland', 'Greenlandic', 'Nuuk'],
  GRD: ['Grenada', 'Grenadian', "St George's"], GLP: ['Guadeloupe', '', 'Basse-Terre'],
  GTM: ['Guatemala', 'Guatemalan', 'Guatemala City'], GIN: ['Guinea', 'Guinean', 'Conakry'],
  GNB: ['Guinea-Bissau', '', 'Bissau'], GUY: ['Guyana', 'Guyanese', 'Georgetown'],
  HTI: ['Haiti', 'Haitian', 'Port-au-Prince'], HND: ['Honduras', 'Honduran', 'Tegucigalpa'],
  HKG: ['Hong Kong', 'Hongkonger', 'Hong Kong'], HUN: ['Hungary', 'Hungarian', 'Budapest'],
  ISL: ['Iceland', 'Icelandic', 'Reykjavik'], IND: ['India', 'Indian', 'New Delhi'],
  IDN: ['Indonesia', 'Indonesian', 'Jakarta'], IRN: ['Iran', 'Iranian', 'Tehran'],
  IRQ: ['Iraq', 'Iraqi', 'Baghdad'], IRL: ['Ireland', 'Irish', 'Dublin'],
  ISR: ['Israel', 'Israeli', 'Jerusalem'], ITA: ['Italy', 'Italian', 'Rome'],
  JAM: ['Jamaica', 'Jamaican', 'Kingston'], JPN: ['Japan', 'Japanese', 'Tokyo'],
  JOR: ['Jordan', 'Jordanian', 'Amman'], KAZ: ['Kazakhstan', 'Kazakh', 'Astana'],
  KEN: ['Kenya', 'Kenyan', 'Nairobi'], KIR: ['Kiribati', 'I-Kiribati', 'Tarawa'],
  PRK: ['North Korea', 'North Korean', 'Pyongyang'], KOR: ['South Korea', 'South Korean', 'Seoul'],
  XKX: ['Kosovo', 'Kosovar', 'Pristina'], KWT: ['Kuwait', 'Kuwaiti', 'Kuwait City'],
  KGZ: ['Kyrgyzstan', 'Kyrgyz', 'Bishkek'], LAO: ['Laos', 'Laotian', 'Vientiane'],
  LVA: ['Latvia', 'Latvian', 'Riga'], LBN: ['Lebanon', 'Lebanese', 'Beirut'],
  LSO: ['Lesotho', 'Basotho', 'Maseru'], LBR: ['Liberia', 'Liberian', 'Monrovia'],
  LBY: ['Libya', 'Libyan', 'Tripoli'], LIE: ['Liechtenstein', '', 'Vaduz'],
  LTU: ['Lithuania', 'Lithuanian', 'Vilnius'], LUX: ['Luxembourg', 'Luxembourgish', 'Luxembourg'],
  MAC: ['Macao', 'Macanese', 'Macao'], MDG: ['Madagascar', 'Malagasy', 'Antananarivo'],
  MWI: ['Malawi', 'Malawian', 'Lilongwe'], MYS: ['Malaysia', 'Malaysian', 'Kuala Lumpur'],
  MDV: ['Maldives', 'Maldivian', 'Male'], MLI: ['Mali', 'Malian', 'Bamako'],
  MLT: ['Malta', 'Maltese', 'Valletta'], MHL: ['Marshall Islands', '', 'Majuro'],
  MTQ: ['Martinique', '', 'Fort-de-France'], MRT: ['Mauritania', 'Mauritanian', 'Nouakchott'],
  MUS: ['Mauritius', 'Mauritian', 'Port Louis'], MEX: ['Mexico', 'Mexican', 'Mexico City'],
  FSM: ['Micronesia', 'Micronesian', 'Palikir'], MDA: ['Moldova', 'Moldovan', 'Chisinau'],
  MCO: ['Monaco', 'Monegasque', 'Monaco'], MNG: ['Mongolia', 'Mongolian', 'Ulaanbaatar'],
  MNE: ['Montenegro', 'Montenegrin', 'Podgorica'], MSR: ['Montserrat', '', 'Brades'],
  MAR: ['Morocco', 'Moroccan', 'Rabat'], MOZ: ['Mozambique', 'Mozambican', 'Maputo'],
  MMR: ['Myanmar', 'Burmese', 'Naypyidaw'], NAM: ['Namibia', 'Namibian', 'Windhoek'],
  NRU: ['Nauru', 'Nauruan', 'Yaren'], NPL: ['Nepal', 'Nepali', 'Kathmandu'],
  NLD: ['Netherlands', 'Dutch', 'Amsterdam'], NCL: ['New Caledonia', '', 'Noumea'],
  NZL: ['New Zealand', 'New Zealander', 'Wellington'], NIC: ['Nicaragua', 'Nicaraguan', 'Managua'],
  NER: ['Niger', 'Nigerien', 'Niamey'], NGA: ['Nigeria', 'Nigerian', 'Abuja'],
  NIU: ['Niue', '', 'Alofi'], MKD: ['North Macedonia', 'Macedonian', 'Skopje'],
  NOR: ['Norway', 'Norwegian', 'Oslo'], OMN: ['Oman', 'Omani', 'Muscat'],
  PAK: ['Pakistan', 'Pakistani', 'Islamabad'], PLW: ['Palau', 'Palauan', 'Ngerulmud'],
  PSE: ['Palestine', 'Palestinian', 'Ramallah'], PAN: ['Panama', 'Panamanian', 'Panama City'],
  PNG: ['Papua New Guinea', '', 'Port Moresby'], PRY: ['Paraguay', 'Paraguayan', 'Asuncion'],
  PER: ['Peru', 'Peruvian', 'Lima'], PHL: ['Philippines', 'Filipino', 'Manila'],
  PCN: ['Pitcairn', '', 'Adamstown'], POL: ['Poland', 'Polish', 'Warsaw'],
  PRT: ['Portugal', 'Portuguese', 'Lisbon'], PRI: ['Puerto Rico', 'Puerto Rican', 'San Juan'],
  QAT: ['Qatar', 'Qatari', 'Doha'], REU: ['Reunion', '', 'Saint-Denis'],
  ROU: ['Romania', 'Romanian', 'Bucharest'], RUS: ['Russia', 'Russian', 'Moscow'],
  RWA: ['Rwanda', 'Rwandan', 'Kigali'], KNA: ['Saint Kitts and Nevis', '', 'Basseterre'],
  LCA: ['Saint Lucia', 'Saint Lucian', 'Castries'],
  VCT: ['Saint Vincent and the Grenadines', '', 'Kingstown'],
  WSM: ['Samoa', 'Samoan', 'Apia'], SMR: ['San Marino', 'Sammarinese', 'San Marino'],
  STP: ['Sao Tome and Principe', '', 'Sao Tome'], SAU: ['Saudi Arabia', 'Saudi', 'Riyadh'],
  SEN: ['Senegal', 'Senegalese', 'Dakar'], SRB: ['Serbia', 'Serbian', 'Belgrade'],
  SYC: ['Seychelles', 'Seychellois', 'Victoria'], SLE: ['Sierra Leone', 'Sierra Leonean', 'Freetown'],
  SGP: ['Singapore', 'Singaporean', 'Singapore'], SXM: ['Sint Maarten', '', 'Philipsburg'],
  SVK: ['Slovakia', 'Slovak', 'Bratislava'], SVN: ['Slovenia', 'Slovenian', 'Ljubljana'],
  SLB: ['Solomon Islands', '', 'Honiara'], SOM: ['Somalia', 'Somali', 'Mogadishu'],
  ZAF: ['South Africa', 'South African', 'Pretoria'], SSD: ['South Sudan', 'South Sudanese', 'Juba'],
  ESP: ['Spain', 'Spanish', 'Madrid'], LKA: ['Sri Lanka', 'Sri Lankan', 'Colombo'],
  SDN: ['Sudan', 'Sudanese', 'Khartoum'], SUR: ['Suriname', 'Surinamese', 'Paramaribo'],
  SJM: ['Svalbard', '', 'Longyearbyen'], SWE: ['Sweden', 'Swedish', 'Stockholm'],
  CHE: ['Switzerland', 'Swiss', 'Bern'], SYR: ['Syria', 'Syrian', 'Damascus'],
  TWN: ['Taiwan', 'Taiwanese', 'Taipei'], TJK: ['Tajikistan', 'Tajik', 'Dushanbe'],
  TZA: ['Tanzania', 'Tanzanian', 'Dodoma'], THA: ['Thailand', 'Thai', 'Bangkok'],
  TLS: ['Timor-Leste', 'Timorese', 'Dili'], TGO: ['Togo', 'Togolese', 'Lome'],
  TKL: ['Tokelau', '', ''], TON: ['Tonga', 'Tongan', "Nuku'alofa"],
  TTO: ['Trinidad and Tobago', 'Trinidadian', 'Port of Spain'], TUN: ['Tunisia', 'Tunisian', 'Tunis'],
  TUR: ['Turkey', 'Turkish', 'Ankara'], TKM: ['Turkmenistan', 'Turkmen', 'Ashgabat'],
  TCA: ['Turks and Caicos Islands', '', 'Cockburn Town'], TUV: ['Tuvalu', 'Tuvaluan', 'Funafuti'],
  UGA: ['Uganda', 'Ugandan', 'Kampala'], UKR: ['Ukraine', 'Ukrainian', 'Kyiv'],
  ARE: ['United Arab Emirates', 'Emirati', 'Abu Dhabi'],
  GBR: ['United Kingdom', 'British', 'London'], USA: ['United States', 'American', 'Washington'],
  URY: ['Uruguay', 'Uruguayan', 'Montevideo'], UZB: ['Uzbekistan', 'Uzbek', 'Tashkent'],
  VUT: ['Vanuatu', 'Ni-Vanuatu', 'Port Vila'], VEN: ['Venezuela', 'Venezuelan', 'Caracas'],
  VNM: ['Vietnam', 'Vietnamese', 'Hanoi'], VGB: ['British Virgin Islands', '', 'Road Town'],
  VIR: ['US Virgin Islands', '', 'Charlotte Amalie'], WLF: ['Wallis and Futuna', '', 'Mata-Utu'],
  YEM: ['Yemen', 'Yemeni', 'Sanaa'], ZMB: ['Zambia', 'Zambian', 'Lusaka'],
  ZWE: ['Zimbabwe', 'Zimbabwean', 'Harare'], ATA: ['Antarctica', '', ''],
  ASM: ['American Samoa', '', 'Pago Pago'], GUM: ['Guam', 'Guamanian', 'Hagatna'],
  MNP: ['Northern Mariana Islands', '', 'Saipan'],
};

// Extra namen/spellingen die in koppen voorkomen naast de korte naam.
const ALIAS = {
  GBR: ['Britain', 'Great Britain', 'UK', 'England', 'Scotland', 'Wales', 'Northern Ireland'],
  USA: ['U.S.', 'US', 'USA', 'America'], ARE: ['UAE', 'Dubai', 'Abu Dhabi'],
  NLD: ['Holland', 'the Hague'], CIV: ['Ivory Coast', "Côte d'Ivoire"], CPV: ['Cape Verde'],
  MMR: ['Burma'], TUR: ['Türkiye', 'Turkiye'], CZE: ['Czech Republic'], SWZ: ['Swaziland'],
  MKD: ['Macedonia'], TLS: ['East Timor'], COD: ['DR Congo', 'DRC', 'Congo-Kinshasa'],
  COG: ['Congo-Brazzaville'], PSE: ['Gaza', 'West Bank'], VAT: ['Vatican'],
  CUW: ['Curaçao'], REU: ['Réunion'], LAO: ['Lao PDR'], BRN: ['Brunei Darussalam'],
  PRK: ['DPRK'], KOR: ['Republic of Korea'], RUS: ['Russian Federation'],
  IRN: ['Islamic Republic of Iran'], VEN: ['Bolivarian Republic of Venezuela'],
  BOL: ['Plurinational State of Bolivia'], SYR: ['Syrian Arab Republic'],
  CHN: ['Beijing'], HKG: ['Hongkong'],
};

// Woorden die óók iets anders betekenen: tellen mee om te behouden, nooit om
// af te wijzen. (Georgia = Amerikaanse staat, Jordan/Chad = voornamen,
// Turkey = vogel, Guinea = ook proefdier/andere Guineas, Mali/Chile = ...)
const WEAK = new Set([
  'Georgia', 'Jordan', 'Chad', 'Turkey', 'Guinea', 'Congo', 'Samoa', 'Korea',
  'Dominica', 'Niger', 'Virgin Islands', 'Ireland', 'Sudan', 'China', 'India',
  'US', 'UK', 'America', 'England', 'Victoria', 'Georgetown', 'Male', 'Djibouti',
  'Singapore', 'Monaco', 'Luxembourg', 'Guatemala City', 'Panama City',
  'Kuwait City', 'Mexico City', 'San Marino', 'Macao', 'Hong Kong', 'Washington',
]);

/** Meervoud van een demonym ("Belgian" -> "Belgians"); -ese/-ish/-i blijven gelijk. */
function plural(d) {
  if (!d || /(ese|ish|ch|ss|s)$/i.test(d) || /^(Swiss|Thai|Saudi|Somali|Nepali|Israeli|Iraqi|Kuwaiti|Qatari|Omani|Emirati|Pakistani|Yemeni|Bahraini|Bangladeshi|Malagasy|Basotho|Motswana|Swazi|Kyrgyz|Uzbek|Tajik|Turkmen|Kazakh|Czech|Slovak|Greenlandic|Icelandic)$/i.test(d)) return null;
  return `${d}s`;
}

/**
 * Deelt een samengestelde landnaam in zijn losse delen: koppen schrijven
 * "Antigua", niet "Antigua and Barbuda", en "Trinidad", niet "Trinidad and
 * Tobago". Zonder deze splitsing werd zo'n kop toegeschreven aan het ándere
 * land dat er wél voluit in stond (Barbados) en dus ten onrechte weggezet.
 * De delen tellen alleen mee om te behouden, nooit om af te wijzen.
 */
function delen(naam) {
  if (!/ and (the )?/i.test(naam)) return [];
  return naam.split(/ and (?:the )?/i).map((s) => s.trim()).filter((s) => s.length > 3);
}

/** "Saint Lucia" wordt in koppen vaak "St Lucia"/"St. Lucia". */
function saintVarianten(naam) {
  if (!/^Saint /i.test(naam)) return [];
  return [naam.replace(/^Saint /i, 'St '), naam.replace(/^Saint /i, 'St. ')];
}

// Landen die zelf geen reisadvies-doel zijn, maar wél in koppen opduiken en
// dus moeten kunnen aantonen dat een kop over een ánder land gaat.
const EXTRA = { NLD: ['Netherlands', 'Dutch', 'Amsterdam'], VAT: ['Vatican', '', 'Vatican City'] };

function main() {
  const out = {};
  let zonderDemonym = 0;
  const bouw = (iso, short, demonym, capital, fallbackEn) => {
    const naam = short || fallbackEn;
    if (!naam) return;
    const names = [...new Set([naam, ...(ALIAS[iso] || []), ...delen(naam), ...saintVarianten(naam)].filter(Boolean))];
    const demonyms = [...new Set([demonym, plural(demonym)].filter(Boolean))];
    const cities = [capital].filter(Boolean);
    if (!demonym) zonderDemonym++;

    // self = alles; veto = alles behalve de dubbelzinnige woorden én de losse
    // delen van een samengestelde naam (te grof om iets mee af te wijzen).
    const losse = new Set(delen(naam));
    const self = [...new Set([...names, ...demonyms, ...cities])];
    const veto = self.filter((t) => !WEAK.has(t) && !losse.has(t));
    out[iso] = { name: naam, self, veto };
  };

  for (const [iso, rec] of Object.entries(countries)) {
    if (!/^[A-Z]{3}$/.test(iso)) continue;
    const [short, demonym, capital] = T[iso] || [];
    bouw(iso, short, demonym, capital, rec.en);
  }
  for (const [iso, [short, demonym, capital]] of Object.entries(EXTRA)) {
    if (!out[iso]) bouw(iso, short, demonym, capital, short);
  }
  writeFileSync(OUT, `${JSON.stringify(out, null, 0)}\n`);
  console.log(`geo-terms.json: ${Object.keys(out).length} landen`
    + `, ${zonderDemonym} zonder demonym`
    + `, ${Object.values(out).reduce((n, e) => n + e.self.length, 0)} termen totaal.`);
}

main();
