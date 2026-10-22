const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { DATA_DIR } = require('./config');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'portal.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  -- Data fra Brønnøysundregistrene. Overskrives ved hver oppdatering.
  CREATE TABLE IF NOT EXISTS selskaper (
    orgnr TEXT PRIMARY KEY,
    navn TEXT NOT NULL,
    orgform TEXT,
    kommune TEXT,
    kommunenr TEXT,
    adresse TEXT,
    postnr TEXT,
    poststed TEXT,
    nace_kode TEXT,
    nace_tekst TEXT,
    ansatte INTEGER,
    stiftet TEXT,
    telefon TEXT,
    mobil TEXT,
    epost TEXT,
    hjemmeside TEXT,
    i_konsern INTEGER,
    daglig_leder TEXT,
    styreleder TEXT,
    revisor_navn TEXT,
    revisor_orgnr TEXT,
    regnskapsforer_navn TEXT,
    regnskapsforer_orgnr TEXT,
    regnskap_aar INTEGER,
    driftsinntekter REAL,
    driftsresultat REAL,
    aarsresultat REAL,
    egenkapital REAL,
    sum_eiendeler REAL,
    fravalg_revisjon INTEGER,
    roller_hentet INTEGER DEFAULT 0,
    regnskap_hentet INTEGER DEFAULT 0,
    aktiv INTEGER DEFAULT 1,
    oppdatert TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_selskaper_kommune ON selskaper(kommunenr);
  CREATE INDEX IF NOT EXISTS idx_selskaper_revisor ON selskaper(revisor_orgnr);

  -- Salgsoppfølging. Påvirkes aldri av dataoppdateringer.
  CREATE TABLE IF NOT EXISTS oppfolging (
    orgnr TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'ny',
    ringt INTEGER NOT NULL DEFAULT 0,
    sist_kontaktet TEXT,
    oppfolging_dato TEXT,
    ansvarlig_id INTEGER REFERENCES brukere(id),
    kontaktperson TEXT,
    kontakt_telefon TEXT,
    kontakt_epost TEXT,
    prioritet INTEGER NOT NULL DEFAULT 0,
    oppdatert TEXT,
    oppdatert_av INTEGER REFERENCES brukere(id)
  );

  CREATE TABLE IF NOT EXISTS aktiviteter (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    orgnr TEXT NOT NULL,
    bruker_id INTEGER REFERENCES brukere(id),
    type TEXT NOT NULL,
    tekst TEXT NOT NULL,
    opprettet TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_aktiviteter_orgnr ON aktiviteter(orgnr);

  CREATE TABLE IF NOT EXISTS brukere (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    navn TEXT NOT NULL UNIQUE,
    kode_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    opprettet TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS okter (
    token_hash TEXT PRIMARY KEY,
    bruker_id INTEGER NOT NULL REFERENCES brukere(id) ON DELETE CASCADE,
    utloper INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS synkroniseringer (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    startet TEXT NOT NULL,
    ferdig TEXT,
    status TEXT NOT NULL,
    melding TEXT,
    antall INTEGER
  );
`);

// Nye kolonner i eksisterende databaser.
const kolonner = new Set(db.prepare('PRAGMA table_info(selskaper)').all().map((k) => k.name));
if (!kolonner.has('sum_gjeld')) db.exec('ALTER TABLE selskaper ADD COLUMN sum_gjeld REAL');

// Personer med roller i selskapene, brukt til å finne tilknyttede selskaper.
// person_nokkel er en hash av navn og fødselsdato, så fødselsdato lagres ikke.
db.exec(`
  CREATE TABLE IF NOT EXISTS personroller (
    orgnr TEXT NOT NULL,
    rolle TEXT NOT NULL,
    navn TEXT NOT NULL,
    person_nokkel TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_personroller_orgnr ON personroller(orgnr);
  CREATE INDEX IF NOT EXISTS idx_personroller_nokkel ON personroller(person_nokkel, orgnr);
`);

module.exports = db;
