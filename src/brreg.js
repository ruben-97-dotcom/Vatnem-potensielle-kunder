// Henter selskaper, roller og årsregnskap fra Brønnøysundregistrenes åpne API-er.
const crypto = require('node:crypto');
const db = require('./db');
const { KOMMUNER, ORGANISASJONSFORMER } = require('./config');

const ENHETER_URL = 'https://data.brreg.no/enhetsregisteret/api/enheter';
const REGNSKAP_URL = 'https://data.brreg.no/regnskapsregisteret/regnskap';
const SAMTIDIGE_KALL = 6;

const status = { kjorer: false, fase: null, ferdig: 0, totalt: 0, startet: null, feil: 0 };

const vent = (ms) => new Promise((r) => setTimeout(r, ms));

async function hentJson(url) {
  for (let forsok = 1; ; forsok++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.status === 404) return null;
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

async function synkroniser({ logg = () => {} } = {}) {
  if (status.kjorer) throw new Error('En oppdatering kjører allerede');
  const naa = new Date().toISOString();
  Object.assign(status, { kjorer: true, fase: 'Henter selskaper', ferdig: 0, totalt: KOMMUNER.length, startet: naa, feil: 0 });
  const synkId = db.prepare('INSERT INTO synkroniseringer (startet, status) VALUES (?, ?)').run(naa, 'kjorer').lastInsertRowid;

  try {
    const sett = new Set();
    for (const k of KOMMUNER) {
      const enheter = await hentEnheterForKommune(k.nr);
      db.exec('BEGIN');
      for (const e of enheter) {
        lagreEnhet.run(enhetTilRad(e, naa));
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
      const [roller, regnskap] = await Promise.all([
        hentJson(`${ENHETER_URL}/${orgnr}/roller`),
        hentJson(`${REGNSKAP_URL}/${orgnr}`),
      ]);
      lagreRoller.run({ orgnr, ...tolkRoller(roller) });
      if (roller) {
        const personer = tolkPersonroller(roller);
        db.exec('BEGIN');
        slettPersonroller.run(orgnr);
        for (const p of personer) lagrePersonrolle.run({ orgnr, ...p });
        db.exec('COMMIT');
      }
      const r = tolkRegnskap(regnskap);
      if (r) lagreRegnskap.run({ orgnr, ...r });
      if (status.ferdig % 500 === 0) logg(`${status.ferdig}/${status.totalt}`);
    });

    const melding = status.feil ? `${status.feil} selskaper kunne ikke hentes` : null;
    db.prepare('UPDATE synkroniseringer SET ferdig=?, status=?, melding=?, antall=? WHERE id=?')
      .run(new Date().toISOString(), 'ok', melding, orgnre.length, synkId);
    logg(`Ferdig: ${orgnre.length} selskaper, ${status.feil} feil`);
  } catch (e) {
    db.prepare('UPDATE synkroniseringer SET ferdig=?, status=?, melding=? WHERE id=?')
      .run(new Date().toISOString(), 'feil', e.message, synkId);
    throw e;
  } finally {
    status.kjorer = false;
    status.fase = null;
  }
}

module.exports = { synkroniser, status };
