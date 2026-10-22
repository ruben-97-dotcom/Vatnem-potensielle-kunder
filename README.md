# Vatnem – potensielle kunder

Intern portal for å finne og følge opp potensielle revisjonskunder på Haugalandet og i Sunnhordland.

## Hva portalen inneholder

Portalen henter **alle aktive AS, ASA, samvirkeforetak og stiftelser** i Haugesund, Karmøy, Tysvær, Sveio, Stord,
Bokn, Utsira, Vindafjord, Etne, Bømlo og Fitjar fra Brønnøysundregistrenes åpne API-er. Selskaper som er konkurs
eller under avvikling er utelatt. For hvert selskap hentes:

- Navn, orgnr, bransje, adresse, antall ansatte, telefon, e-post og hjemmeside (når de er registrert)
- Daglig leder, styreleder, **revisor i dag** og regnskapsfører
- Siste årsregnskap: driftsinntekter, driftsresultat, årsresultat, **egenkapital**, sum eiendeler, og om
  revisjon er valgt bort

Selskaper som allerede har Vatnem Revisjon som revisor er merket som eksisterende kunder og skjult som standard.
Dataene oppdateres automatisk hver uke, eller med knappen på oversiktssiden. Oppdateringen tar rundt 2 minutter og
rører aldri statuser, notater eller annen oppfølging.

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
