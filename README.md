# chore-app

Household chores completed by tapping NFC Tags. Vocabulary: [`GLOSSARY.md`](GLOSSARY.md). Decisions: [`docs/adr/`](docs/adr/).

## Requirements

- Bun 1.4+
- Node 24 (Playwright runs on Node)
- Docker (Postgres runs in a container)

## Commands

| Command | What it does |
| --- | --- |
| `bun install` | Install dependencies (once). |
| `bun run dev` | Start Postgres, the backend (http://localhost:3000) and the frontend (http://localhost:5173). Override with `API_PORT`, `WEB_PORT`, `DATABASE_URL`. |
| `bun run seed -- --household "The Smiths" --time-zone Europe/London --admin "Alex"` | Create a Household, a Person and an Admin Membership. Prints the ids and `signInUrl`, a one-time Invite link for the Admin to enrol a passkey, as JSON. |
| `bun run migrate` | Apply migrations to `DATABASE_URL` (the dev server also migrates on start). |
| `bun run test` | API and Schedule engine tests (starts Postgres if needed). |
| `bun run test:e2e` | Browser end-to-end tests. First time: `bunx playwright install chromium`. |
| `bun run test:all` | Both suites. CI runs this, plus `bun run typecheck`. |
| `bun run typecheck` | Type-check every workspace. |
| `bun run db:up` | Start the shared Postgres container only. |

Sign-in uses passkeys (WebAuthn), with emailed magic links for Persons who have an email address.
Locally, run `bun run seed`, open its `signInUrl` in the browser and set up a passkey (browsers
allow passkeys on `localhost`). In development, emails are printed to the API log.
`PUBLIC_ORIGIN` (default `http://localhost:5173`) is the passkey Relying Party and the origin of
emailed links; in production it is the owned domain.

The test-only endpoints (`POST /api/test/sign-in {"personId"}` and friends) exist only with
`APP_ENV=test ENABLE_TEST_AUTH=1`; any other environment refuses to start with them.

## Layout

```
apps/api            Bun + Hono + PostgreSQL backend
  src/app.ts          createApp({ db, clock, config }): mounts every route under /api
  src/server.ts       production/dev entrypoint
  src/clock.ts        Clock interface; the only source of "now"
  src/config.ts       env -> Config (test-only endpoints only under APP_ENV=test; PUBLIC_ORIGIN)
  src/db/             Bun SQL client, migration runner, migrations/NNNN_name.sql
  src/auth/           sessions (90 days, sliding), requireSession, passkeys (WebAuthn adapter
                      + ceremonies), magic links, Mailer; routes under /api/auth
  src/invites/        Invites (new Person / recovery): Admin creation, public accept
  src/households/     seed, GET/PATCH /api/me
  src/households/membership.ts  requireMembership / requireAdmin for /households/:householdId routes
  src/schedule/       Schedule engine (pure, no I/O), calendar maths, table-driven tests
  src/occurrences/    Occurrence materialiser (lazy, idempotent; marks Missed)
  src/chores/         Chore routes, read model (current Occurrence, next due), Archive and delete
  src/completions/    Completion service: the single path that creates a Completion;
                      corrections.ts: Undo, Void and Excuse (/api/completions, /api/occurrences)
  src/tags/           Tag service and Admin routes (random ids, link/re-point, claim, delete)
  src/scan/           Scan resolver and POST /api/scan/:tagId (the /nfc/{tagId} page's request)
  src/testing/        test-only /api/test/* endpoints
  scripts/            seed and migrate CLIs
  test/               API test harness and API tests (*.test.ts)
apps/web            React + TanStack Router + TanStack Query frontend (Vite)
e2e/                Playwright tests (*.e2e.ts) and fixtures
scripts/            dev and e2e runners
```

## Tests

- **API (main seam):** requests go to the Hono app in-process against a real Postgres database. Each test file gets its own uniquely named database in the shared container on port 54329, migrated on creation and dropped afterwards, so runs from parallel checkouts don't collide. The clock is injectable: `t.clock.advance({ days: 1 })`.
- **Schedule engine:** pure, table-driven tests next to the module.
- **End-to-end:** `scripts/e2e.ts` creates its own database, starts the backend and frontend on free ports, and runs Playwright.

Tests assert only externally observable behaviour: HTTP responses and later API reads. They never check tables directly.
