-- ===========================================================================
--  Eesti Mütoloogiaveeb — database.sql
--  ---------------------------------------------------------------------------
--  Andmebaasi skeem ja testandmed.
--
--  Seda faili kasutab server.js automaatselt SQLite andmebaasi loomiseks.
--  Kõik CREATE laused on IF NOT EXISTS (idempotentne) — turvaline korduvaks
--  käivitamiseks.
--
--  MYSQL MIGRATSIOON (Zone.ee natiivne MySQL):
--    SQLite ja MySQL süntaks erinevad veidi. MySQL jaoks tee järgmised muudatused:
--      * INTEGER PRIMARY KEY AUTOINCREMENT  ->  INT AUTO_INCREMENT PRIMARY KEY
--      * datetime('now')                    ->  CURRENT_TIMESTAMP
--      * TEXT (pikkadele)                   ->  VARCHAR(255) / TEXT vastavalt vajadusele
--    MySQL-spetsiifilised read on märgistatud kommentaariga "-- MYSQL" ja
--    server.js eemaldab need automaatselt SQLite kasutamisel.
-- ===========================================================================

-- --- Kasutajad -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kasutajad (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kasutajanimi  TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL UNIQUE,
  parool        TEXT NOT NULL,                       -- bcrypt räsi
  roll          TEXT NOT NULL DEFAULT 'kasutaja',    -- kasutaja | toimetaja | admin
  loodud_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- --- Olendid (mütoloogilised olendid) --------------------------------------
CREATE TABLE IF NOT EXISTS olendid (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  nimi          TEXT NOT NULL,
  kirjeldus     TEXT NOT NULL DEFAULT '',
  sfaar         TEXT NOT NULL DEFAULT 'Muud',        -- Mets | Vesi | Kodu | Ilm | Kivid ja koopad | Põrgu | Muud
  staatus       TEXT NOT NULL DEFAULT 'mustand',     -- avaldatud | mustand | modereerimisel
  pilt_url      TEXT,
  heli_url      TEXT,
  autor_id      INTEGER,
  loodud_at     TEXT NOT NULL DEFAULT (datetime('now')),
  muudetud_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (autor_id) REFERENCES kasutajad(id) ON DELETE SET NULL
);

-- --- Olendi asukohad (seos 1917. a kihelkondadega) -------------------------
CREATE TABLE IF NOT EXISTS olendi_asukohad (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  olend_id      INTEGER NOT NULL,
  kihelkond     TEXT NOT NULL,                       -- vastab GeoJSON property NIMI
  maakond       TEXT,
  FOREIGN KEY (olend_id) REFERENCES olendid(id) ON DELETE CASCADE
);

-- --- Allikad / viited ------------------------------------------------------
CREATE TABLE IF NOT EXISTS allikad (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  olend_id      INTEGER NOT NULL,
  viide         TEXT NOT NULL,
  url           TEXT,
  FOREIGN KEY (olend_id) REFERENCES olendid(id) ON DELETE CASCADE
);

-- --- Lemmikud (kasutaja <-> olend) -----------------------------------------
CREATE TABLE IF NOT EXISTS lemmikud (
  kasutaja_id   INTEGER NOT NULL,
  olend_id      INTEGER NOT NULL,
  PRIMARY KEY (kasutaja_id, olend_id),
  FOREIGN KEY (kasutaja_id) REFERENCES kasutajad(id) ON DELETE CASCADE,
  FOREIGN KEY (olend_id) REFERENCES olendid(id) ON DELETE CASCADE
);

-- ===========================================================================
--  MÄRKUS TESTANDMETE KOHTA
--  ---------------------------------------------------------------------------
--  Testkasutajaid ja näidisolendeid EI külvata siit SQL-failist, sest paroolid
--  peavad olema bcrypt-räsitud (seda teeb server.js käivitamisel funktsioonis
--  seedData()). See tagab, et paroole ei hoita kunagi avatekstina.
--
--  Loodavad testkasutajad (server.js):
--    admin      / admin123       (roll: admin)
--    toimetaja  / toimetaja123   (roll: toimetaja)
--    kylastaja  / kylastaja123   (roll: kasutaja)
--
--  Loodavad näidisolendid: Näkk, Kratt, Puuk, Metsaema, Vanapagan,
--  Tuule-ema, Maa-alused — koos asukohtade ja allikaviidetega.
-- ===========================================================================
