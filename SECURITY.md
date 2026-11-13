# Security

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them
privately through GitHub: on the repository's **Security** tab, choose
**Report a vulnerability**.

Include what you found, how to reproduce it, and the impact you expect. We
will confirm receipt, keep you informed while we work on a fix, and credit you
in the release notes unless you prefer otherwise.

## Supported versions

Security fixes go into the latest release and the `main` branch.

## Deployment notes

- Generate `BETTER_AUTH_SECRET` with `openssl rand -base64 32`. The library
  refuses to start in production with the example value from `.env.example`.
- Serve the library over HTTPS only, and set `LIBRARY_BASE_URL` to that HTTPS
  URL.
- The Keycloak service account needs only the `view-users` role of
  `realm-management`.
- Set `OIDC_TRUST_EMAIL=true` only if people cannot choose their own email
  address at your identity provider.
- Give the S3 key access to the library bucket only.
- Uploaded sources name their authors and other people. Use an AI provider
  that your organization allows for personal data, and keep `AI_DAILY_LIMIT`
  at a level you are willing to pay for.
- Uploads are untrusted: the screen, the schema check of the AI answer, and
  the uploader's review are the defences (see
  [docs/architecture.md](docs/architecture.md#untrusted-content)).
- The webhook receiver gets notes visible to everyone and notes visible to
  one team (`visibility` in the payload). Use an HTTPS URL, a random
  `WEBHOOK_SECRET` of at least 32 characters, and check every request's
  signature and timestamp ([docs/webhooks.md](docs/webhooks.md)). A receiver
  that shows notes to people must respect `visibility`.
- The Slack bot knows people by the email address Slack has confirmed for
  their account. Install the Slack app only in your organization's own
  workspace, and keep `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` in a
  secret store.
- The email intake trusts the topmost `Authentication-Results` header. Use a
  mailbox at a provider that adds it on receipt and removes or ranks below it
  any such header a sender wrote; list only your organization's own domains
  in `EMAIL_INTAKE_DOMAINS`.
