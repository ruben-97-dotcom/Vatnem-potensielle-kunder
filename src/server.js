// Vatnem Vekst – server. Kjører både lokalt (npm start) og på Vercel (eksportert Express-app).
const path = require('node:path');
const express = require('express');
const db = require('./db');
const auth = require('./auth');
const brreg = require('./brreg');
const { PORT, KOMMUNER, STATUSER, VATNEM_ORGNR, REVISJONSPLIKT, VATNEM_PROFIL } = require('./config');

const PA_VERCEL = Boolean(process.env.VERCEL);
const ENDRINGER_INTERVALL_MIN = Number(process.env.ENDRINGER_INTERVALL_MIN) || 30;
const logg = (m) => console.log(new Date().toISOString(), '[synk]', m);

// Express 4 fanger ikke feil i async-funksjoner; denne sender dem videre til feilhåndteringen.
const a = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: '50kb' }));
// Lokalt serveres filene i public/ herfra. På Vercel serveres de direkte av Vercel.
if (!PA_VERCEL) app.use(express.static(path.join(__dirname, '..', 'public')));
// Reserve på Vercel: rotadressen sendes til forsiden, som Vercel serverer som statisk fil.
if (PA_VERCEL) app.get('/', (req, res) => res.redirect(302, '/index.html'));

// --- Planlagt oppdatering (Vercel Cron og videreføring) ----------------------------
// Vercel Cron kaller denne med «Authorization: Bearer <CRON_SECRET>». Samme nøkkel brukes når
// en kjøring ikke rakk å bli ferdig og starter neste del selv.
function harCronTilgang(req) {
  const hemmelig = process.env.CRON_SECRET;
  return Boolean(hemmelig) && req.headers.authorization === `Bearer ${hemmelig}`;
}

function egenAdresse() {
  const vert = process.env.VERCEL_ENV === 'production'
    ? process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL
    : process.env.VERCEL_URL;
  return vert ? `https://${vert}` : null;
}

// Kjører én del av oppdateringen (maks ~4 min). Gjenstår det arbeid, startes neste del.
async function kjorOgFortsett(type) {
  const resultat = await brreg.kjorSynk({ type, frist: Date.now() + 240_000, logg });
  if (resultat.ferdig || !resultat.startet) return resultat;
  if (!PA_VERCEL) return kjorOgFortsett('auto');
  const adr = egenAdresse();
  if (adr && process.env.CRON_SECRET) {
    await fetch(`${adr}/api/cron/synk`, { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }, signal: AbortSignal.timeout(5000) })
      .catch(() => {}); // Svaret trengs ikke; neste del kjører i sin egen funksjon.
  }
  return resultat;
}

// Starter arbeid i bakgrunnen. På Vercel holder waitUntil funksjonen i live til arbeidet er ferdig.
function iBakgrunnen(lofte) {
  const p = Promise.resolve(lofte).catch((e) => console.error('[synk] feilet:', e.message));
  if (PA_VERCEL) {
    try { require('@vercel/functions').waitUntil(p); } catch (e) { console.error('[waitUntil]', e.message); }
  }
  return p;
}

app.get('/api/cron/synk', a(async (req, res) => {
  if (!harCronTilgang(req)) return res.status(401).json({ feil: 'Ikke tilgang' });
  // Svarer med en gang og jobber videre i bakgrunnen, så kallet ikke blir stående og vente.
  iBakgrunnen(kjorOgFortsett('auto'));
  res.json({ ok: true, startet: new Date().toISOString() });
}));

// Sjekker Brreg for endringer når portalen brukes og siste sjekk er eldre enn intervallet.
// Nødvendig på Vercel Hobby, der cron bare kan kjøre én gang i døgnet.
let sisteSjekkForsok = 0;
async function synkVedBehov() {
  if (process.env.AUTO_SYNK === 'av' || Date.now() - sisteSjekkForsok < 60_000) return;
  sisteSjekkForsok = Date.now();
  const status = await brreg.synkStatus();
  if (status.aktivNa) return;
  const siste = await db.en("SELECT ferdig FROM synkroniseringer WHERE status != 'kjorer' ORDER BY id DESC LIMIT 1");
  const gammel = !siste || Date.now() - new Date(siste.ferdig).getTime() > ENDRINGER_INTERVALL_MIN * 60_000;
  if (status.ko > 0 || gammel) iBakgrunnen(kjorOgFortsett('auto'));
}

// --- Innlogging ------------------------------------------------------------------
app.post('/api/logg-inn', a(auth.loggInn));
app.post('/api/logg-ut', a(auth.loggUt));
app.use('/api', a(auth.krevInnlogging));

const STATUSKODER = new Set(STATUSER.map((s) => s.kode));
// Dagens dato i norsk tid (serveren kan stå i UTC).
const iDag = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Oslo' });
const tekst = (v, maks = 200) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, maks));

// --- Tilknyttede selskaper ---------------------------------------------------
// To selskaper er tilknyttet når samme person (navn + fødselsdato) har en rolle i begge.
const TILKNYTTET_KONTAKTET = `SELECT 1 FROM personroller p1
  JOIN personroller p2 ON p2.person_nokkel = p1.person_nokkel AND p2.orgnr != p1.orgnr
  JOIN selskaper s2 ON s2.orgnr = p2.orgnr AND s2.aktiv = 1
  LEFT JOIN oppfolging o2 ON o2.orgnr = p2.orgnr`;
const ER_KONTAKTET = `(o2.ringt = 1 OR o2.status != 'ny' OR s2.revisor_orgnr = '${VATNEM_ORGNR}')`;

const ROLLENAVN = {
  DAGL: 'daglig leder', LEDE: 'styreleder', NEST: 'nestleder', MEDL: 'styremedlem', KONT: 'kontaktperson',
  INNH: 'innehaver', DTPR: 'deltaker', DTSO: 'deltaker', KOMP: 'komplementar', BEST: 'bestyrende reder',
};

// Antall tilknyttede selskaper og hvor mange av dem som allerede er kontaktet, for en liste orgnr.
async function tilknytningForListe(orgnre) {
  if (!orgnre.length) return {};
  const rader = await db.alle(`SELECT p1.orgnr,
      COUNT(DISTINCT p2.orgnr) AS antall,
      COUNT(DISTINCT CASE WHEN ${ER_KONTAKTET} THEN p2.orgnr END) AS kontaktet
    FROM personroller p1
    JOIN personroller p2 ON p2.person_nokkel = p1.person_nokkel AND p2.orgnr != p1.orgnr
    JOIN selskaper s2 ON s2.orgnr = p2.orgnr AND s2.aktiv = 1
    LEFT JOIN oppfolging o2 ON o2.orgnr = p2.orgnr
    WHERE p1.orgnr IN (${orgnre.map(() => '?').join(',')}) GROUP BY p1.orgnr`, orgnre);
  return Object.fromEntries(rader.map((r) => [r.orgnr, r]));
}

async function tilknyttedeSelskaper(orgnr) {
  const rader = await db.alle(`SELECT v.orgnr, v.navn, v.kommune, v.status, v.ringt, v.sist_kontaktet, v.er_kunde,
      v.revisor_navn, v.driftsinntekter, b.navn AS ansvarlig, p1.navn AS person, p1.rolle AS rolle_her, p2.rolle AS rolle_der
    FROM personroller p1
    JOIN personroller p2 ON p2.person_nokkel = p1.person_nokkel AND p2.orgnr != p1.orgnr
    JOIN v_selskaper v ON v.orgnr = p2.orgnr AND v.aktiv = 1
    LEFT JOIN brukere b ON b.id = v.ansvarlig_id
    WHERE p1.orgnr = ?
    ORDER BY v.navn`, [orgnr]);
  const LEDENDE = new Set(['DAGL', 'LEDE', 'INNH', 'KOMP']);
  const perSelskap = new Map();
  for (const r of rader) {
    if (!perSelskap.has(r.orgnr)) {
      const { person, rolle_her, rolle_der, ...s } = r;
      perSelskap.set(r.orgnr, { ...s, personer: new Map(), sterk: false });
    }
    const sel = perSelskap.get(r.orgnr);
    if (!sel.personer.has(r.person)) sel.personer.set(r.person, { her: new Set(), der: new Set() });
    sel.personer.get(r.person).her.add(r.rolle_her);
    sel.personer.get(r.person).der.add(r.rolle_der);
    if (LEDENDE.has(r.rolle_her) || LEDENDE.has(r.rolle_der)) sel.sterk = true;
  }
  const rolleListe = (sett) => [...sett].map((k) => ROLLENAVN[k] || k).join(' og ');
  const liste = [...perSelskap.values()].map(({ personer, ...s }) => ({
    ...s,
    antallPersoner: personer.size,
    koblinger: [...personer].map(([navn, p]) => `${navn} (${rolleListe(p.her)} her, ${rolleListe(p.der)} der)`),
  }));
  // Kontaktede og eksisterende kunder først, deretter de sterkeste koblingene.
  const kontaktet = (s) => Number(Boolean(s.ringt || s.status !== 'ny' || s.er_kunde));
  return liste.sort((x, y) => kontaktet(y) - kontaktet(x) || Number(y.sterk) - Number(x.sterk) ||
    y.antallPersoner - x.antallPersoner || x.navn.localeCompare(y.navn, 'nb'));
}

// --- Filtrering ------------------------------------------------------------
function byggFilter(q, bruker) {
  const where = ['aktiv = 1'];
  const p = {};
  const liste = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (q.sok) {
    p.sok = `%${String(q.sok).trim()}%`;
    where.push('(navn LIKE :sok OR orgnr LIKE :sok OR daglig_leder LIKE :sok OR styreleder LIKE :sok OR kontaktperson LIKE :sok)');
  }
  const kommuner = liste(q.kommune).filter((k) => /^\d{4}$/.test(k));
  if (kommuner.length) where.push(`kommunenr IN (${kommuner.map((k) => `'${k}'`).join(',')})`);
  const statuser = liste(q.status).filter((s) => STATUSKODER.has(s));
  if (statuser.length) where.push(`status IN (${statuser.map((s) => `'${s}'`).join(',')})`);
  if (q.ringt === 'ja') where.push('ringt = 1');
  if (q.ringt === 'nei') where.push('ringt = 0');
  if (q.ek === 'positiv') where.push('egenkapital > 0');
  if (q.ek === 'negativ') where.push('egenkapital <= 0');
  if (q.ek === 'ukjent') where.push('egenkapital IS NULL');
  if (q.revisor === 'har') where.push('revisor_orgnr IS NOT NULL');
  else if (q.revisor === 'ingen') where.push('(revisor_orgnr IS NULL AND roller_hentet = 1)');
  else if (q.revisor === 'fravalgt') where.push('fravalg_revisjon = 1');
  else if (q.revisor === 'plikt_uten') where.push('revisjonspliktig = 1 AND (revisor_orgnr IS NULL AND roller_hentet = 1)');
  else if (/^\d{9}$/.test(q.revisor || '')) { where.push('revisor_orgnr = :revisor'); p.revisor = q.revisor; }
  if (q.min_inntekt) { where.push('driftsinntekter >= :min_inntekt'); p.min_inntekt = Number(q.min_inntekt) || 0; }
  if (q.min_ansatte) { where.push('ansatte >= :min_ansatte'); p.min_ansatte = Number(q.min_ansatte) || 0; }
  if (q.profil === 'vatnem') {
    where.push(`driftsinntekter >= ${VATNEM_PROFIL.minInntekt} AND driftsinntekter <= ${VATNEM_PROFIL.maksInntekt}
      AND (ansatte IS NULL OR ansatte <= ${VATNEM_PROFIL.maksAnsatte})`);
  }
  if (q.bransje) { where.push('(nace_tekst LIKE :bransje OR nace_kode LIKE :bransje_kode)'); p.bransje = `%${q.bransje}%`; p.bransje_kode = `${q.bransje}%`; }
  const orgformer = liste(q.orgform).filter((o) => /^[A-Z]{2,3}$/.test(o));
  if (orgformer.length) where.push(`orgform IN (${orgformer.map((o) => `'${o}'`).join(',')})`);
  if (q.ansvarlig === 'meg') { where.push('ansvarlig_id = :meg'); p.meg = bruker.id; }
  else if (q.ansvarlig === 'ingen') where.push('ansvarlig_id IS NULL');
  else if (/^\d+$/.test(q.ansvarlig || '')) { where.push('ansvarlig_id = :ansvarlig'); p.ansvarlig = Number(q.ansvarlig); }
  if (q.oppfolging === 'forfalt') { where.push('oppfolging_dato <= :idag'); p.idag = iDag(); }
  if (q.oppfolging === 'planlagt') where.push('oppfolging_dato IS NOT NULL');
  if (q.prioritet === '1') where.push('prioritet = 1');
  if (q.plikt === 'over_uten') where.push("revisjonspliktig = 1 AND (revisor_orgnr IS NULL AND roller_hentet = 1) AND orgform IN ('AS', 'SA')");
  if (q.plikt === 'naer') where.push("revisjonspliktig = 0 AND (revisor_orgnr IS NULL AND roller_hentet = 1) AND plikt_andel >= 0.7 AND orgform IN ('AS', 'SA')");
  if (q.plikt === 'alle') where.push("(revisor_orgnr IS NULL AND roller_hentet = 1) AND orgform IN ('AS', 'SA') AND (revisjonspliktig = 1 OR plikt_andel >= 0.7)");
  if (/^\d+$/.test(q.nye || '')) { where.push("stiftet >= date('now', :nye_dager)"); p.nye_dager = `-${Number(q.nye)} days`; }
  if (q.tilknyttet === 'ukontaktet') where.push(`NOT EXISTS (${TILKNYTTET_KONTAKTET} WHERE p1.orgnr = v_selskaper.orgnr AND ${ER_KONTAKTET})`);
  // Vatnem-kunder: skjult som standard, «vis» tar dem med, «kun» viser bare dem.
  if (q.kunder === 'kun') where.push('er_kunde = 1');
  else if (q.kunder !== 'vis') where.push('er_kunde = 0');
  return { sql: where.join(' AND '), p };
}

const SORTERING = {
  poeng: 'poeng', navn: 'navn', kommune: 'kommune', driftsinntekter: 'driftsinntekter', egenkapital: 'egenkapital',
  aarsresultat: 'aarsresultat', ansatte: 'ansatte', eiendeler: 'sum_eiendeler', gjeld: 'sum_gjeld', plikt: 'plikt_andel',
  stiftet: 'stiftet', status: 'status', oppfolging: 'oppfolging_dato', kontaktet: 'sist_kontaktet', revisor: 'revisor_navn',
  regnskapsforer: 'regnskapsforer_navn',
};

const LISTEFELT = `orgnr, navn, orgform, kommune, nace_tekst, ansatte, daglig_leder, styreleder, revisor_navn, revisor_orgnr,
  regnskapsforer_navn, regnskap_aar, driftsinntekter, aarsresultat, egenkapital, sum_eiendeler, sum_gjeld, fravalg_revisjon, roller_hentet,
  revisjonspliktig, er_kunde, status, ringt, sist_kontaktet, oppfolging_dato, ansvarlig_id, prioritet, poeng, telefon, mobil,
  plikt_andel, stiftet, dl_telefon, sl_telefon`;

app.get('/api/selskaper', a(async (req, res) => {
  const { sql, p } = byggFilter(req.query, req.bruker);
  const kol = SORTERING[req.query.sorter] || 'poeng';
  const retning = req.query.retning === 'asc' ? 'ASC' : 'DESC';
  const side = Math.max(0, Number(req.query.side) || 0);
  const perSide = Math.min(200, Math.max(10, Number(req.query.per_side) || 50));
  const [antall, rader] = await Promise.all([
    db.en(`SELECT COUNT(*) n FROM v_selskaper WHERE ${sql}`, p),
    db.alle(`SELECT ${LISTEFELT} FROM v_selskaper WHERE ${sql}
      ORDER BY (${kol} IS NULL), ${kol} ${retning}, navn ASC LIMIT ${perSide} OFFSET ${side * perSide}`, p),
  ]);
  const tilknytning = await tilknytningForListe(rader.map((r) => r.orgnr));
  for (const r of rader) {
    r.tilknyttede = tilknytning[r.orgnr]?.antall || 0;
    r.tilknyttede_kontaktet = tilknytning[r.orgnr]?.kontaktet || 0;
  }
  res.json({ totalt: antall.n, side, perSide, rader });
}));

function csvCelle(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

app.get('/api/eksport.csv', a(async (req, res) => {
  const { sql, p } = byggFilter(req.query, req.bruker);
  const rader = await db.alle(`SELECT v.*, b.navn AS ansvarlig FROM v_selskaper v LEFT JOIN brukere b ON b.id = v.ansvarlig_id
    WHERE ${sql} ORDER BY poeng DESC, navn`, p);
  const statusNavn = Object.fromEntries(STATUSER.map((s) => [s.kode, s.navn]));
  const kolonner = [
    ['Orgnr', 'orgnr'], ['Selskap', 'navn'], ['Form', 'orgform'], ['Kommune', 'kommune'], ['Bransje', 'nace_tekst'],
    ['Ansatte', 'ansatte'], ['Daglig leder', 'daglig_leder'], ['Styreleder', 'styreleder'], ['Revisor', 'revisor_navn'],
    ['Regnskapsfører', 'regnskapsforer_navn'], ['Regnskapsår', 'regnskap_aar'], ['Driftsinntekter', 'driftsinntekter'],
    ['Årsresultat', 'aarsresultat'], ['Egenkapital', 'egenkapital'], ['Sum eiendeler', 'sum_eiendeler'], ['Sum gjeld', 'sum_gjeld'],
    ['Fravalgt revisjon', 'fravalg_revisjon'], ['Telefon', 'telefon'], ['Mobil', 'mobil'], ['E-post', 'epost'],
    ['Hjemmeside', 'hjemmeside'], ['Adresse', 'adresse'], ['Postnr', 'postnr'], ['Poststed', 'poststed'],
    ['Status', (r) => statusNavn[r.status]], ['Ringt', (r) => (r.ringt ? 'Ja' : 'Nei')], ['Sist kontaktet', 'sist_kontaktet'],
    ['Oppfølging', 'oppfolging_dato'], ['Ansvarlig', 'ansvarlig'], ['Kontaktperson', 'kontaktperson'],
    ['Kontakt telefon', 'kontakt_telefon'], ['Kontakt e-post', 'kontakt_epost'], ['Tlf daglig leder', 'dl_telefon'],
    ['Tlf styreleder', 'sl_telefon'], ['Poeng', 'poeng'],
  ];
  const linjer = [kolonner.map(([t]) => t).join(';')];
  for (const r of rader) linjer.push(kolonner.map(([, f]) => csvCelle(typeof f === 'function' ? f(r) : r[f])).join(';'));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="potensielle-kunder-${iDag()}.csv"`);
  res.send('﻿' + linjer.join('\r\n'));
}));

app.get('/api/selskaper/:orgnr', a(async (req, res) => {
  const { orgnr } = req.params;
  const [s, aktiviteter, hendelser, tilknyttede] = await Promise.all([
    db.en('SELECT * FROM v_selskaper WHERE orgnr = ?', [orgnr]),
    db.alle(`SELECT a.*, b.navn AS bruker FROM aktiviteter a LEFT JOIN brukere b ON b.id = a.bruker_id
      WHERE a.orgnr = ? ORDER BY a.opprettet DESC`, [orgnr]),
    db.alle('SELECT type, tekst, tidspunkt FROM hendelser WHERE orgnr = ? ORDER BY tidspunkt DESC LIMIT 20', [orgnr]),
    tilknyttedeSelskaper(orgnr),
  ]);
  if (!s) return res.status(404).json({ feil: 'Fant ikke selskapet' });
  res.json({ ...s, aktiviteter, hendelser, tilknyttede });
}));

const AKTIVITET_SQL = 'INSERT INTO aktiviteter (orgnr, bruker_id, type, tekst, opprettet) VALUES (?, ?, ?, ?, ?)';
const OPPFOLGING_SQL = `
  INSERT INTO oppfolging (orgnr, status, ringt, sist_kontaktet, oppfolging_dato, ansvarlig_id, kontaktperson,
    kontakt_telefon, kontakt_epost, dl_telefon, sl_telefon, prioritet, oppdatert, oppdatert_av)
  VALUES (:orgnr, :status, :ringt, :sist_kontaktet, :oppfolging_dato, :ansvarlig_id, :kontaktperson,
    :kontakt_telefon, :kontakt_epost, :dl_telefon, :sl_telefon, :prioritet, :oppdatert, :oppdatert_av)
  ON CONFLICT(orgnr) DO UPDATE SET status=excluded.status, ringt=excluded.ringt, sist_kontaktet=excluded.sist_kontaktet,
    oppfolging_dato=excluded.oppfolging_dato, ansvarlig_id=excluded.ansvarlig_id, kontaktperson=excluded.kontaktperson,
    kontakt_telefon=excluded.kontakt_telefon, kontakt_epost=excluded.kontakt_epost, dl_telefon=excluded.dl_telefon,
    sl_telefon=excluded.sl_telefon, prioritet=excluded.prioritet, oppdatert=excluded.oppdatert, oppdatert_av=excluded.oppdatert_av`;
const OPPFOLGING_FELT = ['orgnr', 'status', 'ringt', 'sist_kontaktet', 'oppfolging_dato', 'ansvarlig_id', 'kontaktperson',
  'kontakt_telefon', 'kontakt_epost', 'dl_telefon', 'sl_telefon', 'prioritet', 'oppdatert', 'oppdatert_av'];
const oppfolgingArgs = (o) => Object.fromEntries(OPPFOLGING_FELT.map((f) => [f, o[f] ?? null]));

async function hentOppfolging(orgnr) {
  return (await db.en('SELECT * FROM oppfolging WHERE orgnr = ?', [orgnr])) ||
    { orgnr, status: 'ny', ringt: 0, sist_kontaktet: null, oppfolging_dato: null, ansvarlig_id: null,
      kontaktperson: null, kontakt_telefon: null, kontakt_epost: null, dl_telefon: null, sl_telefon: null, prioritet: 0 };
}

app.patch('/api/selskaper/:orgnr/oppfolging', a(async (req, res) => {
  const { orgnr } = req.params;
  if (!(await db.en('SELECT 1 x FROM selskaper WHERE orgnr = ?', [orgnr]))) return res.status(404).json({ feil: 'Fant ikke selskapet' });
  const b = req.body || {};
  const gml = await hentOppfolging(orgnr);
  const ny = { ...gml };
  const naa = new Date().toISOString();
  const logglinjer = [];
  const statusNavn = Object.fromEntries(STATUSER.map((s) => [s.kode, s.navn]));

  if ('status' in b) {
    if (!STATUSKODER.has(b.status)) return res.status(400).json({ feil: 'Ugyldig status' });
    if (b.status !== gml.status) {
      ny.status = b.status;
      logglinjer.push(['status', `Status: ${statusNavn[gml.status]} → ${statusNavn[b.status]}`]);
      if (b.status !== 'ny' && b.status !== 'ikke_aktuell' && !gml.ringt) ny.ringt = 1;
    }
  }
  if ('ringt' in b) ny.ringt = b.ringt ? 1 : 0;
  if (ny.ringt && !gml.ringt) {
    ny.sist_kontaktet = naa;
    logglinjer.push(['status', 'Markert som ringt']);
  }
  if (!ny.ringt && gml.ringt) logglinjer.push(['status', 'Fjernet markering som ringt']);
  if ('oppfolging_dato' in b) {
    const d = b.oppfolging_dato || null;
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ feil: 'Ugyldig dato' });
    if (d !== gml.oppfolging_dato) logglinjer.push(['status', d ? `Oppfølging satt til ${d}` : 'Oppfølgingsdato fjernet']);
    ny.oppfolging_dato = d;
  }
  if ('ansvarlig_id' in b) {
    const id = b.ansvarlig_id ? Number(b.ansvarlig_id) : null;
    const brukerRad = id && await db.en('SELECT navn FROM brukere WHERE id = ?', [id]);
    if (id && !brukerRad) return res.status(400).json({ feil: 'Ukjent bruker' });
    if (id !== gml.ansvarlig_id) logglinjer.push(['status', brukerRad ? `Ansvarlig: ${brukerRad.navn}` : 'Ansvarlig fjernet']);
    ny.ansvarlig_id = id;
  }
  for (const f of ['kontaktperson', 'kontakt_telefon', 'kontakt_epost', 'dl_telefon', 'sl_telefon']) if (f in b) ny[f] = tekst(b[f]);
  if ('prioritet' in b) ny.prioritet = b.prioritet ? 1 : 0;

  await db.batch([
    [OPPFOLGING_SQL, oppfolgingArgs({ ...ny, oppdatert: naa, oppdatert_av: req.bruker.id })],
    ...logglinjer.map(([type, t]) => [AKTIVITET_SQL, [orgnr, req.bruker.id, type, t, naa]]),
  ]);
  res.json(await db.en('SELECT * FROM v_selskaper WHERE orgnr = ?', [orgnr]));
}));

app.post('/api/selskaper/:orgnr/aktiviteter', a(async (req, res) => {
  const { orgnr } = req.params;
  if (!(await db.en('SELECT 1 x FROM selskaper WHERE orgnr = ?', [orgnr]))) return res.status(404).json({ feil: 'Fant ikke selskapet' });
  const t = tekst(req.body?.tekst, 4000);
  if (!t || !t.trim()) return res.status(400).json({ feil: 'Notatet er tomt' });
  const type = req.body?.type === 'samtale' ? 'samtale' : 'notat';
  const naa = new Date().toISOString();
  const setninger = [[AKTIVITET_SQL, [orgnr, req.bruker.id, type, t.trim(), naa]]];
  if (type === 'samtale') {
    const o = await hentOppfolging(orgnr);
    setninger.push([OPPFOLGING_SQL, oppfolgingArgs({ ...o, ringt: 1, sist_kontaktet: naa, oppdatert: naa, oppdatert_av: req.bruker.id })]);
  }
  await db.batch(setninger);
  res.json({ ok: true });
}));

app.delete('/api/aktiviteter/:id', a(async (req, res) => {
  const akt = await db.en('SELECT * FROM aktiviteter WHERE id = ?', [Number(req.params.id)]);
  if (!akt) return res.status(404).json({ feil: 'Fant ikke notatet' });
  if (akt.bruker_id !== req.bruker.id || akt.type === 'status') return res.status(403).json({ feil: 'Du kan bare slette egne notater' });
  await db.kjor('DELETE FROM aktiviteter WHERE id = ?', [akt.id]);
  res.json({ ok: true });
}));

// --- Felles mål og delmål ----------------------------------------------------------
// Lagres som JSON i innstillinger. Fremdrift regnes fra statusene i oppfølgingen:
// et selskap som har nådd et senere steg teller også på de tidligere stegene.
const MAAL_METRIKKER = {
  ringt: { navn: 'Ringt', sql: 'ringt = 1' },
  interessert: { navn: 'Interessert', sql: "status IN ('interessert', 'mote', 'tilbud', 'vunnet')" },
  mote: { navn: 'Møte avtalt', sql: "status IN ('mote', 'tilbud', 'vunnet')" },
  tilbud: { navn: 'Tilbud sendt', sql: "status IN ('tilbud', 'vunnet')" },
  vunnet: { navn: 'Kunde vunnet', sql: "status = 'vunnet'" },
};
const STANDARD_MAAL = { hovedmal: { tittel: 'nye kunder', antall: 20, frist: null }, delmal: [] };

async function lesMaal() {
  const rad = await db.en("SELECT verdi FROM innstillinger WHERE nokkel = 'maal'");
  try { return rad ? JSON.parse(rad.verdi) : STANDARD_MAAL; } catch { return STANDARD_MAAL; }
}

async function maalMedFremdrift() {
  const m = await lesMaal();
  const telling = await db.en(`SELECT ${Object.entries(MAAL_METRIKKER).map(([k, v]) => `SUM(${v.sql}) AS ${k}`).join(', ')}
    FROM v_selskaper WHERE aktiv = 1`);
  const tell = (k) => telling?.[k] || 0;
  return {
    ...m,
    hovedmal: { ...m.hovedmal, verdi: tell('vunnet') },
    delmal: m.delmal.map((d) => ({ ...d, verdi: tell(d.metrikk) })),
    metrikker: Object.fromEntries(Object.entries(MAAL_METRIKKER).map(([k, v]) => [k, v.navn])),
  };
}

app.put('/api/maal', a(async (req, res) => {
  const b = req.body || {};
  const heltall = (v) => Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) <= 100000;
  const dato = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const h = b.hovedmal || {};
  if (!heltall(h.antall)) return res.status(400).json({ feil: 'Hovedmålet må være et positivt tall' });
  const delmal = Array.isArray(b.delmal) ? b.delmal.slice(0, 8) : [];
  for (const d of delmal) {
    if (!MAAL_METRIKKER[d.metrikk]) return res.status(400).json({ feil: 'Ukjent type delmål' });
    if (!heltall(d.antall)) return res.status(400).json({ feil: 'Delmål må ha et positivt tall' });
  }
  const maal = {
    hovedmal: { tittel: tekst(h.tittel, 60) || 'nye kunder', antall: Number(h.antall), frist: dato(h.frist) },
    delmal: delmal.map((d) => ({ tittel: tekst(d.tittel, 60) || MAAL_METRIKKER[d.metrikk].navn, metrikk: d.metrikk, antall: Number(d.antall) })),
    oppdatert: new Date().toISOString(),
    oppdatertAv: req.bruker.navn,
  };
  await db.kjor(`INSERT INTO innstillinger (nokkel, verdi) VALUES ('maal', ?)
    ON CONFLICT(nokkel) DO UPDATE SET verdi = excluded.verdi`, [JSON.stringify(maal)]);
  res.json(await maalMedFremdrift());
}));

// --- Varsler (hendelser fra Brreg) --------------------------------------------
const HENDELSESTYPER = {
  revisor: ['revisor_fratradt', 'revisor_byttet', 'revisor_ny'],
  revisor_fratradt: ['revisor_fratradt'],
  regnskapsforer: ['regnskapsforer_fratradt', 'regnskapsforer_byttet', 'regnskapsforer_ny'],
  nye: ['nytt_selskap', 'flyttet_inn'],
  revisjonsplikt: ['revisjonsplikt'],
};

async function varslerSett(brukerId) {
  return (await db.en('SELECT varsler_sett FROM brukere WHERE id = ?', [brukerId]))?.varsler_sett || '';
}
async function ulesteVarsler(brukerId) {
  const sett = await varslerSett(brukerId);
  return (await db.en(`SELECT COUNT(*) n FROM hendelser h JOIN selskaper s ON s.orgnr = h.orgnr
    WHERE h.tidspunkt > ? AND s.aktiv = 1`, [sett])).n;
}

app.get('/api/hendelser', a(async (req, res) => {
  const typer = HENDELSESTYPER[req.query.type];
  const where = ['s.aktiv = 1'];
  if (typer) where.push(`h.type IN (${typer.map((t) => `'${t}'`).join(',')})`);
  const side = Math.max(0, Number(req.query.side) || 0);
  const sett = await varslerSett(req.bruker.id);
  const [antall, rader] = await Promise.all([
    db.en(`SELECT COUNT(*) n FROM hendelser h JOIN selskaper s ON s.orgnr = h.orgnr WHERE ${where.join(' AND ')}`),
    db.alle(`SELECT h.*, v.navn, v.kommune, v.orgform, v.nace_tekst, v.driftsinntekter, v.egenkapital, v.ansatte,
        v.revisor_navn, v.regnskapsforer_navn, v.status, v.ringt, v.er_kunde, v.daglig_leder,
        CASE WHEN h.tidspunkt > :sett THEN 1 ELSE 0 END AS ny
      FROM hendelser h JOIN selskaper s ON s.orgnr = h.orgnr JOIN v_selskaper v ON v.orgnr = h.orgnr
      WHERE ${where.join(' AND ')} ORDER BY h.tidspunkt DESC, h.id DESC LIMIT 50 OFFSET :offset`, { sett, offset: side * 50 }),
  ]);
  res.json({ totalt: antall.n, side, perSide: 50, rader });
}));

app.post('/api/hendelser/sett', a(async (req, res) => {
  await db.kjor('UPDATE brukere SET varsler_sett = ? WHERE id = ?', [new Date().toISOString(), req.bruker.id]);
  res.json({ ok: true });
}));

// --- Oversikt og metadata ----------------------------------------------------
app.get('/api/meg', (req, res) => res.json(req.bruker));

app.get('/api/oversikt', a(async (req, res) => {
  const base = 'FROM v_selskaper WHERE aktiv = 1 AND er_kunde = 0';
  const [statusRader, tall, forfalt, forfaltAlle, kunder, sisteAktivitet, sisteVarsler, nye, naerPlikt, uleste, maal] = await Promise.all([
    db.alle(`SELECT status, COUNT(*) n ${base} GROUP BY status`),
    db.en(`SELECT COUNT(*) totalt, SUM(ringt) ringt, SUM(egenkapital > 0) ek_positiv,
      SUM((revisor_orgnr IS NULL AND roller_hentet = 1) AND revisjonspliktig = 1) plikt_uten_revisor ${base}`),
    db.en(`SELECT COUNT(*) n ${base} AND oppfolging_dato <= ? AND ansvarlig_id = ?`, [iDag(), req.bruker.id]),
    db.en(`SELECT COUNT(*) n ${base} AND oppfolging_dato <= ?`, [iDag()]),
    db.en('SELECT COUNT(*) n FROM v_selskaper WHERE aktiv = 1 AND er_kunde = 1'),
    db.alle(`SELECT a.*, b.navn AS bruker, s.navn AS selskap FROM aktiviteter a
      LEFT JOIN brukere b ON b.id = a.bruker_id LEFT JOIN selskaper s ON s.orgnr = a.orgnr
      ORDER BY a.opprettet DESC LIMIT 12`),
    db.alle(`SELECT h.*, s.navn FROM hendelser h JOIN selskaper s ON s.orgnr = h.orgnr
      WHERE s.aktiv = 1 ORDER BY h.tidspunkt DESC, h.id DESC LIMIT 8`),
    db.en("SELECT COUNT(*) n FROM selskaper WHERE aktiv = 1 AND stiftet >= date('now', '-30 days')"),
    db.en(`SELECT SUM(revisjonspliktig = 1 AND (revisor_orgnr IS NULL AND roller_hentet = 1)) over_uten,
      SUM(revisjonspliktig = 0 AND (revisor_orgnr IS NULL AND roller_hentet = 1) AND plikt_andel >= 0.7) naer ${base}`),
    ulesteVarsler(req.bruker.id),
    maalMedFremdrift(),
  ]);
  const perStatus = Object.fromEntries(statusRader.map((r) => [r.status, r.n]));
  res.json({ ...tall, perStatus, forfalt: forfalt.n, forfaltAlle: forfaltAlle.n, kunder: kunder.n, sisteAktivitet,
    sisteVarsler, nyeSiste30: nye.n, ulesteVarsler: uleste, naerPlikt, maal });
}));

app.get('/api/revisorer', a(async (req, res) => {
  res.json(await db.alle(`SELECT revisor_orgnr AS orgnr, revisor_navn AS navn, COUNT(*) antall,
      SUM(driftsinntekter) inntekter, SUM(egenkapital > 0) ek_positiv
    FROM v_selskaper WHERE aktiv = 1 AND revisor_orgnr IS NOT NULL
    GROUP BY revisor_orgnr ORDER BY antall DESC`));
}));

app.get('/api/meta', a(async (req, res) => {
  // Sjekk Brreg for endringer i bakgrunnen hvis det er en stund siden sist.
  synkVedBehov().catch((e) => console.error('[synk]', e.message));
  const siste = (type) => db.en(`SELECT * FROM synkroniseringer WHERE status != 'kjorer' AND COALESCE(type, 'full') = ?
    ORDER BY id DESC LIMIT 1`, [type]);
  const [kommuneRader, brukere, aar, status, sisteFull, sisteEndringer, uleste] = await Promise.all([
    db.alle('SELECT kommunenr, COUNT(*) n FROM selskaper WHERE aktiv = 1 GROUP BY kommunenr'),
    db.alle('SELECT id, navn FROM brukere ORDER BY navn'),
    db.en('SELECT MAX(regnskap_aar) aar FROM selskaper WHERE aktiv = 1'),
    brreg.synkStatus(),
    siste('full'),
    siste('endringer'),
    ulesteVarsler(req.bruker.id),
  ]);
  const antall = Object.fromEntries(kommuneRader.map((r) => [r.kommunenr, r.n]));
  res.json({
    kommuner: KOMMUNER.map((k) => ({ ...k, antall: antall[k.nr] || 0 })),
    statuser: STATUSER,
    brukere,
    revisjonsplikt: REVISJONSPLIKT,
    profil: VATNEM_PROFIL,
    sisteRegnskapsaar: aar?.aar,
    synk: {
      kjorer: status.kjorer,
      ko: status.ko,
      fase: status.jobb ? (status.jobb.type === 'full' ? 'Full oppdatering' : 'Sjekker endringer') : 'Oppdaterer',
      totalt: status.jobb?.antall || 0,
      ferdig: status.jobb?.antall ? Math.max(0, status.jobb.antall - status.ko) : 0,
      siste: sisteFull,
      sisteEndringer,
      intervallMin: ENDRINGER_INTERVALL_MIN,
    },
    ulesteVarsler: uleste,
  });
}));

// --- Detaljer hentet direkte fra Brreg (roller, avdelinger, kapital, formål …) ---
app.get('/api/selskaper/:orgnr/detaljer', a(async (req, res) => {
  if (!/^\d{9}$/.test(req.params.orgnr)) return res.status(400).json({ feil: 'Ugyldig orgnr' });
  try {
    res.json(await brreg.hentDetaljer(req.params.orgnr));
  } catch (e) {
    console.error('[detaljer]', e.message);
    res.status(502).json({ feil: 'Kunne ikke hente detaljer fra Brønnøysundregistrene akkurat nå' });
  }
}));

// --- Manuell oppdatering --------------------------------------------------------
app.post('/api/synk', a(async (req, res) => {
  const status = await brreg.synkStatus();
  if (status.aktivNa) return res.status(409).json({ feil: 'Oppdatering kjører allerede' });
  iBakgrunnen(kjorOgFortsett(req.body?.type === 'full' ? 'full' : 'endringer'));
  res.json({ ok: true });
}));

app.use('/api', (req, res) => res.status(404).json({ feil: 'Ukjent adresse' }));
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ feil: err.kode === 'MANGLER_DATABASE' ? err.message : 'Noe gikk galt på serveren' });
});

// Lokalt: start server og sjekk Brreg jevnlig. På Vercel eksporteres appen i stedet.
if (!PA_VERCEL && require.main === module) {
  auth.brukereFraMiljo().then(async () => {
    const n = (await db.en('SELECT COUNT(*) n FROM brukere')).n;
    app.listen(PORT, () => {
      console.log(`Portalen kjører på http://localhost:${PORT}${db.erLokal ? '' : ' (database: Turso)'}`);
      if (!n) console.log('Ingen brukere ennå. Opprett med: npm run legg-til-bruker -- "Navn"');
    });
    const jevnlig = () => {
      if (process.env.AUTO_SYNK === 'av') return;
      iBakgrunnen(kjorOgFortsett('auto'));
    };
    setTimeout(jevnlig, 5000);
    setInterval(jevnlig, ENDRINGER_INTERVALL_MIN * 60 * 1000).unref();
  }).catch((e) => { console.error('Kunne ikke starte:', e.message); process.exit(1); });
}

module.exports = app;
