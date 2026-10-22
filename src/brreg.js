// Henter selskaper, roller og årsregnskap fra Brønnøysundregistrenes åpne API-er.
const crypto = require('node:crypto');
const db = require('./db');
const { KOMMUNER, ORGANISASJONSFORMER, REVISJONSPLIKT } = require('./config');

const ENHETER_URL = 'https://data.brreg.no/enhetsregisteret/api/enheter';
const REGNSKAP_URL = 'https://data.brreg.no/regnskapsregisteret/regnskap';
const SAMTIDIGE_KALL = 6;

const status = { kjorer: false, type: null, fase: null, ferdig: 0, totalt: 0, startet: null, feil: 0 };

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

const lagreEnhet = db.prepare(`
  INSERT INTO selskaper (orgnr, navn, orgform, kommune, kommunenr, adresse, postnr, poststed, nace_kode, nace_tekst,
    ansatte, stiftet, telefon, mobil, epost, hjemmeside, i_konsern, aktiv, oppdatert)
  VALUES (:orgnr, :navn, :orgform, :kommune, :kommunenr, :adresse, :postnr, :poststed, :nace_kode, :nace_tekst,
    :ansatte, :stiftet, :telefon, :mobil, :epost, :hjemmeside, :i_konsern, 1, :oppdatert)
  ON CONFLICT(orgnr) DO UPDATE SET navn=excluded.navn, orgform=excluded.orgform, kommune=excluded.kommune,
    kommunenr=excluded.kommunenr, adresse=excluded.adresse, postnr=excluded.postnr, poststed=excluded.poststed,
    nace_kode=excluded.nace_kode, nace_tekst=excluded.nace_tekst, ansatte=excluded.ansatte, stiftet=excluded.stiftet,
    telefon=excluded.telefon, mobil=excluded.mobil, epost=excluded.epost, hjemmeside=excluded.hjemmeside,
    i_konsern=excluded.i_konsern, aktiv=1, oppdatert=excluded.oppdatert
`);

const lagreRoller = db.prepare(`
  UPDATE selskaper SET daglig_leder=:daglig_leder, styreleder=:styreleder, revisor_navn=:revisor_navn,
    revisor_orgnr=:revisor_orgnr, regnskapsforer_navn=:regnskapsforer_navn, regnskapsforer_orgnr=:regnskapsforer_orgnr,
    roller_hentet=1 WHERE orgnr=:orgnr
`);

const lagreRegnskap = db.prepare(`
  UPDATE selskaper SET regnskap_aar=:regnskap_aar, driftsinntekter=:driftsinntekter, driftsresultat=:driftsresultat,
    aarsresultat=:aarsresultat, egenkapital=:egenkapital, sum_eiendeler=:sum_eiendeler, sum_gjeld=:sum_gjeld,
    fravalg_revisjon=:fravalg_revisjon, regnskap_hentet=1 WHERE orgnr=:orgnr
`);

const slettPersonroller = db.prepare('DELETE FROM personroller WHERE orgnr = ?');
const lagrePersonrolle = db.prepare('INSERT INTO personroller (orgnr, rolle, navn, person_nokkel) VALUES (:orgnr, :rolle, :navn, :person_nokkel)');

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
  const arbeidere = Array.from({ length: antall }, async () => {
    while (i < elementer.length) {
      const el = elementer[i++];
      try {
        await fn(el);
      } catch (e) {
        status.feil++;
        console.error(e.message);
      }
      status.ferdig++;
    }
  });
  await Promise.all(arbeidere);
}

// --- Innstillinger (posisjon i Brregs endringsfeeder) -----------------------
const lesInnstilling = (n) => db.prepare('SELECT verdi FROM innstillinger WHERE nokkel = ?').get(n)?.verdi ?? null;
const settInnstilling = (n, v) => db.prepare(`INSERT INTO innstillinger (nokkel, verdi) VALUES (?, ?)
  ON CONFLICT(nokkel) DO UPDATE SET verdi = excluded.verdi`).run(n, String(v));

// --- Hendelser ---------------------------------------------------------------
const nyHendelse = db.prepare('INSERT INTO hendelser (orgnr, type, tekst, tidspunkt) VALUES (?, ?, ?, ?)');
const hentLagret = db.prepare(`SELECT orgnr, aktiv, roller_hentet, revisor_navn, revisor_orgnr,
  regnskapsforer_navn, regnskapsforer_orgnr FROM selskaper WHERE orgnr = ?`);

function sammenlignRoller(orgnr, gml, ny) {
  const naa = new Date().toISOString();
  const par = [
    ['revisor', 'revisor', 'Revisor'],
    ['regnskapsforer', 'regnskapsfører', 'Regnskapsfører'],
  ];
  for (const [felt, ord, Ord] of par) {
    const fra = gml[`${felt}_orgnr`] || gml[`${felt}_navn`];
    const til = ny[`${felt}_orgnr`] || ny[`${felt}_navn`];
    if (fra === til) continue;
    const fraNavn = gml[`${felt}_navn`];
    const tilNavn = ny[`${felt}_navn`];
    if (fra && !til) nyHendelse.run(orgnr, `${felt}_fratradt`, `${Ord} ${fraNavn} har gått av. Selskapet har ingen ${ord} registrert nå.`, naa);
    else if (!fra && til) nyHendelse.run(orgnr, `${felt}_ny`, `Har fått ny ${ord}: ${tilNavn}`, naa);
    else nyHendelse.run(orgnr, `${felt}_byttet`, `Byttet ${ord} fra ${fraNavn} til ${tilNavn}`, naa);
  }
}

// --- Revisjonsplikt -----------------------------------------------------------
// Samme regel som visningen i server.js: inntekt, balanse eller ansatte over grensen.
const pliktRad = db.prepare(`SELECT orgnr, orgform, driftsinntekter, sum_eiendeler, ansatte, fravalg_revisjon,
  revisor_orgnr, regnskap_hentet, aktiv FROM selskaper WHERE orgnr = ?`);
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
function sjekkPliktOvergang(foer, naa = new Date().toISOString()) {
  if (!foer || !foer.regnskap_hentet) return;
  const etter = pliktRad.get(foer.orgnr);
  if (!etter || !etter.aktiv || etter.revisor_orgnr) return;
  const grunner = pliktGrunner(etter);
  if (pliktGrunner(foer).length === 0 && grunner.length > 0) {
    nyHendelse.run(foer.orgnr, 'revisjonsplikt', `Har passert grensen for revisjonsplikt (${grunner.join(', ')}) og har ingen revisor`, naa);
  }
}

// Et selskap er med i utvalget når det ligger i en av kommunene, har riktig selskapsform og er i drift.
function iUtvalg(e) {
  const kommunenr = (e.forretningsadresse || e.postadresse || {}).kommunenummer;
  return Boolean(e && KOMMUNER.some((k) => k.nr === kommunenr) && ORGANISASJONSFORMER.includes(e.organisasjonsform?.kode) &&
    !e.konkurs && !e.underAvvikling && !e.underTvangsavviklingEllerTvangsopplosning && !e.slettedato);
}

// Lagrer et selskap fra Enhetsregisteret. Returnerer true hvis det er nytt i utvalget.
function lagreEnhetMedVarsel(e, naa, { varsle }) {
  const fantes = hentLagret.get(e.organisasjonsnummer);
  lagreEnhet.run(enhetTilRad(e, naa));
  if (fantes) return !fantes.aktiv;
  if (varsle) {
    const registrert = e.registreringsdatoEnhetsregisteret || e.stiftelsesdato;
    const erNytt = registrert && Date.now() - new Date(registrert).getTime() < 180 * 24 * 60 * 60 * 1000;
    nyHendelse.run(e.organisasjonsnummer, erNytt ? 'nytt_selskap' : 'flyttet_inn',
      erNytt ? `Nytt selskap registrert ${registrert}${e.naeringskode1 ? ' – ' + e.naeringskode1.beskrivelse : ''}`
        : 'Nytt i området (flyttet hit eller endret selskapsform)', naa);
  }
  return true;
}

// Henter roller (og eventuelt regnskap) for ett selskap og lager hendelser ved revisor-/regnskapsførerbytte.
async function oppdaterRollerOgRegnskap(orgnr, { regnskap = true, varsle = true } = {}) {
  const [roller, regnskapData] = await Promise.all([
    hentJson(`${ENHETER_URL}/${orgnr}/roller`),
    regnskap ? hentJson(`${REGNSKAP_URL}/${orgnr}`) : Promise.resolve(undefined),
  ]);
  if (roller) {
    const gml = hentLagret.get(orgnr);
    const ny = tolkRoller(roller);
    const personer = tolkPersonroller(roller);
    db.exec('BEGIN');
    if (varsle && gml?.roller_hentet) sammenlignRoller(orgnr, gml, ny);
    lagreRoller.run({ orgnr, ...ny });
    slettPersonroller.run(orgnr);
    for (const p of personer) lagrePersonrolle.run({ orgnr, ...p });
    db.exec('COMMIT');
  }
  if (regnskap) {
    const r = tolkRegnskap(regnskapData);
    if (r) lagreRegnskap.run({ orgnr, ...r });
  }
}

function startJobb(type, fase, totalt) {
  if (status.kjorer) throw new Error('En oppdatering kjører allerede');
  const naa = new Date().toISOString();
  Object.assign(status, { kjorer: true, type, fase, ferdig: 0, totalt, startet: naa, feil: 0 });
  const id = db.prepare('INSERT INTO synkroniseringer (startet, status, type) VALUES (?, ?, ?)').run(naa, 'kjorer', type).lastInsertRowid;
  return { id, naa };
}

function avsluttJobb(id, { ok, melding = null, antall = null }) {
  db.prepare('UPDATE synkroniseringer SET ferdig=?, status=?, melding=?, antall=? WHERE id=?')
    .run(new Date().toISOString(), ok ? 'ok' : 'feil', melding, antall, id);
  status.kjorer = false;
  status.fase = null;
}

// --- Full oppdatering: alle selskaper, roller og regnskap ---------------------
async function synkroniser({ logg = () => {} } = {}) {
  const { id: synkId, naa } = startJobb('full', 'Henter selskaper', KOMMUNER.length);
  // Ved aller første henting lages det ikke varsler for alle selskapene.
  const varsle = db.prepare('SELECT COUNT(*) n FROM selskaper').get().n > 0;
  // Øyeblikksbilde for å oppdage selskaper som passerer grensen for revisjonsplikt.
  const foerPlikt = db.prepare(`SELECT orgnr, orgform, driftsinntekter, sum_eiendeler, ansatte, fravalg_revisjon,
    revisor_orgnr, regnskap_hentet, aktiv FROM selskaper WHERE aktiv = 1`).all();
  try {
    // Feedposisjonene settes før hentingen, så ingen endringer underveis går tapt.
    if (!lesInnstilling('enheter_fra_dato') && !lesInnstilling('enheter_oppdateringsid')) settInnstilling('enheter_fra_dato', naa);
    if (!lesInnstilling('roller_fra_tid') && !lesInnstilling('roller_etter_id')) settInnstilling('roller_fra_tid', naa);

    const sett = new Set();
    for (const k of KOMMUNER) {
      const enheter = await hentEnheterForKommune(k.nr);
      db.exec('BEGIN');
      for (const e of enheter) {
        lagreEnhetMedVarsel(e, naa, { varsle });
        sett.add(e.organisasjonsnummer);
      }
      db.exec('COMMIT');
      status.ferdig++;
      logg(`${k.navn}: ${enheter.length} selskaper`);
    }

    // Selskaper som ikke lenger finnes i utvalget (slettet, konkurs, flyttet) skjules, men oppfølgingen beholdes.
    const alle = db.prepare('SELECT orgnr FROM selskaper WHERE aktiv = 1').all();
    const deaktiver = db.prepare('UPDATE selskaper SET aktiv = 0 WHERE orgnr = ?');
    for (const { orgnr } of alle) if (!sett.has(orgnr)) deaktiver.run(orgnr);

    const orgnre = [...sett];
    Object.assign(status, { fase: 'Henter roller og regnskap', ferdig: 0, totalt: orgnre.length });
    await iParallell(orgnre, SAMTIDIGE_KALL, async (orgnr) => {
      await oppdaterRollerOgRegnskap(orgnr, { varsle });
      if (status.ferdig % 500 === 0) logg(`${status.ferdig}/${status.totalt}`);
    });

    if (varsle) for (const r of foerPlikt) sjekkPliktOvergang(r);

    const melding = status.feil ? `${status.feil} selskaper kunne ikke hentes` : null;
    avsluttJobb(synkId, { ok: true, melding, antall: orgnre.length });
    logg(`Ferdig: ${orgnre.length} selskaper, ${status.feil} feil`);
  } catch (e) {
    avsluttJobb(synkId, { ok: false, melding: e.message });
    throw e;
  }
}

// --- Hyppig oppdatering: bare selskaper som er endret i Brreg siden sist ------
async function hentEndredeEnheter() {
  const endret = new Map();
  let id = lesInnstilling('enheter_oppdateringsid');
  const fraDato = lesInnstilling('enheter_fra_dato');
  for (let runde = 0; runde < 200; runde++) {
    const url = id
      ? `${ENHETER_URL.replace('/enheter', '/oppdateringer/enheter')}?oppdateringsid=${id}&size=1000`
      : `${ENHETER_URL.replace('/enheter', '/oppdateringer/enheter')}?dato=${encodeURIComponent(fraDato)}&size=1000`;
    const data = await hentJson(url);
    const liste = data?._embedded?.oppdaterteEnheter || [];
    for (const o of liste) endret.set(o.organisasjonsnummer, o.endringstype);
    if (liste.length) id = String(liste.at(-1).oppdateringsid + 1);
    if (liste.length < 1000) break;
  }
  return { endret, nesteId: id };
}

async function hentEndredeRoller() {
  const endret = new Set();
  let etterId = lesInnstilling('roller_etter_id');
  const fraTid = lesInnstilling('roller_fra_tid');
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

async function synkEndringer({ logg = () => {} } = {}) {
  if (!lesInnstilling('enheter_fra_dato') && !lesInnstilling('enheter_oppdateringsid')) {
    // Ingen feedposisjon ennå: start fra siste fullstendige henting, eller gjør en full henting.
    const siste = db.prepare("SELECT startet FROM synkroniseringer WHERE status = 'ok' AND COALESCE(type, 'full') = 'full' ORDER BY id DESC LIMIT 1").get();
    if (!siste) return synkroniser({ logg });
    settInnstilling('enheter_fra_dato', siste.startet);
    settInnstilling('roller_fra_tid', siste.startet);
  }
  const { id: synkId, naa } = startJobb('endringer', 'Sjekker endringer i Brreg', 0);
  try {
    const [enheter, roller] = await Promise.all([hentEndredeEnheter(), hentEndredeRoller()]);
    const lagret = new Set(db.prepare('SELECT orgnr FROM selskaper').all().map((r) => r.orgnr));
    const aktive = new Set(db.prepare('SELECT orgnr FROM selskaper WHERE aktiv = 1').all().map((r) => r.orgnr));

    // Endrede selskaper: de vi har, og alle nye/endrede som kan ha flyttet inn i området.
    const sjekkEnheter = [...enheter.endret].filter(([orgnr, type]) => lagret.has(orgnr) || type !== 'Sletting').map(([o]) => o);
    const rollerIgjen = new Set([...roller.endret].filter((o) => aktive.has(o)));
    Object.assign(status, { fase: 'Oppdaterer endrede selskaper', totalt: sjekkEnheter.length + rollerIgjen.size });
    let nye = 0;

    await iParallell(sjekkEnheter, SAMTIDIGE_KALL, async (orgnr) => {
      const e = await hentJson(`${ENHETER_URL}/${orgnr}`);
      if (!e || !iUtvalg(e)) {
        if (aktive.has(orgnr)) db.prepare('UPDATE selskaper SET aktiv = 0 WHERE orgnr = ?').run(orgnr);
        return;
      }
      const foer = pliktRad.get(orgnr);
      const erNy = lagreEnhetMedVarsel(e, naa, { varsle: true });
      if (erNy) nye++;
      if (erNy || rollerIgjen.has(orgnr)) {
        rollerIgjen.delete(orgnr);
        await oppdaterRollerOgRegnskap(orgnr, { regnskap: erNy });
      }
      sjekkPliktOvergang(foer);
    });
    await iParallell([...rollerIgjen], SAMTIDIGE_KALL, (orgnr) => oppdaterRollerOgRegnskap(orgnr, { regnskap: false }));

    if (enheter.nesteId) settInnstilling('enheter_oppdateringsid', enheter.nesteId);
    if (roller.etterId) settInnstilling('roller_etter_id', roller.etterId);
    const antall = sjekkEnheter.length + rollerIgjen.size;
    avsluttJobb(synkId, { ok: true, antall, melding: status.feil ? `${status.feil} feil` : null });
    logg(`Endringer: ${enheter.endret.size} i hele landet, ${antall} sjekket, ${nye} nye i området`);
  } catch (e) {
    avsluttJobb(synkId, { ok: false, melding: e.message });
    throw e;
  }
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

module.exports = { synkroniser, synkEndringer, hentDetaljer, status };
