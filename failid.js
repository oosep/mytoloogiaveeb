/**
 * failid.js — Failide üleslaadimise turvamoodul
 * ----------------------------------------------
 * Koondab ühte kohta kogu failide valideerimise ja hoiustamise loogika:
 *   1) Failitüübi tuvastus SISU järgi (magic bytes) — laiendit EI usaldata
 *   2) Pildi mõõtmete lugemine (JPG/PNG/WEBP päistest)
 *   3) Heli kestuse lugemine (MP3/WAV/M4A/OGG päistest)
 *   4) Sisu skaneerimine (polüglot-failide heuristika + ClamAV haakekoht)
 *   5) Krüptograafiliselt juhuslikud failinimed (path traversal võimatu)
 *   6) Valikuline AES-256-GCM krüpteerimine kettal (MANUSTE_VOTI env)
 *   7) Turvaline kustutamine (ülekirjutamine enne unlinki)
 *
 * Põhimõte: failid salvestatakse VÄLJASPOOL veebijuurikat (mitte /public),
 * alati laiendiga ".bin", ning serveeritakse ainult läbi kontrollitud
 * API marsruudi, mis seab õige Content-Type'i andmebaasist.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- Piirangud --------------------------------------------------------------
const PIIRID = {
  PILT_MAX_BAIT: 5 * 1024 * 1024,   // 5 MB
  HELI_MAX_BAIT: 20 * 1024 * 1024,  // 20 MB
  PILT_MAX_MOOT: 8000,              // max laius/kõrgus pikslites
  HELI_MAX_KESTUS_S: 600,           // 10 minutit
};

// Lubatud tüübid: tuvastatud sisu -> mime + laiend + liik
const LUBATUD_TYYBID = {
  jpg:  { mime: 'image/jpeg', liik: 'pilt' },
  png:  { mime: 'image/png',  liik: 'pilt' },
  webp: { mime: 'image/webp', liik: 'pilt' },
  mp3:  { mime: 'audio/mpeg', liik: 'heli' },
  wav:  { mime: 'audio/wav',  liik: 'heli' },
  m4a:  { mime: 'audio/mp4',  liik: 'heli' },
  ogg:  { mime: 'audio/ogg',  liik: 'heli' },
};

// --- 1) Failitüübi tuvastus magic-baitide järgi -----------------------------

/** Kas buffer algab antud baitidega (offsetilt)? */
function algab(buf, baidid, offset = 0) {
  if (buf.length < offset + baidid.length) return false;
  for (let i = 0; i < baidid.length; i++) {
    if (buf[offset + i] !== baidid[i]) return false;
  }
  return true;
}
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

/**
 * Tuvastab failitüübi SISU järgi. Tagastab { laiend, mime, liik } või null.
 * Laiend failinimes ei oma mingit tähtsust — ainult sisu loeb.
 */
function tuvastaTyyp(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

  // JPEG: FF D8 FF
  if (algab(buf, [0xff, 0xd8, 0xff])) return { laiend: 'jpg', ...LUBATUD_TYYBID.jpg };
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (algab(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { laiend: 'png', ...LUBATUD_TYYBID.png };
  // RIFF konteiner: WEBP või WAV
  if (algab(buf, ascii('RIFF'))) {
    if (algab(buf, ascii('WEBP'), 8)) return { laiend: 'webp', ...LUBATUD_TYYBID.webp };
    if (algab(buf, ascii('WAVE'), 8)) return { laiend: 'wav', ...LUBATUD_TYYBID.wav };
    return null;
  }
  // OGG: OggS — aktsepteerime ainult Vorbis/Opus heli (kontrollitakse kestuse parsimisel)
  if (algab(buf, ascii('OggS'))) return { laiend: 'ogg', ...LUBATUD_TYYBID.ogg };
  // M4A: ....ftyp + lubatud brand; video-jälgedega MP4 lükatakse tagasi
  if (algab(buf, ascii('ftyp'), 4)) {
    const brand = buf.toString('latin1', 8, 12);
    const lubatudBrandid = ['M4A ', 'M4B ', 'mp41', 'mp42', 'isom', 'iso2'];
    if (!lubatudBrandid.includes(brand)) return null;
    if (sisaldabVideoJalge(buf)) return null; // MP4-video maskeerimine M4A-ks
    return { laiend: 'm4a', ...LUBATUD_TYYBID.m4a };
  }
  // MP3: ID3-tag või MPEG-kaadri sünk; nõuame, et leiduks päris kaadripäis
  if (algab(buf, ascii('ID3')) || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) {
    if (leiaMp3Kaader(buf)) return { laiend: 'mp3', ...LUBATUD_TYYBID.mp3 };
  }
  return null;
}

/** Otsib MP4 'hdlr' kaste — kui leidub 'vide' handler, on tegu videoga. */
function sisaldabVideoJalge(buf) {
  let i = 0;
  while ((i = buf.indexOf('hdlr', i)) !== -1) {
    // hdlr-kasti sisu: version+flags(4) + pre_defined(4) + handler_type(4)
    const handler = buf.toString('latin1', i + 4 + 8, i + 4 + 12);
    if (handler === 'vide') return true;
    i += 4;
  }
  return false;
}

// --- 2) Pildi mõõtmed --------------------------------------------------------

/** Tagastab { laius, korgus } või null, kui päist ei õnnestu parsida. */
function pildiMootmed(buf, laiend) {
  try {
    if (laiend === 'png') {
      // IHDR on alati esimene chunk: laius/kõrgus big-endian offsetil 16/20
      if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
      return { laius: buf.readUInt32BE(16), korgus: buf.readUInt32BE(20) };
    }
    if (laiend === 'jpg') return jpegMootmed(buf);
    if (laiend === 'webp') return webpMootmed(buf);
  } catch (_) { /* vigane päis */ }
  return null;
}

function jpegMootmed(buf) {
  // Käime markerid läbi, kuni leiame SOF (Start of Frame)
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }       // täitebaidid
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const pikkus = buf.readUInt16BE(i + 2);
    // SOF0..SOF15, v.a DHT(C4), JPG(C8), DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { korgus: buf.readUInt16BE(i + 5), laius: buf.readUInt16BE(i + 7) };
    }
    if (pikkus < 2) return null;
    i += 2 + pikkus;
  }
  return null;
}

function webpMootmed(buf) {
  const vorming = buf.toString('latin1', 12, 16);
  const d = 20; // chunki andmete algus
  if (vorming === 'VP8 ') {
    // Võtmekaadri algus: 3B frame tag + sünk 9D 01 2A + laius/kõrgus (14 bitti)
    if (buf[d + 3] !== 0x9d || buf[d + 4] !== 0x01 || buf[d + 5] !== 0x2a) return null;
    return { laius: buf.readUInt16LE(d + 6) & 0x3fff, korgus: buf.readUInt16LE(d + 8) & 0x3fff };
  }
  if (vorming === 'VP8L') {
    if (buf[d] !== 0x2f) return null;
    const b = buf.readUInt32LE(d + 1);
    return { laius: (b & 0x3fff) + 1, korgus: ((b >> 14) & 0x3fff) + 1 };
  }
  if (vorming === 'VP8X') {
    // 24-bitised canvas'e mõõdud (väärtus - 1)
    const laius = 1 + (buf[d + 4] | (buf[d + 5] << 8) | (buf[d + 6] << 16));
    const korgus = 1 + (buf[d + 7] | (buf[d + 8] << 8) | (buf[d + 9] << 16));
    return { laius, korgus };
  }
  return null;
}

// --- 3) Heli kestus -----------------------------------------------------------

/** Tagastab kestuse sekundites või null, kui ei õnnestu usaldusväärselt parsida. */
function heliKestus(buf, laiend) {
  try {
    if (laiend === 'wav') return wavKestus(buf);
    if (laiend === 'mp3') return mp3Kestus(buf);
    if (laiend === 'ogg') return oggKestus(buf);
    if (laiend === 'm4a') return m4aKestus(buf);
  } catch (_) { /* vigane päis */ }
  return null;
}

function wavKestus(buf) {
  // RIFF chunkide läbikäik: vajame 'fmt ' (byteRate) ja 'data' (suurus)
  let i = 12, byteRate = 0, dataSuurus = 0;
  while (i + 8 <= buf.length) {
    const id = buf.toString('latin1', i, i + 4);
    const suurus = buf.readUInt32LE(i + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(i + 16);
    if (id === 'data') { dataSuurus = suurus; break; }
    i += 8 + suurus + (suurus % 2); // chunkid on 2-baidi joondusega
  }
  if (!byteRate || !dataSuurus) return null;
  return dataSuurus / byteRate;
}

/** Leiab esimese kehtiva MPEG-kaadri päise. Tagastab { offset, ... } või null. */
function leiaMp3Kaader(buf) {
  let i = 0;
  if (algab(buf, ascii('ID3'))) {
    // ID3v2 suurus on "syncsafe" (7 bitti baidi kohta)
    const s = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    i = 10 + s;
  }
  const lopp = Math.min(buf.length - 4, i + 64 * 1024); // otsi mõistlikust algusosast
  for (; i < lopp; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const versioonBit = (buf[i + 1] >> 3) & 0x03; // 0=2.5, 2=MPEG2, 3=MPEG1
    const kiht = (buf[i + 1] >> 1) & 0x03;        // 1 = Layer III
    const brIdx = (buf[i + 2] >> 4) & 0x0f;
    const srIdx = (buf[i + 2] >> 2) & 0x03;
    if (versioonBit === 1 || kiht !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) continue;

    const v1 = versioonBit === 3;
    const bitrate = (v1
      ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[brIdx];
    const sampleRate = (v1 ? [44100, 48000, 32000]
      : versioonBit === 2 ? [22050, 24000, 16000]
      : [11025, 12000, 8000])[srIdx];
    const kanaliMode = (buf[i + 3] >> 6) & 0x03;
    return { offset: i, v1, bitrate, sampleRate, mono: kanaliMode === 3 };
  }
  return null;
}

function mp3Kestus(buf) {
  const k = leiaMp3Kaader(buf);
  if (!k) return null;
  const samplesPerFrame = k.v1 ? 1152 : 576;
  // VBR? Xing/Info päis annab täpse kaadrite arvu
  const xingOff = k.offset + 4 + (k.v1 ? (k.mono ? 17 : 32) : (k.mono ? 9 : 17));
  const tag = buf.toString('latin1', xingOff, xingOff + 4);
  if ((tag === 'Xing' || tag === 'Info') && (buf.readUInt32BE(xingOff + 4) & 0x01)) {
    const kaadreid = buf.readUInt32BE(xingOff + 8);
    return (kaadreid * samplesPerFrame) / k.sampleRate;
  }
  // CBR hinnang failisuuruse ja bitikiiruse järgi
  return ((buf.length - k.offset) * 8) / (k.bitrate * 1000);
}

function oggKestus(buf) {
  // Sämplisagedus esimese lehe esimesest paketist (Vorbis või Opus)
  const nsegs = buf[26];
  const pakett = 27 + nsegs; // esimese paketi algus
  let rate = 0;
  if (buf[pakett] === 0x01 && buf.toString('latin1', pakett + 1, pakett + 7) === 'vorbis') {
    rate = buf.readUInt32LE(pakett + 12);
  } else if (buf.toString('latin1', pakett, pakett + 8) === 'OpusHead') {
    rate = 48000; // Opuse granule-positsioon on alati 48 kHz ühikutes
  } else {
    return null; // tundmatu koodek (nt Theora video OGG-konteineris) -> tagasi lükata
  }
  // Viimase lehe granule-positsioon = sämplite koguarv
  const saba = buf.subarray(Math.max(0, buf.length - 64 * 1024));
  const viimane = saba.lastIndexOf('OggS');
  if (viimane === -1 || viimane + 14 > saba.length) return null;
  const granule = Number(saba.readBigUInt64LE(viimane + 6));
  if (!Number.isFinite(granule) || granule <= 0) return null;
  return granule / rate;
}

function m4aKestus(buf) {
  // MP4 kastide (box) läbikäik: moov -> mvhd -> timescale + duration
  function leiaKast(algus, lopp, tyyp) {
    let i = algus;
    while (i + 8 <= lopp) {
      let suurus = buf.readUInt32BE(i);
      const t = buf.toString('latin1', i + 4, i + 8);
      let pais = 8;
      if (suurus === 1) { suurus = Number(buf.readBigUInt64BE(i + 8)); pais = 16; }
      else if (suurus === 0) suurus = lopp - i;
      if (suurus < pais) return null;
      if (t === tyyp) return { algus: i + pais, lopp: Math.min(i + suurus, lopp) };
      i += suurus;
    }
    return null;
  }
  const moov = leiaKast(0, buf.length, 'moov');
  if (!moov) return null;
  const mvhd = leiaKast(moov.algus, moov.lopp, 'mvhd');
  if (!mvhd) return null;
  const d = mvhd.algus;
  const versioon = buf[d];
  if (versioon === 1) {
    const timescale = buf.readUInt32BE(d + 20);
    const kestus = Number(buf.readBigUInt64BE(d + 24));
    return timescale ? kestus / timescale : null;
  }
  const timescale = buf.readUInt32BE(d + 12);
  const kestus = buf.readUInt32BE(d + 16);
  return timescale ? kestus / timescale : null;
}

// --- 4) Sisu skaneerimine -----------------------------------------------------

/**
 * Heuristiline polüglot-kontroll: meediafail EI tohi sisaldada aktiivset
 * veebisisu (kaitseb HTML/skript-maskeeringu ja serveripoolse koodi vastu,
 * kui fail kunagi mujale satub). Siia saab lisada ka ClamAV vms skanneri:
 *   nt clamdjs.scanBuffer(buf) — tagasta false, kui nakatunud.
 */
function skaneeriSisu(buf) {
  const tekst = buf.toString('latin1').toLowerCase();
  const ohtlikud = ['<script', '<?php', '<%@', '<!doctype html', '<html', '<iframe', '<object data', '<embed src'];
  return !ohtlikud.some((m) => tekst.includes(m));
}

// --- 5) Failinimed ja teed ------------------------------------------------------

/** Krüptograafiliselt juhuslik ID (32 hex märki) — failinimi kettal. */
function genereeriId() {
  return crypto.randomBytes(16).toString('hex');
}

/** Range ID kontroll — välistab path traversal'i serveerimisel. */
function onTurvalineId(id) {
  return typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
}

/** Puhastab kasutaja failinime metaandmete jaoks (mitte kettale!). */
function puhastaFailinimi(nimi) {
  const baas = path.basename(String(nimi || 'fail'));
  return baas.replace(/[^\w.À-ɏ -]/g, '_').slice(0, 120) || 'fail';
}

// --- 6) Hoiustamine (valikulise AES-256-GCM krüpteerimisega) --------------------

const KRYPTO_MARKER = Buffer.from('MV01'); // failivormingu tunnus: marker+iv+tag+sisu

/** Loeb krüptovõtme keskkonnamuutujast (64 hex märki = 32 baiti) või null. */
function kryptoVoti() {
  const hex = process.env.MANUSTE_VOTI || '';
  if (!hex) return null;
  if (!/^[a-f0-9]{64}$/i.test(hex)) {
    throw new Error('MANUSTE_VOTI peab olema täpselt 64 hex märki (32 baiti).');
  }
  return Buffer.from(hex, 'hex');
}

/** Salvestab faili kettale; krüpteerib, kui võti on seadistatud. Tagastab { krypteeritud }. */
function salvestaFail(kaust, id, buf) {
  if (!onTurvalineId(id)) throw new Error('Vigane faili ID.');
  const voti = kryptoVoti();
  let sisu = buf;
  let krypteeritud = 0;
  if (voti) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', voti, iv);
    const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
    sisu = Buffer.concat([KRYPTO_MARKER, iv, cipher.getAuthTag(), ct]);
    krypteeritud = 1;
  }
  // .bin laiend + kirjutuskaitse: faili ei käivita ükski server laiendi järgi
  fs.writeFileSync(path.join(kaust, id + '.bin'), sisu, { mode: 0o600 });
  return { krypteeritud };
}

/** Loeb (ja vajadusel dekrüpteerib) faili. Tagastab Buffer'i või null. */
function loeFail(kaust, id, krypteeritud) {
  if (!onTurvalineId(id)) return null;
  const tee = path.join(kaust, id + '.bin');
  if (!fs.existsSync(tee)) return null;
  const sisu = fs.readFileSync(tee);
  if (!krypteeritud) return sisu;
  const voti = kryptoVoti();
  if (!voti || !sisu.subarray(0, 4).equals(KRYPTO_MARKER)) return null;
  const iv = sisu.subarray(4, 16);
  const tag = sisu.subarray(16, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', voti, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sisu.subarray(32)), decipher.final()]);
}

/** Turvaline kustutamine: kirjutab faili üle juhuslike baitidega, siis eemaldab. */
function kustutaFail(kaust, id) {
  if (!onTurvalineId(id)) return;
  const tee = path.join(kaust, id + '.bin');
  try {
    const suurus = fs.statSync(tee).size;
    fs.writeFileSync(tee, crypto.randomBytes(Math.min(suurus, 32 * 1024 * 1024)));
  } catch (_) { /* faili pole — pole midagi üle kirjutada */ }
  try { fs.unlinkSync(tee); } catch (_) { /* juba kustutatud */ }
}

// --- 7) Tervikvalideerimine -----------------------------------------------------

/**
 * Valideerib üleslaaditud faili täielikult.
 * @param {Buffer} buf — faili sisu
 * @param {string} oodatudLiik — 'pilt' | 'heli' (millist tüüpi vorm ootab)
 * @returns {{ ok:true, laiend, mime, liik, laius?, korgus?, kestus_s? } | { ok:false, viga }}
 */
function valideeriFail(buf, oodatudLiik) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return { ok: false, viga: 'Fail on tühi.' };
  }
  const tyyp = tuvastaTyyp(buf);
  if (!tyyp) {
    return { ok: false, viga: 'Failitüüp pole lubatud. Lubatud: JPG, PNG, WEBP, MP3, WAV, M4A, OGG.' };
  }
  if (oodatudLiik && tyyp.liik !== oodatudLiik) {
    return { ok: false, viga: `Oodati ${oodatudLiik === 'pilt' ? 'pilti' : 'helifaili'}, aga fail on ${tyyp.liik}.` };
  }
  const maxBait = tyyp.liik === 'pilt' ? PIIRID.PILT_MAX_BAIT : PIIRID.HELI_MAX_BAIT;
  if (buf.length > maxBait) {
    return { ok: false, viga: `Fail on liiga suur (max ${Math.round(maxBait / 1024 / 1024)} MB).` };
  }
  if (!skaneeriSisu(buf)) {
    return { ok: false, viga: 'Fail sisaldab keelatud sisu.' };
  }
  const tulemus = { ok: true, ...tyyp };
  if (tyyp.liik === 'pilt') {
    const moot = pildiMootmed(buf, tyyp.laiend);
    if (!moot || !moot.laius || !moot.korgus) {
      return { ok: false, viga: 'Pildi mõõtmeid ei õnnestunud lugeda — fail võib olla vigane.' };
    }
    if (moot.laius > PIIRID.PILT_MAX_MOOT || moot.korgus > PIIRID.PILT_MAX_MOOT) {
      return { ok: false, viga: `Pilt on liiga suur (max ${PIIRID.PILT_MAX_MOOT}×${PIIRID.PILT_MAX_MOOT} px).` };
    }
    tulemus.laius = moot.laius;
    tulemus.korgus = moot.korgus;
  } else {
    const kestus = heliKestus(buf, tyyp.laiend);
    if (kestus == null || !Number.isFinite(kestus) || kestus <= 0) {
      return { ok: false, viga: 'Helifaili kestust ei õnnestunud lugeda — fail võib olla vigane.' };
    }
    if (kestus > PIIRID.HELI_MAX_KESTUS_S) {
      return { ok: false, viga: `Helifail on liiga pikk (max ${PIIRID.HELI_MAX_KESTUS_S / 60} min).` };
    }
    tulemus.kestus_s = Math.round(kestus * 10) / 10;
  }
  return tulemus;
}

module.exports = {
  PIIRID,
  LUBATUD_TYYBID,
  tuvastaTyyp,
  pildiMootmed,
  heliKestus,
  skaneeriSisu,
  genereeriId,
  onTurvalineId,
  puhastaFailinimi,
  kryptoVoti,
  salvestaFail,
  loeFail,
  kustutaFail,
  valideeriFail,
};
