'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const tilstand = {
  meg: null,
  meta: null,
  fane: 'oversikt',
  side: 0,
  sorter: 'poeng',
  retning: 'desc',
  apentOrgnr: null,
};

// --- Hjelpere -------------------------------------------------------------
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const nf = new Intl.NumberFormat('nb-NO');
function kr(v, kort = true) {
  if (v === null || v === undefined) return '<span class="tom">–</span>';
  if (!kort) return nf.format(Math.round(v)) + ' kr';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toLocaleString('nb-NO', { maximumFractionDigits: 1 }) + ' mrd';
  if (a >= 1e6) return (v / 1e6).toLocaleString('nb-NO', { maximumFractionDigits: 1 }) + ' mill';
  if (a >= 1e3) return Math.round(v / 1e3).toLocaleString('nb-NO') + ' k';
  return nf.format(Math.round(v));
}
function ekCelle(v) {
  if (v === null || v === undefined) return '<span class="tom">–</span>';
  return `<span class="${v > 0 ? 'pos' : 'neg'}">${kr(v)}</span>`;
}
function dato(iso, medTid = false) {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
  return d.toLocaleDateString('nb-NO', { day: 'numeric', month: 'short', year: 'numeric' }) +
    (medTid ? ' ' + d.toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' }) : '');
}
const statusInfo = (kode) => tilstand.meta.statuser.find((s) => s.kode === kode) || { navn: kode, farge: 'gray' };
const statusMerke = (kode) => { const s = statusInfo(kode); return `<span class="merkelapp m-${s.farge}">${esc(s.navn)}</span>`; };

let meldingTimer;
function melding(tekst) {
  const el = $('#melding');
  el.textContent = tekst;
  el.hidden = false;
  clearTimeout(meldingTimer);
  meldingTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

async function api(url, valg = {}) {
  const res = await fetch(url, {
    ...valg,
    headers: { 'Content-Type': 'application/json', ...(valg.headers || {}) },
    body: valg.body ? JSON.stringify(valg.body) : undefined,
  });
  if (res.status === 401 && !url.endsWith('/logg-inn')) {
    visInnlogging();
    throw new Error('Ikke innlogget');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.feil || 'Noe gikk galt');
  return data;
}

// --- Innlogging -------------------------------------------------------------
function visInnlogging() {
  $('#portal').hidden = true;
  $('#innlogging').hidden = false;
  $('#kode').value = '';
  $('#kode').focus();
}

$('#kode').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  if (e.target.value.length === 6) $('#innlogging-skjema').requestSubmit();
});

$('#innlogging-skjema').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#innlogging-feil').textContent = '';
  try {
    await api('/api/logg-inn', { method: 'POST', body: { kode: $('#kode').value } });
    await start();
  } catch (err) {
    $('#innlogging-feil').textContent = err.message;
    $('#kode').value = '';
    $('#kode').focus();
  }
});

$('#logg-ut').addEventListener('click', async () => {
  await api('/api/logg-ut', { method: 'POST' }).catch(() => {});
  visInnlogging();
});

// --- Oppstart ---------------------------------------------------------------
async function start() {
  try {
    tilstand.meg = await api('/api/meg');
  } catch {
    return visInnlogging();
  }
  tilstand.meta = await api('/api/meta');
  visVarselTeller(tilstand.meta.ulesteVarsler);
  $('#innlogging').hidden = true;
  $('#portal').hidden = false;
  $('#bruker-navn').textContent = tilstand.meg.navn;
  fyllFilterValg();
  lastFilter();
  byttFane(location.hash.slice(1) || 'oversikt');
}

function fyllFilterValg() {
  const m = tilstand.meta;
  const f = $('#filter');
  f.kommune.length = 1;
  for (const k of m.kommuner) f.kommune.add(new Option(`${k.navn} (${k.antall})`, k.nr));
  f.status.length = 1;
  for (const s of m.statuser) f.status.add(new Option(s.navn, s.kode));
  f.ansvarlig.length = 3;
  for (const b of m.brukere) f.ansvarlig.add(new Option(b.navn, b.id));
}

// --- Faner ------------------------------------------------------------------
function byttFane(fane) {
  if (!['oversikt', 'selskaper', 'varsler', 'plikt', 'revisorer'].includes(fane)) fane = 'oversikt';
  tilstand.fane = fane;
  history.replaceState(null, '', '#' + fane);
  for (const b of $$('.fane')) b.classList.toggle('aktiv', b.dataset.fane === fane);
  for (const s of $$('.fane-innhold')) s.hidden = s.id !== 'fane-' + fane;
  if (fane === 'oversikt') lastOversikt();
  if (fane === 'selskaper') lastListe();
  if (fane === 'revisorer') lastRevisorer();
  if (fane === 'varsler') lastVarsler();
  if (fane === 'plikt') lastPlikt();
}
$$('[data-gaa]').forEach((b) => b.addEventListener('click', () => byttFane(b.dataset.gaa)));

function visVarselTeller(n) {
  const el = $('#varsel-teller');
  el.hidden = !n;
  el.textContent = n > 99 ? '99+' : String(n || '');
}
for (const b of $$('.fane')) b.addEventListener('click', () => byttFane(b.dataset.fane));

// --- Oversikt ---------------------------------------------------------------
async function lastOversikt() {
  const [o, meta] = await Promise.all([api('/api/oversikt'), api('/api/meta')]);
  tilstand.meta = meta;
  const kontaktet = o.totalt - (o.perStatus.ny || 0);
  const iDialog = (o.perStatus.interessert || 0) + (o.perStatus.mote || 0) + (o.perStatus.tilbud || 0);
  const kpi = [
    ['Potensielle kunder', o.totalt, {}],
    ['Positiv egenkapital', o.ek_positiv, { ek: 'positiv' }],
    ['Ringt', o.ringt, { ringt: 'ja' }],
    ['I dialog', iDialog, { status: 'interessert,mote,tilbud' }],
    ['Kunder vunnet', o.perStatus.vunnet || 0, { status: 'vunnet' }],
    ['Mine forfalte oppfølginger', o.forfalt, { ansvarlig: 'meg', oppfolging: 'forfalt' }, o.forfalt > 0],
    ['Nye varsler', o.ulesteVarsler, 'varsler', o.ulesteVarsler > 0],
    ['Nye selskaper siste 30 dager', o.nyeSiste30, { nye: '30', sorter: 'stiftet' }],
    ['Revisjonspliktige uten revisor', o.naerPlikt?.over_uten, 'plikt'],
    ['Nær grensen for revisjonsplikt', o.naerPlikt?.naer, 'plikt'],
  ];
  $('#kpi').innerHTML = kpi.map(([t, v, f, varsel], i) =>
    `<button class="kpi${varsel ? ' varsel' : ''}" data-i="${i}"><div class="kpi-tall">${nf.format(v || 0)}</div><div class="kpi-tekst">${esc(t)}</div></button>`).join('');
  $$('#kpi .kpi').forEach((el) => el.addEventListener('click', () => {
    const mal = kpi[el.dataset.i][2];
    if (typeof mal === 'string') byttFane(mal); else visListeMed(mal);
  }));
  visVarselTeller(o.ulesteVarsler);

  $('#siste-varsler').innerHTML = o.sisteVarsler.length
    ? o.sisteVarsler.map((h) => `<li>
        ${varselMerke(h.type)} <button class="lenke-knapp" data-orgnr="${esc(h.orgnr)}">${esc(h.navn)}</button>
        <div>${esc(h.tekst)}</div>
        <div class="aktivitet-meta">${dato(h.tidspunkt, true)}</div></li>`).join('')
    : '<li class="dempet">Ingen varsler ennå. Portalen sjekker Brreg jevnlig og varsler her når noe skjer.</li>';
  $$('#siste-varsler [data-orgnr]').forEach((el) => el.addEventListener('click', () => apnePanel(el.dataset.orgnr)));

  const maks = Math.max(1, ...meta.statuser.map((s) => o.perStatus[s.kode] || 0));
  $('#trakt').innerHTML = meta.statuser.map((s) => {
    const n = o.perStatus[s.kode] || 0;
    return `<button class="trakt-rad" data-status="${s.kode}">
      <span class="trakt-navn">${esc(s.navn)}</span>
      <span class="trakt-spor"><span class="trakt-fyll" data-bredde="${(n / maks) * 100}"></span></span>
      <span class="trakt-tall">${nf.format(n)}</span></button>`;
  }).join('') + `<p class="dempet">${nf.format(kontaktet)} av ${nf.format(o.totalt)} er tatt kontakt med. ${nf.format(o.kunder)} selskaper har Vatnem som revisor allerede og er holdt utenfor.</p>`;
  $$('#trakt .trakt-fyll').forEach((el) => { el.style.width = el.dataset.bredde + '%'; });
  $$('#trakt .trakt-rad').forEach((el) => el.addEventListener('click', () => visListeMed({ status: el.dataset.status })));

  $('#siste-aktivitet').innerHTML = o.sisteAktivitet.length
    ? o.sisteAktivitet.map((a) => `<li>
        <button class="lenke-knapp" data-orgnr="${esc(a.orgnr)}">${esc(a.selskap || a.orgnr)}</button>
        <div>${esc(a.tekst.length > 140 ? a.tekst.slice(0, 140) + '…' : a.tekst)}</div>
        <div class="aktivitet-meta">${esc(a.bruker || '')} · ${dato(a.opprettet, true)}</div></li>`).join('')
    : '<li class="dempet">Ingen aktivitet ennå. Start med ringelisten!</li>';
  $$('#siste-aktivitet [data-orgnr]').forEach((el) => el.addEventListener('click', () => apnePanel(el.dataset.orgnr)));

  visSynk(meta.synk);
}

function visSynk(s) {
  const knapper = [$('#synk-knapp'), $('#synk-full-knapp')];
  if (s.kjorer) {
    $('#synk-info').textContent = `Oppdaterer nå: ${s.fase}${s.totalt ? ` (${nf.format(s.ferdig)} av ${nf.format(s.totalt)})` : ''}…`;
    knapper.forEach((k) => { k.disabled = true; });
    setTimeout(async () => { if (tilstand.fane === 'oversikt') visSynk((await api('/api/meta')).synk); }, 3000);
    return;
  }
  knapper.forEach((k) => { k.disabled = false; });
  const full = s.siste;
  const endr = s.sisteEndringer;
  const deler = [];
  if (endr) deler.push(`Sist sjekket for endringer ${dato(endr.ferdig, true)}${endr.status === 'feil' ? ` (feilet: ${endr.melding})` : ''}. Sjekkes automatisk hvert ${s.intervallMin}. minutt.`);
  if (full) deler.push(`Siste fulle oppdatering ${dato(full.ferdig, true)}: ${nf.format(full.antall || 0)} selskaper (AS, ASA, SA og stiftelser) i ${tilstand.meta.kommuner.length} kommuner. Kjøres automatisk hver uke.`);
  $('#synk-info').textContent = deler.join(' ') || 'Data er ikke hentet ennå.';
}

async function startSynk(type) {
  try {
    await api('/api/synk', { method: 'POST', body: { type } });
    melding(type === 'full' ? 'Full oppdatering startet. Det tar et par minutter.' : 'Sjekker Brreg for endringer…');
    visSynk((await api('/api/meta')).synk);
  } catch (e) { melding(e.message); }
}
$('#synk-knapp').addEventListener('click', () => startSynk('endringer'));
$('#synk-full-knapp').addEventListener('click', () => startSynk('full'));

// --- Varsler ----------------------------------------------------------------
const VARSELTYPER = {
  revisor_fratradt: ['Revisor gått av', 'red'],
  revisor_byttet: ['Revisorbytte', 'amber'],
  revisor_ny: ['Ny revisor', 'gray'],
  regnskapsforer_fratradt: ['Regnskapsfører gått av', 'amber'],
  regnskapsforer_byttet: ['Regnskapsførerbytte', 'gray'],
  regnskapsforer_ny: ['Ny regnskapsfører', 'gray'],
  nytt_selskap: ['Nytt selskap', 'green'],
  flyttet_inn: ['Nytt i området', 'blue'],
  revisjonsplikt: ['Passert revisjonsplikt', 'violet'],
};
function varselMerke(type) {
  const [t, f] = VARSELTYPER[type] || [type, 'gray'];
  return `<span class="merkelapp m-${f}">${esc(t)}</span>`;
}

const varselTilstand = { type: '', side: 0 };
$$('#varsel-filter .chip').forEach((c) => c.addEventListener('click', () => {
  $$('#varsel-filter .chip').forEach((x) => x.classList.toggle('aktiv', x === c));
  varselTilstand.type = c.dataset.type;
  varselTilstand.side = 0;
  lastVarsler();
}));

function statusCeller(r) {
  const statusValg = tilstand.meta.statuser.map((s) => `<option value="${s.kode}" ${s.kode === r.status ? 'selected' : ''}>${esc(s.navn)}</option>`).join('');
  return `<td>${r.er_kunde ? '<span class="merkelapp m-green">Vatnem-kunde</span>' : `<select class="status-velger" data-handling="status" aria-label="Status">${statusValg}</select>`}</td>
    <td class="smal"><input type="checkbox" data-handling="ringt" ${r.ringt ? 'checked' : ''} aria-label="Ringt"></td>`;
}

function sideknapper(el, data, last) {
  const sider = Math.max(1, Math.ceil(data.totalt / data.perSide));
  el.innerHTML = `<button class="knapp liten" data-side="${data.side - 1}" ${data.side <= 0 ? 'disabled' : ''}>‹ Forrige</button>
    <span class="dempet">Side ${data.side + 1} av ${sider}</span>
    <button class="knapp liten" data-side="${data.side + 1}" ${data.side + 1 >= sider ? 'disabled' : ''}>Neste ›</button>`;
  $$('[data-side]', el).forEach((b) => b.addEventListener('click', () => { last(Number(b.dataset.side)); window.scrollTo(0, 0); }));
}

async function lastVarsler() {
  const p = new URLSearchParams({ type: varselTilstand.type, side: varselTilstand.side });
  const data = await api('/api/hendelser?' + p);
  $('#varsel-antall').textContent = `${nf.format(data.totalt)} varsler`;
  sideknapper($('#varsel-sider'), data, (s) => { varselTilstand.side = s; lastVarsler(); });
  $('#varsel-rader').innerHTML = data.rader.length ? data.rader.map((r) => `
    <tr data-orgnr="${r.orgnr}" class="${r.ny ? 'er-ny' : ''} ${r.ringt ? 'er-ringt' : ''}">
      <td class="ingen-brudd">${dato(r.tidspunkt, true)}${r.ny ? ' <span class="merkelapp m-blue liten-merke">Ny</span>' : ''}</td>
      <td>${varselMerke(r.type)}<div class="under varsel-tekst">${esc(r.tekst)}</div></td>
      <td><div class="selskap-navn">${esc(r.navn)}</div><div class="under">${esc(r.orgnr)} · ${esc(r.orgform)}${r.nace_tekst ? ' · ' + esc(r.nace_tekst) : ''}</div></td>
      <td>${esc(r.kommune)}</td>
      <td class="tall">${kr(r.driftsinntekter)}</td>
      <td class="tall">${ekCelle(r.egenkapital)}</td>
      ${statusCeller(r)}
    </tr>`).join('') : '<tr><td colspan="8" class="tom-liste">Ingen varsler ennå. Portalen sjekker Brreg jevnlig, og nye hendelser dukker opp her.</td></tr>';
  // Varslene regnes som sett når fanen er åpnet.
  if (data.rader.some((r) => r.ny)) {
    await api('/api/hendelser/sett', { method: 'POST' }).catch(() => {});
    visVarselTeller(0);
  }
}

// --- Revisjonsplikt -----------------------------------------------------------
const pliktTilstand = { plikt: 'alle', side: 0 };
$$('#plikt-filter .chip').forEach((c) => c.addEventListener('click', () => {
  $$('#plikt-filter .chip').forEach((x) => x.classList.toggle('aktiv', x === c));
  pliktTilstand.plikt = c.dataset.plikt;
  pliktTilstand.side = 0;
  lastPlikt();
}));

function grenseStolpe(verdi, grense, tekst) {
  if (verdi === null || verdi === undefined) return '<span class="tom">–</span>';
  const andel = verdi / grense;
  const klasse = andel >= 1 ? 'over' : andel >= 0.7 ? 'naer' : '';
  return `<div class="grense"><div class="grense-tekst">${tekst} <span class="dempet">${Math.round(andel * 100)} %</span></div>
    <div class="grense-spor"><div class="grense-fyll ${klasse}" data-bredde="${Math.min(100, andel * 100)}"></div></div></div>`;
}

async function lastPlikt() {
  const g = tilstand.meta.revisjonsplikt;
  $('#plikt-forklaring').textContent = `Et AS kan bare velge bort revisjon når driftsinntektene er under ${kr(g.driftsinntekter).replace(/<[^>]+>/g, '')}, balansen under ${kr(g.sumEiendeler).replace(/<[^>]+>/g, '')} og det har færre enn ${g.ansatte} årsverk. Listen viser selskaper uten revisor som er over en av grensene, eller over 70 % av den. Antall ansatte i registeret er personer, ikke årsverk, så det er et estimat. Du får et varsel når et selskap passerer grensen.`;
  const p = new URLSearchParams({ plikt: pliktTilstand.plikt, side: pliktTilstand.side, sorter: 'plikt', retning: 'desc' });
  const data = await api('/api/selskaper?' + p);
  $('#plikt-antall').textContent = `${nf.format(data.totalt)} selskaper`;
  sideknapper($('#plikt-sider'), data, (s) => { pliktTilstand.side = s; lastPlikt(); });
  $('#plikt-rader').innerHTML = data.rader.length ? data.rader.map((r) => `
    <tr data-orgnr="${r.orgnr}" class="${r.ringt ? 'er-ringt' : ''}">
      <td><div class="selskap-navn">${esc(r.navn)}</div><div class="under">${esc(r.orgnr)} · ${esc(r.orgform)}${r.nace_tekst ? ' · ' + esc(r.nace_tekst) : ''}</div>${tilknytningMerke(r)}</td>
      <td>${esc(r.kommune)}</td>
      <td>${grenseStolpe(r.driftsinntekter, g.driftsinntekter, kr(r.driftsinntekter))}</td>
      <td>${grenseStolpe(r.sum_eiendeler, g.sumEiendeler, kr(r.sum_eiendeler))}</td>
      <td class="tall">${r.ansatte ?? '<span class="tom">–</span>'}</td>
      <td>${r.revisjonspliktig ? '<span class="merkelapp m-violet">Over grensen</span>' : '<span class="merkelapp m-amber">Nær grensen</span>'}${r.fravalg_revisjon ? '<div class="under">Har valgt bort revisjon</div>' : ''}</td>
      <td class="celle-person" title="${esc(r.regnskapsforer_navn || '')}">${esc(r.regnskapsforer_navn) || '<span class="tom">Ingen registrert</span>'}</td>
      ${statusCeller(r)}
    </tr>`).join('') : '<tr><td colspan="9" class="tom-liste">Ingen selskaper i denne kategorien.</td></tr>';
  $$('#plikt-rader .grense-fyll').forEach((el) => { el.style.width = el.dataset.bredde + '%'; });
}

const SNARVEIER = {
  'ringeliste': { ringt: 'nei', ek: 'positiv', status: 'ny', tilknyttet: 'ukontaktet', sorter: 'poeng' },
  'mine-forfalte': { ansvarlig: 'meg', oppfolging: 'forfalt', sorter: 'oppfolging', retning: 'asc' },
  'plikt-uten': { revisor: 'plikt_uten', sorter: 'driftsinntekter' },
  'har-revisor': { revisor: 'har', ek: 'positiv', sorter: 'poeng' },
  'prioritert': { prioritet: '1' },
  'kunder': { kunder: 'kun', sorter: 'driftsinntekter' },
  'nye': { nye: '90', sorter: 'stiftet' },
};
$$('[data-snarvei]').forEach((b) => b.addEventListener('click', () => visListeMed(SNARVEIER[b.dataset.snarvei])));

function visListeMed(filter) {
  const f = $('#filter');
  f.reset();
  const { sorter = 'poeng', retning = 'desc', ...rest } = filter;
  for (const [k, v] of Object.entries(rest)) {
    const el = f.elements[k];
    if (!el) continue;
    if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === v)) el.add(new Option(statusTekstFor(k, v), v));
    el.value = v;
  }
  tilstand.sorter = sorter;
  tilstand.retning = retning;
  tilstand.side = 0;
  lagreFilter();
  byttFane('selskaper');
}
function statusTekstFor(felt, verdi) {
  if (felt === 'status') return verdi.split(',').map((k) => statusInfo(k).navn).join(' / ');
  if (felt === 'revisor') return 'Valgt revisor';
  return verdi;
}

// --- Liste ------------------------------------------------------------------
function filterVerdier() {
  const f = new FormData($('#filter'));
  const p = {};
  for (const [k, v] of f.entries()) if (v) p[k] = v;
  return p;
}
function lagreFilter() {
  try { localStorage.setItem('filter', JSON.stringify({ f: filterVerdier(), sorter: tilstand.sorter, retning: tilstand.retning })); } catch {}
}
function lastFilter() {
  try {
    const lagret = JSON.parse(localStorage.getItem('filter') || 'null');
    if (!lagret) return;
    const f = $('#filter');
    for (const [k, v] of Object.entries(lagret.f || {})) {
      const el = f.elements[k];
      if (!el) continue;
      if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === v)) el.add(new Option(statusTekstFor(k, v), v));
      el.value = v;
    }
    tilstand.sorter = lagret.sorter || 'poeng';
    tilstand.retning = lagret.retning || 'desc';
  } catch {}
}

let sokTimer;
$('#filter').addEventListener('input', (e) => {
  clearTimeout(sokTimer);
  const vent = e.target.type === 'search' ? 300 : 0;
  sokTimer = setTimeout(() => { tilstand.side = 0; lagreFilter(); lastListe(); }, vent);
});
$('#filter').addEventListener('submit', (e) => e.preventDefault());
$('#nullstill').addEventListener('click', () => {
  $('#filter').reset();
  tilstand.side = 0; tilstand.sorter = 'poeng'; tilstand.retning = 'desc';
  lagreFilter(); lastListe();
});
$('#eksport').addEventListener('click', () => {
  const p = new URLSearchParams(filterVerdier());
  location.href = '/api/eksport.csv?' + p;
});

$$('th[data-sorter]').forEach((th) => th.addEventListener('click', () => {
  const k = th.dataset.sorter;
  if (tilstand.sorter === k) tilstand.retning = tilstand.retning === 'desc' ? 'asc' : 'desc';
  else { tilstand.sorter = k; tilstand.retning = ['navn', 'kommune', 'revisor', 'regnskapsforer', 'status', 'oppfolging'].includes(k) ? 'asc' : 'desc'; }
  tilstand.side = 0;
  lagreFilter(); lastListe();
}));

function tilknytningMerke(r) {
  if (!r.tilknyttede) return '';
  if (r.tilknyttede_kontaktet) {
    return `<span class="merkelapp m-amber liten-merke" title="Et selskap med samme person i ledelsen/styret er allerede kontaktet eller er kunde">⚠ ${r.tilknyttede_kontaktet} tilknyttet kontaktet</span>`;
  }
  return `<span class="merkelapp m-gray liten-merke" title="Selskaper med samme person i ledelsen/styret">🔗 ${r.tilknyttede} tilknyttede</span>`;
}

let listeForesporsel = 0;
async function lastListe() {
  const nr = ++listeForesporsel;
  const p = new URLSearchParams({ ...filterVerdier(), side: tilstand.side, sorter: tilstand.sorter, retning: tilstand.retning });
  const data = await api('/api/selskaper?' + p);
  if (nr !== listeForesporsel) return;

  $$('th[data-sorter]').forEach((th) => {
    th.classList.toggle('sortert', th.dataset.sorter === tilstand.sorter);
    th.classList.toggle('asc', th.dataset.sorter === tilstand.sorter && tilstand.retning === 'asc');
  });

  $('#antall').textContent = `${nf.format(data.totalt)} selskaper`;
  const sider = Math.max(1, Math.ceil(data.totalt / data.perSide));
  $('#sider').innerHTML = `<button class="knapp liten" data-side="${data.side - 1}" ${data.side <= 0 ? 'disabled' : ''}>‹ Forrige</button>
    <span class="dempet">Side ${data.side + 1} av ${sider}</span>
    <button class="knapp liten" data-side="${data.side + 1}" ${data.side + 1 >= sider ? 'disabled' : ''}>Neste ›</button>`;
  $$('#sider [data-side]').forEach((b) => b.addEventListener('click', () => { tilstand.side = Number(b.dataset.side); lastListe(); window.scrollTo(0, 0); }));

  const statusValg = tilstand.meta.statuser.map((s) => `<option value="${s.kode}">${esc(s.navn)}</option>`).join('');
  $('#rader').innerHTML = data.rader.length ? data.rader.map((r) => `
    <tr data-orgnr="${r.orgnr}" class="${r.ringt ? 'er-ringt' : ''}">
      <td class="smal"><button class="stjerne ${r.prioritet ? 'pa' : ''}" data-handling="prioritet" title="Prioriter" aria-label="Prioriter">★</button></td>
      <td><div class="selskap-navn">${esc(r.navn)}</div><div class="under">${esc(r.orgnr)} · ${esc(r.orgform)}${r.nace_tekst ? ' · ' + esc(r.nace_tekst) : ''}</div>${tilknytningMerke(r)}</td>
      <td>${esc(r.kommune)}</td>
      <td class="celle-person"><div>${esc(r.daglig_leder) || '<span class="tom">–</span>'}${r.dl_telefon ? ` <span class="dempet">📞 ${esc(r.dl_telefon)}</span>` : ''}</div><div class="under">${r.styreleder ? 'Styreleder: ' + esc(r.styreleder) : ''}${r.sl_telefon ? ' · 📞 ' + esc(r.sl_telefon) : ''}</div></td>
      <td class="celle-person">${r.revisor_navn ? esc(r.revisor_navn) : r.fravalg_revisjon ? '<span class="dempet">Valgt bort</span>' : r.revisjonspliktig ? '<span class="merkelapp m-amber">Ingen – pliktig?</span>' : '<span class="tom">Ingen</span>'}</td>
      <td class="celle-person" title="${esc(r.regnskapsforer_navn || '')}">${esc(r.regnskapsforer_navn) || '<span class="tom">Ingen registrert</span>'}</td>
      <td class="tall">${kr(r.driftsinntekter)}${r.regnskap_aar && r.regnskap_aar !== tilstand.meta.sisteRegnskapsaar ? `<div class="under">${r.regnskap_aar}</div>` : ''}</td>
      <td class="tall">${ekCelle(r.egenkapital)}</td>
      <td class="tall">${kr(r.sum_eiendeler)}</td>
      <td class="tall">${kr(r.sum_gjeld)}</td>
      <td class="tall">${r.ansatte ?? '<span class="tom">–</span>'}</td>
      <td><select class="status-velger" data-handling="status" aria-label="Status">${statusValg}</select></td>
      <td class="smal"><input type="checkbox" data-handling="ringt" ${r.ringt ? 'checked' : ''} aria-label="Ringt"></td>
      <td class="tall"><span class="poeng ${r.poeng >= 70 ? 'hoy' : r.poeng >= 45 ? 'mid' : ''}">${r.poeng}</span></td>
    </tr>`).join('') : '<tr><td colspan="14" class="tom-liste">Ingen selskaper passer filteret.</td></tr>';

  for (const tr of $$('#rader tr[data-orgnr]')) {
    const r = data.rader.find((x) => x.orgnr === tr.dataset.orgnr);
    $('[data-handling="status"]', tr).value = r.status;
  }
}

// Felles for alle tabeller med selskaper (Selskaper, Varsler, Revisjonsplikt).
document.addEventListener('click', async (e) => {
  const tr = e.target.closest('.radliste tr[data-orgnr]');
  if (!tr) return;
  const handling = e.target.dataset.handling;
  if (handling === 'status' || handling === 'ringt') return;
  if (handling === 'prioritet') {
    const pa = !e.target.classList.contains('pa');
    await oppdater(tr.dataset.orgnr, { prioritet: pa });
    e.target.classList.toggle('pa', pa);
    return;
  }
  apnePanel(tr.dataset.orgnr);
});
document.addEventListener('change', async (e) => {
  const tr = e.target.closest('.radliste tr[data-orgnr]');
  const handling = e.target.dataset.handling;
  if (!tr || !handling) return;
  e.stopPropagation();
  const endring = handling === 'status' ? { status: e.target.value } : { ringt: e.target.checked };
  const ny = await oppdater(tr.dataset.orgnr, endring);
  if (ny) {
    tr.classList.toggle('er-ringt', !!ny.ringt);
    const cb = $('[data-handling="ringt"]', tr); if (cb) cb.checked = !!ny.ringt;
    const sv = $('[data-handling="status"]', tr); if (sv) sv.value = ny.status;
  }
});

async function oppdater(orgnr, endring) {
  try {
    const ny = await api(`/api/selskaper/${orgnr}/oppfolging`, { method: 'PATCH', body: endring });
    melding('Lagret');
    return ny;
  } catch (e) {
    melding(e.message);
    return null;
  }
}

// --- Detaljpanel ------------------------------------------------------------
async function apnePanel(orgnr) {
  tilstand.apentOrgnr = orgnr;
  const s = await api('/api/selskaper/' + orgnr);
  const m = tilstand.meta;
  const plikt = s.revisjonspliktig
    ? '<span class="merkelapp m-amber">Trolig revisjonspliktig</span>'
    : '<span class="merkelapp m-gray">Under grensene for revisjonsplikt</span>';
  const merknader = [
    s.er_kunde ? '<span class="merkelapp m-green">Vatnem-kunde</span>' : '',
    s.egenkapital > 0 ? '<span class="merkelapp m-green">Positiv egenkapital</span>' : s.egenkapital !== null ? '<span class="merkelapp m-red">Negativ egenkapital</span>' : '<span class="merkelapp m-gray">Mangler regnskap</span>',
    s.fravalg_revisjon ? '<span class="merkelapp m-gray">Har valgt bort revisjon</span>' : '',
    s.orgform === 'AS' || s.orgform === 'SA' ? plikt : '',
    s.i_konsern ? '<span class="merkelapp m-violet">Del av konsern</span>' : '',
  ].join('');

  const tel = (n) => n ? `<a href="tel:${esc(n.replace(/\s/g, ''))}">${esc(n)}</a>` : '';
  const nett = s.hjemmeside ? `<a href="${esc(/^https?:/.test(s.hjemmeside) ? s.hjemmeside : 'https://' + s.hjemmeside)}" target="_blank" rel="noopener noreferrer">${esc(s.hjemmeside)}</a>` : '';

  $('#panel').innerHTML = `
    <div class="panel-topp">
      <button class="panel-lukk" aria-label="Lukk">×</button>
      <h2>${esc(s.navn)}</h2>
      <div class="dempet">${esc(s.orgnr)} · ${esc(s.orgform)} · ${esc(s.kommune)}${s.nace_tekst ? ' · ' + esc(s.nace_tekst) : ''}</div>
      <div class="panel-lenker">
        <a href="https://virksomhet.brreg.no/nb/oppslag/enheter/${esc(s.orgnr)}" target="_blank" rel="noopener noreferrer">Brønnøysund ↗</a>
        <a href="https://www.proff.no/bransjes%C3%B8k?q=${esc(s.orgnr)}" target="_blank" rel="noopener noreferrer">Proff ↗</a>
        <a href="https://www.google.com/search?q=${encodeURIComponent(s.navn + ' ' + (s.poststed || ''))}" target="_blank" rel="noopener noreferrer">Google ↗</a>
      </div>
      <div class="merknader">${merknader}</div>
    </div>
    <div class="panel-innhold">
      ${tilknyttedeKort(s.tilknyttede)}
      <div class="kort">
        <h3>Oppfølging</h3>
        <form id="oppfolging-skjema" class="felt-rutenett">
          <label class="felt">Status
            <select name="status">${m.statuser.map((x) => `<option value="${x.kode}" ${x.kode === s.status ? 'selected' : ''}>${esc(x.navn)}</option>`).join('')}</select>
          </label>
          <label class="felt">Ansvarlig
            <select name="ansvarlig_id"><option value="">Ingen</option>${m.brukere.map((b) => `<option value="${b.id}" ${b.id === s.ansvarlig_id ? 'selected' : ''}>${esc(b.navn)}</option>`).join('')}</select>
          </label>
          <label class="felt">Neste oppfølging
            <input type="date" name="oppfolging_dato" value="${esc(s.oppfolging_dato || '')}">
          </label>
          <div class="felt">Ringt
            <label class="bryter"><input type="checkbox" name="ringt" ${s.ringt ? 'checked' : ''}> ${s.sist_kontaktet ? 'Sist ' + dato(s.sist_kontaktet, true) : 'Ikke ringt ennå'}</label>
          </div>
          <label class="felt">Kontaktperson
            <input name="kontaktperson" value="${esc(s.kontaktperson || '')}" placeholder="${esc(s.daglig_leder || '')}">
          </label>
          <label class="felt">Telefon kontaktperson
            <input name="kontakt_telefon" type="tel" value="${esc(s.kontakt_telefon || '')}">
          </label>
          <label class="felt hel">E-post kontaktperson
            <input name="kontakt_epost" type="email" value="${esc(s.kontakt_epost || '')}">
          </label>
          <label class="bryter"><input type="checkbox" name="prioritet" ${s.prioritet ? 'checked' : ''}> Prioritert ★</label>
        </form>
      </div>

      <div class="kort">
        <h3>Nøkkeltall ${s.regnskap_aar ? '(regnskap ' + s.regnskap_aar + ')' : ''}</h3>
        ${s.regnskap_aar ? `<div class="nokkeltall">
          <div class="nokkel"><div class="nokkel-tall">${kr(s.driftsinntekter)}</div><div class="nokkel-tekst">Driftsinntekter</div></div>
          <div class="nokkel"><div class="nokkel-tall">${kr(s.driftsresultat)}</div><div class="nokkel-tekst">Driftsresultat</div></div>
          <div class="nokkel"><div class="nokkel-tall">${kr(s.aarsresultat)}</div><div class="nokkel-tekst">Årsresultat</div></div>
          <div class="nokkel"><div class="nokkel-tall">${ekCelle(s.egenkapital)}</div><div class="nokkel-tekst">Egenkapital</div></div>
          <div class="nokkel"><div class="nokkel-tall">${s.ansatte ?? '–'}</div><div class="nokkel-tekst">Ansatte</div></div>
          <div class="nokkel"><div class="nokkel-tall">${kr(s.sum_eiendeler)}</div><div class="nokkel-tekst">Sum eiendeler</div></div>
          <div class="nokkel"><div class="nokkel-tall">${kr(s.sum_gjeld)}</div><div class="nokkel-tekst">Sum gjeld</div></div>
          <div class="nokkel"><div class="nokkel-tall">${s.sum_eiendeler > 0 && s.egenkapital !== null ? (s.egenkapital / s.sum_eiendeler * 100).toLocaleString('nb-NO', { maximumFractionDigits: 0 }) + ' %' : '–'}</div><div class="nokkel-tekst">Egenkapitalandel</div></div>
        </div>` : '<p class="dempet">Ingen årsregnskap registrert i Regnskapsregisteret.</p>'}
      </div>

      <div class="kort">
        <h3>Roller og kontakt</h3>
        <dl class="info-liste">
          <dt>Daglig leder</dt><dd>${personKontakt(s.daglig_leder, 'dl_telefon', s.dl_telefon, s.poststed)}</dd>
          <dt>Styreleder</dt><dd>${personKontakt(s.styreleder, 'sl_telefon', s.sl_telefon, s.poststed)}</dd>
          <dt>Revisor i dag</dt><dd>${esc(s.revisor_navn) || (s.fravalg_revisjon ? 'Ingen (valgt bort)' : 'Ingen')}</dd>
          <dt>Regnskapsfører</dt><dd>${esc(s.regnskapsforer_navn) || '–'}</dd>
          <dt>Telefon</dt><dd>${[tel(s.telefon), tel(s.mobil)].filter(Boolean).join(' · ') || '–'}</dd>
          <dt>E-post</dt><dd>${s.epost ? `<a href="mailto:${esc(s.epost)}">${esc(s.epost)}</a>` : '–'}</dd>
          <dt>Hjemmeside</dt><dd>${nett || '–'}</dd>
          <dt>Adresse</dt><dd>${esc([s.adresse, [s.postnr, s.poststed].filter(Boolean).join(' ')].filter(Boolean).join(', ')) || '–'}</dd>
          <dt>Stiftet</dt><dd>${dato(s.stiftet) || '–'}</dd>
          <dt>Poeng</dt><dd>${s.poeng} av 100</dd>
        </dl>
      </div>

      ${s.hendelser?.length ? `<div class="kort">
        <h3>Varsler for dette selskapet</h3>
        <ul class="tidslinje forste">${s.hendelser.map((h) => `<li>${varselMerke(h.type)} <span class="dempet">${dato(h.tidspunkt, true)}</span><div>${esc(h.tekst)}</div></li>`).join('')}</ul>
      </div>` : ''}

      <div id="brreg-detaljer"><div class="kort"><p class="dempet">Henter mer informasjon fra Brønnøysundregistrene…</p></div></div>

      <div class="kort">
        <h3>Notater og aktivitet</h3>
        <form id="notat-skjema" class="notat-skjema">
          <textarea name="tekst" placeholder="Hva ble sagt? Neste steg?" aria-label="Notat"></textarea>
          <div class="notat-knapper">
            <button class="knapp liten" type="submit" value="notat">Lagre notat</button>
            <button class="knapp liten primar" type="submit" value="samtale">Logg samtale</button>
          </div>
        </form>
        <ul class="tidslinje">
          ${s.aktiviteter.map((a) => `<li>
            ${a.bruker_id === tilstand.meg.id && a.type !== 'status' ? `<button class="slett" data-slett="${a.id}">Slett</button>` : ''}
            <div class="${a.type === 'status' ? 't-status' : 't-tekst'}">${a.type === 'samtale' ? '📞 ' : ''}${esc(a.tekst)}</div>
            <div class="aktivitet-meta">${esc(a.bruker || '')} · ${dato(a.opprettet, true)}</div>
          </li>`).join('') || '<li class="dempet">Ingen aktivitet ennå.</li>'}
        </ul>
      </div>
    </div>`;

  $('#panel').hidden = false;
  $('#panel-bakgrunn').hidden = false;
  $('.panel-lukk').addEventListener('click', lukkPanel);
  $$('#panel [data-tilknyttet]').forEach((b) => b.addEventListener('click', () => apnePanel(b.dataset.tilknyttet)));
  $('#panel').scrollTop = 0;
  $('#vis-alle-tilknyttede')?.addEventListener('click', (e) => {
    $$('#panel .tilknyttet-liste .ekstra').forEach((li) => { li.hidden = false; });
    e.target.remove();
  });
  $$('#panel [data-person-felt]').forEach((inp) => inp.addEventListener('change', async () => {
    if (await oppdater(orgnr, { [inp.dataset.personFelt]: inp.value.trim() })) apnePanel(orgnr);
  }));
  lastBrregDetaljer(orgnr);

  const skjema = $('#oppfolging-skjema');
  skjema.addEventListener('change', async (e) => {
    const el = e.target;
    const verdi = el.type === 'checkbox' ? el.checked : el.value;
    if (await oppdater(orgnr, { [el.name]: verdi })) apnePanel(orgnr);
  });

  $('#notat-skjema').addEventListener('submit', async (e) => {
    e.preventDefault();
    const tekst = e.target.tekst.value.trim();
    const type = e.submitter?.value || 'notat';
    if (!tekst && type === 'notat') return;
    try {
      await api(`/api/selskaper/${orgnr}/aktiviteter`, { method: 'POST', body: { tekst: tekst || 'Samtale', type } });
      melding('Lagret');
      apnePanel(orgnr);
    } catch (err) { melding(err.message); }
  });

  $$('[data-slett]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Slette notatet?')) return;
    await api('/api/aktiviteter/' + b.dataset.slett, { method: 'DELETE' }).catch((e) => melding(e.message));
    apnePanel(orgnr);
  }));
}

// Navn med telefonfelt og oppslag hos 1881/Gulesider (Brreg har ikke personers telefonnummer).
function personKontakt(navn, felt, telefon, sted) {
  if (!navn) return '–';
  const sok = encodeURIComponent(`${navn} ${sted || ''}`.trim());
  const ring = telefon ? ` <a class="ring-lenke" href="tel:${esc(telefon.replace(/\s/g, ''))}">📞 Ring</a>` : '';
  return `<div class="person-navn">${esc(navn)}${ring}</div>
    <div class="person-kontakt">
      <input class="person-tlf" name="${felt}" data-person-felt="${felt}" type="tel" placeholder="Telefonnummer" value="${esc(telefon || '')}" aria-label="Telefon ${esc(navn)}">
      <a class="knapp liten" href="https://www.1881.no/?query=${sok}" target="_blank" rel="noopener noreferrer">Søk 1881 ↗</a>
      <a class="knapp liten" href="https://www.gulesider.no/${encodeURIComponent(navn)}/personer" target="_blank" rel="noopener noreferrer">Gulesider ↗</a>
    </div>`;
}

// Henter roller, avdelinger, kapital, formål, tidligere navn og flere regnskapstall direkte fra Brreg.
async function lastBrregDetaljer(orgnr) {
  let d;
  try {
    d = await api(`/api/selskaper/${orgnr}/detaljer`);
  } catch (e) {
    if ($('#brreg-detaljer')) $('#brreg-detaljer').innerHTML = `<div class="kort"><p class="dempet">${esc(e.message)}</p></div>`;
    return;
  }
  const mal = $('#brreg-detaljer');
  if (!mal || tilstand.apentOrgnr !== orgnr) return;
  const rad = (t, v) => (v === null || v === undefined || v === '' ? '' : `<dt>${esc(t)}</dt><dd>${v}</dd>`);
  const i = d.info || {};
  const r = d.regnskap;

  const info = `<div class="kort">
    <h3>Selskapsinformasjon</h3>
    <dl class="info-liste">
      ${rad(i.kapitalType || 'Aksjekapital', i.aksjekapital !== null && i.aksjekapital !== undefined ? kr(i.aksjekapital, false) + (i.antallAksjer ? ` <span class="dempet">(${nf.format(i.antallAksjer)} aksjer)</span>` : '') : null)}
      ${rad('Formål', i.formaal ? esc(i.formaal) : null)}
      ${rad('Stiftet', dato(i.stiftet))}
      ${rad('Registrert', dato(i.registrert))}
      ${rad('Foretaksregisteret', dato(i.foretaksregisteret))}
      ${rad('MVA-registrert', i.mva ? 'Ja' : 'Nei')}
      ${rad('Sektor', esc(i.sektor))}
      ${rad('Bransje 2', esc(i.naering2))}
      ${rad('Vedtekter sist endret', dato(i.vedtektsdato))}
      ${rad('Siste innsendte årsregnskap', esc(i.sisteAarsregnskap))}
      ${rad('Postadresse', esc(i.postadresse))}
    </dl>
    ${i.tidligereNavn?.length ? `<h3 class="mellomtittel">Tidligere navn</h3>
      <ul class="enkel-liste">${i.tidligereNavn.map((n) => `<li>${esc(n.navn)} <span class="dempet">${dato(n.fra)} – ${dato(n.til)}</span></li>`).join('')}</ul>` : ''}
  </div>`;

  const roller = `<div class="kort">
    <h3>Alle roller</h3>
    ${d.roller.length ? d.roller.map((g) => `<div class="rollegruppe">
      <div class="rollegruppe-navn">${esc(g.gruppe)}</div>
      <ul class="enkel-liste">${g.roller.map((x) => `<li>${esc(x.navn || '–')} <span class="dempet">${esc(x.rolle)}${x.orgnr ? ' · ' + esc(x.orgnr) : ''}${x.fratradt ? ' · fratrådt' : ''}</span></li>`).join('')}</ul>
    </div>`).join('') : '<p class="dempet">Ingen roller registrert.</p>'}
  </div>`;

  const avdelinger = `<div class="kort">
    <h3>Avdelinger (${d.antallAvdelinger})</h3>
    ${d.avdelinger.length ? `<ul class="tilknyttet-liste">${d.avdelinger.map((a) => `<li>
      <div class="selskap-navn">${esc(a.navn)}</div>
      <div class="under">${esc(a.orgnr)}${a.adresse ? ' · ' + esc(a.adresse) : ''}</div>
      <div class="under">${a.ansatte !== null ? `${a.ansatte} ansatte` : 'Ansatte ikke oppgitt'}${a.naering ? ' · ' + esc(a.naering) : ''}${a.oppstart ? ' · startet ' + dato(a.oppstart) : ''}</div>
    </li>`).join('')}</ul>${d.antallAvdelinger > d.avdelinger.length ? `<p class="dempet">Viser ${d.avdelinger.length} av ${d.antallAvdelinger}.</p>` : ''}` : '<p class="dempet">Ingen avdelinger registrert.</p>'}
  </div>`;

  const regnskap = r ? `<div class="kort">
    <h3>Flere regnskapstall (${esc(r.aar)})</h3>
    <dl class="info-liste">
      ${rad('Salgsinntekter', kr(r.salgsinntekter))}
      ${rad('Lønnskostnader', kr(r.loennskostnad))}
      ${rad('Sum driftskostnader', kr(r.driftskostnader))}
      ${rad('Resultat før skatt', kr(r.resultatFoerSkatt))}
      ${rad('Skattekostnad', kr(r.skatt))}
      ${rad('Bankinnskudd og kontanter', kr(r.bank))}
      ${rad('Omløpsmidler', kr(r.omloepsmidler))}
      ${rad('Anleggsmidler', kr(r.anleggsmidler))}
      ${rad('Kortsiktig gjeld', kr(r.kortsiktigGjeld))}
      ${rad('Langsiktig gjeld', kr(r.langsiktigGjeld))}
      ${rad('Regnskapsregler', esc([r.regnskapsregler, r.smaaForetak ? 'små foretak' : null].filter(Boolean).join(', ')))}
      ${rad('Revidert', r.ikkeRevidert ? '<span class="merkelapp m-amber">Nei, ikke revidert</span>' : 'Ja / ikke oppgitt')}
      ${rad('Konsern', r.morselskap || r.harKonsernregnskap ? 'Morselskap med konsernregnskap' : null)}
    </dl>
  </div>` : '';

  const h = d.historikk || [];
  const endring = (a, b) => {
    if (a === null || b === null || !a) return '';
    const p = ((b - a) / Math.abs(a)) * 100;
    return `<div class="under ${p >= 0 ? 'pos' : 'neg'}">${p >= 0 ? '+' : ''}${Math.round(p)} %</div>`;
  };
  const histRad = (tekst, felt, ek = false) => `<tr><td>${tekst}</td>${h.map((x, i) =>
    `<td class="tall">${ek ? ekCelle(x[felt]) : kr(x[felt])}${i > 0 ? endring(h[i - 1][felt], x[felt]) : ''}</td>`).join('')}</tr>`;
  const historikk = h.length > 1 ? `<div class="kort">
    <h3>Utvikling ${esc(h[0].aar)}–${esc(h.at(-1).aar)}</h3>
    <div class="tabell-ramme flat"><table class="tabell kompakt">
      <thead><tr><th></th>${h.map((x) => `<th class="tall">${esc(x.aar)}</th>`).join('')}</tr></thead>
      <tbody>
        ${histRad('Driftsinntekter', 'driftsinntekter')}
        ${histRad('Driftsresultat', 'driftsresultat')}
        ${histRad('Årsresultat', 'aarsresultat')}
        ${histRad('Egenkapital', 'egenkapital', true)}
        ${histRad('Sum eiendeler', 'sumEiendeler')}
        ${histRad('Sum gjeld', 'sumGjeld')}
      </tbody>
    </table></div>
  </div>` : '';

  mal.innerHTML = historikk + info + roller + avdelinger + regnskap;
}

function tilknyttedeKort(liste) {
  if (!liste || !liste.length) {
    return '<div class="kort"><h3>Tilknyttede selskaper</h3><p class="dempet">Ingen andre selskaper i regionen har samme personer i ledelsen eller styret.</p></div>';
  }
  const kontaktet = liste.filter((t) => t.ringt || t.status !== 'ny' || t.er_kunde);
  const varsel = kontaktet.length
    ? `<div class="varsel-boks">⚠ ${kontaktet.length === 1 ? 'Ett tilknyttet selskap' : kontaktet.length + ' tilknyttede selskaper'} er allerede kontaktet eller er kunde. Sjekk før du ringer.</div>`
    : '';
  return `<div class="kort">
    <h3>Tilknyttede selskaper (${liste.length})</h3>
    ${varsel}
    <ul class="tilknyttet-liste">
      ${liste.map((t, i) => `<li${i >= 5 ? ' class="ekstra" hidden' : ''}>
        <div class="tilknyttet-topp">
          <button class="lenke-knapp selskap-navn" data-tilknyttet="${esc(t.orgnr)}">${esc(t.navn)}</button>
          ${t.er_kunde ? '<span class="merkelapp m-green">Vatnem-kunde</span>' : statusMerke(t.status)}
          ${t.ringt ? `<span class="merkelapp m-amber">Ringt${t.sist_kontaktet ? ' ' + dato(t.sist_kontaktet) : ''}</span>` : ''}
        </div>
        <div class="under">${esc(t.kommune || '')}${t.revisor_navn ? ' · Revisor: ' + esc(t.revisor_navn) : ''}${t.ansvarlig ? ' · Ansvarlig: ' + esc(t.ansvarlig) : ''}</div>
        <div class="under">Felles: ${t.koblinger.map(esc).join('; ')}</div>
      </li>`).join('')}
    </ul>
    ${liste.length > 5 ? `<button class="knapp liten" id="vis-alle-tilknyttede">Vis alle ${liste.length}</button>` : ''}
  </div>`;
}

function lukkPanel() {
  $('#panel').hidden = true;
  $('#panel-bakgrunn').hidden = true;
  tilstand.apentOrgnr = null;
  if (tilstand.fane === 'selskaper') lastListe();
  if (tilstand.fane === 'oversikt') lastOversikt();
}
$('#panel-bakgrunn').addEventListener('click', lukkPanel);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#panel').hidden) lukkPanel(); });

// --- Revisorer --------------------------------------------------------------
async function lastRevisorer() {
  const liste = await api('/api/revisorer');
  const totalt = liste.reduce((s, r) => s + r.antall, 0);
  $('#revisor-rader').innerHTML = liste.map((r) => `
    <tr data-orgnr="${esc(r.orgnr)}" data-navn="${esc(r.navn)}">
      <td><span class="selskap-navn">${esc(r.navn)}</span>${r.orgnr === '988075167' ? ' <span class="merkelapp m-green">Oss</span>' : ''}</td>
      <td class="tall">${nf.format(r.antall)}</td>
      <td class="tall">${((r.antall / totalt) * 100).toLocaleString('nb-NO', { maximumFractionDigits: 1 })} %</td>
      <td class="tall">${kr(r.inntekter)}</td>
      <td class="tall">${nf.format(r.ek_positiv || 0)}</td>
    </tr>`).join('');
  $$('#revisor-rader tr').forEach((tr) => tr.addEventListener('click', () => {
    const f = $('#filter');
    const sel = f.revisor;
    [...sel.options].filter((o) => /^\d{9}$/.test(o.value)).forEach((o) => o.remove());
    sel.add(new Option(tr.dataset.navn, tr.dataset.orgnr));
    visListeMed({ revisor: tr.dataset.orgnr, kunder: tr.dataset.orgnr === '988075167' ? 'vis' : '', sorter: 'driftsinntekter' });
  }));
}

start();
