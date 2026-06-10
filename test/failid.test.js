/**
 * test/failid.test.js — failid.js mooduli ühiktestid (sh turvatestid)
 * Käivita: npm test
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const failid = require('../failid');
const fx = require('./fixtures');

describe('tuvastaTyyp — magic bytes', () => {
  test('tuvastab kõik lubatud vormingud sisu järgi', () => {
    assert.equal(failid.tuvastaTyyp(fx.png1x1()).laiend, 'png');
    assert.equal(failid.tuvastaTyyp(fx.jpeg()).laiend, 'jpg');
    assert.equal(failid.tuvastaTyyp(fx.webp()).laiend, 'webp');
    assert.equal(failid.tuvastaTyyp(fx.wav()).laiend, 'wav');
    assert.equal(failid.tuvastaTyyp(fx.mp3()).laiend, 'mp3');
    assert.equal(failid.tuvastaTyyp(fx.ogg()).laiend, 'ogg');
    assert.equal(failid.tuvastaTyyp(fx.m4a()).laiend, 'm4a');
  });

  test('lükkab tagasi keelatud sisu (PHP, HTML, SVG, juhuslik prügi)', () => {
    assert.equal(failid.tuvastaTyyp(fx.phpKest()), null);
    assert.equal(failid.tuvastaTyyp(Buffer.from('<html><script>x</script></html>')), null);
    assert.equal(failid.tuvastaTyyp(Buffer.from('<svg onload=alert(1)></svg>')), null);
    assert.equal(failid.tuvastaTyyp(Buffer.from('GIF89a' + 'x'.repeat(20))), null); // GIF pole lubatud
    assert.equal(failid.tuvastaTyyp(Buffer.alloc(100, 0xab)), null);
    assert.equal(failid.tuvastaTyyp(Buffer.alloc(0)), null);
  });

  test('MIME-võltsing: laiend/Content-Type ei oma tähtsust — ainult sisu', () => {
    // PHP-kest "pildina" — tuvastus käib sisust, mitte nimest
    const v = failid.valideeriFail(fx.phpKest(), 'pilt');
    assert.equal(v.ok, false);
  });
});

describe('pildi valideerimine', () => {
  test('loeb mõõtmed ja aktsepteerib korrektse pildi', () => {
    const v = failid.valideeriFail(fx.png1x1(), 'pilt');
    assert.equal(v.ok, true);
    assert.equal(v.laius, 1);
    assert.equal(v.korgus, 1);
    assert.equal(v.mime, 'image/png');
  });

  test('lükkab tagasi liiga suurte mõõtmetega pildi (pixel flood / DoS)', () => {
    const v = failid.valideeriFail(fx.pngMootuga(9000, 100), 'pilt');
    assert.equal(v.ok, false);
    assert.match(v.viga, /liiga suur/i);
  });

  test('lükkab tagasi vale liigi (heli sloti pilt)', () => {
    const v = failid.valideeriFail(fx.png1x1(), 'heli');
    assert.equal(v.ok, false);
  });

  test('polüglot (PNG + <script>) lükatakse tagasi', () => {
    const v = failid.valideeriFail(fx.polyglotPng(), 'pilt');
    assert.equal(v.ok, false);
    assert.match(v.viga, /keelatud sisu/i);
  });
});

describe('heli valideerimine — kestus', () => {
  test('WAV kestus loetakse ja lubatud pikkus läheb läbi', () => {
    const v = failid.valideeriFail(fx.wav(3), 'heli');
    assert.equal(v.ok, true);
    assert.ok(Math.abs(v.kestus_s - 3) < 0.5);
  });

  test('MP3 / OGG / M4A kestus parsitakse', () => {
    assert.ok(Math.abs(failid.heliKestus(fx.mp3(8), 'mp3') - 8) < 1);
    assert.ok(Math.abs(failid.heliKestus(fx.ogg(7), 'ogg') - 7) < 0.5);
    assert.ok(Math.abs(failid.heliKestus(fx.m4a(6), 'm4a') - 6) < 0.5);
  });

  test('üle 10 min helifail lükatakse tagasi', () => {
    const v = failid.valideeriFail(fx.mp3(700), 'heli'); // ~11,7 min
    assert.equal(v.ok, false);
    assert.match(v.viga, /liiga pikk/i);
  });

  test('parsimatu kestusega "heli" lükatakse tagasi (fail-closed)', () => {
    // OggS päis, aga sisu pole Vorbis/Opus — kestust ei saa lugeda
    const buf = Buffer.alloc(100);
    buf.write('OggS', 0, 'latin1');
    const v = failid.valideeriFail(buf, 'heli');
    assert.equal(v.ok, false);
  });
});

describe('failinimed ja path traversal', () => {
  test('genereeriId annab 32 hex märki ja on juhuslik', () => {
    const a = failid.genereeriId();
    const b = failid.genereeriId();
    assert.match(a, /^[a-f0-9]{32}$/);
    assert.notEqual(a, b);
  });

  test('onTurvalineId blokeerib kõik traversal-katsed', () => {
    assert.equal(failid.onTurvalineId('a'.repeat(32)), true);
    for (const halb of [
      '../../etc/passwd', '..\\..\\windows\\system32', '../' + 'a'.repeat(32),
      'a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32), // suurtähed keelatud
      'a'.repeat(30) + './', '%2e%2e%2f', '', null, undefined, 42, {},
    ]) {
      assert.equal(failid.onTurvalineId(halb), false, 'lubas: ' + halb);
    }
  });

  test('puhastaFailinimi eemaldab kataloogiosad ja ohtlikud märgid', () => {
    assert.equal(failid.puhastaFailinimi('../../../evil.php').includes('/'), false);
    assert.equal(failid.puhastaFailinimi('a"b<c>d.png').includes('"'), false);
    assert.ok(failid.puhastaFailinimi('').length > 0);
    assert.ok(failid.puhastaFailinimi('x'.repeat(500)).length <= 120);
  });
});

describe('hoiustamine: krüpteerimine ja turvaline kustutamine', () => {
  const kaust = fs.mkdtempSync(path.join(os.tmpdir(), 'manused-test-'));

  test('salvestamine + lugemine ilma võtmeta (krüpteerimata)', () => {
    delete process.env.MANUSTE_VOTI;
    const id = failid.genereeriId();
    const sisu = fx.png1x1();
    const { krypteeritud } = failid.salvestaFail(kaust, id, sisu);
    assert.equal(krypteeritud, 0);
    assert.deepEqual(failid.loeFail(kaust, id, 0), sisu);
    failid.kustutaFail(kaust, id);
    assert.equal(failid.loeFail(kaust, id, 0), null);
  });

  test('AES-256-GCM ring: kettal pole avateksti, lugemine dekrüpteerib', () => {
    process.env.MANUSTE_VOTI = require('crypto').randomBytes(32).toString('hex');
    const id = failid.genereeriId();
    const sisu = fx.png1x1();
    const { krypteeritud } = failid.salvestaFail(kaust, id, sisu);
    assert.equal(krypteeritud, 1);
    const kettal = fs.readFileSync(path.join(kaust, id + '.bin'));
    assert.equal(kettal.includes(sisu.subarray(0, 8)), false, 'PNG magic ei tohi kettal paista');
    assert.deepEqual(failid.loeFail(kaust, id, 1), sisu);
    delete process.env.MANUSTE_VOTI;
    failid.kustutaFail(kaust, id);
  });

  test('vigane MANUSTE_VOTI annab selge vea', () => {
    process.env.MANUSTE_VOTI = 'liiga-lyhike';
    assert.throws(() => failid.kryptoVoti());
    delete process.env.MANUSTE_VOTI;
  });

  test('salvestaFail keeldub ebaturvalisest ID-st', () => {
    assert.throws(() => failid.salvestaFail(kaust, '../evil', fx.png1x1()));
  });
});
