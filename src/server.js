const path = require('node:path');
const express = require('express');
const db = require('./db');
const auth = require('./auth');
const brreg = require('./brreg');
const { PORT, KOMMUNER, STATUSER, VATNEM_ORGNR, REVISJONSPLIKT } = require('./config');

auth.brukereFraMiljo();

// Visning med oppfølging og beregnede felt (revisjonsplikt og prioriteringspoeng).
db.exec(`
  DROP VIEW IF EXISTS v_selskaper;
  CREATE VIEW v_selskaper AS
  SELECT x.*,
    -- Prioriteringspoeng 0–100: størrelse, soliditet og behov for revisjon.
    ( CASE WHEN x.egenkapital > 0 THEN 20 ELSE 0 END
    + CASE WHEN x.driftsinntekter >= 100000000 THEN 30 WHEN x.driftsinntekter >= 30000000 THEN 26
           WHEN x.driftsinntekter >= 10000000 THEN 20 WHEN x.driftsinntekter >= 5000000 THEN 14
           WHEN x.driftsinntekter >= 2000000 THEN 8 WHEN x.driftsinntekter >= 500000 THEN 3 ELSE 0 END
    + CASE WHEN x.ansatte >= 50 THEN 10 WHEN x.ansatte >= 10 THEN 8 WHEN x.ansatte >= 3 THEN 5 WHEN x.ansatte >= 1 THEN 3 ELSE 0 END
    + CASE WHEN x.aarsresultat > 0 THEN 10 ELSE 0 END
    + CASE WHEN x.revisjonspliktig = 1 THEN 10 ELSE 0 END
    + CASE WHEN x.revisjonspliktig = 1 AND x.revisor_orgnr IS NULL THEN 10 ELSE 0 END
    + CASE WHEN x.regnskap_aar >= CAST(strftime('%Y', 'now') AS INTEGER) - 2 THEN 10 ELSE 0 END
    ) AS poeng,
    -- Hvor nær grensen for revisjonsplikt selskapet er (1 = på grensen). Ansatte telles bare
    -- når selskapet ikke selv har oppgitt at revisjon er valgt bort (se revisjonspliktig under).
    MAX(COALESCE(x.driftsinntekter, 0) / ${REVISJONSPLIKT.driftsinntekter}.0,
        COALESCE(x.sum_eiendeler, 0) / ${REVISJONSPLIKT.sumEiendeler}.0,
        CASE WHEN COALESCE(x.fravalg_revisjon, 0) = 0 THEN COALESCE(x.ansatte, 0) / ${REVISJONSPLIKT.ansatte}.0 ELSE 0 END
    ) AS plikt_andel
  FROM (
    SELECT s.*,
      COALESCE(o.status, 'ny') AS status,
      COALESCE(o.ringt, 0) AS ringt,
      o.sist_kontaktet, o.oppfolging_dato, o.ansvarlig_id, o.kontaktperson, o.kontakt_telefon, o.kontakt_epost, o.dl_telefon, o.sl_telefon,
      COALESCE(o.prioritet, 0) AS prioritet,
      CASE WHEN s.revisor_orgnr = '${VATNEM_ORGNR}' THEN 1 ELSE 0 END AS er_kunde,
      -- Estimat. Ansatte i registeret er personer, ikke årsverk, så har selskapet selv valgt bort
      -- revisjon, regnes bare inntekt og balanse.
      CASE WHEN s.orgform = 'ASA' THEN 1
           WHEN s.orgform IN ('AS', 'SA') AND (s.driftsinntekter >= ${REVISJONSPLIKT.driftsinntekter}
             OR s.sum_eiendeler >= ${REVISJONSPLIKT.sumEiendeler}
             OR (s.ansatte >= ${REVISJONSPLIKT.ansatte} AND COALESCE(s.fravalg_revisjon, 0) = 0)) THEN 1
           ELSE 0 END AS revisjonspliktig
    FROM selskaper s LEFT JOIN oppfolging o ON o.orgnr = s.orgnr
  ) x;
`);

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.post('/api/logg-inn', auth.loggInn);
app.post('/api/logg-ut', auth.loggUt);
app.use('/api', auth.krevInnlogging);

const STATUSKODER = new Set(STATUSER.map((s) => s.kode));
// Dagens dato i norsk tid (serveren kan stå i UTC).
const iDag = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Oslo' });

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
function tilknytningForListe(orgnre) {
  if (!orgnre.length) return {};
  const plass = orgnre.map(() => '?').join(',');
  const rader = db.prepare(`SELECT p1.orgnr,
      COUNT(DISTINCT p2.orgnr) AS antall,
      COUNT(DISTINCT CASE WHEN ${ER_KONTAKTET} THEN p2.orgnr END) AS kontaktet
    FROM personroller p1
    JOIN personroller p2 ON p2.person_nokkel = p1.person_nokkel AND p2.orgnr != p1.orgnr
    JOIN selskaper s2 ON s2.orgnr = p2.orgnr AND s2.aktiv = 1
    LEFT JOIN oppfolging o2 ON o2.orgnr = p2.orgnr
    WHERE p1.orgnr IN (${plass}) GROUP BY p1.orgnr`).all(...orgnre);
  return Object.fromEntries(rader.map((r) => [r.orgnr, r]));
}

function tilknyttedeSelskaper(orgnr) {
  const rader = db.prepare(`SELECT v.orgnr, v.navn, v.kommune, v.status, v.ringt, v.sist_kontaktet, v.er_kunde,
      v.revisor_navn, v.driftsinntekter, b.navn AS ansvarlig, p1.navn AS person, p1.rolle AS rolle_her, p2.rolle AS rolle_der
    FROM personroller p1
    JOIN personroller p2 ON p2.person_nokkel = p1.person_nokkel AND p2.orgnr != p1.orgnr
    JOIN v_selskaper v ON v.orgnr = p2.orgnr AND v.aktiv = 1
    LEFT JOIN brukere b ON b.id = v.ansvarlig_id
    WHERE p1.orgnr = ?
    ORDER BY v.navn`).all(orgnr);
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
  return liste.sort((a, b) => kontaktet(b) - kontaktet(a) || Number(b.sterk) - Number(a.sterk) ||
    b.antallPersoner - a.antallPersoner || a.navn.localeCompare(b.navn, 'nb'));
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
  else if (q.revisor === 'ingen') where.push('revisor_orgnr IS NULL');
  else if (q.revisor === 'fravalgt') where.push('fravalg_revisjon = 1');
  else if (q.revisor === 'plikt_uten') where.push('revisjonspliktig = 1 AND revisor_orgnr IS NULL');
  else if (/^\d{9}$/.test(q.revisor || '')) { where.push('revisor_orgnr = :revisor'); p.revisor = q.revisor; }
  if (q.min_inntekt) { where.push('driftsinntekter >= :min_inntekt'); p.min_inntekt = Number(q.min_inntekt) || 0; }
  if (q.min_ansatte) { where.push('ansatte >= :min_ansatte'); p.min_ansatte = Number(q.min_ansatte) || 0; }
  if (q.bransje) { where.push('(nace_tekst LIKE :bransje OR nace_kode LIKE :bransje_kode)'); p.bransje = `%${q.bransje}%`; p.bransje_kode = `${q.bransje}%`; }
  const orgformer = liste(q.orgform).filter((o) => /^[A-Z]{2,3}$/.test(o));
  if (orgformer.length) where.push(`orgform IN (${orgformer.map((o) => `'${o}'`).join(',')})`);
  if (q.ansvarlig === 'meg') { where.push('ansvarlig_id = :meg'); p.meg = bruker.id; }
  else if (q.ansvarlig === 'ingen') where.push('ansvarlig_id IS NULL');
  else if (/^\d+$/.test(q.ansvarlig || '')) { where.push('ansvarlig_id = :ansvarlig'); p.ansvarlig = Number(q.ansvarlig); }
  if (q.oppfolging === 'forfalt') { where.push('oppfolging_dato <= :idag'); p.idag = iDag(); }
  if (q.oppfolging === 'planlagt') where.push('oppfolging_dato IS NOT NULL');
  if (q.prioritet === '1') where.push('prioritet = 1');
  if (q.plikt === 'over_uten') where.push("revisjonspliktig = 1 AND revisor_orgnr IS NULL AND orgform IN ('AS', 'SA')");
  if (q.plikt === 'naer') where.push("revisjonspliktig = 0 AND revisor_orgnr IS NULL AND plikt_andel >= 0.7 AND orgform IN ('AS', 'SA')");
  if (q.plikt === 'alle') where.push("revisor_orgnr IS NULL AND orgform IN ('AS', 'SA') AND (revisjonspliktig = 1 OR plikt_andel >= 0.7)");
  if (/^\d+$/.test(q.nye || '')) { where.push("stiftet >= date('now', :nye_dager)"); p.nye_dager = `-${Number(q.nye)} days`; }
  if (q.tilknyttet === 'ukontaktet') where.push(`NOT EXISTS (${TILKNYTTET_KONTAKTET} WHERE p1.orgnr = v_selskaper.orgnr AND ${ER_KONTAKTET})`);
  if (q.kunder !== 'vis') where.push('er_kunde = 0');
  if (q.kunder === 'kun') where.push('er_kunde = 1');
  return { sql: where.join(' AND '), p };
}

const SORTERING = {
  poeng: 'poeng', navn: 'navn', kommune: 'kommune', driftsinntekter: 'driftsinntekter', egenkapital: 'egenkapital',
  aarsresultat: 'aarsresultat', ansatte: 'ansatte', eiendeler: 'sum_eiendeler', gjeld: 'sum_gjeld', plikt: 'plikt_andel', stiftet: 'stiftet', status: 'status', oppfolging: 'oppfolging_dato',
  kontaktet: 'sist_kontaktet', revisor: 'revisor_navn', regnskapsforer: 'regnskapsforer_navn',
};

const LISTEFELT = `orgnr, navn, orgform, kommune, nace_tekst, ansatte, daglig_leder, styreleder, revisor_navn, revisor_orgnr,
  regnskapsforer_navn, regnskap_aar, driftsinntekter, aarsresultat, egenkapital, sum_eiendeler, sum_gjeld, fravalg_revisjon, revisjonspliktig, er_kunde,
  status, ringt, sist_kontaktet, oppfolging_dato, ansvarlig_id, prioritet, poeng, telefon, mobil, plikt_andel, stiftet, dl_telefon, sl_telefon`;

app.get('/api/selskaper', (req, res) => {
  const { sql, p } = byggFilter(req.query, req.bruker);
  const kol = SORTERING[req.query.sorter] || 'poeng';
  const retning = req.query.retning === 'asc' ? 'ASC' : 'DESC';
  const side = Math.max(0, Number(req.query.side) || 0);
  const perSide = Math.min(200, Math.max(10, Number(req.query.per_side) || 50));
  const totalt = db.prepare(`SELECT COUNT(*) n FROM v_selskaper WHERE ${sql}`).get(p).n;
  const rader = db.prepare(`SELECT ${LISTEFELT} FROM v_selskaper WHERE ${sql}
    ORDER BY (${kol} IS NULL), ${kol} ${retning}, navn ASC LIMIT ${perSide} OFFSET ${side * perSide}`).all(p);
  const tilknytning = tilknytningForListe(rader.map((r) => r.orgnr));
  for (const r of rader) {
    r.tilknyttede = tilknytning[r.orgnr]?.antall || 0;
    r.tilknyttede_kontaktet = tilknytning[r.orgnr]?.kontaktet || 0;
  }
  res.json({ totalt, side, perSide, rader });
});

function csvCelle(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

app.get('/api/eksport.csv', (req, res) => {
  const { sql, p } = byggFilter(req.query, req.bruker);
  const rader = db.prepare(`SELECT v.*, b.navn AS ansvarlig FROM v_selskaper v LEFT JOIN brukere b ON b.id = v.ansvarlig_id
    WHERE ${sql} ORDER BY poeng DESC, navn`).all(p);
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
    ['Kontakt telefon', 'kontakt_telefon'], ['Kontakt e-post', 'kontakt_epost'], ['Tlf daglig leder', 'dl_telefon'], ['Tlf styreleder', 'sl_telefon'], ['Poeng', 'poeng'],
  ];
  const linjer = [kolonner.map(([t]) => t).join(';')];
  for (const r of rader) linjer.push(kolonner.map(([, f]) => csvCelle(typeof f === 'function' ? f(r) : r[f])).join(';'));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="potensielle-kunder-${iDag()}.csv"`);
  res.send('﻿' + linjer.join('\r\n'));
});

app.get('/api/selskaper/:orgnr', (req, res) => {
  const s = db.prepare('SELECT * FROM v_selskaper WHERE orgnr = ?').get(req.params.orgnr);
  if (!s) return res.status(404).json({ feil: 'Fant ikke selskapet' });
  const aktiviteter = db.prepare(`SELECT a.*, b.navn AS bruker FROM aktiviteter a LEFT JOIN brukere b ON b.id = a.bruker_id
    WHERE a.orgnr = ? ORDER BY a.opprettet DESC`).all(req.params.orgnr);
  const hendelser = db.prepare('SELECT type, tekst, tidspunkt FROM hendelser WHERE orgnr = ? ORDER BY tidspunkt DESC LIMIT 20').all(req.params.orgnr);
  res.json({ ...s, aktiviteter, hendelser, tilknyttede: tilknyttedeSelskaper(req.params.orgnr) });
});

const leggTilAktivitet = db.prepare('INSERT INTO aktiviteter (orgnr, bruker_id, type, tekst, opprettet) VALUES (?, ?, ?, ?, ?)');

function hentOppfolging(orgnr) {
  return db.prepare('SELECT * FROM oppfolging WHERE orgnr = ?').get(orgnr) ||
    { orgnr, status: 'ny', ringt: 0, sist_kontaktet: null, oppfolging_dato: null, ansvarlig_id: null,
      kontaktperson: null, kontakt_telefon: null, kontakt_epost: null, dl_telefon: null, sl_telefon: null, prioritet: 0 };
}

const lagreOppfolging = db.prepare(`
  INSERT INTO oppfolging (orgnr, status, ringt, sist_kontaktet, oppfolging_dato, ansvarlig_id, kontaktperson,
    kontakt_telefon, kontakt_epost, dl_telefon, sl_telefon, prioritet, oppdatert, oppdatert_av)
  VALUES (:orgnr, :status, :ringt, :sist_kontaktet, :oppfolging_dato, :ansvarlig_id, :kontaktperson,
    :kontakt_telefon, :kontakt_epost, :dl_telefon, :sl_telefon, :prioritet, :oppdatert, :oppdatert_av)
  ON CONFLICT(orgnr) DO UPDATE SET status=excluded.status, ringt=excluded.ringt, sist_kontaktet=excluded.sist_kontaktet,
    oppfolging_dato=excluded.oppfolging_dato, ansvarlig_id=excluded.ansvarlig_id, kontaktperson=excluded.kontaktperson,
    kontakt_telefon=excluded.kontakt_telefon, kontakt_epost=excluded.kontakt_epost, dl_telefon=excluded.dl_telefon, sl_telefon=excluded.sl_telefon, prioritet=excluded.prioritet,
    oppdatert=excluded.oppdatert, oppdatert_av=excluded.oppdatert_av
`);

const tekst = (v, maks = 200) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, maks));

app.patch('/api/selskaper/:orgnr/oppfolging', (req, res) => {
  const { orgnr } = req.params;
  if (!db.prepare('SELECT 1 FROM selskaper WHERE orgnr = ?').get(orgnr)) return res.status(404).json({ feil: 'Fant ikke selskapet' });
  const b = req.body || {};
  const gml = hentOppfolging(orgnr);
  const ny = { ...gml };
  const naa = new Date().toISOString();
  const logg = [];
  const statusNavn = Object.fromEntries(STATUSER.map((s) => [s.kode, s.navn]));

  if ('status' in b) {
    if (!STATUSKODER.has(b.status)) return res.status(400).json({ feil: 'Ugyldig status' });
    if (b.status !== gml.status) {
      ny.status = b.status;
      logg.push(['status', `Status: ${statusNavn[gml.status]} → ${statusNavn[b.status]}`]);
      if (b.status !== 'ny' && b.status !== 'ikke_aktuell' && !gml.ringt) ny.ringt = 1;
    }
  }
  if ('ringt' in b) ny.ringt = b.ringt ? 1 : 0;
  if (ny.ringt && !gml.ringt) {
    ny.sist_kontaktet = naa;
    logg.push(['status', 'Markert som ringt']);
  }
  if (!ny.ringt && gml.ringt) logg.push(['status', 'Fjernet markering som ringt']);
  if ('oppfolging_dato' in b) {
    const d = b.oppfolging_dato || null;
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ feil: 'Ugyldig dato' });
    if (d !== gml.oppfolging_dato) logg.push(['status', d ? `Oppfølging satt til ${d}` : 'Oppfølgingsdato fjernet']);
    ny.oppfolging_dato = d;
  }
  if ('ansvarlig_id' in b) {
    const id = b.ansvarlig_id ? Number(b.ansvarlig_id) : null;
    const brukerRad = id && db.prepare('SELECT navn FROM brukere WHERE id = ?').get(id);
    if (id && !brukerRad) return res.status(400).json({ feil: 'Ukjent bruker' });
    if (id !== gml.ansvarlig_id) logg.push(['status', brukerRad ? `Ansvarlig: ${brukerRad.navn}` : 'Ansvarlig fjernet']);
    ny.ansvarlig_id = id;
  }
  for (const f of ['kontaktperson', 'kontakt_telefon', 'kontakt_epost', 'dl_telefon', 'sl_telefon']) if (f in b) ny[f] = tekst(b[f]);
  if ('prioritet' in b) ny.prioritet = b.prioritet ? 1 : 0;

  db.exec('BEGIN');
  lagreOppfolging.run({ ...ny, oppdatert: naa, oppdatert_av: req.bruker.id });
  for (const [type, t] of logg) leggTilAktivitet.run(orgnr, req.bruker.id, type, t, naa);
  db.exec('COMMIT');
  res.json(db.prepare('SELECT * FROM v_selskaper WHERE orgnr = ?').get(orgnr));
});

app.post('/api/selskaper/:orgnr/aktiviteter', (req, res) => {
  const { orgnr } = req.params;
  if (!db.prepare('SELECT 1 FROM selskaper WHERE orgnr = ?').get(orgnr)) return res.status(404).json({ feil: 'Fant ikke selskapet' });
  const t = tekst(req.body?.tekst, 4000);
  if (!t || !t.trim()) return res.status(400).json({ feil: 'Notatet er tomt' });
  const type = req.body?.type === 'samtale' ? 'samtale' : 'notat';
  const naa = new Date().toISOString();
  db.exec('BEGIN');
  leggTilAktivitet.run(orgnr, req.bruker.id, type, t.trim(), naa);
  if (type === 'samtale') {
    const o = hentOppfolging(orgnr);
    lagreOppfolging.run({ ...o, ringt: 1, sist_kontaktet: naa, oppdatert: naa, oppdatert_av: req.bruker.id });
  }
  db.exec('COMMIT');
  res.json({ ok: true });
});

app.delete('/api/aktiviteter/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM aktiviteter WHERE id = ?').get(Number(req.params.id));
  if (!a) return res.status(404).json({ feil: 'Fant ikke notatet' });
  if (a.bruker_id !== req.bruker.id || a.type === 'status') return res.status(403).json({ feil: 'Du kan bare slette egne notater' });
  db.prepare('DELETE FROM aktiviteter WHERE id = ?').run(a.id);
  res.json({ ok: true });
});

// --- Oversikt og metadata ----------------------------------------------------
app.get('/api/meg', (req, res) => res.json(req.bruker));

app.get('/api/oversikt', (req, res) => {
  const base = 'FROM v_selskaper WHERE aktiv = 1 AND er_kunde = 0';
  const perStatus = Object.fromEntries(db.prepare(`SELECT status, COUNT(*) n ${base} GROUP BY status`).all().map((r) => [r.status, r.n]));
  const tall = db.prepare(`SELECT COUNT(*) totalt, SUM(ringt) ringt, SUM(egenkapital > 0) ek_positiv,
    SUM(revisor_orgnr IS NULL AND revisjonspliktig = 1) plikt_uten_revisor ${base}`).get();
  const forfalt = db.prepare(`SELECT COUNT(*) n ${base} AND oppfolging_dato <= ? AND ansvarlig_id = ?`).get(iDag(), req.bruker.id).n;
  const forfaltAlle = db.prepare(`SELECT COUNT(*) n ${base} AND oppfolging_dato <= ?`).get(iDag()).n;
  const kunder = db.prepare('SELECT COUNT(*) n FROM v_selskaper WHERE aktiv = 1 AND er_kunde = 1').get().n;
  const sisteAktivitet = db.prepare(`SELECT a.*, b.navn AS bruker, s.navn AS selskap FROM aktiviteter a
    LEFT JOIN brukere b ON b.id = a.bruker_id LEFT JOIN selskaper s ON s.orgnr = a.orgnr
    ORDER BY a.opprettet DESC LIMIT 12`).all();
  const sisteVarsler = db.prepare(`SELECT h.*, s.navn FROM hendelser h JOIN selskaper s ON s.orgnr = h.orgnr
    WHERE s.aktiv = 1 ORDER BY h.tidspunkt DESC, h.id DESC LIMIT 8`).all();
  const nyeSiste30 = db.prepare(`SELECT COUNT(*) n FROM selskaper WHERE aktiv = 1 AND stiftet >= date('now', '-30 days')`).get().n;
  const naerPlikt = db.prepare(`SELECT
      SUM(revisjonspliktig = 1 AND revisor_orgnr IS NULL) over_uten,
      SUM(revisjonspliktig = 0 AND revisor_orgnr IS NULL AND plikt_andel >= 0.7) naer
    ${base}`).get();
  res.json({ ...tall, perStatus, forfalt, forfaltAlle, kunder, sisteAktivitet, sisteVarsler, nyeSiste30,
    ulesteVarsler: ulesteVarsler(req.bruker.id), naerPlikt });
});

app.get('/api/revisorer', (req, res) => {
  res.json(db.prepare(`SELECT revisor_orgnr AS orgnr, revisor_navn AS navn, COUNT(*) antall,
      SUM(driftsinntekter) inntekter, SUM(egenkapital > 0) ek_positiv
    FROM v_selskaper WHERE aktiv = 1 AND revisor_orgnr IS NOT NULL
    GROUP BY revisor_orgnr ORDER BY antall DESC`).all());
});

app.get('/api/meta', (req, res) => {
  const antall = Object.fromEntries(db.prepare('SELECT kommunenr, COUNT(*) n FROM selskaper WHERE aktiv = 1 GROUP BY kommunenr').all()
    .map((r) => [r.kommunenr, r.n]));
  const siste = (type) => db.prepare(`SELECT * FROM synkroniseringer WHERE status != 'kjorer' AND COALESCE(type, 'full') = ?
    ORDER BY id DESC LIMIT 1`).get(type) || null;
  res.json({
    kommuner: KOMMUNER.map((k) => ({ ...k, antall: antall[k.nr] || 0 })),
    statuser: STATUSER,
    brukere: db.prepare('SELECT id, navn FROM brukere ORDER BY navn').all(),
    revisjonsplikt: REVISJONSPLIKT,
    sisteRegnskapsaar: db.prepare('SELECT MAX(regnskap_aar) aar FROM selskaper WHERE aktiv = 1').get().aar,
    synk: { ...brreg.status, siste: siste('full'), sisteEndringer: siste('endringer'), intervallMin: ENDRINGER_INTERVALL_MIN },
    ulesteVarsler: ulesteVarsler(req.bruker.id),
  });
});

// --- Varsler (hendelser fra Brreg) --------------------------------------------
const HENDELSESTYPER = {
  revisor: ['revisor_fratradt', 'revisor_byttet', 'revisor_ny'],
  revisor_fratradt: ['revisor_fratradt'],
  regnskapsforer: ['regnskapsforer_fratradt', 'regnskapsforer_byttet', 'regnskapsforer_ny'],
  nye: ['nytt_selskap', 'flyttet_inn'],
  revisjonsplikt: ['revisjonsplikt'],
};

function ulesteVarsler(brukerId) {
  const sett = db.prepare('SELECT varsler_sett FROM brukere WHERE id = ?').get(brukerId)?.varsler_sett || '';
  return db.prepare(`SELECT COUNT(*) n FROM hendelser h JOIN selskaper s ON s.orgnr = h.orgnr
    WHERE h.tidspunkt > ? AND s.aktiv = 1`).get(sett).n;
}

app.get('/api/hendelser', (req, res) => {
  const typer = HENDELSESTYPER[req.query.type];
  const where = ['s.aktiv = 1'];
  if (typer) where.push(`h.type IN (${typer.map((t) => `'${t}'`).join(',')})`);
  const side = Math.max(0, Number(req.query.side) || 0);
  const sett = db.prepare('SELECT varsler_sett FROM brukere WHERE id = ?').get(req.bruker.id)?.varsler_sett || '';
  const totalt = db.prepare(`SELECT COUNT(*) n FROM hendelser h JOIN selskaper s ON s.orgnr = h.orgnr WHERE ${where.join(' AND ')}`).get().n;
  const rader = db.prepare(`SELECT h.*, v.navn, v.kommune, v.orgform, v.nace_tekst, v.driftsinntekter, v.egenkapital, v.ansatte,
      v.revisor_navn, v.regnskapsforer_navn, v.status, v.ringt, v.er_kunde, v.daglig_leder,
      CASE WHEN h.tidspunkt > :sett THEN 1 ELSE 0 END AS ny
    FROM hendelser h JOIN selskaper s ON s.orgnr = h.orgnr JOIN v_selskaper v ON v.orgnr = h.orgnr
    WHERE ${where.join(' AND ')} ORDER BY h.tidspunkt DESC, h.id DESC LIMIT 50 OFFSET :offset`).all({ sett, offset: side * 50 });
  res.json({ totalt, side, perSide: 50, rader });
});

app.post('/api/hendelser/sett', (req, res) => {
  db.prepare('UPDATE brukere SET varsler_sett = ? WHERE id = ?').run(new Date().toISOString(), req.bruker.id);
  res.json({ ok: true });
});

// --- Detaljer hentet direkte fra Brreg (roller, avdelinger, kapital, formål …) ---
app.get('/api/selskaper/:orgnr/detaljer', async (req, res) => {
  if (!/^\d{9}$/.test(req.params.orgnr)) return res.status(400).json({ feil: 'Ugyldig orgnr' });
  try {
    res.json(await brreg.hentDetaljer(req.params.orgnr));
  } catch (e) {
    console.error('[detaljer]', e.message);
    res.status(502).json({ feil: 'Kunne ikke hente detaljer fra Brønnøysundregistrene akkurat nå' });
  }
});

// --- Oppdatering mot Brreg --------------------------------------------------------
// Endringer hentes hvert 30. minutt (nye selskaper, revisorbytte osv.). Full henting ukentlig.
const ENDRINGER_INTERVALL_MIN = Number(process.env.ENDRINGER_INTERVALL_MIN) || 30;
const logg = (m) => console.log(new Date().toISOString(), '[synk]', m);

app.post('/api/synk', (req, res) => {
  if (brreg.status.kjorer) return res.status(409).json({ feil: 'Oppdatering kjører allerede' });
  const jobb = req.body?.type === 'full' ? brreg.synkroniser : brreg.synkEndringer;
  jobb({ logg }).catch((e) => console.error('[synk] feilet:', e.message));
  res.json({ ok: true });
});

function synkVedBehov() {
  if (brreg.status.kjorer || process.env.AUTO_SYNK === 'av') return;
  const sisteFull = db.prepare("SELECT ferdig FROM synkroniseringer WHERE status = 'ok' AND COALESCE(type, 'full') = 'full' ORDER BY id DESC LIMIT 1").get();
  const fullGammel = !sisteFull || Date.now() - new Date(sisteFull.ferdig).getTime() > 7 * 24 * 60 * 60 * 1000;
  const jobb = fullGammel ? brreg.synkroniser : brreg.synkEndringer;
  jobb({ logg }).catch((e) => console.error('[synk] feilet:', e.message));
}
setTimeout(synkVedBehov, 5000);
setInterval(synkVedBehov, ENDRINGER_INTERVALL_MIN * 60 * 1000).unref();

app.use('/api', (req, res) => res.status(404).json({ feil: 'Ukjent adresse' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ feil: 'Noe gikk galt på serveren' });
});

app.listen(PORT, () => {
  const n = db.prepare('SELECT COUNT(*) n FROM brukere').get().n;
  console.log(`Portalen kjører på http://localhost:${PORT}`);
  if (!n) console.log('Ingen brukere ennå. Opprett med: npm run legg-til-bruker -- "Navn"');
});
