// Innlogging med personlig 6-sifret kode, økter i databasen og sperre mot gjetting.
const crypto = require('node:crypto');
const db = require('./db');

const OKT_VARIGHET_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE = 'vatnem_okt';

function hashKode(kode, salt) {
  return crypto.scryptSync(kode, salt, 32).toString('hex');
}

function finnBrukerMedKode(kode) {
  for (const b of db.prepare('SELECT * FROM brukere').all()) {
    const a = Buffer.from(hashKode(kode, b.salt), 'hex');
    if (crypto.timingSafeEqual(a, Buffer.from(b.kode_hash, 'hex'))) return b;
  }
  return null;
}

function lagreBruker(navn, kode) {
  if (!/^\d{6}$/.test(kode)) throw new Error('Koden må være nøyaktig 6 siffer');
  const annen = finnBrukerMedKode(kode);
  if (annen && annen.navn !== navn) throw new Error('Koden er allerede i bruk av en annen bruker');
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare(`INSERT INTO brukere (navn, kode_hash, salt, opprettet) VALUES (?, ?, ?, ?)
    ON CONFLICT(navn) DO UPDATE SET kode_hash = excluded.kode_hash, salt = excluded.salt`)
    .run(navn, hashKode(kode, salt), salt, new Date().toISOString());
}

function nyKode() {
  for (;;) {
    const kode = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    if (!finnBrukerMedKode(kode)) return kode;
  }
}

// Brukere kan settes via miljøvariabel, f.eks. BRUKERE="Ruben:123456;Kari:654321".
function brukereFraMiljo() {
  const verdi = process.env.BRUKERE;
  if (!verdi) return;
  for (const del of verdi.split(';').map((s) => s.trim()).filter(Boolean)) {
    const i = del.lastIndexOf(':');
    const navn = del.slice(0, i).trim();
    const kode = del.slice(i + 1).trim();
    const eksisterende = db.prepare('SELECT * FROM brukere WHERE navn = ?').get(navn);
    if (eksisterende && hashKode(kode, eksisterende.salt) === eksisterende.kode_hash) continue;
    lagreBruker(navn, kode);
  }
}

// --- Sperre mot gjetting -------------------------------------------------
// Maks 5 feil per IP-adresse per 15 min, og maks 30 feil totalt per time.
const feilPerIp = new Map();
let globaleFeil = [];

function erSperret(ip) {
  const naa = Date.now();
  globaleFeil = globaleFeil.filter((t) => naa - t < 60 * 60 * 1000);
  if (globaleFeil.length >= 30) return true;
  const f = feilPerIp.get(ip);
  return Boolean(f && f.antall >= 5 && naa - f.forste < 15 * 60 * 1000);
}

function registrerFeil(ip) {
  const naa = Date.now();
  globaleFeil.push(naa);
  const f = feilPerIp.get(ip);
  if (!f || naa - f.forste >= 15 * 60 * 1000) feilPerIp.set(ip, { antall: 1, forste: naa });
  else f.antall++;
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

function loggInn(req, res) {
  const ip = req.ip;
  if (erSperret(ip)) return res.status(429).json({ feil: 'For mange forsøk. Vent 15 minutter og prøv igjen.' });
  const kode = String(req.body?.kode || '');
  const bruker = /^\d{6}$/.test(kode) ? finnBrukerMedKode(kode) : null;
  if (!bruker) {
    registrerFeil(ip);
    return res.status(401).json({ feil: 'Feil kode' });
  }
  feilPerIp.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM okter WHERE utloper < ?').run(Date.now());
  db.prepare('INSERT INTO okter (token_hash, bruker_id, utloper) VALUES (?, ?, ?)').run(sha(token), bruker.id, Date.now() + OKT_VARIGHET_MS);
  settCookie(req, res, token, OKT_VARIGHET_MS);
  res.json({ id: bruker.id, navn: bruker.navn });
}

function loggUt(req, res) {
  const token = lesCookie(req);
  if (token) db.prepare('DELETE FROM okter WHERE token_hash = ?').run(sha(token));
  settCookie(req, res, '', 0);
  res.json({ ok: true });
}

function krevInnlogging(req, res, next) {
  const token = lesCookie(req);
  const rad = token && db.prepare(`SELECT b.id, b.navn FROM okter o JOIN brukere b ON b.id = o.bruker_id
    WHERE o.token_hash = ? AND o.utloper > ?`).get(sha(token), Date.now());
  if (!rad) return res.status(401).json({ feil: 'Ikke innlogget' });
  req.bruker = { id: rad.id, navn: rad.navn };
  next();
}

module.exports = { loggInn, loggUt, krevInnlogging, lagreBruker, nyKode, brukereFraMiljo };
