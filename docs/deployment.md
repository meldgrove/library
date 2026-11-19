# Deployment

The library ships as one Docker image, `ghcr.io/meldgrove/library`, for
linux/amd64 and linux/arm64. Each [release](https://github.com/meldgrove/library/releases)
is tagged with its version (`0.1.0`) and its series (`0.1`, which moves to
every later release of the series; from 1.0.0 the series is the major
version, `1`); `latest` is the newest release. A release that needs manual
steps starts a new series, so the releases within a series install without
anyone acting. Release candidates (`0.2.0-rc.1`) are for testing and get only
their own tag. Previews (`0.2.1-preview.3`, three changes after 0.2.0; `preview`
is the newest) are built from every change on `main` once its checks passed.
Run a fixed version and upgrade on purpose, or let the updater install new
versions ([automatic updates](#automatic-updates)). The image's command
selects the process:

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
against the PostgreSQL in `DATABASE_URL`, and the optional `updater`
([automatic updates](#automatic-updates)). Run it on [Coolify](#coolify) or
on a [Debian server](#debian) (Debian 12 or later, or a similar system with
systemd and apt, such as Ubuntu 24.04). Both take `compose.yaml` from the
branch `stable`, which is at the newest release; `main` has changes that are
not released yet.

`LIBRARY_VERSION` is required: Compose stops with a message without it.

Put a reverse proxy that terminates TLS in front of `web` (Coolify's own, or
Caddy on Debian) and use its public URL as `LIBRARY_BASE_URL`. Use exactly
that URL: login redirects and links in messages are built from it. `web`
answers on `127.0.0.1:3000` of the host. When another service holds that
port (Docker reports `port is already allocated`), set `LIBRARY_PORT` to a
free one. Coolify's proxy reaches `web` through the Docker network and does
not use this port, so any free port will do there.

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
backup. Without any `S3_*` variable, storage is off: the library runs and
takes links, and refuses files until storage is set up.

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

## Coolify

1. **Database:** create a PostgreSQL 18 resource and copy its internal URL.
   `compose.postgres.yaml` does not work on Coolify: it passes its one
   Compose file with `-f`, which overrides `COMPOSE_FILE`.
2. **Application:** create a Docker Compose resource from the public
   repository `https://github.com/meldgrove/library`, branch `stable`,
   Docker Compose location `/compose.yaml`. Under Advanced, set Auto deploy
   to "Manual deployments only", so that only releases deploy, and turn on
   "Connect To Predefined Network", so that the library reaches the
   database. Without it, `migrate` logs `getaddrinfo EAI_AGAIN` and fails
   after a minute.
3. **Domain:** assign the domain, such as `https://library.example.org`, to
   `web`, port 3000.
4. **Register the library at your provider** with the redirect URI
   `<LIBRARY_BASE_URL>/api/auth/callback/oidc`
   ([identity and access](identity-and-access.md)).
5. **Environment variables** of the resource
   ([configuration](configuration.md)): `LIBRARY_VERSION` (a series such as
   `0.2`, `latest`, or `preview`; see [on Coolify](#on-coolify)), `LIBRARY_BASE_URL`
   (the domain), `DATABASE_URL` (the database's internal URL), a new
   `BETTER_AUTH_SECRET` (`openssl rand -base64 32`), the `OIDC_*` variables,
   `DIRECTORY` with its settings, the `AI_*` variables, and for files the
   `S3_*` variables ([storage](#storage)).
6. **Deploy**, open `LIBRARY_BASE_URL`, and take the
   [first steps](#first-steps-after-the-first-start).
7. **Automatic updates:** set them up [on Coolify](#on-coolify).

## Debian

On a server with Debian 12 or later, or a similar system such as Ubuntu,
run the commands as root (`sudo -i`).

1. **Docker:** install Docker Engine and the Compose plugin from Docker's
   apt repository ([Debian](https://docs.docker.com/engine/install/debian/),
   [Ubuntu](https://docs.docker.com/engine/install/ubuntu/)), and Git:
   `apt install git`.
2. **Get the files** at the newest release:

   ```sh
   git clone --branch stable https://github.com/meldgrove/library.git /srv/library
   cd /srv/library
   ```

3. **Register the library at your provider** with the redirect URI
   `<LIBRARY_BASE_URL>/api/auth/callback/oidc`
   ([identity and access](identity-and-access.md)).
4. **Create `.env`** from `.env.example` (`cp .env.example .env`,
   `chmod 600 .env`) and set the production values
   ([configuration](configuration.md)): `LIBRARY_VERSION` (the newest
   release, such as `0.2.0`; the updater keeps it current), `LIBRARY_BASE_URL`,
   `DATABASE_URL`, a new `BETTER_AUTH_SECRET`
   (`openssl rand -base64 32`), the `OIDC_*` variables, `DIRECTORY` with its
   settings, the `AI_*` variables, and for files the `S3_*` variables.
   Remove `NOTIFICATION_TRANSPORT` (production sends for real),
   `AI_PROVIDER=fake`, and the `STORAGE_*` lines ([storage](#storage)).

   Without a PostgreSQL of your own, set these values for the database.
   `COMPOSE_FILE` makes every `docker compose` command also use
   [`compose.postgres.yaml`](../compose.postgres.yaml), which runs PostgreSQL
   18 next to the library and keeps its data in the volume `postgres-data`:

   ```sh
   COMPOSE_FILE=compose.yaml:compose.postgres.yaml
   # openssl rand -hex 32: no characters that would need escaping in the URL
   POSTGRES_PASSWORD=<password>
   DATABASE_URL=postgres://library:<password>@postgres:5432/library
   ```

   PostgreSQL takes the password once, when it creates the database at the
   first start. Changing `POSTGRES_PASSWORD` later does not change it.

5. **Start:** `docker compose up -d --pull always`.
6. **HTTPS:** point the domain's DNS at the server, install Caddy
   (`apt install caddy`), and replace `/etc/caddy/Caddyfile` with:

   ```text
   library.example.org {
       reverse_proxy 127.0.0.1:3000
   }
   ```

   With another `LIBRARY_PORT`, use that port. Then
   `systemctl reload caddy`. Caddy gets the certificate itself.

7. Open `LIBRARY_BASE_URL` and take the
   [first steps](#first-steps-after-the-first-start).
8. **Automatic updates:** set them up [on Debian](#on-debian).

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
  directory sync status, notification channels and failures, webhook
  deliveries, and updates (installed version and channel).
- **Upgrades**: read the release notes of every release since yours and
  take their steps. Back up the database first: migrations only move
  forward. `migrate` applies new migrations before `web` and `worker` start.
  - **Coolify:** set `LIBRARY_VERSION` to the new release in the resource's
    environment variables and redeploy. Coolify reads `compose.yaml` from
    `stable`, which is at the newest release.
  - **Debian:** take the steps, then install the release with the update
    button (**Install anyway…**). By hand: in `/srv/library`, run `git pull`
    (the newest release's `compose.yaml`), set `LIBRARY_VERSION` in `.env`,
    and run `docker compose up -d --pull always`.

## Automatic updates

`compose.yaml` includes the `updater` service of
[Meldgrove Updater](https://github.com/meldgrove/updater) (image
`ghcr.io/meldgrove/updater:0.2`). Once an hour it checks for new versions of
the library. Set up [on Coolify](#on-coolify) or [on Debian](#on-debian), it
installs them: `migrate` runs first, then `web` and `worker` restart.
Without that setup it installs nothing, and the update button still shows
what is available.

Admins choose the channel under **Admin → Updates**:

- **Stable** (default, recommended): releases. A release that needs no
  manual steps (same series, such as 0.2.x) installs three days after it
  came out, so that a faulty one can be replaced before it reaches the
  server. A release that starts a new series needs
  [upgrade steps](#operations): the update button shows it, but it never
  installs by itself.
- **Preview**: every change on `main` as soon as its checks passed, days or
  weeks before a release, and every release. Previews install within the
  hour. New features first, and now and then a new bug. Previews have no
  release notes.

Switching back to Stable installs nothing and never goes back to an older
version: the library keeps the preview until a release is newer, because a
database migrated by a newer version may not work with an older one.

`UPDATE_COOLDOWN` changes the three days: `0` installs within the hour, `7d`
waits a week. Security fixes wait as well; install them with the update
button. A deployment stops the library for a moment: `UPDATE_WINDOW`, such as
`02:00-05:00` in the time zone `TZ`, keeps automatic installs out of working
hours. Schedule database backups first: migrations run without anyone
watching.

### The update button

Admins (and only they) see an update button at the top right of every page.
It shows whether an update is available, its changes and release notes, and
when it installs by itself, and checks again on request. **Install now**
installs the update at once, regardless of the cooldown and the window: the
library restarts, and the page reloads when it is back. When an installation
fails, the button says why and which version still runs. The admin page
shows the installed version, the channel, and when updates install.

The library reaches the updater at `UPDATER_URL`
([configuration](configuration.md#updates-web)). The updater's API has no
authentication: never publish its port. Without an updater that answers,
such as updater 0.1, which has no API, the button says "No update service";
updater 0.1 keeps installing as before.

### On Coolify

1. Under Settings > Advanced, turn on API Access if it is off.
2. Under Keys & Tokens > API Tokens, create a token with only the `deploy`
   permission; clear `read`. Coolify shows it only once.
3. In the library's resource, select Webhooks and copy Deploy Webhook.
4. In the resource's environment variables, set `UPDATE_DEPLOY_HOOK_URL` to
   the webhook and `UPDATE_DEPLOY_HOOK_TOKEN` to the token, then redeploy.

On Coolify, the image tag in `LIBRARY_VERSION` decides what installs, not the
channel in the library: a series such as `0.2` (Stable), `latest` (every
release, including those with upgrade steps; watch the releases on GitHub
and take their steps right away), or `preview` (Preview). The admin page
says so instead of offering the channel. When the tag points to a new image,
the updater calls the deploy link; **Install now** calls it at once. A
release with upgrade steps that the tag does not reach shows in the update
button without an install action: take its steps, then change the tag.

### On Debian

As root in `/srv/library`, with `UPDATE_DEPLOY_HOOK_URL` empty:

```sh
docker compose up -d --pull always
docker compose run --rm -T --pull always updater host-setup > updater-setup.sh
sh updater-setup.sh
```

The first command starts the version in `LIBRARY_VERSION`. The second writes
the setup script from the updater's image; read it before you run it. The
script installs a systemd unit that waits for the updater's requests. For
each installation, the server writes the exact version into
`LIBRARY_VERSION` in `.env`, pulls the image, runs `docker compose up
--detach --wait`, and waits until the library is healthy. When it does not
become healthy, the server restores `.env` and starts the version before
again; the update button shows why. So `LIBRARY_VERSION` always names the
version that runs. The server installs images, not files: a release that
changes `compose.yaml` says so in its upgrade steps (`git pull`).

`journalctl -u meldgrove-updater-library.service` shows each installation,
and `sh updater-setup.sh remove` switches it off.

#### Servers set up with updater 0.1

A server set up before the update button follows the tag in
`LIBRARY_VERSION` (such as `latest`) and keeps installing releases. Its
update button says "No update service", and admins cannot choose a channel.
To move it to the setup above, as root in `/srv/library`, set
`LIBRARY_VERSION` in `.env` to the release that brings the update button (or
a newer one), then:

```sh
git pull
docker compose up -d --pull always
docker compose run --rm -T --pull always updater host-setup > updater-setup.sh
sh updater-setup.sh
```

`git pull` gets the newest release's `compose.yaml` (branch `stable`), with
updater 0.2. `docker compose up -d --pull always` downloads the images again
and starts them, so that the library itself, not only the updater, runs the
new version: without `--pull always`, Compose keeps an image the server
already has under that tag. Until the host setup runs again, the admin page
explains that the channel needs it.
