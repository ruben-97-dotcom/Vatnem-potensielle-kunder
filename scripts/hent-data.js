// Henter/oppdaterer alle selskaper fra Brønnøysundregistrene (full oppdatering).
// Kjør: npm run hent-data   (bruker Turso hvis TURSO_DATABASE_URL er satt, ellers lokal fil)
const { kjorSynk } = require('../src/brreg');

const start = Date.now();
const logg = (m) => console.log(new Date().toLocaleTimeString('nb-NO'), m);

(async () => {
  let type = 'full';
  for (;;) {
    const r = await kjorSynk({ type, frist: Date.now() + 60 * 60 * 1000, logg });
    if (r.opptatt) { logg('En annen oppdatering kjører. Prøver igjen om 30 sekunder…'); await new Promise((ok) => setTimeout(ok, 30000)); continue; }
    if (r.ferdig) break;
    type = 'auto';
  }
  console.log(`Ferdig på ${Math.round((Date.now() - start) / 1000)} sekunder`);
  process.exit(0);
})().catch((e) => {
  console.error('Feilet:', e.message);
  process.exit(1);
});
