'use strict';
// Fanen «Potensielle»: favoritter (selskaper med stjerne) og forslag fra portalen.
// Bruker hjelpefunksjonene i app.js ($, $$, api, esc, kr, ekCelle, penNavn, kortRevisor, apnePanel, oppdater …).

const POT_FORSLAG = {
  beste: { navn: 'Beste totalt', params: { ek: 'positiv', profil: 'vatnem', ringt: 'nei', status: 'ny', tilknyttet: 'ukontaktet' } },
  uten: { navn: 'Revisjonspliktige uten revisor', params: { revisor: 'plikt_uten', ringt: 'nei', status: 'ny' } },
  nettverk: { navn: 'Felles person med Vatnem-kunde', params: { tilknyttet: 'vatnem', ringt: 'nei', status: 'ny' } },
  bytte: { navn: 'Byttekandidater (har revisor)', params: { revisor: 'har', ek: 'positiv', profil: 'vatnem', ringt: 'nei', status: 'ny', tilknyttet: 'ukontaktet' } },
  nye: { navn: 'Nyetablerte', params: { nye: '365', ringt: 'nei', status: 'ny' } },
};
const potTilstand = { valg: 'beste', side: 0, rader: [], totalt: 0 };

// Hvorfor selskapet er interessant for Vatnem.
function potGrunner(r) {
  const g = [];
  if (r.revisjonspliktig && !r.revisor_navn && r.roller_hentet) g.push(['Revisjonspliktig uten revisor', 'm-violet']);
  else if (!r.revisjonspliktig && r.plikt_andel >= 0.7 && !r.revisor_navn) g.push(['Nær revisjonsplikt', 'm-amber']);
  if (r.tilknyttede_vatnem) g.push([r.tilknyttede_vatnem === 1 ? 'Felles person med Vatnem-kunde' : `Felles person med ${r.tilknyttede_vatnem} Vatnem-kunder`, 'm-green']);
  if (r.fravalg_revisjon) g.push(['Har valgt bort revisjon', 'm-gray']);
  if (r.stiftet && Date.now() - new Date(r.stiftet).getTime() < 365 * 864e5) g.push(['Nyetablert', 'm-blue']);
  if (r.revisor_navn && !r.er_kunde) g.push([`Byttekandidat fra ${kortRevisor(r.revisor_navn)}`, 'm-gray']);
  if (r.egenkapital > 0 && r.aarsresultat > 0) g.push(['Solid og lønnsom', 'm-blue']);
  return g.slice(0, 4);
}

function potKort(r, { favoritt = false } = {}) {
  const status = statusInfo(r.status);
  const ansvarlig = tilstand.meta.brukere.find((b) => b.id === r.ansvarlig_id)?.navn;
  const iDag = new Date().toLocaleDateString('sv-SE');
  const oppfolging = r.oppfolging_dato
    ? `<span class="${r.oppfolging_dato <= iDag ? 'neg' : ''}">${r.oppfolging_dato <= iDag ? 'Følg opp nå' : 'Følg opp ' + dato(r.oppfolging_dato)}</span>` : '';
  return `<article class="pot-kort${favoritt ? ' favoritt' : ''}" data-orgnr="${esc(r.orgnr)}">
    <div class="pot-kort-topp">
      <div class="pot-kort-tittel">
        <h3><button type="button" class="pot-navn" data-pot-apne>${esc(penNavn(r.navn))}</button></h3>
        <div class="pot-under">${esc(penNavn(r.kommune || ''))}${r.nace_tekst ? ' · ' + esc(r.nace_tekst) : ''}</div>
      </div>
      <button type="button" class="stjerne ${r.prioritet ? 'pa' : ''}" data-pot-stjerne aria-pressed="${r.prioritet ? 'true' : 'false'}"
        title="${r.prioritet ? 'Fjern fra favoritter' : 'Legg til i favoritter'}" aria-label="${r.prioritet ? 'Fjern fra favoritter' : 'Legg til i favoritter'}">
        <svg viewBox="0 0 24 24" aria-hidden="true">${IKON.stjerne}</svg></button>
    </div>
    <div class="pot-grunner">${potGrunner(r).map(([t, k]) => `<span class="merkelapp ${k}">${esc(t)}</span>`).join('')}</div>
    <div class="pot-tall">
      <div><span>Inntekt</span><b>${kr(r.driftsinntekter)}</b></div>
      <div><span>Egenkapital</span><b>${ekCelle(r.egenkapital)}</b></div>
      <div><span>Ansatte</span><b>${r.ansatte ?? '–'}</b></div>
      <div><span>Poeng</span><b>${r.poeng}</b></div>
    </div>
    <div class="pot-person">${r.daglig_leder ? esc(r.daglig_leder) + ', daglig leder' : 'Daglig leder ikke registrert'}
      · Revisor: ${esc(r.revisor_navn ? kortRevisor(r.revisor_navn) : r.fravalg_revisjon ? 'valgt bort' : 'ingen')}</div>
    <div class="pot-bunn">
      <div class="pot-status">
        <span class="status-pille s-${esc(r.status)}">${esc(status.navn)}</span>
        ${favoritt && ansvarlig ? `<span class="dempet">${esc(ansvarlig)}</span>` : ''}
        ${favoritt ? oppfolging : ''}
      </div>
      <button type="button" class="knapp primar liten" data-pot-apne>Åpne</button>
    </div>
  </article>`;
}

async function lastPotensielle() {
  // Favoritter: alle med stjerne, også Vatnem-kunder.
  const fav = await api('/api/selskaper?' + new URLSearchParams({ prioritet: '1', kunder: 'vis', sorter: 'poeng', retning: 'desc', per_side: 200 }));
  $('#pot-fav-antall').textContent = nf.format(fav.totalt);
  $('#pot-favoritter').innerHTML = fav.rader.length
    ? fav.rader.map((r) => potKort(r, { favoritt: true })).join('')
    : `<div class="pot-tom"><svg viewBox="0 0 24 24" aria-hidden="true">${IKON.stjerne}</svg>
        <p><strong>Ingen favoritter ennå.</strong> Trykk på stjernen på et selskap, her nede, i selskapslisten eller i detaljvisningen, for å legge det her.</p></div>`;
  potTilstand.side = 0;
  potTilstand.rader = [];
  await lastForslag();
}

async function lastForslag(flere = false) {
  const valg = POT_FORSLAG[potTilstand.valg];
  if (!flere) { potTilstand.side = 0; potTilstand.rader = []; }
  const d = await api('/api/selskaper?' + new URLSearchParams({ ...valg.params, sorter: 'poeng', retning: 'desc', per_side: 24, side: potTilstand.side }));
  potTilstand.rader.push(...d.rader);
  potTilstand.totalt = d.totalt;
  $('#pot-forslag').innerHTML = potTilstand.rader.length
    ? potTilstand.rader.map((r) => potKort(r)).join('')
    : '<div class="pot-tom"><p>Ingen selskaper i denne kategorien akkurat nå.</p></div>';
  $('#pot-forslag-antall').textContent = `${nf.format(d.totalt)} selskaper`;
  $('#pot-mer').hidden = potTilstand.rader.length >= d.totalt;
}

function initPotensielle() {
  const chips = $('#pot-filter');
  chips.innerHTML = Object.entries(POT_FORSLAG).map(([k, v]) =>
    `<button type="button" class="chip${k === potTilstand.valg ? ' aktiv' : ''}" data-pot-valg="${k}">${esc(v.navn)}</button>`).join('');
  chips.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pot-valg]');
    if (!b) return;
    potTilstand.valg = b.dataset.potValg;
    $$('[data-pot-valg]', chips).forEach((x) => x.classList.toggle('aktiv', x === b));
    lastForslag();
  });
  $('#pot-mer').addEventListener('click', () => { potTilstand.side++; lastForslag(true); });
  $('#fane-potensielle').addEventListener('click', async (e) => {
    const kort = e.target.closest('.pot-kort');
    if (!kort) return;
    const orgnr = kort.dataset.orgnr;
    if (e.target.closest('[data-pot-stjerne]')) {
      const pa = !e.target.closest('[data-pot-stjerne]').classList.contains('pa');
      if (await oppdater(orgnr, { prioritet: pa })) {
        melding(pa ? 'Lagt til i favoritter' : 'Fjernet fra favoritter');
        lastPotensielle();
      }
      return;
    }
    if (e.target.closest('[data-pot-apne]')) apnePanel(orgnr);
  });
}
document.addEventListener('DOMContentLoaded', initPotensielle);
