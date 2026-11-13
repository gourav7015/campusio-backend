# Campusio — Backend (API)

Multi-tenant school management API: **Node 20+ · Express 5 · Mongoose 8 · MongoDB Atlas**.
The web app lives in its own repository (`school-erp-frontend`) and talks to this API over HTTP.

```
browser → frontend (:5173) → /api → this backend (:4000) → MongoDB Atlas
```

## Run it
```bash
npm install
cp .env.example .env        # paste your Atlas connection string into MONGO_URI
npm run dev                 # API on http://localhost:4000   (health: /health, readiness: /ready)
```
The first start on a large database builds indexes and can take a while before it accepts traffic.

| Command | What it does |
|---|---|
| `npm run dev` / `npm start` | Run the API (auto-restart / plain) |
| `npm run seed` | Create the first Platform Admin: `SUPERADMIN_EMAIL=… SUPERADMIN_PASSWORD='…' npm run seed` |
| `npm run dump` | Load 3 large demo schools (≈6,750 students, 340 teachers) into an **empty** database |
| `CONFIRM_WIPE=<db name> npm run dump -- --wipe` | Drop the whole database first. Destructive, so the database name must be typed |
| `npm run demo` | Throw-away in-memory database + a small demo school (no Atlas needed) |
| `npm test` / `npm run lint` | 104 integration tests (in-memory MongoDB, never Atlas) / ESLint |

## Environment (`.env`, never committed)
`MONGO_URI` (required — there is no local-database fallback), `JWT_SECRET` (required in production), `CORS_ORIGIN` (the frontend's URL), `PORT`, `UPLOAD_DIR`, `LOGIN_RATE_LIMIT`, `API_RATE_LIMIT`. See `.env.example`.
In Atlas: create a database user, allow your server's IP under Network Access, and use region Mumbai for Indian schools.

## Demo data logins (after `npm run dump`)
Platform `superadmin@erp.local / Super@12345`. Per school code (`dpsr`, `sunr`, `gwvs`): `admin@{code}.school / Admin@12345`,
`finance@{code}.school / Finance@12345`, `library@{code}.school / Library@12345`, `transport@{code}.school / Transport@12345`, teachers `{code}.t0001 / Teach@12345`, students `{code}.adm20260001 / Student@12345`.
**Change these before any real use.**

## Layout
```
src/modules/<feature>/{routes,service,validation}   auth, platform, structure, students, teachers, attendance, exams, finance, library, payroll, …
src/core  src/services  src/middleware  src/models  shared code
test/     API integration tests
docs/     ARCHITECTURE.md · KNOWN_LIMITATIONS.md · requirements.md (the original spec)
```
Eight portals are served: Platform Admin, School Admin, Teacher, Student, Finance, Library, Transport, Staff — each role has its own mount (`/api/school`, `/api/teacher`, …) and a login must come through the matching portal. See `docs/ARCHITECTURE.md`.
