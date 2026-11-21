# Changelog

Versions follow MAJOR.MINOR.PATCH. The first numbered release is 1.0.0.

## 1.0.0
- Fee receipt (A5) and payslip (A4) PDFs with the school's letterhead, colour, stamp and signature; Hindi text prints.
- Two-factor sign-in (authenticator app and recovery codes), password reset by emailed link, session renewal, secret rotation without signing anyone out.
- Requests that repeat safely (`Idempotency-Key`), request time limits, `/api/v1/` address, health page with version and memory.
- Errors kept for the Platform Admin (server and browser) with an optional alert webhook; per-school feature switches.
- Outgoing email waits in the database (nothing lost on restart); scheduled jobs run on one server at a time.
- Backup, verify and restore commands; database migrations; load test and API reference generator.
- Privacy: guardian consent record, download one student's data, erase a former student, daily clearing of old notifications and sessions.
- Optional encryption of uploaded files at rest; two-factor secrets are always stored encrypted.
- Docker image, compose file, Render blueprint (production and staging), CI and Dependabot.
- `zod` upgraded to 4 (closes a published memory-use advisory).
