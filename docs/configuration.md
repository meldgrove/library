# Configuration

The library reads from environment variables only what it needs before it
can reach its database, and limits that admins must not change. Blank values
count as unset. Every process validates what it needs at startup and stops
with a list of missing or invalid variables.

The outside services (the AI model, email, Slack, the weekly digest, the
webhook, and the intake mailbox) are settings in the database. Admins set
them under **Admin → Integrations**; operators set the same settings on the
server with `cli settings`
([deployment](deployment.md#settings-from-the-command-line)). See
[Integrations](#integrations).

Three processes run from one image (see [deployment](deployment.md)):
`migrate`, `web`, and `worker`. The tables below say which process needs a
variable.

## Required

| Variable | Process | Value |
|---|---|---|
| `DATABASE_URL` | all | `postgres://user:password@host:5432/library` |
| `LIBRARY_BASE_URL` | web, worker | The public URL, e.g. `https://library.example.org`. Used for login redirects and links in messages |
| `BETTER_AUTH_SECRET` | web, worker, migrate | At least 32 characters: `openssl rand -base64 32`. Signs session cookies, and seals the secrets of the [integrations](#integrations) in the database. A new value means entering those secrets again |
| `OIDC_ISSUER` | web | Issuer URL of the OpenID Connect provider, e.g. `https://auth.example.org/realms/acme` |
| `OIDC_CLIENT_ID` | web | Client ID registered for the library |
| `OIDC_CLIENT_SECRET` | web | Its client secret |
| `DIRECTORY` and its settings | web, worker | Who has access; see [directory](#directory-who-has-access) |
| `STORAGE_DIR` or the `S3_*` variables | web, worker | Where originals are kept; with `compose.yaml`, only for files. See [storage](#storage-web-worker) |

With Docker Compose, `LIBRARY_VERSION` selects the release image
([deployment](deployment.md#docker-compose)), and `LIBRARY_PORT` (default
`3000`) the port on `127.0.0.1` of the host where `web` answers.

## Login

| Variable | Default | Value |
|---|---|---|
| `OIDC_SCOPES` | `openid profile email` | Scopes requested at login, separated by spaces |
| `OIDC_TRUST_EMAIL` | `false` | `true` treats every email address from the provider as verified. Only for providers that do not send `email_verified` (e.g. Microsoft Entra ID) and whose users cannot choose their own address |
| `OIDC_PROVIDER_NAME` | none | Shown on the sign-in button: `Microsoft` gives "Sign in with Microsoft". At most 40 characters |

See [identity and access](identity-and-access.md) for the redirect URI and
provider-specific notes.

## Directory: who has access

| Variable | Default | Value |
|---|---|---|
| `DIRECTORY` | `manual` | `manual`: admins invite people in the library. `keycloak`: people and teams come from Keycloak groups |

With `DIRECTORY=manual`:

| Variable | Default | Value |
|---|---|---|
| `INITIAL_ADMIN_EMAILS` | required | Email addresses, separated by commas. While the library has no admin, the first login with one of them (verified by the provider) becomes an admin. Without it, nobody could ever get in; afterwards it has no effect |

With `DIRECTORY=keycloak` (needed by web and worker). The access, admin, and
teams groups are required: notes belong to their owner's team ("My team"
visibility), and someone has to run the library. Write group paths with a
leading slash and without a trailing one.

| Variable | Default | Value |
|---|---|---|
| `KEYCLOAK_ACCESS_GROUP` | required | Group path, e.g. `/library`. Its members, and members of its subgroups, have access |
| `KEYCLOAK_ADMIN_GROUP` | required | Group path, e.g. `/library-admins`. Its members are admins (and have access) |
| `KEYCLOAK_MAINTAINER_GROUP` | none (no maintainers) | Group path, e.g. `/library-maintainers`. Its members are maintainers, who look after the content (and have access). Someone in both groups is an admin |
| `KEYCLOAK_TEAMS_GROUP` | required | Group path, e.g. `/teams`. Each direct subgroup is a team; it needs at least one |
| `KEYCLOAK_CLIENT_ID` | `OIDC_CLIENT_ID` | Client with a service account that may read users and groups (role `view-users`; from Keycloak 26.8.2 also the default client scope `kc-admin-api`, see [identity and access](identity-and-access.md#keycloak-setup)) |
| `KEYCLOAK_CLIENT_SECRET` | `OIDC_CLIENT_SECRET` | Its secret |

`OIDC_ISSUER` must be the realm URL (`…/realms/<realm>`); the Admin API URL is
derived from it.

## Storage (web, worker)

Originals are kept once per file (by SHA-256). Web pages are kept as text only.

Storage is off when `STORAGE_DRIVER` is `s3` (the default in `compose.yaml`)
and none of the `S3_*` variables is set, or when it is `off`. The library
then takes links only: it refuses files in every channel, and keeps only the
text of a PDF or Word file behind a link.

| Variable | Default | Value |
|---|---|---|
| `STORAGE_DRIVER` | `filesystem` (`s3` in `compose.yaml`) | `filesystem`, `s3`, or `off` |
| `STORAGE_DIR` | required with `filesystem` | Directory for originals, an absolute path in production; web and worker must share it |
| `S3_ENDPOINT` | AWS | Endpoint of an S3-compatible service, e.g. `https://fsn1.your-objectstorage.com` (Hetzner Object Storage) |
| `S3_REGION` | required with `s3` | e.g. `fsn1` |
| `S3_BUCKET` | required with `s3` | Bucket name |
| `S3_ACCESS_KEY_ID` | required with `s3` | Access key of a key that may read, write, and delete in this bucket only |
| `S3_SECRET_ACCESS_KEY` | required with `s3` | Its secret |
| `S3_FORCE_PATH_STYLE` | `false` | `true` for services that need the bucket in the path (MinIO, RustFS) |
| `UPLOAD_MAX_MB` | `50` | Largest file, in megabytes, for uploads and downloaded links |

## Text recognition (worker)

PDFs without a text layer (scans) need OCR. The Docker image includes
`ocrmypdf` with German and English.

| Variable | Default | Value |
|---|---|---|
| `OCR_COMMAND` | none (off; `ocrmypdf` in `compose.yaml`) | `ocrmypdf`, or another command that takes its arguments. Without it, scans are parked for a maintainer |
| `OCR_LANGUAGES` | `deu+eng` | Tesseract language codes, joined with `+` |

## Integrations

Set under **Admin → Integrations**, or with `cli settings apply <name>`
([deployment](deployment.md#settings-from-the-command-line)). Both run the
same checks and write the same audit entry. Secrets (keys, tokens,
passwords) are sealed with a key derived from `BETTER_AUTH_SECRET` and never
shown again: the page and the command show at most their last four
characters, or only the scheme, host and port of a URL. The web process and the worker
read the settings at each use, so a change applies within a minute, without
a restart. A setting that is off does nothing.

| Setting | Name | What it does |
|---|---|---|
| [AI model](#ai-model) | `ai` | Drafts a note for each upload. Until it is set up, uploads wait at the draft |
| [Email](#email) | `email` | Sends emails: SMTP or MailerSend |
| [Slack](#slack) | `slack` | Sends Slack messages, and runs the [Slack bot](#slack-bot) |
| [Weekly digest](#weekly-digest) | `digest` | Where the digest of notes for everyone goes |
| [Webhook](#webhook) | `webhook` | Sends published notes to another system |
| [Email intake](#email-intake) | `email-intake` | Reads a mailbox that people forward sources to |

### AI model

The worker sends the extracted text of each upload to one AI model, which
returns the draft as JSON. The model gets no tools. Two kinds of provider
work:

- **Anthropic** (`"provider": "anthropic"`): the Claude API through
  Anthropic's SDK. The library asks for the answer's JSON schema (structured
  outputs). On models that support it (Claude Fable 5, Claude Opus 5, and
  Claude Sonnet 5.5 models), a request the model declines runs again on a
  fallback model in the same call.
- **OpenAI-compatible** (`"provider": "openai-compatible"`): any API that
  speaks the OpenAI chat completions format and supports
  `response_format: {"type": "json_object"}`, for example Mistral, OpenAI,
  Azure OpenAI, or a self-hosted model behind an OpenAI-compatible server.
  Anthropic's OpenAI-compatible endpoint refuses this request; use
  `anthropic` for Claude.

Most sources name their authors, so choose a provider that your organization
allows for personal data.

| Field | Value |
|---|---|
| `provider` | `anthropic` or `openai-compatible`; `null` switches drafting off and removes the key |
| `apiKey` | API key (secret). A new provider needs a new key |
| `model` | Model name, e.g. `claude-opus-5-5` (Anthropic) or `mistral-medium-latest` |
| `baseUrl` | With `openai-compatible`: the base URL up to and including `/v1`, e.g. `https://api.mistral.ai/v1` or `https://api.openai.com/v1` |

The test button (and `cli settings test ai`) checks the key and the model
with the smallest call the provider allows, and drafts nothing: Anthropic's
model lookup, or a chat completion of one token.

The limits stay in the environment, so that admins cannot raise them:

| Variable | Default | Value |
|---|---|---|
| `AI_DAILY_LIMIT` | `200` | Drafts per day across all uploads; the rest waits for the next day |
| `AI_TIMEOUT_MS` | `120000` | How long to wait for one answer |
| `AI_PROVIDER` | none | Only `fake`: drafts from the text without a model and ignores the setting (development and tests) |

### Email

Maintainers and admins get emails about uploads on hold, people who follow
tags get a weekly email, and uploaders hear about their uploads by Slack
direct message. When one channel is off, or cannot reach a person (no Slack
account, no email address), the message goes out on the other. So it does
after an error that trying again cannot fix, such as an invalid token, a
missing Slack scope, or a rejected address. Other errors, such as an outage
or a rate limit, are retried after 1, 5, 15, and 60 minutes; the fifth and
last attempt tries the other channel too.

| Field | Value |
|---|---|
| `provider` | `smtp` or `mailersend`; `null` switches email off and removes the secret. Only the provider in use keeps its secret |
| `smtpUrl` | With `smtp` (secret): `smtp://user:password@host:587` (STARTTLS) or `smtps://user:password@host:465`. Percent-encode special characters in the password. After `?`, only `requireTLS`, `ignoreTLS`, `name`, `authMethod`, `pool`, `maxConnections`, `maxMessages`, `connectionTimeout`, `greetingTimeout`, `socketTimeout`, `tls.rejectUnauthorized` and `tls.servername` are accepted |
| `mailersendToken` | With `mailersend` (secret): a MailerSend API token with email sending access |
| `from` | Sender address; required |
| `fromName` | Sender name; `Meldgrove Library` when empty |

The test sends one email to an address the admin enters (`cli settings test
email --to <address>`).

`NOTIFICATION_TRANSPORT` (environment, default `live` in production,
otherwise `console`): `console` only logs Slack messages and emails instead
of sending them.

### Slack

| Field | Value |
|---|---|
| `botToken` | Bot token (`xoxb-…`, secret) of a Slack app with the scopes `chat:write`, `users:read`, and `users:read.email`; the [Slack bot](#slack-bot) needs more |
| `signingSecret` | The app's signing secret (secret; Slack: **Basic Information → App Credentials**). Only for the Slack bot: the web process accepts only events signed with it |

The test asks Slack who the bot token belongs to (`auth.test`) and sends
nothing.

### Slack bot

Optional, and off until the Slack setting has a signing secret. People send
the Slack app a direct message with a link or a file and one line on why;
the worker adds them as uploads and answers in the same conversation with
the bot token.

Set up the Slack app:

- **OAuth & Permissions → Bot Token Scopes**: `chat:write`, `users:read`,
  `users:read.email`, `im:history`, and `files:read`. Reinstall the app after
  adding scopes.
- **Event Subscriptions**: on, with the request URL
  `<LIBRARY_BASE_URL>/api/slack/events` and the bot event `message.im`. Slack
  checks the URL when it is saved; save the signing secret first.
- **App Home**: under **Show Tabs**, turn on the **Messages Tab** and allow
  users to send messages from it.

People are found by the email address of their Slack account, which must be
their `work_email` in the library. Files count against `UPLOAD_MAX_MB`.

### Weekly digest

Mondays at 09:00 in the server's time zone, the worker sends the notes
published in the last 7 days. Admins set a Slack channel for each team under
**Admin → Teams**; everyone can follow tags under **Settings** and gets their
own email. This setting says where notes for everyone go. Add the library's
Slack app to each Slack channel (or give it the `chat:write.public` scope for
public channels). A team's channel gets notes for the team too, so choose
one only the team is in.

| Field | Value |
|---|---|
| `slackChannelId` | Channel ID such as `C0123456789` (Slack: the channel's details, at the bottom); not the channel's name. Needs [Slack](#slack) |
| `emailTo` | An address, such as a mailing list, that gets the digest by email. Needs [email](#email) |

### Webhook

| Field | Value |
|---|---|
| `url` | HTTPS endpoint that receives published notes; `null` switches the webhook off and removes the secret |
| `secret` | At least 16 characters (secret); required with a URL. Signs every request: `openssl rand -hex 32` |

See [webhook](webhooks.md) for the payload and the signature.

### Email intake

Optional, and off until the setting has an IMAP URL. People send or forward
links and files to one mailbox, with one line on why as the subject; the
worker reads it every 2 minutes. Use a mailbox for the library alone: the
worker marks every message it handled as seen.

| Field | Value |
|---|---|
| `imapUrl` | `imaps://user:password@host:993` (secret; or `imap://…`, which must upgrade with STARTTLS; a server without it is refused). Percent-encode special characters in the user and password |
| `domains` | Domains people send from, e.g. `["example.org"]`; required with the URL. Other senders are refused, and links to these domains are ignored |
| `mailbox` | The folder to read; `INBOX` when empty |
| `doneMailbox` | Folder that handled messages move to, e.g. `Processed`; it must exist. Without it they stay, marked as seen |

The test signs in and reads the number of messages in the mailbox; it moves
nothing.

The receiving mail server must add an `Authentication-Results` header with
DKIM and SPF results (Google Workspace, Microsoft 365, and most providers
do). A message is taken only when it shows `dkim=pass` or `spf=pass` for the
sender's domain, and only from people with access, by their `work_email`.
Answers go out by email (or Slack), so set up [email](#email).

### Variables up to 0.3.2

Up to 0.3.2, these settings were environment variables. A process that sees
one of them copies it into the database once, into a field that has no
value yet, and writes an audit entry; afterwards the database wins and the
variable is ignored. **Admin → Integrations**, `cli settings list`, and one
warning in the log at start name the variables that are still set, so they
can be deleted from `.env`.

| Setting | Variables |
|---|---|
| `ai` | `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL` |
| `email` | `SMTP_URL`, `MAILERSEND_API_TOKEN`, `MAIL_FROM`, `MAIL_FROM_NAME` |
| `slack` | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` |
| `digest` | `DIGEST_SLACK_CHANNEL_ID`, `DIGEST_EMAIL_TO` |
| `webhook` | `WEBHOOK_URL`, `WEBHOOK_SECRET` |
| `email-intake` | `EMAIL_INTAKE_IMAP_URL`, `EMAIL_INTAKE_DOMAINS`, `EMAIL_INTAKE_MAILBOX`, `EMAIL_INTAKE_DONE_MAILBOX` |

A `compose.yaml` of 0.3.2 or earlier does not pass `BETTER_AUTH_SECRET` to the
worker. Such a worker cannot open the stored secrets: it reads these
variables, as before, and the admin pages say so. Update `compose.yaml`
([upgrades](deployment.md#upgrades)) to manage the worker's settings in the
library.

## Error reporting (web, worker)

Optional. With `SENTRY_DSN`, server errors in the web process (pages, Server
Actions, route handlers) and failures of the worker go to
[Sentry](https://sentry.io) or a Sentry-compatible service. Only the error and
its stack trace are sent: no user, cookies, headers, request bodies, query
strings, or values from database queries. The browser sends nothing.

Stack traces show the TypeScript files only in a Sentry project that has the
image's source maps. Releases upload them to the maintainers' project; for
your own, build the image with an auth token of your Sentry organization:
`docker build --secret id=sentry_auth_token,env=SENTRY_AUTH_TOKEN --build-arg SENTRY_ORG=<organization> --build-arg SENTRY_PROJECT=<project> .`

| Variable | Default | Value |
|---|---|---|
| `SENTRY_DSN` | none | The project's DSN (Client Key). Off without it |
| `SENTRY_ENVIRONMENT` | Sentry's default, `production` | Environment name shown in Sentry, e.g. `staging` |
| `SENTRY_RELEASE` | `library@<APP_VERSION>` in release images, otherwise none | Release name, e.g. the deployed commit SHA |

## Updates (web)

The update button for admins asks the updater service
([automatic updates](deployment.md#automatic-updates)).

| Variable | Default | Value |
|---|---|---|
| `UPDATER_URL` | `http://updater:8080`, the `updater` service of `compose.yaml` | The updater's API. With `compose.yaml`, an empty value falls back to the default. Only where the library reads its environment directly (outside Docker Compose), empty switches the update button off; unlike other variables, empty is not unset there |
| `UPDATER_TOKEN` | none | Recommended: the token the library sends to the updater, which then refuses requests without it. Below |

With Docker Compose, the `updater` service reads `UPDATE_COOLDOWN` (default
`3d`), `UPDATE_WINDOW`, and `TZ`, and for a private copy of the image
`UPDATE_REGISTRY_USERNAME` and `UPDATE_REGISTRY_PASSWORD`
([deployment](deployment.md#automatic-updates)). On Coolify, it also reads
`UPDATE_DEPLOY_HOOK_URL` and `UPDATE_DEPLOY_HOOK_TOKEN`
([Coolify](coolify.md#automatic-updates)).

`compose.yaml` and `compose.coolify.yaml` pass `UPDATER_TOKEN` to the library
and, as `API_TOKEN`, to the updater; make it with `openssl rand -hex 32`
(visible characters, no spaces). Without it, anything that reaches the
updater on the Docker network can install an offered update or switch the
channel ([protect the update service](deployment.md#protect-the-update-service)).

## Time zone

The library uses the server's time zone, set with the standard `TZ` variable
(e.g. `TZ=Europe/Berlin`; the Docker image defaults to UTC). It decides when
scheduled jobs run: review reminders, weekly digests, and the nightly webhook
run. Everyone can choose their own time zone and date format for display
under **Settings**; the default date format is `DD.MM.YYYY`.

## Operations

Structured application logs show the PostgreSQL error code when available.
The database error summaries omit query values and PostgreSQL error details.

| Variable | Default | Value |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `APP_VERSION` | the version in release images, otherwise none | Set by release images, not by operators. `/-/healthz` and Sentry report it |
| `WORKER_HEARTBEAT_FILE` | `/tmp/library-worker-heartbeat` | File the worker touches for its health check |
| `MIGRATIONS_DIR` | `drizzle` | Folder with the SQL migrations |
