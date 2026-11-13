# Security notes

What exists, how it was checked, and what is still open. Verified items name the test that checks them. Anything not listed as verified has **not** been verified.

## Verified by automated tests (`npm test`)

| Control | Test |
|---|---|
| School B cannot read, change or delete School A's records by id, by list, by `tenantId` in body/query, or by the `X-Acting-School` header; checked for admin, teacher, student, finance and library roles over every read endpoint plus 21 write endpoints; no write changes A's data | `15-cross-tenant-security` |
| A school's files cannot be downloaded or linked by another school; forged tokens fail | `15-cross-tenant-security` |
| A suspended school's sessions stop working at once; other schools are unaffected | `15-cross-tenant-security` |
| Only the Platform Admin can create schools/administrators; teachers and students cannot reach admin routes; acting inside a school is audited | `01-platform-and-tenancy` |
| MongoDB operators (`$ne`, `a[$in][]=…`) and prototype keys in a body or query are refused before any handler | `16-security-hardening` |
| Production refuses to start with a missing, short or published-default `JWT_SECRET`, or with localhost/`*` as the CORS origin | `16-security-hardening` |
| API responses are `no-store`, carry helmet's headers and HSTS, and do not show `X-Powered-By` | `16-security-hardening` |
| Errors do not reveal stack traces, internals or record ids; duplicate errors name the field, not the value | `16-security-hardening` |
| Unknown and known login ids get the same answer (and take one password check each) | `16-security-hardening` |
| A person cannot choose a short, common, demo or over-long password | `16-security-hardening` |
| Uploads: the content must match the declared type (PDF/PNG/JPEG/WebP/Office/text signatures); risky types download rather than open; downloads carry a sandbox CSP | `16-security-hardening`, `04-learning-and-files` |
| Login lockout, wrong-portal refusal, session revoke on password change | `01`, `08-portal-login-and-staff` |

## Controls in the code (reviewed by reading, not separately attack-tested)

* Tenant id comes only from the signed-in user (or the Platform Admin's explicit, audited acting header). Handlers take `ctx.tenantId`, never a client value.
* Input validation with zod on every route; JSON body limit 2 MB; per-IP API rate limit and a stricter login limiter; account lockout after 8 failures for 15 minutes.
* Passwords hashed with bcrypt (12 rounds in production, 10 elsewhere). Argon2id is not used; bcrypt at this cost is acceptable. Existing hashes are not upgraded on login.
* Session = signed JWT + a server-side session row (revocable, listed to the user). Tokens are sent in the `Authorization` header, not cookies, so CSRF does not apply.
* CORS limited to the origins in `CORS_ORIGIN`. Helmet headers. `x-powered-by` off.
* Seed scripts that create published demo passwords (`bulk-seed.js`, `demo.js`) refuse to run when `NODE_ENV=production`.
* `.env`, `.data`, `uploads` are git-ignored; the Git history contains no real credentials (only the published demo/test passwords).

## Known gaps (see the audit report for ratings)

* `zod` has a published high-severity advisory (memory exhaustion on huge validated collections). Fixing it means the zod 4 major upgrade, which changes how defaults behave inside `.partial()`; the code has 35 `.partial()` update schemas, so it needs a reviewed migration with a test per endpoint. Mitigations today: 2 MB body limit and rate limits.
* No multi-factor sign-in. No email or SMS: there is no self-service password reset; administrators reset passwords (the Platform Admin has no recovery path other than `npm run seed`).
* The tokens live in the browser's session storage; a successful script injection could read one. The frontend has no `dangerouslySetInnerHTML`/`eval` and a strict CSP is documented in `frontend/docs/DEPLOYMENT_SECURITY.md`, but a cookie-based session would be stronger (an architectural change).
* Rate-limit counters are in memory per process; behind several instances they are not shared.
* Files are on local disk (not durable or replicated). No virus scanning.
* Database: backups, point-in-time recovery, IP allow-list and least-privilege database users are Atlas settings that have **not been checked**; the free M0 tier has no backups.
* The Platform Admin's *reads* inside a school are not in the audit log (writes are).
