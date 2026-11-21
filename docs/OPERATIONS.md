# Operations: running AtKaksha

For whoever looks after the live system. Commands run from `backend/` unless noted.

## What runs where
API on Render (or any Node host or the Dockerfile), database on MongoDB Atlas, site on Cloudflare (Worker serving `frontend/dist`), staff mail on Zoho, optional outgoing mail by Resend, optional online payments by Razorpay. `render.yaml` describes the API twice (production from `main`, staging from `staging`); nothing is created until you make a Blueprint from it.

## Environment variables that matter
`MONGO_URI`, `JWT_SECRET` (32+ random characters), `DATA_KEY` (64 hex characters: encrypts two-factor secrets, and uploaded files when `ENCRYPT_FILES=true`; keep a copy outside the server), `CORS_ORIGIN` (the real site address), `APP_URL`, `ALERT_WEBHOOK_URL` (a Slack or Discord incoming webhook: AtKaksha posts there when it starts, when five server errors arrive within five minutes, and on an unhandled failure), `RESEND_API_KEY` + `MAIL_FROM` (email, password-reset links), `PAYMENT_PROVIDER` + Razorpay keys, `SESSION_HOURS` / `SESSION_MAX_DAYS`, `REQUEST_TIMEOUT_MS`. The full list is `.env.example`. After a deploy, `GET /health` shows the version and any configuration warnings (for example "DATA_KEY is not set").

## Backups and restore (do the drill once a quarter)
- **Make one:** `npm run backup -- ../backups/$(date +%F)` writes every collection, **including uploaded files**, which are stored in the database (GridFS) since 21 Nov 2026. Add `--files` only to also copy an old uploads folder. Keep copies away from the server and from this computer.
- **Files from before 21 Nov 2026** sit on the disk of the computer that accepted the upload and are invisible to other servers (this is why photos and licence copies could be missing on the live site). Run `npm run files:migrate -- --dry-run`, then `npm run files:migrate`, **on the computer that holds the `uploads` folder**, once. It moves each file into the database and lists any whose bytes are not there (upload those again).
- **Check it:** `npm run backup:verify -- <folder>` confirms every collection is complete.
- **Restore into an empty database** (a new Atlas cluster or a local one): set `MONGO_URI` to it, then `npm run backup:restore -- <folder> --files`. It refuses a database that already has data unless you add `--replace`.
- **The drill:** restore the latest backup into a throw-away database, start the API against it (`npm run dev`), sign in as a School Admin and open a student, a fee receipt, a payslip and a gallery photo. Note how long it took.
- Atlas's own backups (a paid cluster tier) are better for point-in-time recovery; this script is the independent copy you control.

## Database changes (migrations)
Put a file in `src/migrations/` named `NNN-what-it-does.js` exporting `id`, `description` and `async up()`. `npm run migrate -- --status` lists what has and has not run; the API runs pending ones when it starts (turn off with `MIGRATE_ON_START=false`), once, on one server. A migration that throws stops start-up, so a half-changed database is never served; fix it and deploy again.

## Rotating secrets
- **JWT_SECRET (no one signed out):** put the current value in `JWT_SECRET_PREVIOUS`, set a new `JWT_SECRET`, deploy. Tokens signed with the old one keep working until they expire (12 hours); remove `JWT_SECRET_PREVIOUS` after a day.
- **JWT_SECRET (sign everyone out):** change it and leave `JWT_SECRET_PREVIOUS` empty.
- **DATA_KEY:** do not change it while two-factor secrets or encrypted files exist: they could not be read. To change it, first ask each person to switch two-factor off, or reset it (`npm run reset-2fa -- <login id>`), and decrypt files with the old key.
- **Database password, Razorpay and Resend keys:** change at the provider, update the environment variable, deploy.

## Two-factor: someone lost their phone
A School Admin resets a teacher or staff member; the Platform Admin resets a School Admin (School → administrators → Reset two-factor). A Platform Admin who is locked out: `npm run reset-2fa -- <login id>` on the server.

## Monitoring (set up once)
1. Create an incoming webhook in Slack or Discord and put its address in `ALERT_WEBHOOK_URL`.
2. Make a free uptime monitor (for example UptimeRobot or Better Stack) for `https://<api>/ready` every minute, alerting your phone. `/ready` is 503 when the database cannot be reached.
3. Look at Platform → Errors once a week.
4. Watch the Render, Atlas, Cloudflare and Resend usage pages monthly for cost.

## Releases
Both repos run their tests on every push (`.github/workflows/ci.yml`). Version numbers follow `MAJOR.MINOR.PATCH` and are listed in `CHANGELOG.md`; change `version` in `package.json` when you release. Try a change on the staging copy (the `staging` branch) before `main`.

## Load test
`npm run loadtest -- --url http://localhost:4010 --users 30 --seconds 20` on a demo or staging copy (never a live school). It reads only.
