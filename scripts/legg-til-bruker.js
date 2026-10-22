// Oppretter en bruker (eller gir eksisterende bruker ny kode).
// Bruk: npm run legg-til-bruker -- "Navn"            -> lager tilfeldig kode
//       npm run legg-til-bruker -- "Navn" 123456     -> bruker valgt kode
const { lagreBruker, nyKode } = require('../src/auth');

const [navn, valgtKode] = process.argv.slice(2);
if (!navn) {
  console.error('Bruk: npm run legg-til-bruker -- "Navn" [6-sifret kode]');
  process.exit(1);
}
const kode = valgtKode || nyKode();
try {
  lagreBruker(navn, kode);
  console.log(`Bruker "${navn}" kan logge inn med kode: ${kode}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
