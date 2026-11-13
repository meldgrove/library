# Deployment

The library ships as one Docker image, `ghcr.io/meldgrove/library`, for
linux/amd64 and linux/arm64. Each [release](https://github.com/meldgrove/library/releases)
is tagged with its version (`0.1.0`) and its series (`0.1`, which moves to
every later release of the series; from 1.0.0 the series is the major
version, `1`); `latest` is the newest release. A release that needs manual
steps starts a new series, so the releases within a series install without
anyone acting. Release candidates (`0.2.0-rc.1`) are for testing and get only
their own tag. Run a fixed version and upgrade on purpose, or let the updater
install new releases ([automatic updates](#automatic-updates)). The image's
command selects the process:

| Command | What it does |
|---|---|
| `migrate` | Applies the SQL migrations in `drizzle/`, then exits. Run it before `web` and `worker` start, on every deployment |
| `web` | The Next.js server on port 3000 |
| `worker` | Background jobs: uploads (text, screen, duplicate check, AI draft), the Slack bot and the intake mailbox, notifications, reminders and weekly digests, the webhook, and the Keycloak directory sync. One is enough; more can run, since jobs are coordinated through the database |
| `directory-sync` | Runs one Keycloak directory sync, then exits |

Scripts in the image run with `node dist/<name>.mjs`: `taxonomy-import` and
`replay` ([taxonomy and replay test](taxonomy.md)).

The library needs PostgreSQL 18. Background jobs (pg-boss) keep their tables
in the `pgboss` schema of the same database.

## Docker Compose

[`compose.yaml`](../compose.yaml) runs `migrate`, `web`, and `worker`
against the PostgreSQL in `DATABASE_URL`. Take it from the release you deploy,
together with `.env.example` as the start of your `.env`:

```sh
version=0.1.0   # the release to deploy
curl -fsSLO "https://raw.githubusercontent.com/meldgrove/library/v$version/compose.yaml"
curl -fsSL -o .env "https://raw.githubusercontent.com/meldgrove/library/v$version/.env.example"
# Edit .env with the production values (docs/configuration.md): at least
# DATABASE_URL, LIBRARY_BASE_URL, BETTER_AUTH_SECRET, the OIDC_* variables,
# DIRECTORY with its settings, the S3_* variables, and the AI_* variables.
# Remove NOTIFICATION_TRANSPORT (production sends for real), AI_PROVIDER=fake,
# and the STORAGE_* lines (see Storage below). Add the release:
#   LIBRARY_VERSION=0.1.0
docker compose up -d
```

`LIBRARY_VERSION` is required: Compose stops with a message without it.

On a platform that runs Compose files, create the PostgreSQL there and set
`DATABASE_URL` to its internal URL. Some platforms start each Compose project
in a network of its own, where that host name does not resolve (`migrate` logs
`getaddrinfo EAI_AGAIN` and fails after a minute): connect the application to
the network the database is in. Platforms that pass their one Compose file
with `-f` override `COMPOSE_FILE`, so `compose.postgres.yaml` does not work
there. A platform that reads `compose.yaml` from this repository should
follow the branch `stable`, which is at the newest release; `main` has
changes that are not released yet.

Put a reverse proxy that terminates TLS in front of `web` and use its public
URL as `LIBRARY_BASE_URL`. Use exactly that URL: login redirects and links in
messages are built from it.

Set `TZ` to your organization's time zone (default UTC); scheduled jobs run in
that zone.

### Storage

`compose.yaml` keeps originals in an S3-compatible bucket by default
(`STORAGE_DRIVER=s3`), such as Hetzner Object Storage, AWS S3, or a
self-hosted MinIO or RustFS. Create a bucket for the library alone and a key
that may only use it. Turn on bucket versioning or copy the bucket to a
second location: the bucket and the database together are the backup. With
`STORAGE_DRIVER=filesystem`, `web` and `worker` share the `originals` volume
of `compose.yaml` (`STORAGE_DIR=/data/originals`), and that volume needs a
backup.

### PostgreSQL next to the library

On a server without a PostgreSQL of its own,
[`compose.postgres.yaml`](../compose.postgres.yaml) (from the same release)
adds one to the Compose project and keeps its data in the `postgres-data`
volume. Set these values in `.env`; `COMPOSE_FILE` makes every
`docker compose` command use both files:

```sh
COMPOSE_FILE=compose.yaml:compose.postgres.yaml
# openssl rand -hex 32: no characters that would need escaping in the URL
POSTGRES_PASSWORD=<password>
DATABASE_URL=postgres://library:<password>@postgres:5432/library
```

PostgreSQL takes the password once, when it creates the database at the first
start. Changing `POSTGRES_PASSWORD` later does not change it.

### Checking the image

Every release image carries a provenance attestation, signed by GitHub, that
names the commit and the workflow run it was built from. With the
[GitHub CLI](https://cli.github.com):

```sh
gh attestation verify oci://ghcr.io/meldgrove/library:0.1.0 \
  --repo meldgrove/library --signer-repo meldgrove/.github
```

### Building the image yourself

To run your own build, for example of a change that is not released yet, build
the image from a clone of the repository and give it a version of its own:

```sh
docker build -t ghcr.io/meldgrove/library:local .
# In .env: LIBRARY_VERSION=local
docker compose up -d
```

## First steps after the first start

1. Sign in as an admin: with `DIRECTORY=manual`, an address in
   `INITIAL_ADMIN_EMAILS`; with `DIRECTORY=keycloak`, a member of
   `KEYCLOAK_ADMIN_GROUP` ([identity and access](identity-and-access.md)).
2. Fill the taxonomy under **Admin → Taxonomy**, or import it
   ([taxonomy](taxonomy.md)). The AI model picks tags only from it.
3. Optionally, run the [replay test](taxonomy.md#replay-test) against the
   configured AI model before people start uploading.

## Health checks

| Endpoint | Meaning |
|---|---|
| `GET /-/healthz` | Liveness: the process answers, with the release version (`version`, `null` for images built from source). No dependency checks |
| `GET /-/readyz` | Readiness: the database answers and every migration of this build is applied. 503 otherwise |

The worker writes a heartbeat file every 30 seconds;
`node dist/worker-healthcheck.mjs` fails when it is older than 90 seconds. The
admin page shows the worker's last heartbeat.

## Operations

- **Backups**: back up the whole database, including the `pgboss` schema, and
  the originals (bucket or volume). Deleting a note deletes its original; the
  audit log keeps only its number.
- **Logs** are JSON lines on stdout. The `service` field names the process.
- **Admin page** (`/admin`): worker heartbeat, uploads waiting and on hold,
  directory sync status, notification channels and failures, and webhook
  deliveries.
- **Upgrades**: read the release notes of every release since yours, set
  `LIBRARY_VERSION` to the new release, and run `docker compose up -d`. For a
  new series, take its `compose.yaml` too. `migrate` applies new migrations
  before `web` and `worker` start. Back up the database first: migrations
  only move forward.

## Automatic updates

`compose.yaml` includes the `updater` service of
[Meldgrove Updater](https://github.com/meldgrove/updater) (image
`ghcr.io/meldgrove/updater:0.1`). Once an hour it checks whether the tag in
`LIBRARY_VERSION` points to a new image. If so, it calls the deploy link of
the platform, which pulls the image and restarts the library, `migrate`
first. Until `UPDATE_DEPLOY_HOOK_URL` is set, it does nothing.

1. Set `LIBRARY_VERSION` to a tag that moves:
   - a series such as `0.2` (from 1.0.0 the major version, such as `1`):
     every release of that series, with its features and fixes. None of them
     needs manual steps. A release that does starts the next series: the
     `updater` log then names it, and moving to it is an
     [upgrade](#operations) by hand;
   - `latest`: every release. A release with upgrade steps then installs
     before anyone has taken them; watch the releases on GitHub (Watch →
     Custom → Releases) and take the steps right away.
2. Schedule database backups: migrations run without anyone watching.
3. Set `UPDATE_DEPLOY_HOOK_URL` to the platform's deploy link, which must
   redeploy on `POST`, and `UPDATE_DEPLOY_HOOK_TOKEN` to its bearer token if
   it needs one. For Coolify, the updater's
   [README](https://github.com/meldgrove/updater#coolify) shows where to find
   both.
4. Deploy once. The `updater` log then says which tag it watches.

A deployment must pull the image again, or it starts the old one. Coolify
pulls by itself. If the platform only starts the Compose file, set
`PULL_POLICY=always`: Docker Compose then pulls the images on every start, so
every `docker compose up` or `run` also brings the newest release of the tag.
After the first automatic update, check that it arrived: `/-/healthz` reports
the version.

A release installs three days after it came out, so that a faulty one can be
replaced before it reaches the server. `UPDATE_COOLDOWN` changes the time:
`0` installs within the hour, `7d` waits a week. Security fixes wait as well;
deploy by hand to install a release at once. Most platforms stop the library for
a moment while they deploy: `UPDATE_WINDOW`, such as `02:00-05:00` in the
time zone `TZ`, keeps that out of working hours.

Without a platform, leave the deploy link empty and let cron run
`docker compose up --detach --pull always --quiet-pull` every hour instead.
