/**
 * test/fixtures.js — testfailide ehitajad
 * Iga funktsioon tagastab Buffer'i, mis on vastava vormingu MINIMAALNE
 * kehtiv (parserite jaoks) esitus. Pole vaja binaarfaile repos hoida.
 */

'use strict';

/** 1×1 px kehtiv PNG (base64). */
function png1x1() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
}

/** PNG etteantud mõõtmetega (ainult päis — mõõtmete parseri jaoks piisav). */
function pngMootuga(laius, korgus) {
  const buf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);          // IHDR pikkus
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(laius, 16);
  buf.writeUInt32BE(korgus, 20);
  return buf;
}

/** Minimaalne JPEG päis SOF0 markeriga (mõõtmed sees). */
function jpeg(laius = 1, korgus = 1) {
  const buf = Buffer.alloc(32);
  buf[0] = 0xff; buf[1] = 0xd8;      // SOI
  buf[2] = 0xff; buf[3] = 0xc0;      // SOF0
  buf.writeUInt16BE(17, 4);          // segmendi pikkus
  buf[6] = 8;                        // täpsus
  buf.writeUInt16BE(korgus, 7);
  buf.writeUInt16BE(laius, 9);
  return buf;
}

/** Minimaalne WEBP (VP8L, 1×1). */
function webp() {
  const buf = Buffer.alloc(32);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(24, 4);
  buf.write('WEBP', 8, 'latin1');
  buf.write('VP8L', 12, 'latin1');
  buf.writeUInt32LE(8, 16);
  buf[20] = 0x2f;                    // VP8L signatuur
  buf.writeUInt32LE(0, 21);          // 14+14 bitti: (0+1)×(0+1) px
  return buf;
}

/** Kehtiv WAV etteantud kestusega (sekundites). */
function wav(kestusS = 2) {
  const byteRate = 8000;
  const dataSuurus = Math.round(byteRate * kestusS);
  const buf = Buffer.alloc(44 + Math.min(dataSuurus, 1024)); // sisu ei pea päriselt olemas olema
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + dataSuurus, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16);         // fmt chunki suurus
  buf.writeUInt16LE(1, 20);          // PCM
  buf.writeUInt16LE(1, 22);          // mono
  buf.writeUInt32LE(8000, 24);       // sämplisagedus
  buf.writeUInt32LE(byteRate, 28);   // byteRate
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(dataSuurus, 40);
  return buf;
}

/** MP3 (CBR 32 kbps, 44100 Hz) — kestus tuleneb faili suurusest. */
function mp3(kestusS = 5) {
  const suurus = Math.max(256, Math.round((32000 / 8) * kestusS));
  const buf = Buffer.alloc(suurus);
  buf[0] = 0xff; buf[1] = 0xfb;      // sünk + MPEG1 Layer III
  buf[2] = 0x10;                     // bitrate idx 1 (32 kbps), 44100 Hz
  buf[3] = 0x00;                     // stereo
  return buf;
}

/** OGG Vorbis etteantud kestusega. */
function ogg(kestusS = 5) {
  const rate = 44100;
  // Esimene leht: identifitseerimispakett
  const p1 = Buffer.alloc(27 + 1 + 30);
  p1.write('OggS', 0, 'latin1');
  p1[26] = 1;                        // 1 segment
  p1[27] = 30;                       // segmendi pikkus
  const pakett = 28;
  p1[pakett] = 0x01;
  p1.write('vorbis', pakett + 1, 'latin1');
  p1.writeUInt32LE(rate, pakett + 12);
  // Viimane leht: granule = sämplite koguarv
  const p2 = Buffer.alloc(27);
  p2.write('OggS', 0, 'latin1');
  p2.writeBigUInt64LE(BigInt(Math.round(rate * kestusS)), 6);
  return Buffer.concat([p1, Buffer.alloc(64), p2]);
}

/** M4A (ftyp + moov/mvhd) etteantud kestusega. */
function m4a(kestusS = 5) {
  const ftyp = Buffer.alloc(16);
  ftyp.writeUInt32BE(16, 0);
  ftyp.write('ftyp', 4, 'latin1');
  ftyp.write('M4A ', 8, 'latin1');
  const mvhd = Buffer.alloc(8 + 24);
  mvhd.writeUInt32BE(8 + 24, 0);
  mvhd.write('mvhd', 4, 'latin1');
  mvhd[8] = 0;                       // versioon 0
  mvhd.writeUInt32BE(1000, 8 + 12);  // timescale
  mvhd.writeUInt32BE(Math.round(kestusS * 1000), 8 + 16); // kestus
  const moov = Buffer.alloc(8);
  moov.writeUInt32BE(8 + mvhd.length, 0);
  moov.write('moov', 4, 'latin1');
  return Buffer.concat([ftyp, moov, mvhd]);
}

/** PHP veebikest (pahaloomulise faili simulatsioon). */
function phpKest() {
  return Buffer.from("<?php system($_GET['c']); ?>", 'utf8');
}

/** Polüglot: kehtiv PNG, mille lõppu on peidetud skript. */
function polyglotPng() {
  return Buffer.concat([png1x1(), Buffer.from('<script>alert(1)</script>', 'utf8')]);
}

module.exports = { png1x1, pngMootuga, jpeg, webp, wav, mp3, ogg, m4a, phpKest, polyglotPng };
