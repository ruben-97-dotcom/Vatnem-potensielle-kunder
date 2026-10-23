// Kopierer alle data fra den lokale databasefila (data/portal.db) til Turso.
// Krever TURSO_DATABASE_URL og TURSO_AUTH_TOKEN i .env. Kjør: npm run migrer
// Eksisterende rader i Turso med samme nøkkel overskrives; ingenting slettes i den lokale fila.
const path = require('node:path');
const { createClient } = require('@libsql/client');
const { DATA_DIR } = require('../src/config');

if (!process.env.TURSO_DATABASE_URL) {
  console.error('Mangler TURSO_DATABASE_URL (og TURSO_AUTH_TOKEN) i .env');
  process.exit(1);
}
const maal = require('../src/db'); // kobler til Turso og oppretter tabellene
const kilde = createClient({ url: 'file:' + path.join(DATA_DIR, 'portal.db').replace(/\\/g, '/') });

// Tabeller som flyttes (økter, køer og innloggingsfeil tas ikke med).
const TABELLER = ['brukere', 'selskaper', 'oppfolging', 'aktiviteter', 'personroller', 'hendelser', 'synkroniseringer', 'innstillinger'];
const HOPP_OVER_INNSTILLINGER = new Set(['skjema_versjon', 'synk_las']);

(async () => {
  await maal.klar();
  for (const tabell of TABELLER) {
    const r = await kilde.execute(`SELECT * FROM ${tabell}`);
    let rader = r.rows.map((rad) => r.columns.map((_, i) => rad[i]));
    if (tabell === 'innstillinger') rader = rader.filter((rad) => !HOPP_OVER_INNSTILLINGER.has(rad[0]));
    if (tabell === 'personroller') await maal.kjor('DELETE FROM personroller');
    const kolonner = r.columns;
    const perSetning = Math.max(1, Math.floor(20000 / kolonner.length));
    const setninger = [];
    for (let i = 0; i < rader.length; i += perSetning) {
      const del = rader.slice(i, i + perSetning);
      setninger.push([`INSERT OR REPLACE INTO ${tabell} (${kolonner.join(',')}) VALUES ${del.map(() => `(${kolonner.map(() => '?').join(',')})`).join(',')}`, del.flat()]);
    }
    for (let i = 0; i < setninger.length; i += 20) await maal.batch(setninger.slice(i, i + 20));
    console.log(`${tabell}: ${rader.length} rader kopiert`);
  }
  console.log('Ferdig. Alle data ligger nå i Turso.');
  process.exit(0);
})().catch((e) => {
  console.error('Feilet:', e.message);
  process.exit(1);
});
