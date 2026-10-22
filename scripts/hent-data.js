// Henter/oppdaterer alle selskaper fra Brønnøysundregistrene. Kjør: npm run hent-data
const { synkroniser } = require('../src/brreg');

const start = Date.now();
synkroniser({ logg: (m) => console.log(new Date().toLocaleTimeString('nb-NO'), m) })
  .then(() => console.log(`Ferdig på ${Math.round((Date.now() - start) / 1000)} sekunder`))
  .catch((e) => {
    console.error('Feilet:', e.message);
    process.exit(1);
  });
