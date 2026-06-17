# Eesti Mütoloogiaveeb — projekt5

Hariduslik ja kultuuriline infosüsteem Eesti mütoloogilise pärimuse kohta.
Olendid on jaotatud seitsmesse mütoloogilisse sfääri ja seotud 1917. aasta
kihelkondade piiridega (Mapbox GL JS + GeoJSON).

![Eesti Mütoloogiaveebi ekraanipilt](docs/ekraanipilt.png)

## Eesmärk ja lühikirjeldus

Eesti mütoloogiline pärimus on laiali raamatutes, arhiivides ja akadeemilistes
allikates ning seda on tavakasutajal raske geograafiliselt ja temaatiliselt
hoomata. Mütoloogiaveeb koondab olendid ühte otsitavasse ja kaardipõhisesse
keskkonda, kus iga olend on seotud konkreetsete 1917. aasta kihelkondadega ja
varustatud allikaviidetega. Rakendus võimaldab sirvida, filtreerida ja
salvestada olendeid ning toimetajatel ja administraatoritel sisu lisada ja
modereerida. Nii muutub Eesti rahvapärimus interaktiivseks, kontrollitavaks ja
hariduslikult kasutatavaks tervikuks.

## Loomise raamistik

Projekt on valminud **Tallinna Ülikooli Digitehnoloogiate Instituudi**
õppetöö raames objektorienteeritud programmeerimise ja veebiarenduse kursuse
arendusprojektina (Meeskond 12). Töö ühendab akadeemilise usaldusväärsuse
(allikaviited, modereeritud sisu) tänapäevase kasutajakogemusega
(kaardipõhine avastamine, otsing ja filtreerimine).

## Autorid

- Artjom Kudrjašov
- Joosep Tawan Turba
- Olaf Anton Kirsberg

## Kasutatud tehnoloogiad ja versioonid

| Tehnoloogia | Versioon | Roll |
|-------------|----------|------|
| Node.js | >= 22.5.0 | käituskeskkond |
| Express | ^4.19.2 | HTTP-server, REST API marsruudid |
| node:sqlite (sisseehitatud) | Node 22.5+ | andmebaas, ei vaja kompileerimist |
| better-sqlite3 | ^11.3.0 | SQLite tagavara vanemale Node'ile |
| jsonwebtoken | ^9.0.2 | JWT autentimine (httpOnly küpsis) |
| bcryptjs | ^2.4.3 | paroolide räsimine |
| cookie-parser | ^1.4.6 | küpsiste lugemine |
| express-rate-limit | ^7.4.1 | päringusageduse piiramine |
| multer | ^2.1.1 | failide üleslaadimine |
| dotenv | ^16.4.5 | keskkonnamuutujate laadimine |
| Mapbox GL JS | v3.0.1 | kaart ja kihelkondade kuvamine |

**Frontend:** puhas SPA (HTML + CSS + vanilla JavaScript), hash-marsruuter —
raamistikku ei kasutata.

## Vaated (V1–V6)

1. **V1 Avaleht** — hero, otsing, sfäärid, esiletõstetud olendid
2. **V2 Olendite nimekiri** — filtreerimine (otsing, sfäär, kihelkond) + sortimine
3. **V3 Olendi detail** — pilt (lightbox), kirjeldus, helimängija, asukohakaart, allikad, seotud olendid
4. **V4 Admin** — tabel staatustega (roheline/hall/kollane), staatuse muutmine, kustutamine
5. **V5 Profiil** — kasutaja andmed, roll, lemmikud
6. **V6 Vorm** — uue olendi lisamine / muutmine, dünaamilised asukohad ja allikaviited

## Paigaldus- ja arenduskeskkonna juhised

### Eeldused

- **Node.js 22.5.0 või uuem** (kontrolli: `node --version`).
  Node 22.5+ sisaldab sisseehitatud `node:sqlite` moodulit, mis ei vaja
  kompileerimist ega Visual Studio't.
- npm (tuleb Node'iga kaasa).
- Git (koodi allalaadimiseks).

### Sammud

```bash
# 1. Klooni repositoorium
git clone https://github.com/oosep/mytoloogiaveeb.git
cd mytoloogiaveeb

# 2. Paigalda sõltuvused
npm install

# 3. Loo keskkonnamuutujate fail
#    Kopeeri .env.example failiks .env ja täida väärtused
cp .env.example .env        # Windows PowerShell: copy .env.example .env

# 4. Käivita rakendus
npm start

# 5. Ava brauseris
#    http://localhost:3000
```

Esimesel käivitusel luuakse automaatselt andmebaasifail `mytoloogia.db`,
testkasutajad ja näidisolendid.

### Keskkonnamuutujad (`.env`)

| Muutuja | Kohustuslik | Selgitus |
|---------|-------------|----------|
| `JWT_SECRET` | jah | juhuslik salajane string JWT allkirjastamiseks |
| `MAPBOX_TOKEN` | jah (kaardi jaoks) | Mapboxi avalik token (`pk....`) |
| `LUBATUD_ORIGINID` | tootmises | komaeraldatud lubatud päritolu-URL-id (CSRF-kaitse). Arenduses võib tühi olla. |

Token ja saladused ei lähe kunagi GitHubi — `.env` on `.gitignore`-s, repos on
ainult `.env.example` näidisstruktuuriga.

### Testkasutajad

| Kasutajanimi | Parool         | Roll       |
|--------------|----------------|------------|
| `admin`      | `admin123`     | admin      |
| `toimetaja`  | `toimetaja123` | toimetaja  |
| `kylastaja`  | `kylastaja123` | kasutaja   |

- **Admin** näeb halduslauda, kinnitab sisu, muudab staatusi.
- **Toimetaja** saab lisada/muuta olendeid — uus sisu läheb *modereerimisele*.
- **Kasutaja/külastaja** saab sirvida ja salvestada lemmikuid.

> Uued registreerunud saavad vaikimisi rolli **toimetaja**. Soovi korral muuda
> see `server.js` failis (`/api/auth/register`) `'kasutaja'`-ks.

## Andmebaasi struktuur

Andmebaas luuakse automaatselt failist `database.sql` (või `server.js`
sisseehitatud skeemist). Kõik laused on `IF NOT EXISTS` — korduv käivitamine on
turvaline. Allpool tabelite ülevaade; täielik skeem koos kommentaaride ja
MySQL-migratsiooni juhistega on failis [`database.sql`](database.sql).

**Tabelid:**

- `kasutajad` — kasutajakontod (kasutajanimi, e-post, bcrypt-räsitud parool, roll)
- `olendid` — mütoloogilised olendid (nimi, kirjeldus, sfäär, staatus, pilt, heli, autor)
- `olendi_asukohad` — olendi seos 1917. a kihelkondadega (kihelkond, maakond)
- `allikad` — olendi allikaviited (viide, URL)
- `lemmikud` — kasutaja ja olendi seos (lemmikud)
- `manused` — üleslaaditud piltide/helifailide metaandmed (failid ise asuvad `uploads/` väljaspool veebijuurikat)
- `audit_logi` — turvalogi (sisselogimiskatsed, failitegevused jne)

Näidis — kasutajate tabeli loomise lause (kopeeritav):

```sql
CREATE TABLE IF NOT EXISTS kasutajad (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kasutajanimi  TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL UNIQUE,
  parool        TEXT NOT NULL,                       -- bcrypt räsi
  roll          TEXT NOT NULL DEFAULT 'kasutaja',    -- kasutaja | toimetaja | admin
  loodud_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Paroole ei külvata kunagi SQL-failist — testkasutajad luuakse `server.js`
funktsioonis `seedData()`, kus paroolid bcrypt-räsitakse. Nii ei hoita paroole
kunagi avatekstina.

## Testid

```bash
npm test
```

Kasutab Node.js sisseehitatud testiraamistikku (`node --test`). Testid asuvad
kaustas `test/` (API, failivalideerimine jm).

## Zone.ee juurutamine (Node.js)

1. Lae kogu kaust üles Zone.ee virtuaalserverisse.
2. **Zone App Manager** → loo uus Node.js rakendus, sea käivitusfailiks `server.js`.
3. Käivita `npm install` (App Manageri kaudu või SSH-iga).
4. Sea keskkonnamuutujad `JWT_SECRET`, `MAPBOX_TOKEN` ja `LUBATUD_ORIGINID`.
5. Rakendus serveerib nii API-t kui ka frontendi samast pordist.

### MySQL alternatiiv

Failis `database.sql` on skeem kommenteeritud MySQL-i migratsioonijuhistega.
SQLite töötab Zone.ee-s ilma lisaseadistuseta; MySQL-i kasutamiseks kohanda
`server.js` andmebaasikiht (`better-sqlite3` → `mysql2`).

## Litsents

See projekt on litsentseeritud **MIT litsentsi** alusel — vaata
[`LICENSE`](LICENSE) faili täisteksti jaoks.