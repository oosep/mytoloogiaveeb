# Eesti Mütoloogiaveeb — projekt5

Hariduslik ja kultuuriline infosüsteem Eesti mütoloogilise pärimuse kohta.
Olendid on jaotatud seitsmesse mütoloogilisse sfääri ja seotud 1917. aasta
kihelkondade piiridega (Mapbox GL JS + GeoJSON).

## Tehnoloogiad

- **Backend:** Node.js + Express
- **Andmebaas:** SQLite — üks fail, ei vaja eraldi serverit. Kasutab Node.js sisseehitatud `node:sqlite` moodulit (Node 22.5+/24), mis EI vaja kompileerimist ega Visual Studio't. Vanema Node'i korral kasutatakse automaatselt `better-sqlite3` tagavarana.
- **Autentimine:** JWT (httpOnly küpsis) + bcrypt paroolide räsimine
- **Frontend:** puhas SPA (HTML + CSS + vanilla JS), hash-marsruuter
- **Kaart:** Mapbox GL JS

## Vaated (V1–V6)

1. **V1 Avaleht** — hero, otsing, sfäärid, esiletõstetud olendid
2. **V2 Olendite nimekiri** — filtreerimine (otsing, sfäär, kihelkond) + sortimine
3. **V3 Olendi detail** — pilt (lightbox), kirjeldus, helimängija, asukohakaart, allikad, seotud olendid
4. **V4 Admin** — tabel staatustega (roheline/hall/kollane), staatuse muutmine, kustutamine
5. **V5 Profiil** — kasutaja andmed, roll, lemmikud
6. **V6 Vorm** — uue olendi lisamine / muutmine, dünaamilised asukohad ja allikaviited

## Kohalik käivitamine

```bash
npm install
npm start
# Ava http://localhost:3000
```

Esimesel käivitusel luuakse `mytoloogia.db`, testkasutajad ja näidisolendid.

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

## Zone.ee juurutamine (Node.js)

1. Lae kogu kaust üles Zone.ee virtuaalserverisse.
2. **Zone App Manager** → loo uus Node.js rakendus, sea käivitusfailiks `server.js`.
3. Käivita `npm install` (App Manageri kaudu või SSH-iga).
4. Sea keskkonnamuutuja `JWT_SECRET` (turvaline juhuslik string).
5. Rakendus serveerib nii API-t kui ka frontendi samast pordist.

### MySQL alternatiiv

Failis `database.sql` on skeem kommenteeritud MySQL-i migratsioonijuhistega.
SQLite töötab Zone.ee-s ilma lisaseadistuseta; MySQL-i kasutamiseks kohanda
`server.js` andmebaasikiht (`better-sqlite3` → `mysql2`).

## Mapbox

Mapboxi token loetakse keskkonnamuutujast `MAPBOX_TOKEN`.

- **Kohalikul arendamisel:** kopeeri `.env.example` failiks `.env` ja lisa oma token sinna.
- **Zone.ee-l:** sea `MAPBOX_TOKEN` Zone App Manageri keskkonnamuutujate all.

Token ei ole koodis ega lähe GitHubi.