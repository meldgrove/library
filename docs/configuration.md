# Configuration

The library reads its configuration from environment variables. Blank values
count as unset. Every process validates what it needs at startup and stops
with a list of missing or invalid variables.

Three processes run from one image (see [deployment](deployment.md)):
`migrate`, `web`, and `worker`. The tables below say which process needs a
variable.

## Required

| Variable | Process | Value |
|---|---|---|
| `DATABASE_URL` | all | `postgres://user:password@host:5432/library` |
| `LIBRARY_BASE_URL` | web, worker | The public URL, e.g. `https://library.example.org`. Used for login redirects and links in messages |
| `BETTER_AUTH_SECRET` | web | At least 32 characters: `openssl rand -base64 32`. Signs session cookies |
| `OIDC_ISSUER` | web | Issuer URL of the OpenID Connect provider, e.g. `https://auth.example.org/realms/acme` |
| `OIDC_CLIENT_ID` | web | Client ID registered for the library |
| `OIDC_CLIENT_SECRET` | web | Its client secret |
| `DIRECTORY` and its settings | web, worker | Who has access; see [directory](#directory-who-has-access) |
| `STORAGE_DIR` or the `S3_*` variables | web, worker | Where originals are kept; see [storage](#storage-web-worker) |
| `AI_PROVIDER`, `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | worker | The AI model that drafts notes; see [AI model](#ai-model-worker) |

With Docker Compose, `LIBRARY_VERSION` selects the release image
([deployment](deployment.md#docker-compose)).

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

With `DIRECTORY=keycloak` (needed by web and worker). All three groups are
required: notes belong to their owner's team ("My team" visibility), and
admins are the library's stewards. Write group paths with a leading slash
and without a trailing one.

| Variable | Default | Value |
|---|---|---|
| `KEYCLOAK_ACCESS_GROUP` | required | Group path, e.g. `/library`. Its members, and members of its subgroups, have access |
| `KEYCLOAK_ADMIN_GROUP` | required | Group path, e.g. `/library-admins`. Its members are admins, the library's stewards (and have access) |
| `KEYCLOAK_TEAMS_GROUP` | required | Group path, e.g. `/teams`. Each direct subgroup is a team; it needs at least one |
| `KEYCLOAK_CLIENT_ID` | `OIDC_CLIENT_ID` | Client with a service account that may read users and groups |
| `KEYCLOAK_CLIENT_SECRET` | `OIDC_CLIENT_SECRET` | Its secret |

`OIDC_ISSUER` must be the realm URL (`…/realms/<realm>`); the Admin API URL is
derived from it.

## Storage (web, worker)

Originals are kept once per file (by SHA-256). Web pages are kept as text only.

| Variable | Default | Value |
|---|---|---|
| `STORAGE_DRIVER` | `filesystem` (`s3` in `compose.yaml`) | `filesystem` or `s3` |
| `STORAGE_DIR` | required with `filesystem` | Directory for originals, an absolute path in production; web and worker must share it |
| `S3_ENDPOINT` | AWS | Endpoint of an S3-compatible service, e.g. `https://fsn1.your-objectstorage.com` (Hetzner Object Storage) |
| `S3_REGION` | required with `s3` | e.g. `fsn1` |
| `S3_BUCKET` | required with `s3` | Bucket name |
| `S3_ACCESS_KEY_ID` | required with `s3` | Access key of a key that may read, write, and delete in this bucket only |
| `S3_SECRET_ACCESS_KEY` | required with `s3` | Its secret |
| `S3_FORCE_PATH_STYLE` | `false` | `true` for services that need the bucket in the path (MinIO, RustFS) |
| `UPLOAD_MAX_MB` | `50` | Largest file, in megabytes, for uploads and downloaded links |

## AI model (worker)

The worker sends the extracted text of each upload to one AI model, which
returns the draft as JSON. The model gets no tools. Any API that speaks the
OpenAI chat completions format and supports
`response_format: {"type": "json_object"}` works: for example Mistral,
OpenAI, Azure OpenAI, or a self-hosted model behind an OpenAI-compatible
server. Most sources name their authors, so choose a provider that your
organization allows for personal data.

| Variable | Default | Value |
|---|---|---|
| `AI_PROVIDER` | `fake` outside production, required in production (`openai-compatible` in `compose.yaml`) | `openai-compatible`, or `fake`, which drafts from the text without a model (development and tests only) |
| `AI_BASE_URL` | required | Base URL up to and including `/v1`, e.g. `https://api.mistral.ai/v1` or `https://api.openai.com/v1` |
| `AI_API_KEY` | required | API key |
| `AI_MODEL` | required | Model name, e.g. `mistral-medium-latest` |
| `AI_DAILY_LIMIT` | `200` | Drafts per day across all uploads; the rest waits for the next day |
| `AI_TIMEOUT_MS` | `120000` | How long to wait for one answer |

## Webhook (worker)

| Variable | Default | Value |
|---|---|---|
| `WEBHOOK_URL` | none (off) | HTTPS endpoint that receives published notes |
| `WEBHOOK_SECRET` | none | At least 16 characters; required with `WEBHOOK_URL`. Signs every request: `openssl rand -hex 32` |

See [webhook](webhooks.md) for the payload and the signature.

## Text recognition (worker)

PDFs without a text layer (scans) need OCR. The Docker image includes
`ocrmypdf` with German and English.

| Variable | Default | Value |
|---|---|---|
| `OCR_COMMAND` | none (off; `ocrmypdf` in `compose.yaml`) | `ocrmypdf`, or another command that takes its arguments. Without it, scans are parked for a steward |
| `OCR_LANGUAGES` | `deu+eng` | Tesseract language codes, joined with `+` |

## Notifications (worker)

Email and Slack are each optional. Stewards get emails about uploads on hold,
people who follow tags get a weekly email, and uploaders hear about their
uploads by Slack direct message. When one channel is off, or cannot reach a
person (no Slack account, no email address), the message goes out on the
other. So it does after an error that trying again cannot fix, such as an
invalid token, a missing Slack scope, or a rejected address. Other errors,
such as an outage or a rate limit, are retried after 1, 5, 15, and 60
minutes; the fifth and last attempt tries the other channel too.

Email goes through an SMTP server or the MailerSend API, not both.

| Variable | Default | Value |
|---|---|---|
| `SMTP_URL` | none | `smtp://user:password@host:587` (STARTTLS) or `smtps://user:password@host:465`. Percent-encode special characters in the password |
| `MAILERSEND_API_TOKEN` | none | Instead of SMTP: a MailerSend API token with email sending access |
| `MAIL_FROM` | none | Sender address; required with SMTP or MailerSend |
| `MAIL_FROM_NAME` | `Meldgrove Library` | Sender name |
| `SLACK_BOT_TOKEN` | none | Bot token (`xoxb-…`) of a Slack app with the scopes `chat:write`, `users:read`, and `users:read.email` (the [Slack bot](#slack-bot-web-worker) needs more) |
| `NOTIFICATION_TRANSPORT` | `live` in production, otherwise `console` | `console` only logs messages instead of sending them |

## Slack bot (web, worker)

Optional, and off until `SLACK_SIGNING_SECRET` is set. People send the Slack
app a direct message with a link or a file and one line on why; the worker
adds them as uploads and answers in the same conversation.

| Variable | Process | Value |
|---|---|---|
| `SLACK_SIGNING_SECRET` | web | The app's signing secret (Slack: **Basic Information → App Credentials**). The web process accepts only events signed with it |
| `SLACK_BOT_TOKEN` | worker | The bot token, as for notifications. The worker handles messages only with it |

Set up the Slack app:

- **OAuth & Permissions → Bot Token Scopes**: `chat:write`, `users:read`,
  `users:read.email`, `im:history`, and `files:read`. Reinstall the app after
  adding scopes.
- **Event Subscriptions**: on, with the request URL
  `<LIBRARY_BASE_URL>/api/slack/events` and the bot event `message.im`. Slack
  checks the URL when it is saved; the web process must run with the signing
  secret by then.
- **App Home**: under **Show Tabs**, turn on the **Messages Tab** and allow
  users to send messages from it.

People are found by the email address of their Slack account, which must be
their `work_email` in the library. Files count against `UPLOAD_MAX_MB`.

## Email intake (worker)

Optional, and off until `EMAIL_INTAKE_IMAP_URL` is set. People send or
forward links and files to one mailbox, with one line on why as the subject;
the worker reads it every 2 minutes. Use a mailbox for the library alone: the
worker marks every message it handled as seen.

| Variable | Default | Value |
|---|---|---|
| `EMAIL_INTAKE_IMAP_URL` | none (off) | `imaps://user:password@host:993` (or `imap://…`, which must upgrade with STARTTLS; a server without it is refused). Percent-encode special characters in the user and password |
| `EMAIL_INTAKE_DOMAINS` | required with the URL | Domains people send from, separated by commas, e.g. `example.org`. Other senders are refused, and links to these domains are ignored |
| `EMAIL_INTAKE_MAILBOX` | `INBOX` | The folder to read |
| `EMAIL_INTAKE_DONE_MAILBOX` | none | Folder that handled messages move to, e.g. `Processed`; it must exist. Without it they stay, marked as seen |

The receiving mail server must add an `Authentication-Results` header with
DKIM and SPF results (Google Workspace, Microsoft 365, and most providers
do). A message is taken only when it shows `dkim=pass` or `spf=pass` for the
sender's domain, and only from people with access, by their `work_email`.
Answers go out by email (or Slack), so set up
[notifications](#notifications-worker).

## Weekly digests (worker)

Optional. Mondays at 09:00 in the server's time zone, the worker sends the
notes published in the last 7 days. Stewards set a Slack channel for each
team under **Admin → Teams**; everyone can follow tags under **Settings** and
gets their own email. These variables set where notes for everyone go. Add
the library's Slack app to each Slack channel (or give it the
`chat:write.public` scope for public channels). A team's channel gets notes
for the team too, so choose one only the team is in.

| Variable | Default | Value |
|---|---|---|
| `DIGEST_SLACK_CHANNEL_ID` | none | Channel ID such as `C0123456789` (Slack: the channel's details, at the bottom); not the channel's name |
| `DIGEST_EMAIL_TO` | none | An address, such as a mailing list, that gets the digest by email; needs [email](#notifications-worker) |

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

## Time zone

The library uses the server's time zone, set with the standard `TZ` variable
(e.g. `TZ=Europe/Berlin`; the Docker image defaults to UTC). It decides when
scheduled jobs run: review reminders, weekly digests, and the nightly webhook
run. Everyone can choose their own time zone and date format for display
under **Settings**; the default date format is `DD.MM.YYYY`.

## Operations

| Variable | Default | Value |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `APP_VERSION` | the version in release images, otherwise none | Set by release images, not by operators. `/-/healthz` and Sentry report it |
| `WORKER_HEARTBEAT_FILE` | `/tmp/library-worker-heartbeat` | File the worker touches for its health check |
| `MIGRATIONS_DIR` | `drizzle` | Folder with the SQL migrations |
