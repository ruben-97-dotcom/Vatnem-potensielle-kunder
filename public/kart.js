'use strict';
// Kart over selskapene. Bruker hjelpefunksjonene i app.js ($, api, esc, kr, penNavn, apnePanel …).
// Vatnem i oransje, selskaper uten revisor i grønt (potensialet), de største konkurrentene
// i hver sin farge og resten samlet som «Andre revisorer».

const KART_FARGER = ['#7B5EA7', '#3B82C4', '#C2185B', '#8A9A2B', '#C99A06', '#D9534F', '#5F7A8A', '#9C6B3C'];
const KART_GRUPPER_FAST = {
  vatnem: { navn: 'Vatnem-kunder', farge: '#F28C38' },
  ingen: { navn: 'Ingen revisor', farge: '#0F6E6E' },
  andre: { navn: 'Andre revisorer', farge: '#A8A08C' },
  ukjent: { navn: 'Revisor ikke hentet', farge: '#D5CDB8' },
};
// Feltene i hver rad fra /api/kart.
const K = { orgnr: 0, navn: 1, lat: 2, lon: 3, omtrentlig: 4, revisor: 5, inntekt: 6, ansatte: 7, status: 8, ringt: 9,
  passer: 10, kunde: 11, kommunenr: 12, rollerHentet: 13, poeng: 16, kommune: 17 };
const kartTilstand = {
  kart: null, lag: null, data: null, grupper: [], skjult: new Set(), toppRevisorer: new Map(),
  harZoomet: false, markorer: new Map(), synlige: [],
};

const harKontakt = (rad) => Boolean(rad[K.ringt] || rad[K.status] !== 0);

function kartGruppe(rad) {
  if (rad[K.kunde]) return 'vatnem';
  if (rad[K.revisor] === -1) return rad[K.rollerHentet] ? 'ingen' : 'ukjent';
  const orgnr = kartTilstand.data.revisorer[rad[K.revisor]][0];
  return kartTilstand.toppRevisorer.has(orgnr) ? orgnr : 'andre';
}

// Prikkene vokser når man zoomer inn, så oversikten ikke blir et fargehav.
function radiusFor(gruppe, zoom) {
  const base = zoom <= 9 ? 3.5 : zoom <= 10 ? 4.5 : zoom <= 12 ? 5.5 : zoom <= 14 ? 7 : 8.5;
  return gruppe === 'vatnem' ? base + 4 : base;
}

function initKart() {
  const k = L.map('kart', { preferCanvas: true, zoomControl: false, zoomSnap: 0.25, zoomDelta: 0.5, attributionControl: true }).setView([59.55, 5.6], 9);
  L.control.zoom({ position: 'topright', zoomInTitle: 'Zoom inn', zoomOutTitle: 'Zoom ut' }).addTo(k);
  // «Min posisjon»: flytter kartet dit du er (nyttig når dere er ute i området).
  const Posisjon = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const knapp = L.DomUtil.create('button', 'kart-posisjon');
      knapp.type = 'button';
      knapp.title = 'Vis hvor jeg er';
      knapp.setAttribute('aria-label', 'Vis hvor jeg er');
      knapp.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7"/></svg>';
      L.DomEvent.disableClickPropagation(knapp);
      L.DomEvent.on(knapp, 'click', visMinPosisjon);
      return knapp;
    },
  });
  new Posisjon().addTo(k);
  L.tileLayer('https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png', {
    maxZoom: 18,
    className: 'kart-fliser',
    attribution: '© <a href="https://www.kartverket.no/" target="_blank" rel="noopener noreferrer">Kartverket</a>',
  }).addTo(k);
  k.attributionControl.setPrefix(false);
  k.attributionControl.setPosition('bottomleft');
  kartTilstand.kart = k;
  tegnKommuner(k);
  kartTilstand.lag = L.layerGroup().addTo(k);

  const valg = $('#kart-kommune');
  for (const km of tilstand.meta.kommuner) valg.add(new Option(km.navn, km.nr));
  valg.addEventListener('change', zoomTilKommune);
  $('#kart-passer').addEventListener('change', tegnKart);
  $('#kart-ukontaktet').addEventListener('change', tegnKart);
  $('#kart-forklaring').addEventListener('click', (e) => {
    const b = e.target.closest('[data-gruppe]');
    if (!b) return;
    const g = b.dataset.gruppe;
    if (kartTilstand.skjult.has(g)) kartTilstand.skjult.delete(g); else kartTilstand.skjult.add(g);
    tegnKart();
  });
  // Knapper i boblen og i listene.
  $('#kart').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kart-apne]');
    if (b) apnePanel(b.dataset.kartApne);
  });
  $('.kart-panel').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kart-ga]');
    if (b) gaTilSelskap(b.dataset.kartGa);
  });
  k.on('zoomend', () => {
    const z = k.getZoom();
    for (const [orgnr, m] of kartTilstand.markorer) m.setRadius(radiusFor(m.options.gruppe, z));
    oppdaterOmrade();
  });
  k.on('moveend', oppdaterOmrade);

  // Panelet kan skjules. På mobil starter det sammenslått, så kartet får plass.
  const panel = $('#kart-panel');
  const knapp = $('#kart-panel-knapp');
  const settPanel = (apen) => {
    panel.classList.toggle('lukket', !apen);
    knapp.setAttribute('aria-expanded', String(apen));
    knapp.setAttribute('aria-label', apen ? 'Skjul panelet' : 'Vis panelet');
  };
  settPanel(window.innerWidth > 700);
  knapp.addEventListener('click', () => settPanel(panel.classList.contains('lukket')));
  $('.kart-panel-topp').addEventListener('click', (e) => {
    if (e.target.closest('#kart-panel-knapp')) return;
    if (panel.classList.contains('lukket')) settPanel(true);
  });

  // Kartet fyller høyden under menyen (og banneret, når det vises).
  const toppfelt = $('.toppfelt');
  const settHoyde = () => {
    document.documentElement.style.setProperty('--kart-topp', toppfelt.offsetHeight + 'px');
    k.invalidateSize();
  };
  new ResizeObserver(settHoyde).observe(toppfelt);
  window.addEventListener('resize', settHoyde);
  settHoyde();
}

function zoomTilKommune() {
  const nr = $('#kart-kommune').value;
  const punkter = kartTilstand.data.rader.filter((r) => !nr || r[K.kommunenr] === nr).map((r) => [r[K.lat], r[K.lon]]);
  if (!punkter.length) return;
  // På mobil ligger panelet som et ark nederst på kartet; hold prikkene over det.
  const mobil = window.innerWidth <= 700;
  const bunn = mobil ? $('#kart-panel').offsetHeight + 30 : 30;
  kartTilstand.kart.flyToBounds(L.latLngBounds(punkter), {
    paddingTopLeft: [30, mobil ? 60 : 90], paddingBottomRight: [mobil ? 30 : 70, bunn], maxZoom: 13, duration: 0.8,
  });
}

function gaTilSelskap(orgnr) {
  const m = kartTilstand.markorer.get(orgnr);
  if (!m) return;
  const k = kartTilstand.kart;
  k.flyTo(m.getLatLng(), Math.max(k.getZoom(), 14), { duration: 0.7 });
  k.once('moveend', () => m.openPopup());
  if (window.innerWidth <= 700) $('#kart-panel-knapp').click();
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
  kartTilstand.toppRevisorer = new Map(topp.map(([orgnr, navn], i) => [orgnr, { navn: kortRevisor(navn), farge: KART_FARGER[i] }]));
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

function revisorNavn(rad) {
  if (rad[K.kunde]) return 'Vatnem Revisjon';
  if (rad[K.revisor] === -1) return rad[K.rollerHentet] ? 'Ingen revisor' : 'Revisor ikke hentet';
  return kortRevisor(kartTilstand.data.revisorer[rad[K.revisor]][1]);
}

function kartBoble(rad, gruppe) {
  const status = tilstand.meta.statuser[rad[K.status]] || tilstand.meta.statuser[0];
  const inntekt = rad[K.inntekt] !== null ? kr(rad[K.inntekt] * 1000) : '–';
  const ansatte = rad[K.ansatte] !== null ? nf.format(rad[K.ansatte]) : '–';
  return '<div class="kart-boble">' +
    '<div class="kart-boble-kicker" data-farge="' + gruppe.farge + '"><span class="kart-prikk"></span>' + esc(revisorNavn(rad)) + '</div>' +
    '<div class="kart-boble-navn">' + esc(penNavn(rad[K.navn])) + '</div>' +
    '<div class="kart-boble-sted">' + esc(penNavn(rad[K.kommune] || '')) + (rad[K.omtrentlig] ? ' · omtrentlig plassering' : '') + '</div>' +
    '<div class="kart-boble-tall">' +
      '<div><span>Inntekt</span><b>' + inntekt + '</b></div>' +
      '<div><span>Ansatte</span><b>' + ansatte + '</b></div>' +
      '<div><span>Poeng</span><b>' + (rad[K.poeng] ?? '–') + '</b></div>' +
    '</div>' +
    '<div class="kart-boble-bunn">' +
      '<span class="status-pille s-' + esc(status.kode) + '">' + esc(status.navn) + '</span>' +
      '<button type="button" class="knapp primar liten" data-kart-apne="' + esc(rad[K.orgnr]) + '">Åpne</button>' +
    '</div></div>';
}

function tegnKart() {
  const d = kartTilstand.data;
  if (!d) return;
  const barePasser = $('#kart-passer').checked;
  const skjulKontaktet = $('#kart-ukontaktet').checked;
  const grupper = Object.fromEntries(kartTilstand.grupper);
  const telling = {};
  const zoom = kartTilstand.kart.getZoom();
  kartTilstand.lag.clearLayers();
  kartTilstand.markorer.clear();
  kartTilstand.synlige = [];
  // Vatnem-kundene tegnes sist, så de ligger øverst.
  const rekkefolge = [...d.rader].sort((a, b) => a[K.kunde] - b[K.kunde]);
  for (const rad of rekkefolge) {
    const g = kartGruppe(rad);
    if (barePasser && !rad[K.passer] && !rad[K.kunde]) continue;
    if (skjulKontaktet && !rad[K.kunde] && harKontakt(rad)) continue;
    telling[g] = (telling[g] || 0) + 1;
    if (kartTilstand.skjult.has(g)) continue;
    const gruppe = grupper[g];
    const m = L.circleMarker([rad[K.lat], rad[K.lon]], {
      gruppe: g,
      radius: radiusFor(g, zoom),
      color: g === 'vatnem' ? '#1A2B2B' : '#FFFFFF',
      weight: g === 'vatnem' ? 2 : 1,
      fillColor: gruppe.farge,
      fillOpacity: rad[K.omtrentlig] ? 0.55 : 0.92,
    });
    m.bindPopup(() => kartBoble(rad, gruppe), { maxWidth: 300, minWidth: 260, className: 'kart-popup', closeButton: true, autoPanPadding: [40, 40] });
    m.on('popupopen', (e) => {
      const el = e.popup.getElement();
      el?.querySelectorAll('[data-farge]').forEach((x) => { x.style.setProperty('--prikk', x.dataset.farge); });
    });
    kartTilstand.lag.addLayer(m);
    kartTilstand.markorer.set(rad[K.orgnr], m);
    kartTilstand.synlige.push(rad);
  }

  // Forklaringen som piller som kan slås av og på.
  $('#kart-forklaring').innerHTML = kartTilstand.grupper
    .filter(([k]) => telling[k] || k === 'vatnem' || k === 'ingen')
    .map(([k, g]) => {
      const av = kartTilstand.skjult.has(k);
      return '<button type="button" class="kart-chip' + (av ? ' av' : '') + '" data-gruppe="' + esc(k) + '" aria-pressed="' + (!av) + '"' +
        ' title="' + (av ? 'Vis ' : 'Skjul ') + esc(g.navn) + '" data-farge="' + g.farge + '">' +
        '<span class="kart-prikk"></span>' + esc(g.navn) + ' <span class="kart-chip-tall">' + nf.format(telling[k] || 0) + '</span></button>';
    }).join('');
  $$('#kart-forklaring [data-farge]').forEach((x) => { x.style.setProperty('--prikk', x.dataset.farge); });

  const plassert = d.rader.length;
  const iRegionen = d.totalt - (d.utenfor || 0);
  const omtrentlig = d.rader.filter((r) => r[K.omtrentlig]).length;
  $('#kart-info').textContent = nf.format(plassert) + ' av ' + nf.format(iRegionen) + ' selskaper i regionen er plassert på kartet' +
    (plassert < iRegionen ? ' (resten plasseres i bakgrunnen)' : '') +
    (omtrentlig ? '. ' + nf.format(omtrentlig) + ' har omtrentlig plassering og vises svakere' : '') + '.' +
    (d.utenfor ? ' ' + nf.format(d.utenfor) + ' har forretningsadresse utenfor regionen og vises ikke.' : '');
  oppdaterOmrade();
}

// Tall og lister for det som er synlig i kartutsnittet.
function oppdaterOmrade() {
  const k = kartTilstand.kart;
  if (!k || !kartTilstand.data) return;
  const grenser = k.getBounds();
  const iUtsnitt = kartTilstand.synlige.filter((r) => grenser.contains([r[K.lat], r[K.lon]]));
  const uten = iUtsnitt.filter((r) => !r[K.kunde] && r[K.revisor] === -1 && r[K.rollerHentet]).length;
  const passer = iUtsnitt.filter((r) => !r[K.kunde] && r[K.passer]).length;
  const kunder = iUtsnitt.filter((r) => r[K.kunde]);
  $('#kart-tall').innerHTML =
    '<div class="kart-tall-brikke"><b>' + nf.format(iUtsnitt.length) + '</b><span>i utsnittet</span></div>' +
    '<div class="kart-tall-brikke gronn"><b>' + nf.format(uten) + '</b><span>uten revisor</span></div>' +
    '<div class="kart-tall-brikke"><b>' + nf.format(passer) + '</b><span>passer for Vatnem</span></div>' +
    '<div class="kart-tall-brikke mork"><b>' + nf.format(kunder.length) + '</b><span>Vatnem-kunder</span></div>';

  const valgt = $('#kart-kommune');
  $('#kart-omrade-tittel').textContent = valgt.value ? valgt.selectedOptions[0].text : 'Kartutsnittet';

  // Beste muligheter: ikke kunde, ikke kontaktet, passer for Vatnem, høyest poeng.
  const muligheter = iUtsnitt
    .filter((r) => !r[K.kunde] && !harKontakt(r) && r[K.passer])
    .sort((a, b) => (b[K.poeng] || 0) - (a[K.poeng] || 0) || (b[K.inntekt] || 0) - (a[K.inntekt] || 0))
    .slice(0, 6);
  const grupper = Object.fromEntries(kartTilstand.grupper);
  const linje = (r) => {
    const g = grupper[kartGruppe(r)];
    return '<li><button type="button" class="kart-liste-rad" data-kart-ga="' + esc(r[K.orgnr]) + '" data-farge="' + g.farge + '">' +
      '<span class="kart-prikk"></span>' +
      '<span class="kart-liste-tekst"><b>' + esc(penNavn(r[K.navn])) + '</b>' +
      '<span>' + (r[K.inntekt] !== null ? kr(r[K.inntekt] * 1000) : 'Ingen regnskap') + ' · ' + esc(revisorNavn(r)) + '</span></span>' +
      (r[K.poeng] !== undefined && !r[K.kunde] ? '<span class="poeng ' + (r[K.poeng] >= 70 ? 'hoy' : r[K.poeng] >= 45 ? 'mid' : '') + '">' + r[K.poeng] + '</span>' : '') +
      '</button></li>';
  };
  $('#kart-muligheter').innerHTML = muligheter.length ? muligheter.map(linje).join('')
    : '<li class="dempet kart-tom">Ingen ukontaktede selskaper som passer for Vatnem her. Zoom ut eller flytt kartet.</li>';
  const kunderSortert = [...kunder].sort((a, b) => (b[K.inntekt] || 0) - (a[K.inntekt] || 0)).slice(0, 5);
  $('#kart-kunder').innerHTML = kunderSortert.length ? kunderSortert.map(linje).join('') +
    (kunder.length > 5 ? '<li class="dempet kart-tom">og ' + (kunder.length - 5) + ' til i utsnittet</li>' : '')
    : '<li class="dempet kart-tom">Ingen Vatnem-kunder i utsnittet.</li>';
  $$('.kart-panel [data-farge]').forEach((x) => { x.style.setProperty('--prikk', x.dataset.farge); });
}

// Kommunegrenser (stiplet) og kommunenavn fra public/kommuner.json (Kartverket, forenklet).
async function tegnKommuner(k) {
  let data;
  try { data = await fetch('/kommuner.json').then((r) => r.json()); } catch { return; }
  L.geoJSON(data, {
    interactive: false,
    style: { color: '#8C9494', weight: 1.3, opacity: 0.9, dashArray: '4 5', fill: false },
  }).addTo(k);
  const navn = L.layerGroup(data.features.map((f) => L.marker([f.properties.punkt[1], f.properties.punkt[0]], {
    interactive: false, keyboard: false,
    icon: L.divIcon({ className: 'kommune-navn', html: '<span>' + esc(f.properties.navn) + '</span>', iconSize: null }),
  }))).addTo(k);
  // Navnene skjules når man zoomer langt inn.
  const visNavn = () => { if (k.getZoom() >= 13) k.removeLayer(navn); else if (!k.hasLayer(navn)) navn.addTo(k); };
  k.on('zoomend', visNavn);
  visNavn();
}

let minPosisjon = null;
function visMinPosisjon() {
  if (!navigator.geolocation) { melding('Nettleseren kan ikke vise posisjonen din'); return; }
  navigator.geolocation.getCurrentPosition((p) => {
    const punkt = [p.coords.latitude, p.coords.longitude];
    const k = kartTilstand.kart;
    if (minPosisjon) minPosisjon.setLatLng(punkt);
    else minPosisjon = L.circleMarker(punkt, { radius: 8, color: '#FFFFFF', weight: 3, fillColor: '#2563EB', fillOpacity: 1 }).bindTooltip('Du er her').addTo(k);
    k.flyTo(punkt, Math.max(k.getZoom(), 13), { duration: 0.8 });
  }, () => melding('Fikk ikke tilgang til posisjonen din'), { enableHighAccuracy: true, timeout: 10000 });
}
