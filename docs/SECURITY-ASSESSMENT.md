# Security Assessment - Eesti Mütoloogiaveeb (2026-06-10)

Scope: full codebase + deps (`npm audit`: **0 vulnerabilities**). Status refers to this change-set.

| # | Severity | Finding | Where | Status |
|---|----------|---------|-------|--------|
| C1 | Critical | Default creds (`admin/admin123`) seeded in production **and shown in the login UI** → instant admin takeover of fresh deploys | `server.js seedData()`, `index.html` | ✅ Fixed: prod seeds admin only from `ADMIN_PAROOL` env; UI hint removed |
| H1 | High | Stored XSS: `allikad[].url` unvalidated, rendered as `<a href>` - `javascript:` scheme survives `esc()`; admin clicks it during moderation | `server.js` POST/PUT olendid; `app.js renderDetail()` | ✅ Fixed: server allows only `http(s)` / internal refs; client `turvalineUrl()` guard |
| H2 | High | `pilt_url`/`heli_url` accepted with any scheme/host (length check only): `data:` URLs, visitor IP harvesting via hotlinks, attacker-controlled media under site origin | `server.js valideeriOlend()`; `app.js` | ✅ Fixed: replaced by validated upload system; legacy `https:` still renders |
| H3 | High | CSP `script-src 'unsafe-inline'` - no second line of defense if any HTML injection slips past `esc()` (forced by inline `onerror=` handlers) | `turve.js`, `app.js` | ⚠️ New code avoids inline handlers; refactor rest, then drop `'unsafe-inline'` |
| M1 | Medium | 7-day JWT embeds role; no revocation/server-side logout - demoted users keep role, stolen tokens stay valid | `server.js signToken()` | ❌ Recommend ≤24 h expiry + DB role re-check |
| M2 | Medium | Token also returned in JSON body (invites localStorage storage) | login/register routes | ❌ Recommend cookie-only |
| M3 | Medium | Audit log = `console.log` only (no persistence/tamper resistance) | `server.js auditLog()` | ✅ Fixed: `audit_logi` DB table (user, action, details, IP, time) |
| M4 | Medium | CAPTCHA fails **open** in production if `TURNSTILE_SECRET_KEY` unset | `turve.js verifyTurnstile()` | ✅ Fixed: fails closed in production |
| M5 | Medium | Brute-force counters in-memory, per-IP only - reset on restart, distributed attacks bypass | `turve.js`, rate limiters | ❌ Recommend persisted per-account counters |
| M6 | Medium | `bcrypt.hashSync/compareSync` block the event loop on auth routes | `server.js` | ❌ Recommend async bcrypt |
| M7 | Medium | SQLite DB in code dir; Railway ephemeral FS loses data (and uploads) on redeploy | `DB_PATH` default | ❌ Ops: mount volume, point `DB_PATH`/`MANUSTE_KAUST` at it |
| L1 | Low | User enumeration via register error | `server.js` | Accepted (CAPTCHA limits abuse) |
| L2 | Low | `:id` params unvalidated (parameterized SQL, so injection-safe) | various routes | ✅ New routes validate strictly |
| L3 | Low | `LIKE` search doesn't escape `%`/`_` | `/api/olendid` | Accepted |
| L4 | Low | Favoriting nonexistent olend → FK error → 500 | `POST /api/lemmikud/:id` | ❌ Validate → 404 |
| L5 | Low | `trust proxy 1` lets clients spoof IP if not actually behind a proxy | `server.js` | Documented; make env-driven if self-hosting |
| L6 | Low | No pagination + N+1 queries on `/api/olendid` | `olendTaielik()` | ❌ Add when data grows |

**Misconfiguration note:** `NODE_ENV=production` is the master switch for cookie `secure`, CSRF origin enforcement, JWT-secret guard, CAPTCHA fail-closed and seed gating - set it explicitly in Railway. Mapbox token is public by design; restrict it by URL in the Mapbox dashboard.

**Strengths kept as-is:** parameterized SQL everywhere (no injection found); bcrypt cost 12; `httpOnly`+`SameSite=Strict`+`secure` cookie; Origin allow-list CSRF check on mutating requests; API/auth rate limits; prod boot guard on weak `JWT_SECRET`; registration can't set role; ownership checks on edit/delete; generic error handler; solid header set (HSTS, nosniff, frame-deny, CSP).

**Hardening roadmap:** drop `'unsafe-inline'` (H3) → short-lived JWT + revocation (M1/M2) → persistent lockout counters (M5) → async bcrypt (M6) → pagination (L6) → optional ClamAV hook in upload pipeline (`failid.js skaneeriSisu`) → `npm audit` + `npm test` in CI.

File-upload architecture and controls: see `docs/UPLOAD-SYSTEM.md`.
