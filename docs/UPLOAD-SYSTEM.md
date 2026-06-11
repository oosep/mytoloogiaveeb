# Secure File Upload System

Replaces the old "paste a URL" model (findings H1/H2 in `SECURITY-ASSESSMENT.md`) with authenticated, content-validated uploads. Images: **JPG, PNG, WEBP**. Audio: **MP3, WAV, M4A, OGG**.

## Architecture

```
Browser (file input)                Server                         Disk / DB
────────────────────                ──────                         ─────────
1. user picks file
2. POST /api/failid  ──multipart──▶ uploadLimiter (30/15min)
   (cookie/JWT auth)                authRequired + rollRequired(toimetaja,admin)
                                    multer memoryStorage (≤20 MB, 1 file)
                                    failid.valideeriFail(buf):
                                      • magic-byte type detection (NOT extension/Content-Type)
                                      • size limits (5 MB img / 20 MB audio)
                                      • image dimensions ≤ 8000×8000
                                      • audio duration ≤ 10 min
                                      • content scan (reject HTML/script/php polyglots)
                                    random 32-hex id ─────────────▶ uploads/<id>.bin  (mode 0600,
                                    optional AES-256-GCM at rest      OUTSIDE /public)
                                    metadata + sha256 ────────────▶ manused (DB)
                                    auditLog ─────────────────────▶ audit_logi (DB)
3. {id, url:/api/failid/<id>} ◀───
4. url stored in olend.pilt_url/heli_url (hidden form field)

GET /api/failid/<id>  ──▶ strict id regex (no traversal)
                         public only if linked olend is 'avaldatud', else owner/staff
                         serve with exact MIME + nosniff + CSP "default-src 'none'; sandbox"
```

Files are **never** served from disk by the static handler — only through `GET /api/failid/:id`, which sets the type from the DB and a sandbox CSP so a browser can't sniff or execute the bytes.

## API

| Method | Path | Auth | Body / Notes | Returns |
|--------|------|------|--------------|---------|
| POST | `/api/failid` | toimetaja, admin | multipart: `fail` (binary), `liik` (`pilt`\|`heli`) | `201 {fail:{id,url,liik,mime,originaalnimi,suurus,laius,korgus,kestus_s}}` |
| GET | `/api/failid/:id` | public if published, else owner/staff | `:id` = 32 hex | file bytes + `nosniff`, sandbox CSP, `Content-Disposition: inline` |
| DELETE | `/api/failid/:id` | owner or admin | overwrites then unlinks; clears olend references | `200 {ok:true}` |

Error codes: `401` no auth, `403` wrong role/not owner, `413` too large, `422` failed validation, `404` not found / no access (privacy: never `403` for a hidden file's existence).

Olend create/update validate that any `/api/failid/<id>` reference exists, is the right `liik`, and belongs to the caller (admin may use any) before linking.

## Database

`manused` (id PK 32-hex, liik, mime, laiend, originaalnimi, suurus, sha256, laius, korgus, kestus_s, krypteeritud, omanik_id→kasutajad, olend_id→olendid, loodud_at). `audit_logi` (kasutaja_id, kasutajanimi, tegevus, yksikasjad JSON, ip, loodud_at). Full DDL in `database.sql` and the built-in schema in `server.js`.

## Config (env)

`MANUSTE_KAUST` (upload dir, default `./uploads` — point at a Railway volume in prod), `MANUSTE_VOTI` (64 hex = 32 bytes → enables AES-256-GCM at rest), `ADMIN_PAROOL`/`ADMIN_EMAIL` (prod-only initial admin; no default test users in prod). See `.env.example`.

## Security controls checklist

- [x] Server-side MIME via magic bytes; extension & client Content-Type ignored
- [x] File signature verification for all 7 formats; RIFF/OGG/MP4 sub-type checks; MP4-video-as-M4A rejected
- [x] Size limits (5/20 MB) enforced by multer **and** revalidated post-parse
- [x] Image dimension limits (≤8000²); pixel-flood headers rejected
- [x] Audio duration limit (≤10 min); unparsable audio fails closed
- [x] Polyglot/active-content scan (`<script`, `<?php`, `<html`, …) — extensible to ClamAV via `skaneeriSisu`
- [x] Cryptographically random filenames (`crypto.randomBytes`), `.bin` ext, mode 0600
- [x] Stored outside web root; served only via controlled route
- [x] Path traversal blocked by `/^[a-f0-9]{32}$/` id check
- [x] No execution: sandbox CSP + `nosniff` + exact MIME on serve
- [x] Optional AES-256-GCM encryption at rest; metadata stored separately in DB
- [x] Secure delete (overwrite then unlink)
- [x] AuthN + role-based AuthZ on upload/delete; ownership checks; access control on serve
- [x] Upload rate limiting (30 / 15 min) + global API limiter
- [x] CSRF: Origin allow-list on mutating requests + `SameSite=Strict` cookie
- [x] Security headers incl. HSTS; HTTPS enforced by platform
- [x] DB audit log of every upload/reject/delete with IP
- [x] Stored-XSS defense: server rejects non-`http(s)`/non-internal URLs; client `turvalineUrl()` guards link rendering

## Manual penetration-testing checklist

1. **Path traversal:** `GET /api/failid/..%2f..%2fserver.js`, `%2e%2e%5c.env`, 31/33-char ids → all 404.
2. **Malicious upload:** upload `shell.php`, EICAR, ELF, `.htaccess` as `fail` with `image/png` → 422; confirm nothing lands in `uploads/`.
3. **MIME spoofing:** PHP body, filename `x.png`, `Content-Type: image/png` → 422 (content wins).
4. **Polyglot:** valid PNG with appended `<script>`/PHP → 422.
5. **XSS via content:** upload SVG (not allowed → 422); fetch a stored image, confirm `Content-Type` exact + `nosniff` + sandbox CSP so it can't run as HTML.
6. **SSRF:** confirm no server-side fetch of user URLs remains; `pilt_url` only accepts internal refs or inert `http(s)` strings (never dereferenced server-side).
7. **CSRF:** replay `POST /api/failid` from a foreign Origin → 403; cookie is `SameSite=Strict`.
8. **AuthN bypass:** upload with no token / expired token → 401.
9. **AuthZ bypass:** kylastaja uploads → 403; user A deletes user B's file → 403; user A links user B's file to an olend → 400; fetch another user's unpublished file → 404.
10. **Resource exhaustion:** 21 MB body → 413; 100 rapid uploads → 429; long-duration/huge-dimension media → 422; zip-bomb-style oversized declared WAV `data` chunk → bounded by byte cap.
11. **At rest:** with `MANUSTE_VOTI` set, inspect `uploads/<id>.bin` — no plaintext magic bytes; after DELETE the file is gone.

Automated coverage for 1–11 lives in `test/failid.test.js` and `test/api.test.js` (`npm test`, 36 tests).
