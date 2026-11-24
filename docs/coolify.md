# Coolify

For running Meldgrove Library on [Coolify](https://coolify.io) instead of on
a Linux server of its own. Coolify uses
[`compose.coolify.yaml`](../compose.coolify.yaml): the services of
`compose.yaml`, without a host port, pulling the images at every deploy, and
with an `updater` that calls Coolify's deploy link. Storage, the first steps,
health checks, operations and the update button are the same as on a server:
see [Deployment](deployment.md). Every variable is described in
[Configuration](configuration.md).

## Setup

1. **Database:** create a PostgreSQL 18 resource and copy its internal URL.
   `compose.postgres.yaml` does not work on Coolify: it passes its one
   Compose file with `-f`, which overrides `COMPOSE_FILE`.
2. **Application:** create a Docker Compose resource from the public
   repository `https://github.com/meldgrove/library`, branch `stable`,
   Docker Compose location `/compose.coolify.yaml`. Under Advanced, set Auto
   deploy to "Manual deployments only", so that only releases deploy, and
   turn on "Connect To Predefined Network", so that the library reaches the
   database. Without it, `migrate` logs `getaddrinfo EAI_AGAIN` and fails
   after a minute.
3. **Domain:** assign the domain, such as `https://library.example.org`, to
   `web`, port 3000.
4. **Register the library at your provider** with the redirect URI
   `<LIBRARY_BASE_URL>/api/auth/callback/oidc`
   ([identity and access](identity-and-access.md)).
5. **Environment variables** of the resource
   ([configuration](configuration.md)): `LIBRARY_VERSION` (a series such as
   `0.2`, `latest`, or `preview`; see [automatic updates](#automatic-updates)),
   `LIBRARY_BASE_URL` (the domain), `DATABASE_URL` (the database's internal
   URL), a new `BETTER_AUTH_SECRET` (`openssl rand -base64 32`), the `OIDC_*`
   variables, `DIRECTORY` with its settings, and for files the `S3_*`
   variables ([storage](deployment.md#storage)). The AI model, email, Slack
   and the other outside services are set in the library, not here.
6. **Deploy**, open `LIBRARY_BASE_URL`, and take the
   [first steps](deployment.md#first-steps-after-the-first-start): set up
   the integrations under **Admin → Integrations**, or in a terminal (below).
7. **Automatic updates:** set them up as [below](#automatic-updates).

## Settings in a terminal

`cli` is on the `PATH` of the library's containers. In the resource's
**Terminal**, choose the `web` or `worker` container and run, for example,
`cli settings list`. `cli settings apply <name>` reads the JSON body from
stdin: paste it (it is not shown), then press Enter and Ctrl-D. The
commands, the setting names, and an example body for each are in
[Deployment](deployment.md#settings-from-the-command-line).

Up to 0.3.2, the AI model, email, Slack, the webhook, the weekly digest and
the intake mailbox were environment variables of the resource. Coolify
deploys the newest `compose.coolify.yaml` with each release, so the worker
copies them into the database once; afterwards **Admin → Integrations** names
the ones that can be deleted from the resource's environment variables.

## Upgrades

Read the release notes of every release since yours and take their steps.
Back up the database first: migrations only move forward. Then set
`LIBRARY_VERSION` to the new release or series in the resource's environment
variables and redeploy. Coolify reads `compose.coolify.yaml` from `stable`,
which is at the newest release.

## Backups

For [Meldgrove Backups](deployment.md#backups), set `BACKUP_URL` and
`BACKUP_TOKEN` (from the app's source in Backups) in the resource's
environment variables and redeploy. Each deploy pulls the backup agent's
image.

## Automatic updates

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
`UPDATE_COOLDOWN` and `UPDATE_WINDOW` work as on a server
([automatic updates](deployment.md#automatic-updates)). Schedule database
backups first: migrations run without anyone watching.

## Moving an existing resource

Resources set up before `compose.coolify.yaml` existed read
`/compose.yaml`. That file is made for a server now: it has no deploy link
and does not pull the images again, so automatic updates stop with it. Once
the release that brings `compose.coolify.yaml` is out (its release notes
name this step):

1. In the resource's configuration, set Docker Compose Location to
   `/compose.coolify.yaml` and save.
2. Keep the environment variables. Change `LIBRARY_VERSION` when the release
   starts a new series.
3. Redeploy. The services and volumes keep their names, so the data stays.
