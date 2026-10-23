// Henter selskaper, roller og årsregnskap fra Brønnøysundregistrenes åpne API-er.
const crypto = require('node:crypto');
const db = require('./db');
const { KOMMUNER, ORGANISASJONSFORMER, REVISJONSPLIKT } = require('./config');

const ENHETER_URL = 'https://data.brreg.no/enhetsregisteret/api/enheter';
const REGNSKAP_URL = 'https://data.brreg.no/regnskapsregisteret/regnskap';
const SAMTIDIGE_KALL = 6;



const vent = (ms) => new Promise((r) => setTimeout(r, ms));

async function hentJson(url) {
  for (let forsok = 1; ; forsok++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.status === 404 || res.status === 410) return null; // 410 = slettet
      if (res.ok) return await res.json();
      if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status} for ${url}`);
      if (forsok >= 6) throw new Error(`HTTP ${res.status} for ${url}`);
    } catch (e) {
      if (forsok >= 6 || /HTTP 4\d\d/.test(e.message)) throw e;
    }
    await vent(500 * 2 ** forsok);
  }
}

function personNavn(p) {
  const n = p?.navn;
  if (!n) return null;
  return [n.fornavn, n.mellomnavn, n.etternavn].filter(Boolean).join(' ');
}

function rolleNavn(r) {
  if (r.person) return personNavn(r.person);
  if (r.enhet) return (r.enhet.navn || []).join(' ');
  return null;
}

// Roller som knytter selskaper sammen via samme person (ikke revisor/regnskapsfører).
const KOBLENDE_ROLLER = new Set(['DAGL', 'LEDE', 'NEST', 'MEDL', 'KONT', 'INNH', 'DTPR', 'DTSO', 'KOMP', 'BEST']);

function personNokkel(r) {
  if (r.person) {
    const navn = (personNavn(r.person) || '').toLowerCase();
    return crypto.createHash('sha256').update(`${navn}|${r.person.fodselsdato || ''}`).digest('hex').slice(0, 24);
  }
  if (r.enhet?.organisasjonsnummer) return 'org:' + r.enhet.organisasjonsnummer;
  return null;
}

function tolkPersonroller(data) {
  const ut = [];
  const sett = new Set();
  for (const gruppe of data?.rollegrupper || []) {
    for (const r of gruppe.roller || []) {
      const kode = r.type?.kode;
      if (r.avregistrert || r.fratraadt || r.person?.erDoed || !KOBLENDE_ROLLER.has(kode)) continue;
      const nokkel = personNokkel(r);
      const navn = rolleNavn(r);
      if (!nokkel || !navn || sett.has(nokkel + kode)) continue;
      sett.add(nokkel + kode);
      ut.push({ rolle: kode, navn, person_nokkel: nokkel });
    }
  }
  return ut;
}

function tolkRoller(data) {
  const ut = { daglig_leder: null, styreleder: null, revisor_navn: null, revisor_orgnr: null, regnskapsforer_navn: null, regnskapsforer_orgnr: null };
  for (const gruppe of data?.rollegrupper || []) {
    for (const r of gruppe.roller || []) {
      if (r.avregistrert || r.fratraadt) continue;
      const kode = r.type?.kode;
      if (kode === 'DAGL' && !ut.daglig_leder) ut.daglig_leder = rolleNavn(r);
      if (kode === 'LEDE' && !ut.styreleder) ut.styreleder = rolleNavn(r);
      if (kode === 'REVI' && !ut.revisor_navn) {
        ut.revisor_navn = rolleNavn(r);
        ut.revisor_orgnr = r.enhet?.organisasjonsnummer || null;
      }
      if (kode === 'REGN' && !ut.regnskapsforer_navn) {
        ut.regnskapsforer_navn = rolleNavn(r);
        ut.regnskapsforer_orgnr = r.enhet?.organisasjonsnummer || null;
      }
    }
  }
  return ut;
}

function tolkRegnskap(liste) {
  if (!Array.isArray(liste) || liste.length === 0) return null;
  // Foretrekk selskapsregnskap fremfor konsernregnskap, og nyeste periode.
  const sortert = [...liste].sort((a, b) => {
    const t = (b.regnskapsperiode?.tilDato || '').localeCompare(a.regnskapsperiode?.tilDato || '');
    if (t !== 0) return t;
    return (a.regnskapstype === 'SELSKAP' ? -1 : 1) - (b.regnskapstype === 'SELSKAP' ? -1 : 1);
  });
  const r = sortert.find((x) => x.regnskapstype === 'SELSKAP') || sortert[0];
  const res = r.resultatregnskapResultat || {};
  const tall = (v) => (typeof v === 'number' ? v : null);
  return {
    regnskap_aar: Number((r.regnskapsperiode?.tilDato || '').slice(0, 4)) || null,
    driftsinntekter: tall(res.driftsresultat?.driftsinntekter?.sumDriftsinntekter),
    driftsresultat: tall(res.driftsresultat?.driftsresultat),
    aarsresultat: tall(res.aarsresultat),
    egenkapital: tall(r.egenkapitalGjeld?.egenkapital?.sumEgenkapital),
    sum_eiendeler: tall(r.eiendeler?.sumEiendeler),
    sum_gjeld: tall(r.egenkapitalGjeld?.gjeldOversikt?.sumGjeld),
    fravalg_revisjon: r.revisjon?.fravalgRevisjon ? 1 : 0,
  };
}

// ============================================================================
// Oppdatering mot Brreg med kø i databasen.
// Arbeidet legges i tabellen synk_ko og behandles innenfor en tidsfrist. Når fristen
// nås, fortsetter neste kjøring der den slapp (viktig på Vercel, der funksjoner har
// begrenset kjøretid). En lås i databasen hindrer at to kjøringer jobber samtidig.
// ============================================================================

const ENHET_KOLONNER = ['orgnr', 'navn', 'orgform', 'kommune', 'kommunenr', 'adresse', 'postnr', 'poststed', 'nace_kode',
  'nace_tekst', 'ansatte', 'stiftet', 'telefon', 'mobil', 'epost', 'hjemmeside', 'i_konsern', 'oppdatert'];
const ENHET_OPPDATER = `ON CONFLICT(orgnr) DO UPDATE SET navn=excluded.navn, orgform=excluded.orgform, kommune=excluded.kommune,
  kommunenr=excluded.kommunenr, adresse=excluded.adresse, postnr=excluded.postnr, poststed=excluded.poststed,
  nace_kode=excluded.nace_kode, nace_tekst=excluded.nace_tekst, ansatte=excluded.ansatte, stiftet=excluded.stiftet,
  telefon=excluded.telefon, mobil=excluded.mobil, epost=excluded.epost, hjemmeside=excluded.hjemmeside,
  i_konsern=excluded.i_konsern, aktiv=1, oppdatert=excluded.oppdatert`;

// Én INSERT med mange rader (raskere mot en database i skyen).
function lagreEnheterSql(rader) {
  const plass = rader.map(() => `(${ENHET_KOLONNER.map(() => '?').join(',')}, 1)`).join(',');
  const args = rader.flatMap((r) => ENHET_KOLONNER.map((k) => r[k]));
  return [`INSERT INTO selskaper (${ENHET_KOLONNER.join(',')}, aktiv) VALUES ${plass} ${ENHET_OPPDATER}`, args];
}

const SQL_ROLLER = `UPDATE selskaper SET daglig_leder=:daglig_leder, styreleder=:styreleder, revisor_navn=:revisor_navn,
  revisor_orgnr=:revisor_orgnr, regnskapsforer_navn=:regnskapsforer_navn, regnskapsforer_orgnr=:regnskapsforer_orgnr,
  roller_hentet=1 WHERE orgnr=:orgnr`;
const SQL_REGNSKAP = `UPDATE selskaper SET regnskap_aar=:regnskap_aar, driftsinntekter=:driftsinntekter, driftsresultat=:driftsresultat,
  aarsresultat=:aarsresultat, egenkapital=:egenkapital, sum_eiendeler=:sum_eiendeler, sum_gjeld=:sum_gjeld,
  fravalg_revisjon=:fravalg_revisjon, regnskap_hentet=1 WHERE orgnr=:orgnr`;

function enhetTilRad(e, naa) {
  const a = e.forretningsadresse || e.postadresse || {};
  return {
    orgnr: e.organisasjonsnummer,
    navn: e.navn,
    orgform: e.organisasjonsform?.kode || null,
    kommune: a.kommune || null,
    kommunenr: a.kommunenummer || null,
    adresse: (a.adresse || []).join(', ') || null,
    postnr: a.postnummer || null,
    poststed: a.poststed || null,
    nace_kode: e.naeringskode1?.kode || null,
    nace_tekst: e.naeringskode1?.beskrivelse || null,
    ansatte: e.harRegistrertAntallAnsatte ? e.antallAnsatte ?? 0 : null,
    stiftet: e.stiftelsesdato || e.registreringsdatoEnhetsregisteret || null,
    telefon: e.telefon || null,
    mobil: e.mobil || null,
    epost: e.epostadresse || null,
    hjemmeside: e.hjemmeside || null,
    i_konsern: e.erIKonsern ? 1 : 0,
    oppdatert: naa,
  };
}

async function hentEnheterForKommune(kommunenr) {
  const enheter = [];
  for (let side = 0; ; side++) {
    const url = `${ENHETER_URL}?kommunenummer=${kommunenr}&organisasjonsform=${ORGANISASJONSFORMER.join(',')}` +
      `&konkurs=false&underAvvikling=false&underTvangsavviklingEllerTvangsopplosning=false&size=1000&page=${side}`;
    const data = await hentJson(url);
    enheter.push(...(data?._embedded?.enheter || []));
    if (!data || side + 1 >= data.page.totalPages) break;
  }
  return enheter;
}

async function iParallell(elementer, antall, fn) {
  let i = 0;
  let feil = 0;
  await Promise.all(Array.from({ length: antall }, async () => {
    while (i < elementer.length) {
      const el = elementer[i++];
      try { await fn(el); } catch (e) { feil++; console.error('[synk]', e.message); }
    }
  }));
  return feil;
}

const deler = (liste, n) => Array.from({ length: Math.ceil(liste.length / n) }, (_, i) => liste.slice(i * n, i * n + n));

// --- Innstillinger (posisjon i Brregs endringsfeeder) -----------------------
const lesInnstilling = async (n) => (await db.en('SELECT verdi FROM innstillinger WHERE nokkel = ?', [n]))?.verdi ?? null;
const settInnstillingSql = (n, v) => [`INSERT INTO innstillinger (nokkel, verdi) VALUES (?, ?)
  ON CONFLICT(nokkel) DO UPDATE SET verdi = excluded.verdi`, [n, String(v)]];

// --- Hendelser ---------------------------------------------------------------
const hendelseSql = (orgnr, type, tekst, naa = new Date().toISOString()) =>
  ['INSERT INTO hendelser (orgnr, type, tekst, tidspunkt) VALUES (?, ?, ?, ?)', [orgnr, type, tekst, naa]];
const hentLagret = (orgnr) => db.en(`SELECT orgnr, aktiv, roller_hentet, revisor_navn, revisor_orgnr,
  regnskapsforer_navn, regnskapsforer_orgnr FROM selskaper WHERE orgnr = ?`, [orgnr]);

function sammenlignRoller(orgnr, gml, ny) {
  const ut = [];
  const par = [['revisor', 'revisor', 'Revisor'], ['regnskapsforer', 'regnskapsfører', 'Regnskapsfører']];
  for (const [felt, ord, Ord] of par) {
    const fra = gml[`${felt}_orgnr`] || gml[`${felt}_navn`];
    const til = ny[`${felt}_orgnr`] || ny[`${felt}_navn`];
    if (fra === til) continue;
    const fraNavn = gml[`${felt}_navn`];
    const tilNavn = ny[`${felt}_navn`];
    if (fra && !til) ut.push(hendelseSql(orgnr, `${felt}_fratradt`, `${Ord} ${fraNavn} har gått av. Selskapet har ingen ${ord} registrert nå.`));
    else if (!fra && til) ut.push(hendelseSql(orgnr, `${felt}_ny`, `Har fått ny ${ord}: ${tilNavn}`));
    else ut.push(hendelseSql(orgnr, `${felt}_byttet`, `Byttet ${ord} fra ${fraNavn} til ${tilNavn}`));
  }
  return ut;
}

// --- Revisjonsplikt -----------------------------------------------------------
// Samme regel som visningen i db.js: inntekt, balanse eller ansatte over grensen.
const pliktRad = (orgnr) => db.en(`SELECT orgnr, orgform, driftsinntekter, sum_eiendeler, ansatte, fravalg_revisjon,
  revisor_orgnr, regnskap_hentet, aktiv FROM selskaper WHERE orgnr = ?`, [orgnr]);
const T = REVISJONSPLIKT;

function pliktGrunner(r) {
  if (!r || !['AS', 'SA'].includes(r.orgform)) return [];
  const mill = (v) => (v / 1e6).toLocaleString('nb-NO', { maximumFractionDigits: 1 }) + ' mill';
  const g = [];
  if ((r.driftsinntekter ?? 0) >= T.driftsinntekter) g.push(`driftsinntekter ${mill(r.driftsinntekter)}`);
  if ((r.sum_eiendeler ?? 0) >= T.sumEiendeler) g.push(`balanse ${mill(r.sum_eiendeler)}`);
  if ((r.ansatte ?? 0) >= T.ansatte && !r.fravalg_revisjon) g.push(`${r.ansatte} ansatte`);
  return g;
}

// Lager varsel hvis selskapet har gått fra under til over grensen og ikke har revisor.
async function sjekkPliktOvergang(foer) {
  if (!foer || !foer.regnskap_hentet) return;
  const etter = await pliktRad(foer.orgnr);
  if (!etter || !etter.aktiv || etter.revisor_orgnr) return;
  const grunner = pliktGrunner(etter);
  if (pliktGrunner(foer).length === 0 && grunner.length > 0) {
    await db.kjor(...hendelseSql(foer.orgnr, 'revisjonsplikt', `Har passert grensen for revisjonsplikt (${grunner.join(', ')}) og har ingen revisor`));
  }
}

// Et selskap er med i utvalget når det ligger i en av kommunene, har riktig selskapsform og er i drift.
function iUtvalg(e) {
  const kommunenr = (e.forretningsadresse || e.postadresse || {}).kommunenummer;
  return Boolean(e && KOMMUNER.some((k) => k.nr === kommunenr) && ORGANISASJONSFORMER.includes(e.organisasjonsform?.kode) &&
    !e.konkurs && !e.underAvvikling && !e.underTvangsavviklingEllerTvangsopplosning && !e.slettedato);
}

function nyttSelskapHendelse(e, naa) {
  const registrert = e.registreringsdatoEnhetsregisteret || e.stiftelsesdato;
  const erNytt = registrert && Date.now() - new Date(registrert).getTime() < 180 * 24 * 60 * 60 * 1000;
  return hendelseSql(e.organisasjonsnummer, erNytt ? 'nytt_selskap' : 'flyttet_inn',
    erNytt ? `Nytt selskap registrert ${registrert}${e.naeringskode1 ? ' – ' + e.naeringskode1.beskrivelse : ''}`
      : 'Nytt i området (flyttet hit eller endret selskapsform)', naa);
}

// Henter roller (og eventuelt regnskap) for ett selskap og lager hendelser ved revisor-/regnskapsførerbytte.
async function oppdaterRollerOgRegnskap(orgnr, { regnskap = true, varsle = true } = {}) {
  const [roller, regnskapData] = await Promise.all([
    hentJson(`${ENHETER_URL}/${orgnr}/roller`),
    regnskap ? hentJson(`${REGNSKAP_URL}/${orgnr}`) : Promise.resolve(undefined),
  ]);
  const setninger = [];
  if (roller) {
    const gml = await hentLagret(orgnr);
    const ny = tolkRoller(roller);
    if (varsle && gml?.roller_hentet) setninger.push(...sammenlignRoller(orgnr, gml, ny));
    setninger.push([SQL_ROLLER, { orgnr, ...ny }], ['DELETE FROM personroller WHERE orgnr = ?', [orgnr]]);
    for (const p of tolkPersonroller(roller)) {
      setninger.push(['INSERT INTO personroller (orgnr, rolle, navn, person_nokkel) VALUES (?, ?, ?, ?)', [orgnr, p.rolle, p.navn, p.person_nokkel]]);
    }
  }
  const r = regnskap ? tolkRegnskap(regnskapData) : null;
  if (r) setninger.push([SQL_REGNSKAP, { orgnr, ...r }]);
  await db.batch(setninger);
}

// --- Kø -----------------------------------------------------------------------
// Typer: full / full_stille (roller + regnskap), enhet (sjekk selskapet, så roller), roller (bare roller).
const RANG = { full: 3, full_stille: 3, enhet: 2, roller: 1 };

async function leggIKo(orgnre, type) {
  const naa = new Date().toISOString();
  for (const del of deler(orgnre, 300)) {
    await db.kjor(`INSERT INTO synk_ko (orgnr, type, lagt_til) VALUES ${del.map(() => '(?, ?, ?)').join(',')}
      ON CONFLICT(orgnr) DO UPDATE SET type = CASE
        WHEN (CASE synk_ko.type WHEN 'full' THEN 3 WHEN 'full_stille' THEN 3 WHEN 'enhet' THEN 2 ELSE 1 END) >= ${RANG[type]}
        THEN synk_ko.type ELSE excluded.type END`, del.flatMap((o) => [o, type, naa]));
  }
}

async function behandle({ orgnr, type }) {
  if (type === 'full' || type === 'full_stille') {
    const foer = await pliktRad(orgnr);
    await oppdaterRollerOgRegnskap(orgnr, { varsle: type === 'full' });
    if (type === 'full') await sjekkPliktOvergang(foer);
  } else if (type === 'roller') {
    await oppdaterRollerOgRegnskap(orgnr, { regnskap: false });
  } else {
    const e = await hentJson(`${ENHETER_URL}/${orgnr}`);
    const lagret = await db.en('SELECT aktiv FROM selskaper WHERE orgnr = ?', [orgnr]);
    if (!e || !iUtvalg(e)) {
      if (lagret?.aktiv) await db.kjor('UPDATE selskaper SET aktiv = 0 WHERE orgnr = ?', [orgnr]);
      return;
    }
    const foer = await pliktRad(orgnr);
    const naa = new Date().toISOString();
    const erNy = !lagret || !lagret.aktiv;
    await db.batch([lagreEnheterSql([enhetTilRad(e, naa)]), ...(!lagret ? [nyttSelskapHendelse(e, naa)] : [])]);
    await oppdaterRollerOgRegnskap(orgnr, { regnskap: erNy });
    await sjekkPliktOvergang(foer);
  }
}

// --- Lås -------------------------------------------------------------------------
async function taLas(varighetMs) {
  const naa = Date.now();
  const r = await db.kjor(`INSERT INTO innstillinger (nokkel, verdi) VALUES ('synk_las', ?)
    ON CONFLICT(nokkel) DO UPDATE SET verdi = excluded.verdi WHERE CAST(innstillinger.verdi AS INTEGER) < ?`,
  [String(naa + varighetMs), naa]);
  return r.endret > 0;
}
const slippLas = () => db.kjor("UPDATE innstillinger SET verdi = '0' WHERE nokkel = 'synk_las'");

// --- Start av jobber ----------------------------------------------------------------
async function nyJobb(type, antall) {
  return db.kjor('INSERT INTO synkroniseringer (startet, status, type, antall) VALUES (?, ?, ?, ?)',
    [new Date().toISOString(), 'kjorer', type, antall]);
}

// Full oppdatering: lagrer alle selskaper i kommunene og legger dem i køen for roller og regnskap.
async function startFull(logg) {
  // Jobben registreres med en gang, så portalen kan vise at den jobber.
  const jobb = await nyJobb('full', null);
  const naa = new Date().toISOString();
  const varsle = (await db.en('SELECT COUNT(*) n FROM selskaper')).n > 0;
  // Feedposisjonene settes før hentingen, så ingen endringer underveis går tapt.
  const posisjon = [];
  if (!(await lesInnstilling('enheter_fra_dato')) && !(await lesInnstilling('enheter_oppdateringsid'))) posisjon.push(settInnstillingSql('enheter_fra_dato', naa));
  if (!(await lesInnstilling('roller_fra_tid')) && !(await lesInnstilling('roller_etter_id'))) posisjon.push(settInnstillingSql('roller_fra_tid', naa));
  if (posisjon.length) await db.batch(posisjon);

  const fantes = new Map((await db.alle('SELECT orgnr, aktiv FROM selskaper')).map((r) => [r.orgnr, r.aktiv]));
  const sett = new Set();
  for (const k of KOMMUNER) {
    const enheter = await hentEnheterForKommune(k.nr);
    for (const del of deler(enheter, 100)) {
      const setninger = [lagreEnheterSql(del.map((e) => enhetTilRad(e, naa)))];
      if (varsle) for (const e of del) if (!fantes.has(e.organisasjonsnummer)) setninger.push(nyttSelskapHendelse(e, naa));
      await db.batch(setninger);
    }
    enheter.forEach((e) => sett.add(e.organisasjonsnummer));
    logg(`${k.navn}: ${enheter.length} selskaper`);
  }
  // Selskaper som ikke lenger finnes i utvalget (slettet, konkurs, flyttet) skjules, men oppfølgingen beholdes.
  const borte = [...fantes].filter(([orgnr, aktiv]) => aktiv && !sett.has(orgnr)).map(([o]) => o);
  for (const del of deler(borte, 300)) await db.kjor(`UPDATE selskaper SET aktiv = 0 WHERE orgnr IN (${del.map(() => '?').join(',')})`, del);

  await leggIKo([...sett], varsle ? 'full' : 'full_stille');
  await db.kjor('UPDATE synkroniseringer SET antall = ? WHERE id = ?', [sett.size, jobb.id]);
  logg(`Full oppdatering: ${sett.size} selskaper lagt i kø`);
}

async function hentEndredeEnheter() {
  const endret = new Map();
  let id = await lesInnstilling('enheter_oppdateringsid');
  const fraDato = await lesInnstilling('enheter_fra_dato');
  const base = ENHETER_URL.replace('/enheter', '/oppdateringer/enheter');
  for (let runde = 0; runde < 200; runde++) {
    const url = id ? `${base}?oppdateringsid=${id}&size=1000` : `${base}?dato=${encodeURIComponent(fraDato)}&size=1000`;
    const liste = (await hentJson(url))?._embedded?.oppdaterteEnheter || [];
    for (const o of liste) endret.set(o.organisasjonsnummer, o.endringstype);
    if (liste.length) id = String(liste.at(-1).oppdateringsid + 1);
    if (liste.length < 1000) break;
  }
  return { endret, nesteId: id };
}

async function hentEndredeRoller() {
  const endret = new Set();
  let etterId = await lesInnstilling('roller_etter_id');
  const fraTid = await lesInnstilling('roller_fra_tid');
  const base = ENHETER_URL.replace('/enheter', '/oppdateringer/roller');
  for (let runde = 0; runde < 50; runde++) {
    const url = etterId ? `${base}?afterId=${etterId}&size=10000` : `${base}?afterTime=${encodeURIComponent(fraTid)}&size=10000`;
    const liste = (await hentJson(url)) || [];
    for (const h of liste) if (h.data?.organisasjonsnummer) endret.add(h.data.organisasjonsnummer);
    if (liste.length) etterId = liste.at(-1).id;
    if (liste.length < 10000) break;
  }
  return { endret, etterId };
}

// Endringer: leser Brregs endringsfeeder og legger endrede selskaper i køen.
async function startEndringer(logg) {
  if (!(await lesInnstilling('enheter_fra_dato')) && !(await lesInnstilling('enheter_oppdateringsid'))) {
    const siste = await db.en("SELECT startet FROM synkroniseringer WHERE status = 'ok' AND COALESCE(type, 'full') = 'full' ORDER BY id DESC LIMIT 1");
    if (!siste) return startFull(logg);
    await db.batch([settInnstillingSql('enheter_fra_dato', siste.startet), settInnstillingSql('roller_fra_tid', siste.startet)]);
  }
  const jobb = await nyJobb('endringer', null);
  const [enheter, roller] = await Promise.all([hentEndredeEnheter(), hentEndredeRoller()]);
  const lagret = new Set((await db.alle('SELECT orgnr FROM selskaper')).map((r) => r.orgnr));
  const aktive = new Set((await db.alle('SELECT orgnr FROM selskaper WHERE aktiv = 1')).map((r) => r.orgnr));
  // Endrede selskaper: de vi har, og alle nye/endrede som kan ha flyttet inn i området.
  const sjekk = [...enheter.endret].filter(([orgnr, type]) => lagret.has(orgnr) || type !== 'Sletting').map(([o]) => o);
  const rollerEndret = [...roller.endret].filter((o) => aktive.has(o) && !enheter.endret.has(o));
  await leggIKo(sjekk, 'enhet');
  await leggIKo(rollerEndret, 'roller');
  const posisjon = [];
  if (enheter.nesteId) posisjon.push(settInnstillingSql('enheter_oppdateringsid', enheter.nesteId));
  if (roller.etterId) posisjon.push(settInnstillingSql('roller_etter_id', roller.etterId));
  if (posisjon.length) await db.batch(posisjon);
  await db.kjor('UPDATE synkroniseringer SET antall = ? WHERE id = ?', [sjekk.length + rollerEndret.length, jobb.id]);
  logg(`Endringer: ${enheter.endret.size} i hele landet, ${sjekk.length + rollerEndret.length} lagt i kø`);
}

// Behandler køen til den er tom eller fristen er nådd.
async function arbeid(frist, logg) {
  for (;;) {
    const rader = await db.alle('SELECT orgnr, type FROM synk_ko ORDER BY lagt_til, orgnr LIMIT 60');
    if (!rader.length) {
      await db.kjor("UPDATE synkroniseringer SET status = 'ok', ferdig = ? WHERE status = 'kjorer'", [new Date().toISOString()]);
      return true;
    }
    await iParallell(rader, SAMTIDIGE_KALL, async (r) => {
      try { await behandle(r); } finally {
        await db.kjor('DELETE FROM synk_ko WHERE orgnr = ? AND type = ?', [r.orgnr, r.type]);
      }
    });
    const igjen = (await db.en('SELECT COUNT(*) n FROM synk_ko')).n;
    if (igjen % 1000 < 60) logg(`${igjen} igjen i køen`);
    if (Date.now() > frist) return false;
  }
}

/**
 * Kjører oppdatering mot Brreg til køen er tom eller fristen nås.
 * type: 'auto' (full hvis forrige fulle er over en uke gammel, ellers endringer), 'full' eller 'endringer'.
 * Returnerer { ferdig, startet } – ferdig=false betyr at mer gjenstår i køen.
 */
async function kjorSynk({ type = 'auto', frist = Date.now() + 240_000, logg = () => {} } = {}) {
  if (!(await taLas(frist - Date.now() + 60_000))) return { ferdig: false, startet: false, opptatt: true };
  try {
    const iKo = (await db.en('SELECT COUNT(*) n FROM synk_ko')).n;
    // Gjenstår bare kartplassering fra en tidligere kjøring, fortsettes den uten å starte en ny jobb.
    const bareKart = !iKo && type === 'auto' && (await antallUtenPlassering()) > 0;
    if (!iKo && !bareKart) {
      let vilFull = type === 'full';
      if (type === 'auto') {
        const sisteFull = await db.en("SELECT ferdig FROM synkroniseringer WHERE status = 'ok' AND COALESCE(type, 'full') = 'full' ORDER BY id DESC LIMIT 1");
        vilFull = !sisteFull || Date.now() - new Date(sisteFull.ferdig).getTime() > 7 * 24 * 60 * 60 * 1000;
      }
      if (vilFull) await startFull(logg); else await startEndringer(logg);
    }
    const koFerdig = await arbeid(frist, logg);
    const ferdig = koFerdig && await plasserPaaKart(frist, logg);
    if (ferdig) logg('Oppdatering ferdig');
    return { ferdig, startet: true };
  } catch (e) {
    await db.kjor("UPDATE synkroniseringer SET status = 'feil', ferdig = ?, melding = ? WHERE status = 'kjorer'",
      [new Date().toISOString(), e.message]).catch(() => {});
    throw e;
  } finally {
    await slippLas().catch(() => {});
  }
}

// --- Plassering på kart (Kartverkets åpne adresse-API) ---------------------------
// Forretningsadressen slås opp én gang og lagres. Finnes ikke adressen (f.eks. postboks),
// brukes postnummer, så poststed, så kommune, og plasseringen merkes som omtrentlig.
const ADRESSE_URL = 'https://ws.geonorge.no/adresser/v1/sok';
const UTEN_PLASSERING = `aktiv = 1 AND (geo_status IS NULL
  OR geo_nokkel IS NOT (COALESCE(adresse, '') || '|' || COALESCE(postnr, '') || '|' || COALESCE(kommunenr, '')))`;

const antallUtenPlassering = async () => (await db.en(`SELECT COUNT(*) n FROM selskaper WHERE ${UTEN_PLASSERING}`)).n;

async function finnPunkt(sporring) {
  const d = await hentJson(`${ADRESSE_URL}?${sporring}&treffPerSide=1&utkoordsys=4258`);
  const p = d?.adresser?.[0]?.representasjonspunkt;
  return p && typeof p.lat === 'number' ? { lat: p.lat, lon: p.lon } : null;
}

async function geokod(r) {
  const gate = (r.adresse || '').split(',')[0].trim();
  if (gate && r.postnr && !/post\s*boks|^pb\b|^boks\b|postboks/i.test(gate)) {
    const p = await finnPunkt(`sok=${encodeURIComponent(gate)}&postnummer=${r.postnr}`);
    if (p) return { ...p, status: 'adresse' };
  }
  if (r.postnr) {
    const p = await finnPunkt(`postnummer=${r.postnr}`);
    if (p) return { ...p, status: 'omtrentlig' };
  }
  if (r.poststed) {
    const p = await finnPunkt(`poststed=${encodeURIComponent(r.poststed)}`);
    if (p) return { ...p, status: 'omtrentlig' };
  }
  if (r.kommunenr) {
    const p = await finnPunkt(`kommunenummer=${r.kommunenr}`);
    if (p) return { ...p, status: 'omtrentlig' };
  }
  return { lat: null, lon: null, status: 'mangler' };
}

// Plasserer selskaper som mangler koordinater, til alle er plassert eller fristen nås.
async function plasserPaaKart(frist, logg) {
  for (;;) {
    const rader = await db.alle(`SELECT orgnr, adresse, postnr, poststed, kommunenr FROM selskaper WHERE ${UTEN_PLASSERING} LIMIT 120`);
    if (!rader.length) return true;
    const oppdateringer = [];
    await iParallell(rader, SAMTIDIGE_KALL, async (r) => {
      const g = await geokod(r);
      oppdateringer.push(['UPDATE selskaper SET lat = ?, lon = ?, geo_status = ?, geo_nokkel = ? WHERE orgnr = ?',
        [g.lat, g.lon, g.status, `${r.adresse || ''}|${r.postnr || ''}|${r.kommunenr || ''}`, r.orgnr]]);
    });
    await db.batch(oppdateringer);
    const igjen = await antallUtenPlassering();
    if (igjen % 1000 < 120) logg(`${igjen} selskaper igjen å plassere på kartet`);
    if (Date.now() > frist) return false;
  }
}

// Status for visning i portalen (fra databasen, så den er lik for alle kopier av appen).
async function synkStatus() {
  const [koRad, lasVerdi, jobb, utenKart, aktive] = await Promise.all([
    db.en('SELECT COUNT(*) n FROM synk_ko'),
    lesInnstilling('synk_las'),
    db.en("SELECT * FROM synkroniseringer WHERE status = 'kjorer' ORDER BY id DESC LIMIT 1"),
    antallUtenPlassering(),
    db.en('SELECT COUNT(*) n FROM selskaper WHERE aktiv = 1'),
  ]);
  const las = Number(lasVerdi) || 0;
  return { kjorer: koRad.n > 0 || las > Date.now(), ko: koRad.n, jobb, aktivNa: las > Date.now(), utenKart, aktive: aktive.n };
}

// --- Detaljer hentet direkte fra Brreg når et selskap åpnes -------------------
const detaljCache = new Map();

function tolkAlleRoller(data) {
  return (data?.rollegrupper || []).map((g) => ({
    gruppe: g.type?.beskrivelse,
    roller: (g.roller || []).filter((r) => !r.avregistrert).map((r) => ({
      rolle: r.type?.beskrivelse,
      navn: rolleNavn(r),
      orgnr: r.enhet?.organisasjonsnummer || null,
      fratradt: Boolean(r.fratraadt),
    })),
  })).filter((g) => g.roller.length);
}

async function hentDetaljer(orgnr) {
  const c = detaljCache.get(orgnr);
  if (c && Date.now() - c.tid < 30 * 60 * 1000) return c.data;
  const [e, roller, under, regnskap] = await Promise.all([
    hentJson(`${ENHETER_URL}/${orgnr}`),
    hentJson(`${ENHETER_URL}/${orgnr}/roller`),
    hentJson(`${ENHETER_URL.replace('/enheter', '/underenheter')}?overordnetEnhet=${orgnr}&size=100`),
    hentJson(`${REGNSKAP_URL}/${orgnr}`),
  ]);
  // Nyeste periode, og selskapsregnskap fremfor konsernregnskap.
  const sortert = Array.isArray(regnskap)
    ? [...regnskap].sort((a, b) => (b.regnskapsperiode?.tilDato || '').localeCompare(a.regnskapsperiode?.tilDato || '') ||
      Number(b.regnskapstype === 'SELSKAP') - Number(a.regnskapstype === 'SELSKAP'))
    : [];
  const regn = sortert[0] || null;
  const res = regn?.resultatregnskapResultat || {};
  const data = {
    info: e && {
      aksjekapital: e.kapital?.belop ?? null,
      antallAksjer: e.kapital?.antallAksjer ?? null,
      kapitalType: e.kapital?.type || null,
      formaal: (e.vedtektsfestetFormaal || e.aktivitet || []).join(' '),
      stiftet: e.stiftelsesdato || null,
      registrert: e.registreringsdatoEnhetsregisteret || null,
      foretaksregisteret: e.registreringsdatoForetaksregisteret || null,
      mva: Boolean(e.registrertIMvaregisteret),
      sektor: e.institusjonellSektorkode?.beskrivelse || null,
      naering2: e.naeringskode2?.beskrivelse || null,
      sisteAarsregnskap: e.sisteInnsendteAarsregnskap || null,
      vedtektsdato: e.vedtektsdato || null,
      postadresse: e.postadresse ? [...(e.postadresse.adresse || []), [e.postadresse.postnummer, e.postadresse.poststed].filter(Boolean).join(' ')].join(', ') : null,
      tidligereNavn: (e.historiskeNavn || []).map((h) => ({ navn: h.navn, fra: h.fraDato?.slice(0, 10), til: h.tilDato?.slice(0, 10) })).reverse(),
    },
    roller: tolkAlleRoller(roller),
    avdelinger: (under?._embedded?.underenheter || []).map((u) => ({
      orgnr: u.organisasjonsnummer,
      navn: u.navn,
      adresse: [...(u.beliggenhetsadresse?.adresse || []), [u.beliggenhetsadresse?.postnummer, u.beliggenhetsadresse?.poststed].filter(Boolean).join(' ')].filter(Boolean).join(', '),
      ansatte: u.harRegistrertAntallAnsatte ? u.antallAnsatte ?? 0 : null,
      naering: u.naeringskode1?.beskrivelse || null,
      oppstart: u.oppstartsdato || null,
    })),
    antallAvdelinger: under?.page?.totalElements ?? 0,
    // Utvikling over årene Brreg har (vanligvis tre), selskapsregnskap, eldste først.
    historikk: sortert.filter((x) => x.regnskapstype === 'SELSKAP').reverse().map((x) => ({
      aar: x.regnskapsperiode?.tilDato?.slice(0, 4),
      driftsinntekter: x.resultatregnskapResultat?.driftsresultat?.driftsinntekter?.sumDriftsinntekter ?? null,
      driftsresultat: x.resultatregnskapResultat?.driftsresultat?.driftsresultat ?? null,
      aarsresultat: x.resultatregnskapResultat?.aarsresultat ?? null,
      egenkapital: x.egenkapitalGjeld?.egenkapital?.sumEgenkapital ?? null,
      sumEiendeler: x.eiendeler?.sumEiendeler ?? null,
      sumGjeld: x.egenkapitalGjeld?.gjeldOversikt?.sumGjeld ?? null,
    })),
    regnskap: regn && {
      aar: regn.regnskapsperiode?.tilDato?.slice(0, 4),
      salgsinntekter: res.driftsresultat?.driftsinntekter?.salgsinntekter ?? null,
      loennskostnad: res.driftsresultat?.driftskostnad?.loennskostnad ?? null,
      driftskostnader: res.driftsresultat?.driftskostnad?.sumDriftskostnad ?? null,
      resultatFoerSkatt: res.ordinaertResultatFoerSkattekostnad ?? null,
      skatt: res.ordinaertResultatSkattekostnad ?? null,
      kortsiktigGjeld: regn.egenkapitalGjeld?.gjeldOversikt?.kortsiktigGjeld?.sumKortsiktigGjeld ?? null,
      langsiktigGjeld: regn.egenkapitalGjeld?.gjeldOversikt?.langsiktigGjeld?.sumLangsiktigGjeld ?? null,
      bank: regn.eiendeler?.sumBankinnskuddOgKontanter ?? null,
      omloepsmidler: regn.eiendeler?.omloepsmidler?.sumOmloepsmidler ?? null,
      anleggsmidler: regn.eiendeler?.anleggsmidler?.sumAnleggsmidler ?? null,
      smaaForetak: regn.regnkapsprinsipper?.smaaForetak ?? null,
      regnskapsregler: regn.regnkapsprinsipper?.regnskapsregler || null,
      ikkeRevidert: Boolean(regn.revisjon?.ikkeRevidertAarsregnskap),
      morselskap: Boolean(regn.virksomhet?.morselskap),
      harKonsernregnskap: regnskap.some((x) => x.regnskapstype === 'KONSERN'),
    },
  };
  detaljCache.set(orgnr, { tid: Date.now(), data });
  if (detaljCache.size > 500) detaljCache.delete(detaljCache.keys().next().value);
  return data;
}

module.exports = { kjorSynk, synkStatus, hentDetaljer };
