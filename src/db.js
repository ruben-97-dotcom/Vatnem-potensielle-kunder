// Database: Turso (libSQL) i skyen, eller en lokal SQLite-fil når Turso ikke er satt opp.
// Alle kall er asynkrone, slik at samme kode virker på Vercel og lokalt.
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const { DATA_DIR, VATNEM_ORGNR, REVISJONSPLIKT } = require('./config');

const url = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL;
const erLokal = !url;
// På Vercel finnes ingen fast disk, så der må Turso være satt opp.
const manglerDatabase = erLokal && Boolean(process.env.VERCEL);
if (erLokal && !manglerDatabase) fs.mkdirSync(DATA_DIR, { recursive: true });

const klient = manglerDatabase ? null : createClient({
  url: url || 'file:' + path.join(DATA_DIR, 'portal.db').replace(/\\/g, '/'),
  authToken: process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN,
});

// Rader fra libSQL gjøres om til vanlige objekter.
const tilObjekter = (r) => r.rows.map((rad) => Object.fromEntries(r.columns.map((k, i) => [k, rad[i]])));

// Parametre kan være en liste (?) eller et objekt (:navn). undefined blir null.
function rens(args) {
  if (args === undefined) return [];
  if (Array.isArray(args)) return args.map((v) => (v === undefined ? null : v));
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, v === undefined ? null : typeof v === 'boolean' ? Number(v) : v]));
}

let klarLofte = null;
const klar = () => (klarLofte ||= sikreSkjema().catch((e) => { klarLofte = null; throw e; }));

async function alle(sql, args) {
  await klar();
  return tilObjekter(await klient.execute({ sql, args: rens(args) }));
}
async function en(sql, args) {
  return (await alle(sql, args))[0] || null;
}
async function kjor(sql, args) {
  await klar();
  const r = await klient.execute({ sql, args: rens(args) });
  return { endret: r.rowsAffected, id: r.lastInsertRowid === undefined ? null : Number(r.lastInsertRowid) };
}
// Flere skrivinger som én transaksjon: [[sql, args], ...]
async function batch(setninger) {
  if (!setninger.length) return [];
  await klar();
  return klient.batch(setninger.map(([sql, args]) => ({ sql, args: rens(args) })), 'write');
}

// --- Skjema --------------------------------------------------------------------
// Øk versjonen når tabeller eller visningen endres; da kjøres oppsettet på nytt.
const SKJEMA_VERSJON = '8';

const TABELLER = `
  CREATE TABLE IF NOT EXISTS selskaper (
    orgnr TEXT PRIMARY KEY, navn TEXT NOT NULL, orgform TEXT, kommune TEXT, kommunenr TEXT, adresse TEXT,
    postnr TEXT, poststed TEXT, nace_kode TEXT, nace_tekst TEXT, ansatte INTEGER, stiftet TEXT, telefon TEXT,
    mobil TEXT, epost TEXT, hjemmeside TEXT, i_konsern INTEGER, daglig_leder TEXT, styreleder TEXT,
    revisor_navn TEXT, revisor_orgnr TEXT, regnskapsforer_navn TEXT, regnskapsforer_orgnr TEXT,
    regnskap_aar INTEGER, driftsinntekter REAL, driftsresultat REAL, aarsresultat REAL, egenkapital REAL,
    sum_eiendeler REAL, fravalg_revisjon INTEGER, roller_hentet INTEGER DEFAULT 0, regnskap_hentet INTEGER DEFAULT 0,
    aktiv INTEGER DEFAULT 1, oppdatert TEXT, sum_gjeld REAL
  );
  CREATE INDEX IF NOT EXISTS idx_selskaper_kommune ON selskaper(kommunenr);
  CREATE INDEX IF NOT EXISTS idx_selskaper_revisor ON selskaper(revisor_orgnr);
  CREATE TABLE IF NOT EXISTS brukere (
    id INTEGER PRIMARY KEY AUTOINCREMENT, navn TEXT NOT NULL UNIQUE, kode_hash TEXT NOT NULL, salt TEXT NOT NULL,
    opprettet TEXT NOT NULL, varsler_sett TEXT
  );
  CREATE TABLE IF NOT EXISTS oppfolging (
    orgnr TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'ny', ringt INTEGER NOT NULL DEFAULT 0, sist_kontaktet TEXT,
    oppfolging_dato TEXT, ansvarlig_id INTEGER, kontaktperson TEXT, kontakt_telefon TEXT, kontakt_epost TEXT,
    prioritet INTEGER NOT NULL DEFAULT 0, oppdatert TEXT, oppdatert_av INTEGER, dl_telefon TEXT, sl_telefon TEXT
  );
  CREATE TABLE IF NOT EXISTS aktiviteter (
    id INTEGER PRIMARY KEY AUTOINCREMENT, orgnr TEXT NOT NULL, bruker_id INTEGER, type TEXT NOT NULL,
    tekst TEXT NOT NULL, opprettet TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_aktiviteter_orgnr ON aktiviteter(orgnr);
  CREATE TABLE IF NOT EXISTS okter (token_hash TEXT PRIMARY KEY, bruker_id INTEGER NOT NULL, utloper INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS synkroniseringer (
    id INTEGER PRIMARY KEY AUTOINCREMENT, startet TEXT NOT NULL, ferdig TEXT, status TEXT NOT NULL, melding TEXT,
    antall INTEGER, type TEXT DEFAULT 'full'
  );
  CREATE TABLE IF NOT EXISTS personroller (orgnr TEXT NOT NULL, rolle TEXT NOT NULL, navn TEXT NOT NULL, person_nokkel TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_personroller_orgnr ON personroller(orgnr);
  CREATE INDEX IF NOT EXISTS idx_personroller_nokkel ON personroller(person_nokkel, orgnr);
  CREATE TABLE IF NOT EXISTS hendelser (id INTEGER PRIMARY KEY AUTOINCREMENT, orgnr TEXT NOT NULL, type TEXT NOT NULL, tekst TEXT NOT NULL, tidspunkt TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_hendelser_tid ON hendelser(tidspunkt);
  CREATE INDEX IF NOT EXISTS idx_hendelser_orgnr ON hendelser(orgnr);
  CREATE TABLE IF NOT EXISTS innstillinger (nokkel TEXT PRIMARY KEY, verdi TEXT);
  CREATE TABLE IF NOT EXISTS synk_ko (orgnr TEXT PRIMARY KEY, type TEXT NOT NULL, lagt_til TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS innlogging_feil (ip TEXT NOT NULL, tidspunkt INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_innlogging_feil ON innlogging_feil(tidspunkt);
`;

// Visning med oppfølging og beregnede felt (revisjonsplikt, prioriteringspoeng og nærhet til revisjonsplikt).
const T = REVISJONSPLIKT;
const VISNING = `
  DROP VIEW IF EXISTS v_selskaper;
  CREATE VIEW v_selskaper AS
  SELECT x.*,
    ( CASE WHEN x.egenkapital > 0 THEN 20 ELSE 0 END
    + CASE WHEN x.driftsinntekter >= 100000000 THEN 30 WHEN x.driftsinntekter >= 30000000 THEN 26
           WHEN x.driftsinntekter >= 10000000 THEN 20 WHEN x.driftsinntekter >= 5000000 THEN 14
           WHEN x.driftsinntekter >= 2000000 THEN 8 WHEN x.driftsinntekter >= 500000 THEN 3 ELSE 0 END
    + CASE WHEN x.ansatte >= 50 THEN 10 WHEN x.ansatte >= 10 THEN 8 WHEN x.ansatte >= 3 THEN 5 WHEN x.ansatte >= 1 THEN 3 ELSE 0 END
    + CASE WHEN x.aarsresultat > 0 THEN 10 ELSE 0 END
    + CASE WHEN x.revisjonspliktig = 1 THEN 10 ELSE 0 END
    + CASE WHEN x.revisjonspliktig = 1 AND x.revisor_orgnr IS NULL AND x.roller_hentet = 1 THEN 10 ELSE 0 END
    + CASE WHEN x.regnskap_aar >= CAST(strftime('%Y', 'now') AS INTEGER) - 2 THEN 10 ELSE 0 END
    ) AS poeng,
    MAX(COALESCE(x.driftsinntekter, 0) / ${T.driftsinntekter}.0,
        COALESCE(x.sum_eiendeler, 0) / ${T.sumEiendeler}.0,
        CASE WHEN COALESCE(x.fravalg_revisjon, 0) = 0 THEN COALESCE(x.ansatte, 0) / ${T.ansatte}.0 ELSE 0 END
    ) AS plikt_andel
  FROM (
    SELECT s.*,
      COALESCE(o.status, 'ny') AS status,
      COALESCE(o.ringt, 0) AS ringt,
      o.sist_kontaktet, o.oppfolging_dato, o.ansvarlig_id, o.kontaktperson, o.kontakt_telefon, o.kontakt_epost,
      o.dl_telefon, o.sl_telefon,
      COALESCE(o.prioritet, 0) AS prioritet,
      CASE WHEN s.revisor_orgnr = '${VATNEM_ORGNR}' THEN 1 ELSE 0 END AS er_kunde,
      -- Estimat. Ansatte i registeret er personer, ikke årsverk, så har selskapet selv valgt bort
      -- revisjon, regnes bare inntekt og balanse.
      CASE WHEN s.orgform = 'ASA' THEN 1
           WHEN s.orgform IN ('AS', 'SA') AND (s.driftsinntekter >= ${T.driftsinntekter}
             OR s.sum_eiendeler >= ${T.sumEiendeler}
             OR (s.ansatte >= ${T.ansatte} AND COALESCE(s.fravalg_revisjon, 0) = 0)) THEN 1
           ELSE 0 END AS revisjonspliktig
    FROM selskaper s LEFT JOIN oppfolging o ON o.orgnr = s.orgnr
  ) x;
`;

// Kolonner som er lagt til etter første versjon (for eldre lokale databaser).
const NYE_KOLONNER = [
  ['selskaper', 'sum_gjeld', 'REAL'],
  ['brukere', 'varsler_sett', 'TEXT'],
  ['synkroniseringer', 'type', "TEXT DEFAULT 'full'"],
  ['oppfolging', 'dl_telefon', 'TEXT'],
  ['oppfolging', 'sl_telefon', 'TEXT'],
];

async function sikreSkjema() {
  if (manglerDatabase) {
    const e = new Error('Databasen er ikke satt opp. Legg inn TURSO_DATABASE_URL og TURSO_AUTH_TOKEN i Vercel (Settings → Environment Variables) og send ut på nytt.');
    e.kode = 'MANGLER_DATABASE';
    throw e;
  }
  // Sjekk versjon først, så vanlige oppstarter bare koster én spørring.
  try {
    const r = await klient.execute("SELECT verdi FROM innstillinger WHERE nokkel = 'skjema_versjon'");
    if (r.rows[0]?.[0] === SKJEMA_VERSJON) return;
  } catch { /* tabellen finnes ikke ennå */ }

  if (erLokal) await klient.execute('PRAGMA journal_mode = WAL');
  await klient.executeMultiple(TABELLER);
  for (const [tabell, kolonne, type] of NYE_KOLONNER) {
    const kol = await klient.execute(`PRAGMA table_info(${tabell})`);
    if (!kol.rows.some((r) => r[1] === kolonne)) await klient.execute(`ALTER TABLE ${tabell} ADD COLUMN ${kolonne} ${type}`);
  }
  await klient.executeMultiple(VISNING);
  await klient.execute({ sql: `INSERT INTO innstillinger (nokkel, verdi) VALUES ('skjema_versjon', ?)
    ON CONFLICT(nokkel) DO UPDATE SET verdi = excluded.verdi`, args: [SKJEMA_VERSJON] });
}

module.exports = { alle, en, kjor, batch, klar, erLokal, klient };
