/**
 * test/api.test.js — failide üleslaadimise API integratsiooni- ja turvatestid
 * Käivitab päris rakenduse ajutise andmebaasi ja manuste kaustaga.
 * Käivita: npm test
 */

'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Testikeskkond PEAB olema paigas enne server.js laadimist
const ajutine = fs.mkdtempSync(path.join(os.tmpdir(), 'mytoloogia-test-'));
process.env.DB_PATH = path.join(ajutine, 'test.db');
process.env.MANUSTE_KAUST = path.join(ajutine, 'uploads');
delete process.env.NODE_ENV; // arendusrežiim: testkasutajad külvatakse

const fx = require('./fixtures');
const { app } = require('../server');

let srv, base;
const tokenid = {}; // kasutajanimi -> JWT

async function login(kasutajanimi, parool) {
  const r = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kasutajanimi, parool }),
  });
  assert.equal(r.status, 200, 'login ' + kasutajanimi);
  return (await r.json()).token;
}

/** Laadib faili üles; tagastab toore Response'i. */
async function laeYles(token, buf, nimi, liik, mime = 'application/octet-stream') {
  const fd = new FormData();
  fd.append('liik', liik);
  fd.append('fail', new Blob([buf], { type: mime }), nimi);
  return fetch(base + '/api/failid', {
    method: 'POST',
    headers: token ? { Authorization: 'Bearer ' + token } : {},
    body: fd,
  });
}

before(async () => {
  srv = app.listen(0);
  base = 'http://127.0.0.1:' + srv.address().port;
  tokenid.admin = await login('admin', 'admin123');
  tokenid.toimetaja = await login('toimetaja', 'toimetaja123');
  tokenid.kylastaja = await login('kylastaja', 'kylastaja123');
});

after(() => {
  srv.close();
  try { fs.rmSync(ajutine, { recursive: true, force: true }); } catch (_) {}
});

describe('autentimine ja autoriseerimine', () => {
  test('üleslaadimine ilma sisselogimiseta -> 401', async () => {
    const r = await laeYles(null, fx.png1x1(), 'a.png', 'pilt');
    assert.equal(r.status, 401);
  });

  test('tavakasutaja (kylastaja) ei tohi üles laadida -> 403', async () => {
    const r = await laeYles(tokenid.kylastaja, fx.png1x1(), 'a.png', 'pilt');
    assert.equal(r.status, 403);
  });

  test('toimetaja tohib üles laadida -> 201', async () => {
    const r = await laeYles(tokenid.toimetaja, fx.png1x1(), 'a.png', 'pilt', 'image/png');
    assert.equal(r.status, 201);
    const d = await r.json();
    assert.match(d.fail.id, /^[a-f0-9]{32}$/);
    assert.equal(d.fail.mime, 'image/png');
  });
});

describe('failide valideerimine (MIME-võltsing, polüglotid, suurus)', () => {
  test('PHP-kest nimega "pilt.png" ja Content-Type image/png -> 422', async () => {
    const r = await laeYles(tokenid.toimetaja, fx.phpKest(), 'pilt.png', 'pilt', 'image/png');
    assert.equal(r.status, 422);
  });

  test('polüglot (PNG + <script>) -> 422', async () => {
    const r = await laeYles(tokenid.toimetaja, fx.polyglotPng(), 'p.png', 'pilt', 'image/png');
    assert.equal(r.status, 422);
  });

  test('vale liik: MP3 pildi-slotti -> 422', async () => {
    const r = await laeYles(tokenid.toimetaja, fx.mp3(3), 'laul.mp3', 'pilt', 'audio/mpeg');
    assert.equal(r.status, 422);
  });

  test('liiga pikk helifail (üle 10 min) -> 422', async () => {
    const r = await laeYles(tokenid.toimetaja, fx.mp3(700), 'pikk.mp3', 'heli', 'audio/mpeg');
    assert.equal(r.status, 422);
  });

  test('liiga suur fail (üle 20 MB) -> 413 (DoS-kaitse)', async () => {
    const suur = Buffer.alloc(21 * 1024 * 1024, 0x41);
    const r = await laeYles(tokenid.toimetaja, suur, 'suur.bin', 'heli');
    assert.equal(r.status, 413);
  });

  test('kehtiv WAV läheb läbi koos kestuse metaandmetega', async () => {
    const r = await laeYles(tokenid.toimetaja, fx.wav(3), 'heli.wav', 'heli', 'audio/wav');
    assert.equal(r.status, 201);
    const d = await r.json();
    assert.ok(d.fail.kestus_s > 2 && d.fail.kestus_s < 4);
  });
});

describe('serveerimine ja juurdepääsukontroll', () => {
  let failUrl, failId;

  test('omanik näeb oma sidumata faili; anonüümne saab 404', async () => {
    const r = await laeYles(tokenid.toimetaja, fx.png1x1(), 'salajane.png', 'pilt', 'image/png');
    const d = await r.json();
    failUrl = d.fail.url; failId = d.fail.id;

    const anon = await fetch(base + failUrl);
    assert.equal(anon.status, 404, 'sidumata fail ei tohi olla avalik');

    const oma = await fetch(base + failUrl, { headers: { Authorization: 'Bearer ' + tokenid.toimetaja } });
    assert.equal(oma.status, 200);
    assert.equal(oma.headers.get('content-type'), 'image/png');
    assert.equal(oma.headers.get('x-content-type-options'), 'nosniff');
    assert.match(oma.headers.get('content-security-policy') || '', /sandbox/);
  });

  test('fail muutub avalikuks alles AVALDATUD olendi kaudu', async () => {
    // Toimetaja loob olendi (läheb modereerimisele)
    const loo = await fetch(base + '/api/olendid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenid.toimetaja },
      body: JSON.stringify({ nimi: 'Testolend', sfaar: 'Muud', pilt_url: failUrl }),
    });
    assert.equal(loo.status, 201);
    const oid = (await loo.json()).olend.id;

    let anon = await fetch(base + failUrl);
    assert.equal(anon.status, 404, 'modereerimisel olendi fail pole avalik');

    // Admin avaldab
    const pat = await fetch(base + '/api/olendid/' + oid + '/staatus', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenid.admin },
      body: JSON.stringify({ staatus: 'avaldatud' }),
    });
    assert.equal(pat.status, 200);

    anon = await fetch(base + failUrl);
    assert.equal(anon.status, 200, 'avaldatud olendi fail on avalik');
  });

  test('path traversal /api/failid kaudu on võimatu', async () => {
    for (const halb of ['..%2F..%2Fserver.js', '..%5C..%5C.env', 'A'.repeat(32), 'x']) {
      const r = await fetch(base + '/api/failid/' + halb, {
        headers: { Authorization: 'Bearer ' + tokenid.admin },
      });
      assert.equal(r.status, 404, 'lubas: ' + halb);
    }
  });

  test('võõra faili sidumine olendiga on keelatud', async () => {
    // Admin laadib faili, toimetaja üritab seda enda olendile panna
    const r = await laeYles(tokenid.admin, fx.png1x1(), 'adminipilt.png', 'pilt', 'image/png');
    const adminiFail = (await r.json()).fail.url;
    const loo = await fetch(base + '/api/olendid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenid.toimetaja },
      body: JSON.stringify({ nimi: 'Vargus', sfaar: 'Muud', pilt_url: adminiFail }),
    });
    assert.equal(loo.status, 400);
  });

  test('kustutada saab ainult oma faili (või admin); kustutatud fail kaob', async () => {
    const veerand = await fetch(base + '/api/failid/' + failId, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + tokenid.kylastaja },
    });
    assert.equal(veerand.status, 403);

    const oma = await fetch(base + '/api/failid/' + failId, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + tokenid.toimetaja },
    });
    assert.equal(oma.status, 200);

    const j2rel = await fetch(base + failUrl, { headers: { Authorization: 'Bearer ' + tokenid.toimetaja } });
    assert.equal(j2rel.status, 404);
  });
});

describe('URL-väljade valideerimine (stored XSS kaitse)', () => {
  test('javascript: pilt_url lükatakse tagasi', async () => {
    const r = await fetch(base + '/api/olendid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenid.admin },
      body: JSON.stringify({ nimi: 'XSS', pilt_url: 'javascript:alert(1)' }),
    });
    assert.equal(r.status, 400);
  });

  test('javascript: allika URL lükatakse tagasi', async () => {
    const r = await fetch(base + '/api/olendid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenid.admin },
      body: JSON.stringify({
        nimi: 'XSS2',
        allikad: [{ viide: 'Viide', url: 'javascript:document.location="https://kuri.ee"' }],
      }),
    });
    assert.equal(r.status, 400);
  });

  test('data: ja väljamõeldud manuse-ID lükatakse tagasi; https on lubatud (pärand)', async () => {
    for (const [url, oodatud] of [
      ['data:text/html,<script>alert(1)</script>', 400],
      ['/api/failid/' + 'f'.repeat(32), 400], // olematu manus
      ['https://upload.wikimedia.org/pilt.jpg', 201],
    ]) {
      const r = await fetch(base + '/api/olendid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenid.admin },
        body: JSON.stringify({ nimi: 'URL-test', pilt_url: url }),
      });
      assert.equal(r.status, oodatud, url);
    }
  });
});
