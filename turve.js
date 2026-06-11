/**
 * turve.js — Mütoloogiaveebi turvalisuse abimoodul
 * -------------------------------------------------
 * Koondab ühte kohta:
 *   1) Turvalised HTTP-päised (käsitsi, ilma uue sõltuvuseta)
 *   2) Cloudflare Turnstile CAPTCHA serveripoolne verifitseerimine
 *   3) Sisselogimiskatsete loendur (otsustab, millal CAPTCHA nõuda)
 *
 * Põhjus, miks ei kasuta `helmet`-i: vähem sõltuvusi ja sa näed täpselt,
 * milline päis mida teeb — kasulik eksamil selgitamiseks.
 */

'use strict';

// --- 1) Turvalised HTTP-päised --------------------------------------------
// Lisatakse igale vastusele. Kaitsevad XSS, clickjacking, MIME-sniffing eest.
function turvapaised(req, res, next) {
  // Brauser ei tohi sisu "ära arvata" — väldib MIME-sniffing rünnakuid
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Lehte ei tohi panna <iframe> sisse (clickjacking-kaitse)
  res.setHeader('X-Frame-Options', 'DENY');
  // Piira, kui palju viitajat (Referer) edasi antakse
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Keela vananenud brauseri-API-d
  res.setHeader('Permissions-Policy', 'geolocation=(self), microphone=(), camera=()');
  // Content Security Policy — lubab ainult vajalikud välisallikad
  // (Mapbox, Google Fonts, Cloudflare Turnstile).
  //
  // TURVAPARANDUS: 'unsafe-inline' on script-src'ist EEMALDATUD.
  // Varem oli see vajalik, sest frontend kasutas inline onerror=""
  // atribuute. Need on app.js-is asendatud ühe delegeeritud
  // addEventListener('error', ..., true) käsitlejaga. Nüüd ei käivitu
  // ükski HTML-i sisse süstitud <script> ega on*-atribuut — isegi kui
  // ründaja peaks leidma viisi HTML-i sisestada, blokeerib brauser selle.
  // ('unsafe-inline' jääb ainult style-src'i, sest Mapbox GL lisab
  // elementidele inline-stiile — stiilide kaudu skripti käivitada ei saa.)
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' https://api.mapbox.com https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline' https://api.mapbox.com https://fonts.googleapis.com",
      "img-src 'self' data: https:",
      "font-src 'self' https://fonts.gstatic.com",
      "connect-src 'self' https://api.mapbox.com https://events.mapbox.com",
      "frame-src https://challenges.cloudflare.com",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      // frame-ancestors on X-Frame-Options'i kaasaegne CSP-vaste —
      // mõlemad koos katavad nii vanad kui uued brauserid.
      "frame-ancestors 'none'",
    ].join('; ')
  );
  // HSTS — sunni HTTPS-i (toimib alles HTTPS-i all, Railwayl on see olemas)
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

// --- 2) Cloudflare Turnstile verifitseerimine -----------------------------
// Kontrollib kasutaja saadetud CAPTCHA-tokenit Cloudflare'i serveris.
// Tagastab true/false. Kui salavõti puudub (arendus), möödub kontrollist.
async function verifyTurnstile(token, remoteip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  // Arenduses ilma võtmeta: ära blokeeri (aga logi hoiatus)
  if (!secret) {
    console.warn('⚠️  TURNSTILE_SECRET_KEY puudub — CAPTCHA kontroll vahele jäetud (ainult arendus!)');
    return true;
  }
  if (!token) return false;

  try {
    const body = new URLSearchParams();
    body.append('secret', secret);
    body.append('response', token);
    if (remoteip) body.append('remoteip', remoteip);

    // Node 22 sisseehitatud fetch — ei vaja node-fetch'i
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await r.json();
    return data.success === true;
  } catch (e) {
    console.error('[TURNSTILE] verifitseerimine ebaõnnestus:', e.message);
    return false; // turvaline vaikeväärtus: viga = ei lase läbi
  }
}

// --- 3) Sisselogimiskatsete loendur (brute-force) -------------------------
// Mälupõhine loendur kasutajanime + IP kohta. Pärast N ebaõnnestumist
// nõutakse sisselogimisel CAPTCHA-t. Edukas login nullib loenduri.
// (Mälupõhine = lihtne; tootmises mitme serveriga kasuta Redist.)
const ebaonnestumised = new Map(); // võti -> { arv, esimene }
const CAPTCHA_LAVI = 3;            // mitu ebaõnnestumist enne CAPTCHA-t
const AKEN_MS = 15 * 60 * 1000;    // loendur nulldub 15 min pärast

function votmeKlapp(req) {
  const nimi = (req.body && req.body.kasutajanimi) || '';
  return nimi.toLowerCase() + '|' + req.ip;
}

function vajabCaptchat(req) {
  const k = ebaonnestumised.get(votmeKlapp(req));
  if (!k) return false;
  if (Date.now() - k.esimene > AKEN_MS) return false; // aken aegunud
  return k.arv >= CAPTCHA_LAVI;
}

function markEbaonnestumine(req) {
  const key = votmeKlapp(req);
  const k = ebaonnestumised.get(key);
  if (!k || Date.now() - k.esimene > AKEN_MS) {
    ebaonnestumised.set(key, { arv: 1, esimene: Date.now() });
  } else {
    k.arv += 1;
  }
}

function nullistaKatsed(req) {
  ebaonnestumised.delete(votmeKlapp(req));
}

module.exports = {
  turvapaised,
  verifyTurnstile,
  vajabCaptchat,
  markEbaonnestumine,
  nullistaKatsed,
  CAPTCHA_LAVI,
};