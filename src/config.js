const path = require('node:path');

// Kommuner i Haugalandet / Sunnhordland som portalen henter selskaper fra.
const KOMMUNER = [
  { nr: '1106', navn: 'Haugesund' },
  { nr: '1149', navn: 'Karmøy' },
  { nr: '1146', navn: 'Tysvær' },
  { nr: '4612', navn: 'Sveio' },
  { nr: '4614', navn: 'Stord' },
  { nr: '1145', navn: 'Bokn' },
  { nr: '1151', navn: 'Utsira' },
  { nr: '1160', navn: 'Vindafjord' },
  { nr: '4611', navn: 'Etne' },
  { nr: '4613', navn: 'Bømlo' },
  { nr: '4615', navn: 'Fitjar' },
];

// Aksjeselskap, allmennaksjeselskap, samvirkeforetak og stiftelser.
const ORGANISASJONSFORMER = ['AS', 'ASA', 'SA', 'STI'];

// Vatnem Revisjon AS – selskaper med denne revisoren er eksisterende kunder.
const VATNEM_ORGNR = '988075167';

// Grenser for når et AS kan velge bort revisjon (regnskapsloven/aksjeloven § 7-6).
// Alle tre må være under grensen for å kunne velge bort revisjon.
// Hva som er en passende kunde for Vatnem (mindre og mellomstore selskaper).
// Brukes av ringelisten, «Neste steg opp» og prioriteringspoengene.
const VATNEM_PROFIL = {
  minInntekt: 1_000_000,
  maksInntekt: 50_000_000,
  maksAnsatte: 50,
};

const REVISJONSPLIKT = {
  driftsinntekter: 7_000_000,
  sumEiendeler: 27_000_000,
  ansatte: 10,
};

const STATUSER = [
  { kode: 'ny', navn: 'Ikke kontaktet', farge: 'gray' },
  { kode: 'ingen_svar', navn: 'Ringt – ikke svar', farge: 'amber' },
  { kode: 'ring_tilbake', navn: 'Ring tilbake', farge: 'amber' },
  { kode: 'interessert', navn: 'Interessert', farge: 'blue' },
  { kode: 'mote', navn: 'Møte avtalt', farge: 'blue' },
  { kode: 'tilbud', navn: 'Tilbud sendt', farge: 'violet' },
  { kode: 'vunnet', navn: 'Kunde vunnet', farge: 'green' },
  { kode: 'ikke_interessert', navn: 'Ikke interessert', farge: 'red' },
  { kode: 'ikke_aktuell', navn: 'Ikke aktuell', farge: 'red' },
];

module.exports = {
  KOMMUNER,
  ORGANISASJONSFORMER,
  VATNEM_ORGNR,
  REVISJONSPLIKT,
  VATNEM_PROFIL,
  STATUSER,
  PORT: Number(process.env.PORT) || 3000,
  DATA_DIR: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
};
