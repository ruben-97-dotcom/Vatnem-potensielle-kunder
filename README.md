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

- **Hvert 30. minutt** leser portalen Brregs endringsfeeder for selskaper og roller, og henter bare selskapene som
  er endret. Nye selskaper i området kommer dermed inn innen en halvtime. Intervallet kan endres med
  `ENDRINGER_INTERVALL_MIN`.
- **Hver uke** gjøres en full oppdatering av alle selskaper, roller og regnskap (rundt 2 minutter).
- Begge kan også startes manuelt fra oversiktssiden. Oppdateringene rører aldri statuser, notater eller annen
  oppfølging.

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

Krever Node.js 22.13 eller nyere.

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

## Publisere på nett (Render)

Repoet inneholder `render.yaml` for [Render](https://render.com):

1. Opprett en konto på Render og koble til GitHub-repoet.
2. Velg **New → Blueprint** og pek på dette repoet. Render leser `render.yaml`.
3. Fyll inn `BRUKERE` med navn og koder når Render ber om det.
4. Ved første oppstart henter portalen dataene selv. Det tar et par minutter.

Oppsettet bruker Starter-planen med en fast disk på 1 GB, slik at databasen overlever omstart. Gratisplanen har
ikke fast disk, og der ville statuser og notater blitt slettet ved hver omstart. Andre tjenester med fast disk,
for eksempel Railway eller Fly.io, fungerer også. Sett `DATA_DIR` til mappen der disken er montert.

## Teknisk

- `src/server.js`: Express-server og API
- `src/brreg.js`: henter data fra Enhetsregisteret og Regnskapsregisteret
- `src/auth.js`: innlogging, økter og sperre mot gjetting
- `src/db.js`: SQLite-database (innebygd i Node, `node:sqlite`)
- `public/`: grensesnittet (HTML, CSS og JavaScript uten rammeverk)
