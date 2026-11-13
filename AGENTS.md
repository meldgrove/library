# AGENTS.md

Meldgrove Library is a self-hosted shared library of external reading.
People add files or links, the worker drafts a source note with an AI model,
the uploader reviews and publishes it, and an optional signed webhook passes
published notes on. User documentation is in `docs/` (start with
`docs/architecture.md`); contributor setup and releases are in
`CONTRIBUTING.md`.

## Stack

Next.js 16 (App Router, Server Actions, `src/proxy.ts`), Node.js 26, npm,
strict TypeScript, PostgreSQL 18 with Drizzle ORM (`pg` driver), Better Auth
with one OpenID Connect provider (PKCE), pg-boss worker, zod 4, Tailwind 4
with shadcn/ui (Radix), pino, Vitest, Playwright. Text extraction: unpdf,
mammoth, Readability with linkedom; OCR through `ocrmypdf`. Storage: the
filesystem or S3 (`@aws-sdk/client-s3`). AI model: any OpenAI-compatible
chat completions API.

## Layout

- `src/app/`: routes. Pages, Server Actions, and route handlers stay thin:
  check access, validate input with zod, call a module. Uploads go through the
  route handler `src/app/api/uploads/route.ts` (no Server Action body limit).
  `src/app/-/healthz` and `src/app/-/readyz` are the health checks.
- `src/components/ui/`: shadcn/ui components (new-york-v4), copied into the
  repository; there is no `shadcn` package. `src/components/library/`: the
  library's own components.
- `src/lib/library/`: the domain. `submissions.ts` (every way in),
  `pipeline.ts` (the worker's steps), `extract.ts`, `fetch-link.ts`,
  `screen.ts`, `identify.ts`, `draft.ts` (AI model and answer checks),
  `notes.ts` (reading), `review.ts` (publish, edit, check, delete),
  `access.ts` (who sees a note), `taxonomy.ts`, `notify.ts`, `replay.ts`,
  `slack-intake.ts` (the Slack bot), `email-intake.ts` (the intake mailbox),
  `digest.ts` (weekly digests), `subscriptions.ts` (tags people follow),
  `constants.ts` (closed lists and limits).
- `src/lib/webhook/`: the signed webhook. `payload.ts` (what is sent),
  `client.ts` (signing and posting), `sync.ts` (which notes are due).
- `src/lib/<module>/`: `auth`, `directory` (manual and Keycloak directory),
  `db`, `storage`, `audit`, `health`, `jobs` (queues and schedules),
  `security`, `notifications`, `slack` (signature check, the bot's Slack
  client), `email` (IMAP).
- `src/workers/`: the pg-boss worker. `src/scripts/`: migrate, directory
  sync, taxonomy import, replay. Both are bundled with esbuild into `dist/`
  (`scripts/build-scripts.mjs`).
- `drizzle/`: SQL migrations (`0000_init.sql`, then one file per change).
  `dev/`: the development Keycloak realm and `seed-demo.ts` (example notes).
  `e2e/`: Playwright. `tests/`: test helpers and fixtures
  (`tests/fixtures/files`: PDFs, a scan, a Word file; `tests/fixtures/email`:
  `.eml` messages). Unit tests sit next to the code (`*.test.ts`),
  integration tests too (`*.int.test.ts`).

## Rules

- Every page, Server Action, and route handler calls `requireUser()` or
  `requireAdmin()` from `src/lib/auth/session.ts` (route handlers:
  `getCurrentPerson()`). Layouts do not re-render on navigation, so a check in
  a layout is not enough. Admins are the library's stewards. The one
  exception is `/api/slack/events`: it has no session and accepts only
  requests Slack signed (`src/lib/slack/signature.ts`).
- Who sees a note is decided only in `src/lib/library/access.ts`:
  `canSeeNote` for pages, `visibleNotes` for SQL. A test checks they agree.
  Pages answer 404 for notes a person may not see.
- Uploads enter only through `submitFile` and `submitLink`
  (`submissions.ts`), whatever the channel. The original is stored before its
  database row. Only the worker processes submissions (`pipeline.ts`): text,
  screen, duplicate check, AI budget, draft, note, in that order.
- The AI model gets the source text fenced as untrusted data, no tools, and
  must answer with JSON. `draft.ts` checks the answer against the schema and
  the closed lists and drops quotes that are not in the source; nothing is
  guessed. Never pass model output to anything that executes or fetches.
- Links are downloaded only through `fetchLink`, which refuses private
  addresses at connect time. Never call `fetch` on a URL from an upload.
- Notifications are rows in `notification_delivery`, written in the
  command's transaction (`src/lib/library/notify.ts`); only the worker sends
  (`src/lib/notifications/dispatch.ts`). Messages about one note or upload
  carry titles and links, never the text of a note or a source. Digests are
  the exception, because listing new notes is what they are for: each listed
  note's core and one quote of the week, only notes published for the
  digest's audience, rebuilt from the current notes just before each send.
- The webhook works the same way: a command that may change a note's
  published state calls `requestWebhookSync` in its transaction; only the
  worker sends (`src/lib/webhook/sync.ts`), from the note as it is then.
  Private notes never leave the library. Change the payload only together
  with `docs/webhooks.md`; receivers depend on it.
- The audit log is append-only (`drizzle/0001_audit_append_only.sql`) and
  records IDs, numbers, and rule names, never source text. People and teams
  are never deleted. Notes and sources may be deleted (copyright, privacy).
- Who has access comes from the directory (`DIRECTORY`). Only
  `getDirectory()` in `src/lib/directory/directory.ts` reads it. Link logins
  by the OIDC `sub`; match an email only once, and only when the provider
  verified it (or `OIDC_TRUST_EMAIL` is set).
- Form Server Actions use `handleFormAction` from `src/lib/form-actions.ts`
  (access, validation, rate limit, write, revalidate, redirect). Commands
  throw `CommandError` (`src/lib/commands.ts`) to refuse a write.
- After a Server Action redirect, call `revalidatePath` for the target, or a
  redirect to the same page shows stale data.
- Change the schema in `src/lib/db/schema.ts`, then run `npm run db:generate`
  and commit the migration. CI fails if they differ.
- Read application settings only through `src/lib/config.ts`, and
  operational settings (`LOG_LEVEL`, `LIBRARY_PROCESS`,
  `WORKER_HEARTBEAT_FILE`, `MIGRATIONS_DIR`) through `envValue()` in
  `src/lib/env.ts`. Both treat blank values as unset. Framework variables
  (`NODE_ENV`, `NEXT_RUNTIME`, `TZ`) are read directly. Document every new
  variable in `docs/configuration.md`, and pass it through in `compose.yaml`.
- Code, fixtures, and docs name no real organization or person. Use
  `example.org` and `example.test` addresses and made-up names.
- UI text is English (US).

## Commands

```sh
docker compose -f compose.dev.yaml up -d   # PostgreSQL 18 (55444), Keycloak (8094), S3 (9012, console 9013), Mailpit (SMTP 1026, web 8026)
cp .env.example .env.local
npm ci
npm run db:migrate
npm run directory:sync                     # the Keycloak test users into the database
npm run dev:seed                           # optional: example notes (dev/seed-demo.ts)
npm run dev                                # http://localhost:3000, users erika / adam / olga, password library-dev
npm run worker                             # pg-boss worker in a second terminal

npm run lint
npm run typecheck
npm test                                   # unit tests
npm run test:integration                   # needs the PostgreSQL from compose.dev.yaml
S3_TEST_ENDPOINT=http://localhost:9012 npm test   # also tests the S3 driver
npm run build                              # Next.js standalone build and dist/ bundles
```

`compose.yaml` is the production setup, so every Compose command for the
development services needs `-f compose.dev.yaml` (project `library-dev`).
Keycloak's admin console is at http://localhost:8094 (`admin` / `admin`,
realm `library`). To see emails in Mailpit (http://localhost:8026), set the
SMTP lines in `.env.local` as `.env.example` shows.

End-to-end tests run against production builds, Keycloak, and PostgreSQL:
one instance with the Keycloak directory (port 3000) and one with the manual
directory and a fresh database (port 3001). CI's `e2e` job shows the exact
steps; locally:

```sh
npm run build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/
set -a; source .env.example; set +a
export BETTER_AUTH_SECRET="$(openssl rand -base64 32)" NODE_ENV=production TZ=Europe/Amsterdam
export STORAGE_DIR="$PWD/.storage"   # absolute: the standalone server runs in .next/standalone
node dist/migrate.mjs
node .next/standalone/server.js &
node dist/worker.mjs &
docker compose -f compose.dev.yaml exec postgres psql -U library -c "drop database if exists library_manual with (force)" -c "create database library_manual"
DATABASE_URL=postgres://library:library@localhost:55444/library_manual DIRECTORY=manual \
  INITIAL_ADMIN_EMAILS=adam@example.test LIBRARY_BASE_URL=http://localhost:3001 PORT=3001 \
  sh -c 'node dist/migrate.mjs && node .next/standalone/server.js' &
DATABASE_URL=postgres://library:library@localhost:55444/library npm run test:e2e
```

The worker drafts uploads with the fake AI model (`AI_PROVIDER=fake` in
`.env.example`), and one test changes Keycloak group memberships through the
Admin API.

CI (`.github/workflows/ci.yml`) runs lint, typecheck, unit tests, a
migration check, build, `npm audit`, integration tests, end-to-end tests,
and a Docker build. Releases run through `.github/workflows/release.yml`
(`CONTRIBUTING.md`, Releases). Use only GitHub-owned actions, pinned by
commit SHA.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
