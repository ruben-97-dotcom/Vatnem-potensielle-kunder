'use strict';
// Kart over selskapene. Bruker hjelpefunksjonene i app.js ($, api, esc, kr, penNavn, apnePanel …).
// Vatnem i oransje, selskaper uten revisor i grønt (potensialet), de største konkurrentene
// i hver sin farge og resten samlet som «Andre revisorer».

const KART_FARGER = ['#7B5EA7', '#3B82C4', '#C2185B', '#8A9A2B', '#C99A06', '#D9534F', '#5F7A8A', '#9C6B3C'];
const KART_GRUPPER_FAST = {
  vatnem: { navn: 'Vatnem Revisjon (kunder)', farge: '#F28C38' },
  ingen: { navn: 'Ingen revisor', farge: '#0F6E6E' },
  andre: { navn: 'Andre revisorer', farge: '#A8A08C' },
  ukjent: { navn: 'Revisor ikke hentet ennå', farge: '#D5CDB8' },
};
// Feltene i hver rad fra /api/kart.
const K = { orgnr: 0, navn: 1, lat: 2, lon: 3, omtrentlig: 4, revisor: 5, inntekt: 6, ansatte: 7, status: 8, ringt: 9, passer: 10, kunde: 11, kommunenr: 12, rollerHentet: 13 };
const kartTilstand = { kart: null, lag: null, data: null, grupper: [], skjult: new Set(), toppRevisorer: new Map(), harZoomet: false };

function kartGruppe(rad) {
  if (rad[K.kunde]) return 'vatnem';
  if (rad[K.revisor] === -1) return rad[K.rollerHentet] ? 'ingen' : 'ukjent';
  const orgnr = kartTilstand.data.revisorer[rad[K.revisor]][0];
  return kartTilstand.toppRevisorer.has(orgnr) ? orgnr : 'andre';
}

function initKart() {
  const k = L.map('kart', { preferCanvas: true }).setView([59.55, 5.6], 9);
  L.tileLayer('https://cache.kartverket.no/v1/wmts/1.0.0/topograatone/default/webmercator/{z}/{y}/{x}.png', {
    maxZoom: 18,
    attribution: '© <a href="https://www.kartverket.no/" target="_blank" rel="noopener noreferrer">Kartverket</a>',
  }).addTo(k);
  kartTilstand.kart = k;
  kartTilstand.lag = L.layerGroup().addTo(k);

  const valg = $('#kart-kommune');
  for (const km of tilstand.meta.kommuner) valg.add(new Option(km.navn, km.nr));
  valg.addEventListener('change', zoomTilKommune);
  $('#kart-passer').addEventListener('change', tegnKart);
  $('#kart-ukontaktet').addEventListener('change', tegnKart);
  $('#kart-alle').addEventListener('click', () => { kartTilstand.skjult.clear(); tegnKart(); });
  $('#kart-forklaring').addEventListener('change', (e) => {
    const g = e.target.dataset.gruppe;
    if (!g) return;
    if (e.target.checked) kartTilstand.skjult.delete(g); else kartTilstand.skjult.add(g);
    tegnKart();
  });
  // Knappen i boblen åpner selskapet.
  $('#kart').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kart-apne]');
    if (b) apnePanel(b.dataset.kartApne);
  });
}

function zoomTilKommune() {
  const nr = $('#kart-kommune').value;
  const punkter = kartTilstand.data.rader.filter((r) => !nr || r[K.kommunenr] === nr).map((r) => [r[K.lat], r[K.lon]]);
  if (punkter.length) kartTilstand.kart.fitBounds(L.latLngBounds(punkter), { padding: [30, 30], maxZoom: 13 });
}

async function lastKart() {
  if (!window.L) {
    $('#kart-info').textContent = 'Kartet kunne ikke lastes. Prøv å laste siden på nytt.';
    return;
  }
  if (!kartTilstand.kart) initKart();
  setTimeout(() => kartTilstand.kart.invalidateSize(), 60);
  if (!kartTilstand.data) $('#kart-info').textContent = 'Henter selskapene …';
  const data = await api('/api/kart');
  kartTilstand.data = data;
  // De største revisorene (utenom Vatnem) får egne farger.
  const topp = data.revisorer.filter(([orgnr]) => orgnr !== '988075167').slice(0, KART_FARGER.length);
  kartTilstand.toppRevisorer = new Map(topp.map(([orgnr, navn], i) => [orgnr, { navn: penNavn(navn), farge: KART_FARGER[i] }]));
  kartTilstand.grupper = [
    ['vatnem', KART_GRUPPER_FAST.vatnem],
    ['ingen', KART_GRUPPER_FAST.ingen],
    ...kartTilstand.toppRevisorer,
    ['andre', KART_GRUPPER_FAST.andre],
    ['ukjent', KART_GRUPPER_FAST.ukjent],
  ];
  tegnKart();
  if (!kartTilstand.harZoomet && data.rader.length) { zoomTilKommune(); kartTilstand.harZoomet = true; }
}

function kartBoble(rad, gruppe) {
  const revisor = rad[K.kunde] ? 'Vatnem Revisjon AS'
    : rad[K.revisor] === -1 ? (rad[K.rollerHentet] ? 'Ingen revisor' : 'Revisor ikke hentet ennå')
      : penNavn(kartTilstand.data.revisorer[rad[K.revisor]][1]);
  const status = tilstand.meta.statuser[rad[K.status]] || tilstand.meta.statuser[0];
  const inntekt = rad[K.inntekt] !== null ? kr(rad[K.inntekt] * 1000) + ' i inntekt' : 'Ingen regnskap';
  const ansatte = rad[K.ansatte] !== null ? ' · ' + rad[K.ansatte] + ' ansatte' : '';
  return '<div class="kart-boble">' +
    '<div class="kart-boble-navn">' + esc(penNavn(rad[K.navn])) + '</div>' +
    '<div class="kart-boble-rad"><span class="kart-prikk" data-farge="' + gruppe.farge + '"></span>' + esc(revisor) + '</div>' +
    '<div class="kart-boble-rad dempet">' + inntekt + ansatte + '</div>' +
    '<div class="kart-boble-rad"><span class="status-pille s-' + esc(status.kode) + '">' + esc(status.navn) + '</span></div>' +
    (rad[K.omtrentlig] ? '<div class="kart-boble-rad dempet">Omtrentlig plassering (postnummer)</div>' : '') +
    '<button type="button" class="knapp liten" data-kart-apne="' + esc(rad[K.orgnr]) + '">Åpne selskapet</button>' +
    '</div>';
}

function tegnKart() {
  const d = kartTilstand.data;
  if (!d) return;
  const barePasser = $('#kart-passer').checked;
  const skjulKontaktet = $('#kart-ukontaktet').checked;
  const grupper = Object.fromEntries(kartTilstand.grupper);
  const telling = {};
  kartTilstand.lag.clearLayers();
  // Vatnem-kundene tegnes sist, så de ligger øverst.
  const rekkefolge = [...d.rader].sort((a, b) => a[K.kunde] - b[K.kunde]);
  let vist = 0;
  for (const rad of rekkefolge) {
    const g = kartGruppe(rad);
    if (barePasser && !rad[K.passer] && !rad[K.kunde]) continue;
    if (skjulKontaktet && !rad[K.kunde] && (rad[K.ringt] || rad[K.status] !== 0)) continue;
    telling[g] = (telling[g] || 0) + 1;
    if (kartTilstand.skjult.has(g)) continue;
    const gruppe = grupper[g];
    const m = L.circleMarker([rad[K.lat], rad[K.lon]], {
      radius: g === 'vatnem' ? 7 : g === 'ingen' ? 6 : 5,
      color: '#FFFFFF',
      weight: g === 'vatnem' ? 2 : 1,
      fillColor: gruppe.farge,
      fillOpacity: rad[K.omtrentlig] ? 0.5 : 0.9,
    });
    m.bindPopup(() => kartBoble(rad, gruppe), { maxWidth: 280, className: 'kart-popup' });
    m.on('popupopen', (e) => {
      const p = e.popup.getElement()?.querySelector('.kart-prikk');
      if (p) p.style.background = p.dataset.farge;
    });
    kartTilstand.lag.addLayer(m);
    vist++;
  }

  $('#kart-forklaring').innerHTML = kartTilstand.grupper
    .filter(([k]) => telling[k] || k === 'vatnem' || k === 'ingen')
    .map(([k, g]) => '<li><label class="kart-gruppe">' +
      '<input type="checkbox" data-gruppe="' + esc(k) + '"' + (kartTilstand.skjult.has(k) ? '' : ' checked') + '>' +
      '<span class="kart-prikk" data-farge="' + g.farge + '"></span>' +
      '<span class="kart-gruppe-navn">' + esc(g.navn) + '</span>' +
      '<span class="kart-gruppe-tall">' + nf.format(telling[k] || 0) + '</span>' +
      '</label></li>').join('');
  $$('#kart-forklaring .kart-prikk').forEach((p) => { p.style.background = p.dataset.farge; });

  const plassert = d.rader.length;
  const iRegionen = d.totalt - (d.utenfor || 0);
  const omtrentlig = d.rader.filter((r) => r[K.omtrentlig]).length;
  $('#kart-info').textContent = nf.format(vist) + ' selskaper vises. ' +
    nf.format(plassert) + ' av ' + nf.format(iRegionen) + ' selskaper i regionen er plassert på kartet' +
    (plassert < iRegionen ? ' (resten plasseres i bakgrunnen)' : '') +
    (omtrentlig ? ', ' + nf.format(omtrentlig) + ' med omtrentlig plassering (svakere farge)' : '') + '.' +
    (d.utenfor ? ' ' + nf.format(d.utenfor) + ' selskaper har forretningsadresse utenfor regionen og vises ikke.' : '');
}
