/**
 * Eesti Mütoloogiaveeb — server.js
 * ---------------------------------
 * Täielik Express taustasüsteem (backend) projekt5 jaoks.
 *
 * Tehnoloogiad:
 *   - Express        : HTTP server ja API marsruudid
 *   - better-sqlite3 : sünkroonne, kiire SQLite andmebaas (üks fail, Zone.ee sõbralik)
 *   - bcryptjs       : paroolide räsimine (puhas JS, ei vaja kompileerimist)
 *   - jsonwebtoken   : JWT-põhine autentimine
 *
 * Käivitamine:
 *   npm install
 *   npm start
 *
 * Server serveerib ka staatilisi faile kaustast /public, seega kogu rakendus
 * (frontend + backend) töötab ühest Node protsessist — ideaalne Zone.ee jaoks.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const turve = require('./turve');
const failid = require('./failid');

/*
 * Andmebaasi draiver.
 * Eelistame Node.js sisseehitatud 'node:sqlite' moodulit (Node 22.5+), mis EI
 * vaja kompileerimist ega Visual Studio't. Kui see pole saadaval (vanem Node),
 * proovime 'better-sqlite3'. Mõlemad pakuvad siin kasutatud API alamhulka.
 */
function loadDatabase() {
  // 1) Sisseehitatud node:sqlite (Node 22.5+/24) — soovitatud, ei vaja midagi paigaldada
  try {
    const { DatabaseSync } = require('node:sqlite');

    // Õhuke adapter, mis annab better-sqlite3-laadse liidese.
    class Database {
      constructor(file) {
        this._db = new DatabaseSync(file);
      }
      // pragma('foreign_keys = ON') / pragma('journal_mode = WAL')
      pragma(str) {
        this._db.exec(`PRAGMA ${str};`);
      }
      exec(sql) {
        this._db.exec(sql);
      }
      prepare(sql) {
        const stmt = this._db.prepare(sql);
        return {
          get: (...args) => stmt.get(...args),
          all: (...args) => stmt.all(...args),
          run: (...args) => {
            const r = stmt.run(...args);
            // node:sqlite tagastab { changes, lastInsertRowid } — sama mis better-sqlite3
            return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
          },
        };
      }
      // better-sqlite3 .transaction(fn) → tagastab kutsutava funktsiooni
      transaction(fn) {
        const dbi = this._db;
        return (...args) => {
          dbi.exec('BEGIN');
          try {
            const result = fn(...args);
            dbi.exec('COMMIT');
            return result;
          } catch (e) {
            dbi.exec('ROLLBACK');
            throw e;
          }
        };
      }
    }
    return Database;
  } catch (_) {
    // 2) Tagavara: better-sqlite3 (vajab eelkompileeritud binaari või build-tööriistu)
    return require('better-sqlite3');
  }
}
const Database = loadDatabase();

// --- Konfiguratsioon ------------------------------------------------------
// Lae .env fail, kui see on olemas (arenduseks; toodangus kasutatakse päris env muutujaid)
try { require('dotenv').config(); } catch (_) { /* dotenv pole kohustuslik */ }

const PORT         = process.env.PORT         || 3000;
const JWT_SECRET   = process.env.JWT_SECRET   || 'mytoloogiaveeb-arenduse-saladus-muuda-toodangus';
const ON_TOODANG   = process.env.NODE_ENV === 'production';
if (JWT_SECRET === 'mytoloogiaveeb-arenduse-saladus-muuda-toodangus') {
  if (ON_TOODANG) {
    // Tootmises EI tohi vaikeväärtusega käivituda — see oleks kriitiline turvaauk
    console.error('\n❌  KRIITILINE: JWT_SECRET on seadmata tootmises. Server ei käivitu.\n');
    process.exit(1);
  }
  console.warn('\n⚠️  HOIATUS: JWT_SECRET on vaikeväärtus! Sea .env failis oma tugev saladus.\n');
}
if (ON_TOODANG && JWT_SECRET.length < 32) {
  console.error('\n❌  KRIITILINE: JWT_SECRET peab olema vähemalt 32 tähemärki. Server ei käivitu.\n');
  process.exit(1);
}
const DB_PATH      = process.env.DB_PATH      || path.join(__dirname, 'mytoloogia.db');
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || '';

// Manuste kaust — VÄLJASPOOL veebijuurikat (/public). Faile ei serveerita
// kunagi otse kettalt, vaid ainult läbi kontrollitud API marsruudi.
const MANUSTE_KAUST = process.env.MANUSTE_KAUST || path.join(__dirname, 'uploads');
fs.mkdirSync(MANUSTE_KAUST, { recursive: true });
if (ON_TOODANG && !process.env.MANUSTE_VOTI) {
  console.warn('⚠️  MANUSTE_VOTI on seadmata — üleslaaditud faile EI krüpteerita kettal.');
}

const app = express();
app.set('trust proxy', 1); // Railway (ja teised reverse proxy-d) seab X-Forwarded-For
app.use(turve.turvapaised);            // turvalised HTTP-päised igale vastusele
app.use(express.json({ limit: '1mb' })); // 5mb -> 1mb: väiksem DoS-pind
app.use(cookieParser());

// Küpsise valikud — `secure` ainult HTTPS-i all (Railway), arenduses localhostis mitte
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'strict',
  secure: ON_TOODANG,
  maxAge: 7 * 864e5,
};

// --- Turvalisus: rate limiting --------------------------------------------

// Üldine piirmäär kõigile API päringutele
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutit
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { viga: 'Liiga palju päringuid, proovi mõne minuti pärast uuesti.' },
});

// Rangem piirmäär sisselogimisele ja registreerimisele (brute force kaitse)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutit
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { viga: 'Liiga palju sisselogimiskatseid, proovi 15 minuti pärast uuesti.' },
  skipSuccessfulRequests: true, // edukaid päringuid ei loeta
});

// Eraldi piirmäär failide üleslaadimisele (DoS-kaitse: suured kehad on kallid)
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutit
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { viga: 'Liiga palju üleslaadimisi, proovi hiljem uuesti.' },
});

app.use('/api/', apiLimiter);

// --- Turvaline Origin kontroll (CSRF kaitse) ------------------------------
// Toodangus luba ainult oma domeeni päringuid.
const LUBATUD_ORIGINID = (process.env.LUBATUD_ORIGINID || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use('/api/', (req, res, next) => {
  // GET ja HEAD on ohutud (ei muuda andmeid)
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin || req.headers.referer || '';

  // Arenduses (mitte tootmises) luba localhost / tühi Origin (nt curl, Postman).
  if (!ON_TOODANG) {
    if (!origin) return next();
    try {
      const host = new URL(origin).hostname;
      if (host === 'localhost' || host === '127.0.0.1') return next();
    } catch (_) { return next(); } // parsimatu Origin arenduses -> luba
  }

  // Tootmises: Origin PEAB olema olemas ja lubatud nimekirjas (mitte ainult startsWith).
  if (ON_TOODANG && LUBATUD_ORIGINID.length === 0) {
    console.warn('⚠️  LUBATUD_ORIGINID on seadmata — kõik muutvad päringud blokeeritakse.');
  }
  let lubatud = false;
  try {
    const host = origin ? new URL(origin).hostname : '';
    lubatud = LUBATUD_ORIGINID.some((o) => {
      try { return new URL(o).hostname === host; } catch { return false; }
    });
  } catch (_) { lubatud = false; }

  if (!lubatud) {
    return res.status(403).json({ viga: 'Keelatud päritolu.' });
  }
  next();
});

// --- Sisendi valideerimise abifunktsioonid --------------------------------
const LUBATUD_SFAARID = ['Mets', 'Vesi', 'Kodu', 'Ilm', 'Kivid ja koopad', 'Põrgu', 'Muud'];

/**
 * TURVAPARANDUS: kontrollib, et URL kasutab AINULT http(s) protokolli.
 * Miks: frontend paneb need väärtused <img src>, <audio src> ja <a href>
 * atribuutidesse. HTML-escape (esc) kaitseb märgendisüsti eest, aga MITTE
 * "javascript:alert(1)" stiilis protokollisüsti eest — <a href="javascript:...">
 * käivitaks koodi kasutaja klõpsul. Valideerime serveris (mitte ainult
 * kliendis!), sest API-t saab kutsuda ka otse, vormist mööda minnes.
 */
function onTurvalineUrl(u) {
  if (!u) return true; // tühi väärtus on lubatud (väli pole kohustuslik)
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) {
    return false; // parsimatu string ei ole URL
  }
}

// Sisemise manuse viite muster: /api/failid/<32 hex>
const MANUSE_VIITE_RE = /^\/api\/failid\/([a-f0-9]{32})$/;

/**
 * Meedia-URL (pilt_url / heli_url) on lubatud, kui see on KAS sisemine
 * üleslaaditud manuse viide VÕI tavaline http(s) URL (pärand-kirjed). Muu
 * (javascript:, data: jne) lükatakse tagasi — vt onTurvalineUrl.
 */
function onTurvalineMeediaUrl(u) {
  if (!u) return true;
  if (typeof u === 'string' && MANUSE_VIITE_RE.test(u)) return true;
  return onTurvalineUrl(u);
}

/**
 * Kontrollib sisemist manuse viidet enne olendiga sidumist:
 * manus peab olemas olema, olema õiget liiki ning kuuluma kasutajale
 * (admin võib siduda kõiki). Tagastab { id } või { viga }.
 */
function kontrolliManuseViide(url, liik, user) {
  if (!url) return { id: null };
  const m = MANUSE_VIITE_RE.exec(url);
  if (!m) return { id: null }; // väline https URL (pärand) — pole midagi siduda
  const rida = db.prepare('SELECT id, liik, omanik_id FROM manused WHERE id = ?').get(m[1]);
  if (!rida) return { viga: 'Viidatud üleslaaditud faili ei leitud.' };
  if (rida.liik !== liik) return { viga: 'Viidatud fail on vale tüüpi.' };
  if (user.roll !== 'admin' && rida.omanik_id !== user.id) {
    return { viga: 'Saad kasutada ainult enda üleslaaditud faile.' };
  }
  return { id: rida.id };
}

/**
 * TURVAPARANDUS: ID-parameetri valideerimine.
 * SQL-süsti siin ei teki (kõik päringud on parameetriseeritud), aga
 * mittenumbriline ID põhjustaks asjatu DB-päringu ja kohati segase 500-vea.
 * Selge 400-vastus on nii turvalisem (vähem infot lekkimas) kui ka kasutajasõbralikum.
 */
function valiideeriId(req, res, next) {
  if (!/^\d{1,10}$/.test(String(req.params.id))) {
    return res.status(400).json({ viga: 'Vigane ID.' });
  }
  next();
}

function valideeriOlend(body) {
  const vead = [];
  if (!body.nimi || !body.nimi.trim()) vead.push('Olendi nimi on kohustuslik.');
  if (body.nimi && body.nimi.trim().length > 200) vead.push('Nimi on liiga pikk (max 200 tähemärki).');
  if (body.sfaar && !LUBATUD_SFAARID.includes(body.sfaar)) vead.push('Tundmatu sfäär.');
  if (body.kirjeldus && body.kirjeldus.length > 50000) vead.push('Kirjeldus on liiga pikk.');
  if (body.pilt_url && body.pilt_url.length > 1000) vead.push('Pildi URL on liiga pikk.');
  if (body.heli_url && body.heli_url.length > 1000) vead.push('Heli URL on liiga pikk.');

  // TURVAPARANDUS: protokollikontroll — väldi javascript:/data: URL-e.
  // Meediaväljad lubavad ka sisemist üleslaaditud manuse viidet (/api/failid/<id>).
  if (!onTurvalineMeediaUrl(body.pilt_url)) vead.push('Pildi URL peab olema üleslaaditud fail või http(s)-aadress.');
  if (!onTurvalineMeediaUrl(body.heli_url)) vead.push('Heli URL peab olema üleslaaditud fail või http(s)-aadress.');

  // TURVAPARANDUS: alam-massiivide piirid. Varem võis üks päring sisaldada
  // piiramatul hulgal asukohti/allikaid (kuni 1MB keha täis) — iga kirje
  // tähendab eraldi INSERT-i. Mõistlik ülempiir tõkestab andmebaasi
  // täispumpamise ühe päringuga.
  const asukohad = Array.isArray(body.asukohad) ? body.asukohad : [];
  const allikad = Array.isArray(body.allikad) ? body.allikad : [];
  if (asukohad.length > 30) vead.push('Liiga palju asukohti (max 30).');
  if (allikad.length > 30) vead.push('Liiga palju allikaid (max 30).');
  asukohad.forEach((a) => {
    if (a && a.kihelkond && String(a.kihelkond).length > 100) vead.push('Kihelkonna nimi on liiga pikk.');
    if (a && a.maakond && String(a.maakond).length > 100) vead.push('Maakonna nimi on liiga pikk.');
  });
  allikad.forEach((s) => {
    if (s && s.viide && String(s.viide).length > 500) vead.push('Allikaviide on liiga pikk (max 500).');
    if (s && s.url && String(s.url).length > 1000) vead.push('Allika URL on liiga pikk.');
    if (s && !onTurvalineUrl(s.url)) vead.push('Allika URL peab algama http:// või https://');
  });
  return vead;
}

// --- Audit log ------------------------------------------------------------
// TURVAPARANDUS: logisüsti tõkestamine. Kasutajanimi tuleb kasutaja käest —
// kui see sisaldaks reavahetust (\n), saaks ründaja logisse "võltsida" terve
// uue [AUDIT] rea ja varjata oma tegevust. Eemaldame kõik kontrollmärgid.
function puhastaLogiks(s) {
  return String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]/g, ' ');
}

function auditLog(kasutaja, tegevus, üksikasjad, ip) {
  const kellaaeg = new Date().toISOString();
  const kasutajaInfo = kasutaja
    ? (puhastaLogiks(kasutaja.kasutajanimi) + '(roll:' + puhastaLogiks(kasutaja.roll) + ')')
    : 'anonüüm';
  // JSON.stringify kodeerib \n ja muud erimärgid ise — üksikasjad on ohutud.
  console.log('[AUDIT] ' + kellaaeg + ' | ' + kasutajaInfo + ' | ' + tegevus + ' | ' + JSON.stringify(üksikasjad));
  // Püsiv jälg andmebaasis (audit_logi tabel).
  try {
    db.prepare('INSERT INTO audit_logi (kasutaja_id, kasutajanimi, tegevus, yksikasjad, ip) VALUES (?, ?, ?, ?, ?)')
      .run(kasutaja ? kasutaja.id : null, kasutaja ? kasutaja.kasutajanimi : null,
           tegevus, JSON.stringify(üksikasjad || {}), ip || null);
  } catch (e) {
    console.error('[AUDIT] andmebaasi kirje ebaõnnestus:', e.message);
  }
}

// --- Andmebaasi ühendus ja initsialiseerimine -----------------------------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Loob skeemi ja külvab testandmed, kui andmebaas on tühi.
 * Sama loogika on ka failis database.sql (MySQL/SQLite migratsiooniks).
 */
function initDatabase() {
  const schemaPath = path.join(__dirname, 'database.sql');
  if (fs.existsSync(schemaPath)) {
    // database.sql sisaldab CREATE TABLE IF NOT EXISTS lauseid (idempotentne)
    const schema = fs.readFileSync(schemaPath, 'utf8');
    // Eemaldame MySQL-spetsiifilised read, mis SQLite ei mõista (kommenteeritud sektsioonid)
    const sqliteSchema = schema
      .split('\n')
      .filter((line) => !line.trim().startsWith('-- MYSQL'))
      .join('\n');
    try {
      db.exec(sqliteSchema);
    } catch (err) {
      // Kui database.sql sisaldab MySQL-spetsiifikat, kasutame sisseehitatud skeemi
      console.warn('database.sql laadimine ebaõnnestus, kasutan sisseehitatud skeemi:', err.message);
      db.exec(BUILTIN_SCHEMA);
    }
  } else {
    db.exec(BUILTIN_SCHEMA);
  }
  seedData();
}

// Sisseehitatud SQLite skeem (varuvariant) ---------------------------------
const BUILTIN_SCHEMA = `
CREATE TABLE IF NOT EXISTS kasutajad (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kasutajanimi  TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL UNIQUE,
  parool        TEXT NOT NULL,
  roll          TEXT NOT NULL DEFAULT 'kasutaja',
  loodud_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS olendid (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  nimi          TEXT NOT NULL,
  kirjeldus     TEXT NOT NULL DEFAULT '',
  sfaar         TEXT NOT NULL DEFAULT 'Muud',
  staatus       TEXT NOT NULL DEFAULT 'mustand',
  pilt_url      TEXT,
  heli_url      TEXT,
  autor_id      INTEGER,
  loodud_at     TEXT NOT NULL DEFAULT (datetime('now')),
  muudetud_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (autor_id) REFERENCES kasutajad(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS olendi_asukohad (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  olend_id      INTEGER NOT NULL,
  kihelkond     TEXT NOT NULL,
  maakond       TEXT,
  FOREIGN KEY (olend_id) REFERENCES olendid(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS allikad (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  olend_id      INTEGER NOT NULL,
  viide         TEXT NOT NULL,
  url           TEXT,
  FOREIGN KEY (olend_id) REFERENCES olendid(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lemmikud (
  kasutaja_id   INTEGER NOT NULL,
  olend_id      INTEGER NOT NULL,
  PRIMARY KEY (kasutaja_id, olend_id),
  FOREIGN KEY (kasutaja_id) REFERENCES kasutajad(id) ON DELETE CASCADE,
  FOREIGN KEY (olend_id) REFERENCES olendid(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS manused (
  id            TEXT PRIMARY KEY,
  liik          TEXT NOT NULL,
  mime          TEXT NOT NULL,
  laiend        TEXT NOT NULL,
  originaalnimi TEXT NOT NULL,
  suurus        INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  laius         INTEGER,
  korgus        INTEGER,
  kestus_s      REAL,
  krypteeritud  INTEGER NOT NULL DEFAULT 0,
  omanik_id     INTEGER NOT NULL,
  olend_id      INTEGER,
  loodud_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (omanik_id) REFERENCES kasutajad(id) ON DELETE CASCADE,
  FOREIGN KEY (olend_id) REFERENCES olendid(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS audit_logi (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kasutaja_id   INTEGER,
  kasutajanimi  TEXT,
  tegevus       TEXT NOT NULL,
  yksikasjad    TEXT,
  ip            TEXT,
  loodud_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// --- Testandmete külvamine ------------------------------------------------
function seedData() {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM kasutajad').get().c;
  if (userCount === 0) {
    const insertUser = db.prepare(
      'INSERT INTO kasutajad (kasutajanimi, email, parool, roll) VALUES (?, ?, ?, ?)'
    );
    if (ON_TOODANG) {
      // TOOTMISES EI LOODA KUNAGI vaikeparoolidega kasutajaid (kriitiline turvaauk).
      // Esmane admin luuakse ainult ADMIN_PAROOL keskkonnamuutujast (min 12 märki).
      const parool = process.env.ADMIN_PAROOL || '';
      if (parool.length >= 12) {
        insertUser.run('admin', process.env.ADMIN_EMAIL || 'admin@mytoloogia.ee',
          bcrypt.hashSync(parool, 12), 'admin');
        console.log('✓ Admin-kasutaja loodud ADMIN_PAROOL keskkonnamuutuja põhjal.');
      } else {
        console.warn('⚠️  Kasutajaid ei loodud. Sea ADMIN_PAROOL (min 12 märki) esmase admini loomiseks.');
      }
    } else {
      const hash = (pw) => bcrypt.hashSync(pw, 10);
      insertUser.run('admin', 'admin@mytoloogia.ee', hash('admin123'), 'admin');
      insertUser.run('toimetaja', 'toimetaja@mytoloogia.ee', hash('toimetaja123'), 'toimetaja');
      insertUser.run('kylastaja', 'kylastaja@mytoloogia.ee', hash('kylastaja123'), 'kasutaja');
      console.log('✓ Testkasutajad loodud (admin/admin123, toimetaja/toimetaja123, kylastaja/kylastaja123) — AINULT arenduses');
    }
  }

  const olendCount = db.prepare('SELECT COUNT(*) AS c FROM olendid').get().c;
  if (olendCount === 0) {
    const adminRida = db.prepare("SELECT id FROM kasutajad WHERE kasutajanimi='admin'").get();
    if (!adminRida) return; // tootmises ilma ADMIN_PAROOL-ita pole autorit — ei külva näidisandmeid
    const adminId = adminRida.id;
    const insertOlend = db.prepare(`
      INSERT INTO olendid (nimi, kirjeldus, sfaar, staatus, pilt_url, heli_url, autor_id)
      VALUES (@nimi, @kirjeldus, @sfaar, @staatus, @pilt_url, @heli_url, @autor_id)
    `);
    const insertAsukoht = db.prepare(
      'INSERT INTO olendi_asukohad (olend_id, kihelkond, maakond) VALUES (?, ?, ?)'
    );
    const insertAllikas = db.prepare(
      'INSERT INTO allikad (olend_id, viide, url) VALUES (?, ?, ?)'
    );

    const seed = [
      {
        nimi: 'Näkk',
        sfaar: 'Vesi',
        staatus: 'avaldatud',
        kirjeldus:
          'Näkk on Eesti rahvapärimuses veekogudes elav olend, kes meelitab inimesi oma laulu ja ilusa välimusega vee äärde ning tõmbab nad sügavusse. Näkki kujutati sageli kaunina, kuid tema tõeline olemus oli petlik ja ohtlik. Vanasti hoiatati eriti lapsi ja noori, et nad ei läheks üksi tundmatute veekogude lähedale, sest näkk võib nad endaga kaasa võtta.',
        pilt_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0e/Nix_by_Nyblom.jpg/640px-Nix_by_Nyblom.jpg',
        heli_url: '',
        asukohad: [['Varbla', 'Lääne'], ['Ridala', 'Lääne']],
        allikad: [
          ['Eisen, M. J. — Eesti mütoloogia (1919)', 'https://www.digar.ee'],
          ['Eesti Rahvaluule Arhiiv, ERA', 'https://www.folklore.ee'],
        ],
      },
      {
        nimi: 'Kratt',
        sfaar: 'Kodu',
        staatus: 'avaldatud',
        kirjeldus:
          'Kratt (ka pisuhänd) on rikkust kandev abivaim, kelle peremees pidi kuradiga lepingu sõlmides oma verega looma. Kratt kandis kokku vilja, raha ja vara naabrite juurest, kuid teda tuli pidevalt tööga hõivatuna hoida, muidu võis ta peremehe surnuks kurnata või talu maha põletada. Krati lugu peegeldab rahva suhtumist ahnusse ja ebaausalt kogutud rikkusesse.',
        pilt_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2e/Kratt.jpg/640px-Kratt.jpg',
        heli_url: '',
        asukohad: [['Juuru', 'Harju'], ['Rapla', 'Harju']],
        allikad: [['Kreutzwald, F. R. — Eesti rahva ennemuistsed jutud', 'https://www.eki.ee']],
      },
      {
        nimi: 'Puuk',
        sfaar: 'Kodu',
        staatus: 'avaldatud',
        kirjeldus:
          'Puuk on Lõuna-Eestis tuntud vara- ja piimavaim, krati lähedane sugulane. Puuk lendas õhus tulekera kujul ja tõi peremehele naabrite varandust, eriti piima ja võid. Puugi pidamine oli ohtlik ja patune ettevõtmine, mis sidus inimese kurjade jõududega.',
        pilt_url: '',
        heli_url: '',
        asukohad: [['Otepää', 'Tartu']],
        allikad: [['Loorits, O. — Grundzüge des estnischen Volksglaubens', null]],
      },
      {
        nimi: 'Metsaema',
        sfaar: 'Mets',
        staatus: 'avaldatud',
        kirjeldus:
          'Metsaema (ka Metsahaldjas) on metsa kaitsevaim ja valitseja, kes hoolitseb metsloomade ja taimede eest. Kütid ja marjulised pidid teda austama ning paluma luba metsa andide kasutamiseks. Metsaema võis eksitada lugupidamatuid rändajaid, pannes nad metsas ringi käima.',
        pilt_url: '',
        heli_url: '',
        asukohad: [['Nissi', 'Harju'], ['Risti', 'Lääne']],
        allikad: [['Eesti Rahvaluule Arhiiv, ERA', 'https://www.folklore.ee']],
      },
      {
        nimi: 'Vanapagan',
        sfaar: 'Põrgu',
        staatus: 'avaldatud',
        kirjeldus:
          'Vanapagan on Eesti muinasjuttude rumal ja heatahtlik hiiglane-kurat, kes elab tihti soos või põrgus. Erinevalt kristlikust kuradist on Vanapagan sageli naljakas ja kohmakas tegelane, keda kaval Kaval-Ants pidevalt alt veab. Vanapagana lood seletavad maastiku tekkimist — suuri kive ja künkaid.',
        pilt_url: '',
        heli_url: '',
        asukohad: [['Märjamaa', 'Lääne']],
        allikad: [['Kreutzwald, F. R. — Kalevipoeg', 'https://www.eki.ee']],
      },
      {
        nimi: 'Tuule-ema',
        sfaar: 'Ilm',
        staatus: 'modereerimisel',
        kirjeldus:
          'Tuule-ema valitseb tuulte üle ning teda kutsuti appi nii purjelaevade kui ka tuuleveskite tarbeks. Liiga tugeva tuule korral püüti teda lepitada ohvriandidega. Tuule-ema kuulub ilmastikuvaimude hulka, kes mõjutasid otseselt talurahva igapäevaelu ja saaki.',
        pilt_url: '',
        heli_url: '',
        asukohad: [['Hageri', 'Harju']],
        allikad: [['Eisen, M. J. — Eesti mütoloogia', null]],
      },
      {
        nimi: 'Maa-alused',
        sfaar: 'Kivid ja koopad',
        staatus: 'mustand',
        kirjeldus:
          'Maa-alused on maa sees ja kivide all elavad väikesed olendid, kes võivad inimesi nii aidata kui kahjustada. Neile toodi ohvriks toitu ja piima ning nendega arvestamine oli osa argielust. Maa-aluseid seostati haiguste ja õnnetustega, mida võis põhjustada nende rahu rikkumine.',
        pilt_url: '',
        heli_url: '',
        asukohad: [['Karuse', 'Lääne']],
        allikad: [['Loorits, O. — Eesti rahvausund', null]],
      },
    ];

    const tx = db.transaction(() => {
      for (const o of seed) {
        const info = insertOlend.run({
          nimi: o.nimi,
          kirjeldus: o.kirjeldus,
          sfaar: o.sfaar,
          staatus: o.staatus,
          pilt_url: o.pilt_url || null,
          heli_url: o.heli_url || null,
          autor_id: adminId,
        });
        const oid = info.lastInsertRowid;
        for (const [kihelkond, maakond] of o.asukohad) insertAsukoht.run(oid, kihelkond, maakond);
        for (const [viide, url] of o.allikad) insertAllikas.run(oid, viide, url);
      }
    });
    tx();
    console.log('✓ Näidisolendid loodud (Näkk, Kratt, Puuk, Metsaema, Vanapagan, Tuule-ema, Maa-alused)');
  }
}

initDatabase();

// --- Abifunktsioonid ------------------------------------------------------

/** Annab JWT tokeni kasutaja andmetega. */
function signToken(user) {
  return jwt.sign(
    { id: user.id, kasutajanimi: user.kasutajanimi, roll: user.roll },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

/** Loeb tokeni nii Authorization-päisest kui ka küpsisest. */
function readToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  if (req.cookies && req.cookies.token) return req.cookies.token;
  return null;
}

/** Middleware: nõuab kehtivat sisselogimist. */
function authRequired(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ viga: 'Sisselogimine on nõutud.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ viga: 'Sessioon on aegunud, logi uuesti sisse.' });
  }
}

/** Middleware: nõuab üht lubatud rollidest. */
function rollRequired(...rollid) {
  return (req, res, next) => {
    if (!req.user || !rollid.includes(req.user.roll)) {
      return res.status(403).json({ viga: 'Sul puuduvad õigused selleks tegevuseks.' });
    }
    next();
  };
}

/** Kogub ühe olendi kõik andmed (asukohad, allikad) kokku. */
function olendTaielik(row) {
  if (!row) return null;
  const asukohad = db
    .prepare('SELECT id, kihelkond, maakond FROM olendi_asukohad WHERE olend_id = ?')
    .all(row.id);
  const allikad = db
    .prepare('SELECT id, viide, url FROM allikad WHERE olend_id = ?')
    .all(row.id);
  const autor = row.autor_id
    ? db.prepare('SELECT kasutajanimi FROM kasutajad WHERE id = ?').get(row.autor_id)
    : null;
  return { ...row, autor: autor ? autor.kasutajanimi : null, asukohad, allikad };
}

// ==========================================================================
//  API MARSRUUDID
// ==========================================================================

// --- Autentimine ----------------------------------------------------------

// Registreerimine
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { kasutajanimi, email, parool, nousolek, captchaToken } = req.body || {};

  // 1) CAPTCHA — alati nõutav registreerimisel (bottide tõkestamine)
  const captchaOk = await turve.verifyTurnstile(captchaToken, req.ip);
  if (!captchaOk) {
    return res.status(400).json({ viga: 'CAPTCHA kontroll ebaõnnestus. Proovi uuesti.' });
  }

  // 2) GDPR — nõusolek privaatsuspoliitika ja tingimustega on kohustuslik
  if (nousolek !== true) {
    return res.status(400).json({ viga: 'Pead nõustuma privaatsuspoliitika ja kasutustingimustega.' });
  }

  if (!kasutajanimi || !email || !parool) {
    return res.status(400).json({ viga: 'Kasutajanimi, email ja parool on kohustuslikud.' });
  }
  // 3) Tugevam sisendi valideerimine
  if (kasutajanimi.trim().length < 3 || kasutajanimi.trim().length > 50) {
    return res.status(400).json({ viga: 'Kasutajanimi peab olema 3–50 tähemärki.' });
  }
  // TURVAPARANDUS: kasutajanime lubatud tähestik. Varem võis nimi sisaldada
  // suvalisi märke (sh < > " ja kontrollmärke). Kuigi frontend esc()-ib kõik
  // väljundid, on kaitse mitmekihilisus (defense in depth) põhimõte: kui üks
  // kiht (esc) kunagi unustatakse, ei muutu nimi automaatselt XSS-kandjaks.
  // Lubame ladina/eesti tähed, numbrid, punkti, alakriipsu ja sidekriipsu.
  if (!/^[\p{L}\p{N}._-]+$/u.test(kasutajanimi.trim())) {
    return res.status(400).json({ viga: 'Kasutajanimi tohib sisaldada ainult tähti, numbreid, punkti, ala- ja sidekriipsu.' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ viga: 'E-posti aadress on vigane.' });
  }
  if (parool.length < 8) {
    return res.status(400).json({ viga: 'Parool peab olema vähemalt 8 tähemärki.' });
  }

  const olemas = db
    .prepare('SELECT id FROM kasutajad WHERE kasutajanimi = ? OR email = ?')
    .get(kasutajanimi, email);
  if (olemas) {
    return res.status(409).json({ viga: 'Selline kasutajanimi või email on juba kasutusel.' });
  }
  const hash = bcrypt.hashSync(parool, 12); // 10 -> 12: tugevam räsi
  // Avalik registreerimine annab AINULT 'kasutaja' rolli (külastaja).
  // Toimetaja/admin õigused annab admin käsitsi — väldib õiguste eskalatsiooni.
  const info = db
    .prepare('INSERT INTO kasutajad (kasutajanimi, email, parool, roll) VALUES (?, ?, ?, ?)')
    .run(kasutajanimi.trim(), email.trim().toLowerCase(), hash, 'kasutaja');
  const user = db.prepare('SELECT * FROM kasutajad WHERE id = ?').get(info.lastInsertRowid);
  auditLog(user, 'REGISTREERIMINE', { id: user.id });
  const token = signToken(user);
  res.cookie('token', token, COOKIE_OPTS);
  res.json({ token, kasutaja: { id: user.id, kasutajanimi: user.kasutajanimi, email: user.email, roll: user.roll } });
});

// Kas sisselogimisel on vaja CAPTCHA-t? (frontend küsib seda enne vormi näitamist)
app.post('/api/auth/login-check', (req, res) => {
  res.json({ vajabCaptchat: turve.vajabCaptchat(req), lavi: turve.CAPTCHA_LAVI });
});

// Sisselogimine
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { kasutajanimi, parool, captchaToken } = req.body || {};
  if (!kasutajanimi || !parool) {
    return res.status(400).json({ viga: 'Kasutajanimi ja parool on kohustuslikud.' });
  }

  // CAPTCHA AINULT siis, kui sellelt kasutajalt/IP-lt on olnud mitu ebaõnnestumist
  if (turve.vajabCaptchat(req)) {
    const ok = await turve.verifyTurnstile(captchaToken, req.ip);
    if (!ok) {
      return res.status(400).json({ viga: 'CAPTCHA kontroll on nõutav.', vajabCaptchat: true });
    }
  }

  const user = db
    .prepare('SELECT * FROM kasutajad WHERE kasutajanimi = ? OR email = ?')
    .get(kasutajanimi, kasutajanimi);
  if (!user || !bcrypt.compareSync(parool, user.parool)) {
    turve.markEbaonnestumine(req); // suurenda loendurit
    auditLog(null, 'SISSELOGIMINE_EBAONNESTUS', { kasutajanimi, ip: req.ip });
    return res.status(401).json({ viga: 'Vale kasutajanimi või parool.', vajabCaptchat: turve.vajabCaptchat(req) });
  }
  turve.nullistaKatsed(req); // edukas login nullib loenduri
  const token = signToken(user);
  res.cookie('token', token, COOKIE_OPTS);
  res.json({ token, kasutaja: { id: user.id, kasutajanimi: user.kasutajanimi, email: user.email, roll: user.roll } });
});

// Väljalogimine
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

// Praegune kasutaja
app.get('/api/auth/me', authRequired, (req, res) => {
  const user = db.prepare('SELECT id, kasutajanimi, email, roll, loodud_at FROM kasutajad WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ viga: 'Kasutajat ei leitud.' });
  res.json({ kasutaja: user });
});

// --- Olendid --------------------------------------------------------------

// Kõik olendid (avalik näeb ainult avaldatud; toimetaja/admin näeb kõiki)
app.get('/api/olendid', (req, res) => {
  const token = readToken(req);
  let roll = 'kasutaja';
  if (token) {
    try { roll = jwt.verify(token, JWT_SECRET).roll; } catch (_) { /* ignore */ }
  }
  const { sfaar, kihelkond, otsing } = req.query;

  let sql = 'SELECT DISTINCT o.* FROM olendid o LEFT JOIN olendi_asukohad a ON a.olend_id = o.id WHERE 1=1';
  const params = [];

  if (roll !== 'admin' && roll !== 'toimetaja') {
    sql += " AND o.staatus = 'avaldatud'";
  }
  if (sfaar) { sql += ' AND o.sfaar = ?'; params.push(sfaar); }
  if (kihelkond) { sql += ' AND a.kihelkond = ?'; params.push(kihelkond); }
  if (otsing) {
    sql += ' AND (o.nimi LIKE ? OR o.kirjeldus LIKE ?)';
    params.push(`%${otsing}%`, `%${otsing}%`);
  }
  sql += ' ORDER BY o.nimi COLLATE NOCASE ASC';

  const rows = db.prepare(sql).all(...params);
  res.json({ olendid: rows.map(olendTaielik) });
});

// Üks olend
app.get('/api/olendid/:id', valiideeriId, (req, res) => {
  const row = db.prepare('SELECT * FROM olendid WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ viga: 'Olendit ei leitud.' });
  // Mustandeid näevad ainult toimetaja/admin
  if (row.staatus !== 'avaldatud') {
    const token = readToken(req);
    let roll = null;
    if (token) { try { roll = jwt.verify(token, JWT_SECRET).roll; } catch (_) {} }
    if (roll !== 'admin' && roll !== 'toimetaja') {
      return res.status(403).json({ viga: 'See olend pole veel avaldatud.' });
    }
  }
  res.json({ olend: olendTaielik(row) });
});

// Loo uus olend (toimetaja, admin)
app.post('/api/olendid', authRequired, rollRequired('toimetaja', 'admin'), (req, res) => {
  const { nimi, kirjeldus, sfaar, pilt_url, heli_url, asukohad, allikad } = req.body || {};
  const valVead = valideeriOlend(req.body || {});
  if (valVead.length) return res.status(400).json({ viga: valVead.join(' ') });

  // Sisemised manuse viited: fail peab eksisteerima ja kuuluma kasutajale
  const piltViide = kontrolliManuseViide(pilt_url, 'pilt', req.user);
  if (piltViide.viga) return res.status(400).json({ viga: piltViide.viga });
  const heliViide = kontrolliManuseViide(heli_url, 'heli', req.user);
  if (heliViide.viga) return res.status(400).json({ viga: heliViide.viga });

  // Toimetaja sisu läheb modereerimisele; admini sisu avaldatakse kohe.
  const staatus = req.user.roll === 'admin' ? 'avaldatud' : 'modereerimisel';

  const tx = db.transaction(() => {
    const info = db
      .prepare(`INSERT INTO olendid (nimi, kirjeldus, sfaar, staatus, pilt_url, heli_url, autor_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(nimi.trim(), kirjeldus || '', sfaar || 'Muud', staatus, pilt_url || null, heli_url || null, req.user.id);
    const oid = info.lastInsertRowid;
    if (piltViide.id) db.prepare('UPDATE manused SET olend_id = ? WHERE id = ?').run(oid, piltViide.id);
    if (heliViide.id) db.prepare('UPDATE manused SET olend_id = ? WHERE id = ?').run(oid, heliViide.id);
    (asukohad || []).forEach((a) => {
      if (a && a.kihelkond) {
        db.prepare('INSERT INTO olendi_asukohad (olend_id, kihelkond, maakond) VALUES (?, ?, ?)')
          .run(oid, a.kihelkond, a.maakond || null);
      }
    });
    (allikad || []).forEach((s) => {
      if (s && s.viide) {
        db.prepare('INSERT INTO allikad (olend_id, viide, url) VALUES (?, ?, ?)')
          .run(oid, s.viide, s.url || null);
      }
    });
    return oid;
  });
  const oid = tx();
  const row = db.prepare('SELECT * FROM olendid WHERE id = ?').get(oid);
  res.status(201).json({ olend: olendTaielik(row) });
});

// Muuda olendit (toimetaja saab muuta enda oma, admin kõike)
app.put('/api/olendid/:id', valiideeriId, authRequired, rollRequired('toimetaja', 'admin'), (req, res) => {
  const row = db.prepare('SELECT * FROM olendid WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ viga: 'Olendit ei leitud.' });
  if (req.user.roll !== 'admin' && row.autor_id !== req.user.id) {
    return res.status(403).json({ viga: 'Saad muuta ainult enda loodud olendeid.' });
  }
  const { nimi, kirjeldus, sfaar, pilt_url, heli_url, asukohad, allikad } = req.body || {};

  // Valideeri LÕPLIKKE väärtusi (muutmata väljad võetakse olemasolevast kirjest)
  const efektiivne = {
    nimi: nimi != null ? nimi : row.nimi,
    kirjeldus: kirjeldus != null ? kirjeldus : row.kirjeldus,
    sfaar: sfaar != null ? sfaar : row.sfaar,
    pilt_url: pilt_url !== undefined ? (pilt_url || null) : row.pilt_url,
    heli_url: heli_url !== undefined ? (heli_url || null) : row.heli_url,
    asukohad, allikad,
  };
  const valVead = valideeriOlend(efektiivne);
  if (valVead.length) return res.status(400).json({ viga: valVead.join(' ') });

  // Uue manuse viite korral kontrolli olemasolu + omandiõigust ja seo olendiga
  let piltViide = { id: null }, heliViide = { id: null };
  if (efektiivne.pilt_url !== row.pilt_url) {
    piltViide = kontrolliManuseViide(efektiivne.pilt_url, 'pilt', req.user);
    if (piltViide.viga) return res.status(400).json({ viga: piltViide.viga });
  }
  if (efektiivne.heli_url !== row.heli_url) {
    heliViide = kontrolliManuseViide(efektiivne.heli_url, 'heli', req.user);
    if (heliViide.viga) return res.status(400).json({ viga: heliViide.viga });
  }

  const tx = db.transaction(() => {
    if (piltViide.id) db.prepare('UPDATE manused SET olend_id = ? WHERE id = ?').run(req.params.id, piltViide.id);
    if (heliViide.id) db.prepare('UPDATE manused SET olend_id = ? WHERE id = ?').run(req.params.id, heliViide.id);
    db.prepare(`UPDATE olendid SET nimi=?, kirjeldus=?, sfaar=?, pilt_url=?, heli_url=?, muudetud_at=datetime('now') WHERE id=?`)
      .run(
        nimi != null ? nimi : row.nimi,
        kirjeldus != null ? kirjeldus : row.kirjeldus,
        sfaar != null ? sfaar : row.sfaar,
        pilt_url !== undefined ? (pilt_url || null) : row.pilt_url,
        heli_url !== undefined ? (heli_url || null) : row.heli_url,
        req.params.id
      );
    if (Array.isArray(asukohad)) {
      db.prepare('DELETE FROM olendi_asukohad WHERE olend_id = ?').run(req.params.id);
      asukohad.forEach((a) => {
        if (a && a.kihelkond) {
          db.prepare('INSERT INTO olendi_asukohad (olend_id, kihelkond, maakond) VALUES (?, ?, ?)')
            .run(req.params.id, a.kihelkond, a.maakond || null);
        }
      });
    }
    if (Array.isArray(allikad)) {
      db.prepare('DELETE FROM allikad WHERE olend_id = ?').run(req.params.id);
      allikad.forEach((s) => {
        if (s && s.viide) {
          db.prepare('INSERT INTO allikad (olend_id, viide, url) VALUES (?, ?, ?)')
            .run(req.params.id, s.viide, s.url || null);
        }
      });
    }
  });
  tx();
  const updated = db.prepare('SELECT * FROM olendid WHERE id = ?').get(req.params.id);
  res.json({ olend: olendTaielik(updated) });
});

// Muuda staatust (ainult admin — modereerimine)
app.patch('/api/olendid/:id/staatus', valiideeriId, authRequired, rollRequired('admin'), (req, res) => {
  const { staatus } = req.body || {};
  const lubatud = ['avaldatud', 'mustand', 'modereerimisel'];
  if (!lubatud.includes(staatus)) {
    return res.status(400).json({ viga: 'Tundmatu staatus.' });
  }
  const row = db.prepare('SELECT * FROM olendid WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ viga: 'Olendit ei leitud.' });
  db.prepare("UPDATE olendid SET staatus = ?, muudetud_at = datetime('now') WHERE id = ?").run(staatus, req.params.id);
  auditLog(req.user, 'MUUDA_STAATUS', { id: req.params.id, uus_staatus: staatus });
  res.json({ olend: olendTaielik(db.prepare('SELECT * FROM olendid WHERE id = ?').get(req.params.id)) });
});

// Kustuta olend (toimetaja enda, admin kõik)
app.delete('/api/olendid/:id', valiideeriId, authRequired, rollRequired('toimetaja', 'admin'), (req, res) => {
  const row = db.prepare('SELECT * FROM olendid WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ viga: 'Olendit ei leitud.' });
  if (req.user.roll !== 'admin' && row.autor_id !== req.user.id) {
    return res.status(403).json({ viga: 'Saad kustutada ainult enda loodud olendeid.' });
  }
  db.prepare('DELETE FROM olendid WHERE id = ?').run(req.params.id);
  auditLog(req.user, 'KUSTUTA_OLEND', { id: req.params.id, nimi: row.nimi });
  res.json({ ok: true });
});

// --- Asukohad (kihelkonna järgi) ------------------------------------------

// Ühe kihelkonnaga seotud avaldatud olendid — kasutab kaart
app.get('/api/kihelkonnad/:nimi/olendid', (req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT o.* FROM olendid o
    JOIN olendi_asukohad a ON a.olend_id = o.id
    WHERE a.kihelkond = ? AND o.staatus = 'avaldatud'
    ORDER BY o.nimi COLLATE NOCASE
  `).all(req.params.nimi);
  res.json({ kihelkond: req.params.nimi, olendid: rows.map(olendTaielik) });
});

// --- Lemmikud -------------------------------------------------------------

app.get('/api/lemmikud', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT o.* FROM olendid o
    JOIN lemmikud l ON l.olend_id = o.id
    WHERE l.kasutaja_id = ?
    ORDER BY o.nimi COLLATE NOCASE
  `).all(req.user.id);
  res.json({ lemmikud: rows.map(olendTaielik) });
});

app.post('/api/lemmikud/:id', valiideeriId, authRequired, (req, res) => {
  // TURVA/KVALITEEDIPARANDUS: kontrolli, et olend on olemas JA avaldatud.
  // Varem kukkus olematu ID FOREIGN KEY veaga 500-ks (lekitab sisemist infot)
  // ja sai lemmikuks lisada ka avaldamata mustandeid, mille olemasolu
  // tavakasutaja teadma ei peaks (ID-de skaneerimine).
  const olend = db.prepare("SELECT id FROM olendid WHERE id = ? AND staatus = 'avaldatud'").get(req.params.id);
  if (!olend) return res.status(404).json({ viga: 'Olendit ei leitud.' });
  db.prepare('INSERT OR IGNORE INTO lemmikud (kasutaja_id, olend_id) VALUES (?, ?)')
    .run(req.user.id, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/lemmikud/:id', valiideeriId, authRequired, (req, res) => {
  db.prepare('DELETE FROM lemmikud WHERE kasutaja_id = ? AND olend_id = ?')
    .run(req.user.id, req.params.id);
  res.json({ ok: true });
});

// --- Failide üleslaadimine (manused) ----------------------------------------
//
// Turvamudel:
//   * Üleslaadimine: ainult sisselogitud toimetaja/admin, eraldi rate-limit.
//   * Valideerimine: tüüp tuvastatakse SISU järgi (magic bytes), mitte laiendi
//     ega kliendi Content-Type'i järgi; suurus-, mõõtme- ja kestusepiirangud.
//   * Hoiustamine: juhuslik 32-hex nimi + ".bin" kaustas väljaspool /public,
//     valikuline AES-256-GCM krüpteerimine (MANUSTE_VOTI).
//   * Serveerimine: ainult läbi GET /api/failid/:id, range ID-kontroll
//     (path traversal võimatu), nosniff + sandbox-CSP päised.

// Multer hoiab faili mälus (max 20 MB) — me EI kirjuta kettale enne valideerimist.
const ülesLaadija = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: failid.PIIRID.HELI_MAX_BAIT, files: 1, fields: 5, parts: 10 },
});

// Üleslaadimine
app.post('/api/failid', uploadLimiter, authRequired, rollRequired('toimetaja', 'admin'), (req, res) => {
  ülesLaadija.single('fail')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ viga: 'Fail on liiga suur (max 20 MB).' });
      }
      return res.status(400).json({ viga: 'Faili vastuvõtt ebaõnnestus.' });
    }
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ viga: 'Fail puudub (välja nimi peab olema "fail").' });
    }

    // Oodatav liik vormilt ('pilt' | 'heli') — lõplik otsus tehakse sisu järgi
    const oodatudLiik = ['pilt', 'heli'].includes(req.body.liik) ? req.body.liik : null;
    const v = failid.valideeriFail(req.file.buffer, oodatudLiik);
    if (!v.ok) {
      auditLog(req.user, 'FAIL_TAGASI_LYKATUD', { nimi: req.file.originalname, viga: v.viga }, req.ip);
      return res.status(422).json({ viga: v.viga });
    }

    const id = failid.genereeriId();
    const sha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const originaalnimi = failid.puhastaFailinimi(req.file.originalname);

    let krypteeritud = 0;
    try {
      krypteeritud = failid.salvestaFail(MANUSTE_KAUST, id, req.file.buffer).krypteeritud;
    } catch (e) {
      console.error('[FAILID] salvestamine ebaõnnestus:', e.message);
      return res.status(500).json({ viga: 'Faili salvestamine ebaõnnestus.' });
    }
    try {
      db.prepare(`INSERT INTO manused (id, liik, mime, laiend, originaalnimi, suurus, sha256,
                                       laius, korgus, kestus_s, krypteeritud, omanik_id)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, v.liik, v.mime, v.laiend, originaalnimi, req.file.buffer.length, sha256,
             v.laius || null, v.korgus || null, v.kestus_s || null, krypteeritud, req.user.id);
    } catch (e) {
      failid.kustutaFail(MANUSTE_KAUST, id); // ära jäta orbfaili kettale
      console.error('[FAILID] metaandmete kirjutamine ebaõnnestus:', e.message);
      return res.status(500).json({ viga: 'Faili salvestamine ebaõnnestus.' });
    }

    auditLog(req.user, 'FAIL_ULES', { id, liik: v.liik, mime: v.mime, suurus: req.file.buffer.length, nimi: originaalnimi }, req.ip);
    res.status(201).json({
      fail: {
        id, url: '/api/failid/' + id, liik: v.liik, mime: v.mime,
        originaalnimi, suurus: req.file.buffer.length,
        laius: v.laius || null, korgus: v.korgus || null, kestus_s: v.kestus_s || null,
      },
    });
  });
});

// Serveerimine — AINUS viis üleslaaditud faili kätte saada.
// Avalik, kui fail on seotud avaldatud olendiga; muidu omanik/toimetaja/admin.
app.get('/api/failid/:id', (req, res) => {
  const id = req.params.id;
  if (!failid.onTurvalineId(id)) return res.status(404).json({ viga: 'Faili ei leitud.' });
  const rida = db.prepare('SELECT * FROM manused WHERE id = ?').get(id);
  if (!rida) return res.status(404).json({ viga: 'Faili ei leitud.' });

  let avalik = false;
  if (rida.olend_id) {
    const o = db.prepare('SELECT staatus FROM olendid WHERE id = ?').get(rida.olend_id);
    avalik = !!o && o.staatus === 'avaldatud';
  }
  if (!avalik) {
    // 404 (mitte 403), et mitte paljastada privaatse faili olemasolu
    const token = readToken(req);
    let user = null;
    if (token) { try { user = jwt.verify(token, JWT_SECRET); } catch (_) {} }
    const lubatud = user && (user.id === rida.omanik_id || ['admin', 'toimetaja'].includes(user.roll));
    if (!lubatud) return res.status(404).json({ viga: 'Faili ei leitud.' });
  }

  const sisu = failid.loeFail(MANUSTE_KAUST, id, rida.krypteeritud);
  if (!sisu) return res.status(410).json({ viga: 'Faili sisu pole saadaval.' });

  // Ranged päised: brauser EI tohi sisu tüüpi ära arvata ega selles skripte käivitada
  res.setHeader('Content-Type', rida.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Content-Disposition', 'inline; filename="' + rida.originaalnimi.replace(/["\r\n]/g, '') + '"');
  res.setHeader('Cache-Control', avalik ? 'public, max-age=86400' : 'private, no-store');
  res.send(sisu);
});

// Kustutamine — omanik või admin. Fail kirjutatakse enne eemaldamist üle.
app.delete('/api/failid/:id', authRequired, (req, res) => {
  const id = req.params.id;
  if (!failid.onTurvalineId(id)) return res.status(404).json({ viga: 'Faili ei leitud.' });
  const rida = db.prepare('SELECT * FROM manused WHERE id = ?').get(id);
  if (!rida) return res.status(404).json({ viga: 'Faili ei leitud.' });
  if (req.user.roll !== 'admin' && rida.omanik_id !== req.user.id) {
    return res.status(403).json({ viga: 'Saad kustutada ainult enda üleslaaditud faile.' });
  }
  const viide = '/api/failid/' + id;
  const tx = db.transaction(() => {
    // Eemalda viited olenditelt, et ei jääks katkisi linke
    db.prepare('UPDATE olendid SET pilt_url = NULL WHERE pilt_url = ?').run(viide);
    db.prepare('UPDATE olendid SET heli_url = NULL WHERE heli_url = ?').run(viide);
    db.prepare('DELETE FROM manused WHERE id = ?').run(id);
  });
  tx();
  failid.kustutaFail(MANUSTE_KAUST, id);
  auditLog(req.user, 'FAIL_KUSTUTATUD', { id, nimi: rida.originaalnimi }, req.ip);
  res.json({ ok: true });
});

// --- Sfäärid (staatiline loend) -------------------------------------------
app.get('/api/sfaarid', (req, res) => {
  res.json({
    sfaarid: ['Mets', 'Vesi', 'Kodu', 'Ilm', 'Kivid ja koopad', 'Põrgu', 'Muud'],
  });
});

// Avalik konfiguratsioon — tagastab ainult need võtmed, mida frontend vajab.
// Mapboxi võti loetakse keskkonnamuutujast, mitte koodist.
app.get('/api/config', (req, res) => {
  res.json({
    mapboxToken: MAPBOX_TOKEN,
    turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || '',
  });
});

// --- Staatilised failid (frontend) ----------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback — kõik tundmatud (mitte-API) marsruudid serveerivad index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Käivitamine ----------------------------------------------------------
// --- Vigade käsitleja (ei leki Stack trace't kasutajale) ------------------
app.use((err, req, res, _next) => {
  console.error('[VIGA]', err);
  res.status(500).json({ viga: 'Serveri sisemine viga. Proovi hiljem uuesti.' });
});

// Testides imporditakse app ilma serverit käivitamata (vt test/ kaust)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🜂  Eesti Mütoloogiaveeb töötab: http://localhost:${PORT}\n`);
  });
}

module.exports = { app, db };