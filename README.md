# Vatnem – potensielle kunder

Intern portal for å finne og følge opp potensielle revisjonskunder på Haugalandet og i Sunnhordland.

## Hva portalen inneholder

Portalen henter **alle aktive AS, ASA, samvirkeforetak og stiftelser** i Haugesund, Karmøy, Tysvær, Sveio, Stord,
Bokn, Utsira, Vindafjord, Etne, Bømlo og Fitjar fra Brønnøysundregistrenes åpne API-er. Selskaper som er konkurs
eller under avvikling er utelatt. For hvert selskap hentes:

- Navn, orgnr, bransje, adresse, antall ansatte, telefon, e-post og hjemmeside (når de er registrert)
- Daglig leder, styreleder, **revisor i dag** og regnskapsfører
- Siste årsregnskap: driftsinntekter, driftsresultat, årsresultat, **egenkapital**, sum eiendeler, sum gjeld,
  og om revisjon er valgt bort
- Alle personer i ledelse og styre, brukt til å finne **tilknyttede selskaper**

### Tilknyttede selskaper

To selskaper regnes som tilknyttet når samme person er daglig leder, styreleder, styremedlem, nestleder,
kontaktperson eller deltaker i begge. Personer matches på navn og fødselsdato, slik at navnebrødre ikke blandes.
Fødselsdatoen lagres ikke, bare en anonym nøkkel. Detaljvisningen viser alle tilknyttede selskaper i regionen,
med status og hvem som eier dem, og varsler hvis ett av dem allerede er kontaktet eller er kunde. I listen er slike
selskaper merket med ⚠, og ringelisten skjuler dem automatisk.

Eierskap (aksjonærregisteret) finnes ikke i de åpne API-ene. Et holdingselskap uten felles person i styret blir
derfor ikke fanget opp.

Selskaper som allerede har Vatnem Revisjon som revisor er merket som eksisterende kunder og skjult som standard.

### Oppdatering mot Brreg

Arbeidet legges i en kø i databasen og gjøres i biter, slik at det tåler begrenset kjøretid på Vercel. En kjøring
som ikke blir ferdig, fortsetter der den slapp.

- **Endringer** (nye selskaper, revisorbytte osv.): leser Brregs endringsfeeder og oppdaterer bare selskapene som
  er endret. Kjøres når portalen er i bruk og forrige sjekk er eldre enn 30 minutter (`ENDRINGER_INTERVALL_MIN`),
  og av Vercel Cron hver natt. Lokalt kjøres den hvert 30. minutt.
- **Full oppdatering** av alle selskaper, roller og regnskap: automatisk hvis den forrige er over en uke gammel.
- Begge kan startes manuelt fra oversiktssiden. Oppdateringene rører aldri statuser, notater eller annen oppfølging.

### Felles mål

Oversikten viser et fjell der toppen er hovedmålet (for eksempel 30 nye kunder) og etappene er felles delmål
underveis (for eksempel «Ringe 50 selskaper» eller «10 møter»). Målene settes med «Sett mål» øverst til høyre og er
felles for alle brukere. Fremdriften regnes fra statusene: et selskap som har kommet lenger i løypa teller også på
de tidligere stegene. Uten delmål viser fjellet salgstrakten (basecamp, ringt, interessert, møte, tilbud, vunnet).

### Varsler

Fanen **Varsler** (med teller for uleste) viser:

- Revisor har gått av, revisorbytte og ny revisor
- Regnskapsfører har gått av, bytte og ny regnskapsfører
- Nye selskaper registrert i området, og selskaper som har flyttet hit
- Selskaper uten revisor som har passert grensen for revisjonsplikt

### Revisjonsplikt

Fanen **Revisjonsplikt** viser selskaper uten revisor som er over grensen, eller over 70 % av den, med stolper som
viser hvor nær de er grensene for inntekt (7 mill) og balanse (27 mill).

### Detaljer om hvert selskap

Når et selskap åpnes, hentes dette direkte fra Brreg: alle roller med navn, avdelinger, aksjekapital, formål,
tidligere navn, MVA-registrering, utvikling i regnskapet de siste tre årene, og flere regnskapstall (lønn,
driftskostnader, bank, kortsiktig og langsiktig gjeld, om regnskapet er revidert).

Brreg har ikke telefonnummer til personer. Ved daglig leder og styreleder er det derfor felt for å lagre
telefonnummer, og knapper som søker opp personen hos 1881 og Gulesider.

### Oppfølging

- Status per selskap: Ikke kontaktet, Ringt – ikke svar, Ring tilbake, Interessert, Møte avtalt, Tilbud sendt,
  Kunde vunnet, Ikke interessert, Ikke aktuell
- «Ringt»-avkrysning, neste oppfølgingsdato, ansvarlig, kontaktperson og prioritet (★)
- Notater og samtalelogg med full historikk over hvem som gjorde hva
- Oversikt med salgstrakt, siste aktivitet og snarveier (ringeliste, forfalte oppfølginger, byttekandidater m.m.)
- **Revisormarkedet**: hvilke revisorer som har kundene i regionen
- Filtre på kommune, status, egenkapital, revisor, størrelse, bransje m.m., og eksport til CSV (Excel)

### Prioriteringspoeng (0–100)

Poengene er ment som en hjelp til å sortere ringelisten:

| Kriterium | Poeng |
|---|---|
| Positiv egenkapital | 20 |
| Driftsinntekter (fra 0,5 mill til over 100 mill) | 3–30 |
| Antall ansatte | 3–10 |
| Positivt årsresultat | 10 |
| Trolig revisjonspliktig | 10 |
| Trolig revisjonspliktig, men har ingen revisor | +10 |
| Regnskap fra de siste to årene | 10 |

«Trolig revisjonspliktig» er et estimat: driftsinntekter fra 7 mill, balanse fra 27 mill, eller 10 eller flere
ansatte. Grensene står i `src/config.js`. Ansatte i registeret er personer og ikke årsverk, så dersom selskapet selv
har oppgitt at revisjon er valgt bort, regnes bare inntekt og balanse.

## Kjøre lokalt

Krever Node.js 22 eller nyere.

```bash
npm install
```

```bash
npm run hent-data
```

```bash
npm start
```

Åpne deretter http://localhost:3000.

## Brukere og innloggingskoder

Hver bruker logger inn med en personlig 6-sifret kode. Kodene lagres kryptert (hashet) i databasen. Etter 5 feil
forsøk fra samme IP-adresse sperres innloggingen i 15 minutter, og etter 30 feil totalt i løpet av en time sperres
den for alle.

Brukere kan settes opp på to måter:

1. **Miljøvariabel** (anbefalt ved hosting): `BRUKERE="Ruben:123456;Kari:654321"`. Lokalt ligger denne i `.env`,
   som ikke legges i git.
2. **Kommando**: `npm run legg-til-bruker -- "Navn"` lager en tilfeldig kode og skriver den ut. Legg til en kode
   etter navnet for å velge den selv.

## Publisere på Vercel

Appen kjører på Vercel som én funksjon (Express), med databasen i [Turso](https://turso.tech) (SQLite i skyen).

1. **Database:** I Vercel-prosjektet, gå til **Storage** (eller **Marketplace**) og legg til **Turso**. Opprett en
   database og koble den til prosjektet. Da legges `TURSO_DATABASE_URL` og `TURSO_AUTH_TOKEN` inn automatisk.
   Alternativt kan du opprette databasen på turso.tech og legge inn de to verdiene selv.
2. **Miljøvariabler** under **Settings → Environment Variables**:
   - `BRUKERE`: navn og koder, samme format som i `.env` (f.eks. `Ruben:123456;Judith:654321`)
   - `CRON_SECRET`: verdien fra `.env` (brukes av Vercel Cron og når en oppdatering fortsetter seg selv)
3. **Flytt dataene:** legg `TURSO_DATABASE_URL` og `TURSO_AUTH_TOKEN` inn i `.env` lokalt og kjør
   `npm run migrer`. Det kopierer selskaper, statuser, notater, mål og brukere fra den lokale fila til Turso.
   Hopper du over dette, henter portalen alt fra Brreg selv i biter, og det tar en stund.
4. **Send ut på nytt:** **Deployments → Redeploy**, slik at miljøvariablene blir med.

`vercel.json` setter opp en cron-jobb hver natt. På gratisplanen (Hobby) kan cron bare kjøre én gang i døgnet;
den halvtimelige sjekken skjer derfor når portalen brukes. På Pro kan cron settes til f.eks. `*/30 * * * *`.

Lokalt bruker appen fortsatt fila `data/portal.db`, med mindre `TURSO_DATABASE_URL` er satt i `.env`.
`render.yaml` er beholdt: appen kan fortsatt kjøres på Render med fast disk i stedet for Vercel.

## Teknisk

- `src/server.js`: Express-app og API (eksporteres for Vercel, starter egen server lokalt)
- `src/brreg.js`: henter data fra Enhetsregisteret og Regnskapsregisteret, med kø og tidsbudsjett
- `src/auth.js`: innlogging, økter og sperre mot gjetting (alt i databasen)
- `src/db.js`: database via libSQL – Turso i skyen eller lokal SQLite-fil
- `scripts/migrer-til-turso.js`: kopierer lokale data til Turso
- `public/`: grensesnittet (HTML, CSS og JavaScript uten rammeverk)
