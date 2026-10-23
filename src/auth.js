// Innlogging med personlig 6-sifret kode, økter i databasen og sperre mot gjetting.
// Alt lagres i databasen, slik at det virker når appen kjører i flere kopier (Vercel).
const crypto = require('node:crypto');
const db = require('./db');

const OKT_VARIGHET_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE = 'vatnem_okt';

function hashKode(kode, salt) {
  return crypto.scryptSync(kode, salt, 32).toString('hex');
}

async function finnBrukerMedKode(kode) {
  for (const b of await db.alle('SELECT * FROM brukere')) {
    const a = Buffer.from(hashKode(kode, b.salt), 'hex');
    if (crypto.timingSafeEqual(a, Buffer.from(b.kode_hash, 'hex'))) return b;
  }
  return null;
}

async function lagreBruker(navn, kode) {
  if (!/^\d{6}$/.test(kode)) throw new Error('Koden må være nøyaktig 6 siffer');
  const annen = await finnBrukerMedKode(kode);
  if (annen && annen.navn !== navn) throw new Error('Koden er allerede i bruk av en annen bruker');
  const salt = crypto.randomBytes(16).toString('hex');
  await db.kjor(`INSERT INTO brukere (navn, kode_hash, salt, opprettet) VALUES (?, ?, ?, ?)
    ON CONFLICT(navn) DO UPDATE SET kode_hash = excluded.kode_hash, salt = excluded.salt`,
  [navn, hashKode(kode, salt), salt, new Date().toISOString()]);
}

async function nyKode() {
  for (;;) {
    const kode = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    if (!(await finnBrukerMedKode(kode))) return kode;
  }
}

// Brukere kan settes via miljøvariabel, f.eks. BRUKERE="Ruben:123456;Judith:654321".
// Kjøres én gang per oppstart av appen.
let brukereLofte = null;
function brukereFraMiljo() {
  return (brukereLofte ||= (async () => {
    const verdi = process.env.BRUKERE;
    if (!verdi) return;
    for (const del of verdi.split(';').map((s) => s.trim()).filter(Boolean)) {
      const i = del.lastIndexOf(':');
      const navn = del.slice(0, i).trim();
      const kode = del.slice(i + 1).trim();
      const eksisterende = await db.en('SELECT * FROM brukere WHERE navn = ?', [navn]);
      if (eksisterende && hashKode(kode, eksisterende.salt) === eksisterende.kode_hash) continue;
      await lagreBruker(navn, kode);
    }
  })().catch((e) => { brukereLofte = null; console.error('[brukere]', e.message); }));
}

// --- Sperre mot gjetting -------------------------------------------------
// Maks 5 feil per IP-adresse per 15 min, og maks 30 feil totalt per time.
const KVARTER = 15 * 60 * 1000;
const TIME = 60 * 60 * 1000;

async function erSperret(ip) {
  const naa = Date.now();
  const totalt = await db.en('SELECT COUNT(*) n FROM innlogging_feil WHERE tidspunkt > ?', [naa - TIME]);
  if (totalt.n >= 30) return true;
  const perIp = await db.en('SELECT COUNT(*) n FROM innlogging_feil WHERE ip = ? AND tidspunkt > ?', [ip, naa - KVARTER]);
  return perIp.n >= 5;
}

async function registrerFeil(ip) {
  const naa = Date.now();
  await db.batch([
    ['DELETE FROM innlogging_feil WHERE tidspunkt < ?', [naa - TIME]],
    ['INSERT INTO innlogging_feil (ip, tidspunkt) VALUES (?, ?)', [ip, naa]],
  ]);
}

// --- Økter -----------------------------------------------------------------
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function lesCookie(req) {
  const rad = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(COOKIE + '='));
  return rad ? decodeURIComponent(rad.slice(COOKIE.length + 1)) : null;
}

function settCookie(req, res, verdi, maxAgeMs) {
  const deler = [`${COOKIE}=${encodeURIComponent(verdi)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (req.secure) deler.push('Secure');
  res.setHeader('Set-Cookie', deler.join('; '));
}

async function loggInn(req, res) {
  await brukereFraMiljo();
  const ip = req.ip || 'ukjent';
  if (await erSperret(ip)) return res.status(429).json({ feil: 'For mange forsøk. Vent 15 minutter og prøv igjen.' });
  const kode = String(req.body?.kode || '');
  const bruker = /^\d{6}$/.test(kode) ? await finnBrukerMedKode(kode) : null;
  if (!bruker) {
    await registrerFeil(ip);
    return res.status(401).json({ feil: 'Feil kode' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  await db.batch([
    ['DELETE FROM innlogging_feil WHERE ip = ?', [ip]],
    ['DELETE FROM okter WHERE utloper < ?', [Date.now()]],
    ['INSERT INTO okter (token_hash, bruker_id, utloper) VALUES (?, ?, ?)', [sha(token), bruker.id, Date.now() + OKT_VARIGHET_MS]],
  ]);
  settCookie(req, res, token, OKT_VARIGHET_MS);
  res.json({ id: bruker.id, navn: bruker.navn });
}

async function loggUt(req, res) {
  const token = lesCookie(req);
  if (token) await db.kjor('DELETE FROM okter WHERE token_hash = ?', [sha(token)]);
  settCookie(req, res, '', 0);
  res.json({ ok: true });
}

async function krevInnlogging(req, res, next) {
  const token = lesCookie(req);
  const rad = token && await db.en(`SELECT b.id, b.navn FROM okter o JOIN brukere b ON b.id = o.bruker_id
    WHERE o.token_hash = ? AND o.utloper > ?`, [sha(token), Date.now()]);
  if (!rad) return res.status(401).json({ feil: 'Ikke innlogget' });
  req.bruker = { id: rad.id, navn: rad.navn };
  next();
}

module.exports = { loggInn, loggUt, krevInnlogging, lagreBruker, nyKode, brukereFraMiljo };
