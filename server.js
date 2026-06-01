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
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

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
const DB_PATH      = process.env.DB_PATH      || path.join(__dirname, 'mytoloogia.db');
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || '';

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

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
`;

// --- Testandmete külvamine ------------------------------------------------
function seedData() {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM kasutajad').get().c;
  if (userCount === 0) {
    const insertUser = db.prepare(
      'INSERT INTO kasutajad (kasutajanimi, email, parool, roll) VALUES (?, ?, ?, ?)'
    );
    const hash = (pw) => bcrypt.hashSync(pw, 10);
    insertUser.run('admin', 'admin@mytoloogia.ee', hash('admin123'), 'admin');
    insertUser.run('toimetaja', 'toimetaja@mytoloogia.ee', hash('toimetaja123'), 'toimetaja');
    insertUser.run('kylastaja', 'kylastaja@mytoloogia.ee', hash('kylastaja123'), 'kasutaja');
    console.log('✓ Testkasutajad loodud (admin/admin123, toimetaja/toimetaja123, kylastaja/kylastaja123)');
  }

  const olendCount = db.prepare('SELECT COUNT(*) AS c FROM olendid').get().c;
  if (olendCount === 0) {
    const adminId = db.prepare("SELECT id FROM kasutajad WHERE kasutajanimi='admin'").get().id;
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
app.post('/api/auth/register', (req, res) => {
  const { kasutajanimi, email, parool } = req.body || {};
  if (!kasutajanimi || !email || !parool) {
    return res.status(400).json({ viga: 'Kasutajanimi, email ja parool on kohustuslikud.' });
  }
  if (parool.length < 6) {
    return res.status(400).json({ viga: 'Parool peab olema vähemalt 6 tähemärki.' });
  }
  const olemas = db
    .prepare('SELECT id FROM kasutajad WHERE kasutajanimi = ? OR email = ?')
    .get(kasutajanimi, email);
  if (olemas) {
    return res.status(409).json({ viga: 'Selline kasutajanimi või email on juba kasutusel.' });
  }
  const hash = bcrypt.hashSync(parool, 10);
  // Uued kasutajad on vaikimisi toimetajad (saavad sisu lisada modereerimisele).
  // Soovi korral muuda 'kasutaja' rolliks puhta külastaja jaoks.
  const info = db
    .prepare('INSERT INTO kasutajad (kasutajanimi, email, parool, roll) VALUES (?, ?, ?, ?)')
    .run(kasutajanimi, email, hash, 'toimetaja');
  const user = db.prepare('SELECT * FROM kasutajad WHERE id = ?').get(info.lastInsertRowid);
  const token = signToken(user);
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 864e5 });
  res.json({ token, kasutaja: { id: user.id, kasutajanimi: user.kasutajanimi, email: user.email, roll: user.roll } });
});

// Sisselogimine
app.post('/api/auth/login', (req, res) => {
  const { kasutajanimi, parool } = req.body || {};
  if (!kasutajanimi || !parool) {
    return res.status(400).json({ viga: 'Kasutajanimi ja parool on kohustuslikud.' });
  }
  const user = db
    .prepare('SELECT * FROM kasutajad WHERE kasutajanimi = ? OR email = ?')
    .get(kasutajanimi, kasutajanimi);
  if (!user || !bcrypt.compareSync(parool, user.parool)) {
    return res.status(401).json({ viga: 'Vale kasutajanimi või parool.' });
  }
  const token = signToken(user);
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 864e5 });
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
app.get('/api/olendid/:id', (req, res) => {
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
  if (!nimi || !nimi.trim()) return res.status(400).json({ viga: 'Olendi nimi on kohustuslik.' });

  // Toimetaja sisu läheb modereerimisele; admini sisu avaldatakse kohe.
  const staatus = req.user.roll === 'admin' ? 'avaldatud' : 'modereerimisel';

  const tx = db.transaction(() => {
    const info = db
      .prepare(`INSERT INTO olendid (nimi, kirjeldus, sfaar, staatus, pilt_url, heli_url, autor_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(nimi.trim(), kirjeldus || '', sfaar || 'Muud', staatus, pilt_url || null, heli_url || null, req.user.id);
    const oid = info.lastInsertRowid;
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
app.put('/api/olendid/:id', authRequired, rollRequired('toimetaja', 'admin'), (req, res) => {
  const row = db.prepare('SELECT * FROM olendid WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ viga: 'Olendit ei leitud.' });
  if (req.user.roll !== 'admin' && row.autor_id !== req.user.id) {
    return res.status(403).json({ viga: 'Saad muuta ainult enda loodud olendeid.' });
  }
  const { nimi, kirjeldus, sfaar, pilt_url, heli_url, asukohad, allikad } = req.body || {};

  const tx = db.transaction(() => {
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
app.patch('/api/olendid/:id/staatus', authRequired, rollRequired('admin'), (req, res) => {
  const { staatus } = req.body || {};
  const lubatud = ['avaldatud', 'mustand', 'modereerimisel'];
  if (!lubatud.includes(staatus)) {
    return res.status(400).json({ viga: 'Tundmatu staatus.' });
  }
  const row = db.prepare('SELECT * FROM olendid WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ viga: 'Olendit ei leitud.' });
  db.prepare("UPDATE olendid SET staatus = ?, muudetud_at = datetime('now') WHERE id = ?")
    .run(staatus, req.params.id);
  res.json({ olend: olendTaielik(db.prepare('SELECT * FROM olendid WHERE id = ?').get(req.params.id)) });
});

// Kustuta olend (toimetaja enda, admin kõik)
app.delete('/api/olendid/:id', authRequired, rollRequired('toimetaja', 'admin'), (req, res) => {
  const row = db.prepare('SELECT * FROM olendid WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ viga: 'Olendit ei leitud.' });
  if (req.user.roll !== 'admin' && row.autor_id !== req.user.id) {
    return res.status(403).json({ viga: 'Saad kustutada ainult enda loodud olendeid.' });
  }
  db.prepare('DELETE FROM olendid WHERE id = ?').run(req.params.id);
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

app.post('/api/lemmikud/:id', authRequired, (req, res) => {
  db.prepare('INSERT OR IGNORE INTO lemmikud (kasutaja_id, olend_id) VALUES (?, ?)')
    .run(req.user.id, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/lemmikud/:id', authRequired, (req, res) => {
  db.prepare('DELETE FROM lemmikud WHERE kasutaja_id = ? AND olend_id = ?')
    .run(req.user.id, req.params.id);
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
  res.json({ mapboxToken: MAPBOX_TOKEN });
});

// --- Staatilised failid (frontend) ----------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback — kõik tundmatud (mitte-API) marsruudid serveerivad index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Käivitamine ----------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\n🜂  Eesti Mütoloogiaveeb töötab: http://localhost:${PORT}\n`);
});