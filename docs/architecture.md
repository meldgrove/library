# Architecture

Meldgrove Library is a shared library of external reading: studies, reports,
articles, and funder material. People add a file or a link, the worker drafts
a structured source note with an AI model, the uploader checks and publishes
it, and an optional webhook passes published notes on, for example to a
search index or a knowledge base.

```text
web upload ──┐
Slack bot ───┼─► Meldgrove Library ──► webhook (optional): search index, knowledge base, AI assistant
email ───────┘   web app · worker · PostgreSQL · object storage
                 ├─► AI model (OpenAI-compatible API): text in, JSON out
                 └─► email and Slack: replies, reminders, weekly digests
```

## Data

| Table | Holds |
|---|---|
| `source` | One file (by SHA-256) or link (by normalized URL), with its DOI and where the original is stored |
| `source_text` | The extracted text, kept for re-drafting and for checking quotes |
| `submission` | One upload by one person: channel, reason, status, and why it stopped |
| `note` | The source note: title, core, key points, quotes, citation, categories, visibility, review state. Shown as LIB-<number> |
| `note_tag`, `note_reason`, `note_version` | Tags, who added the source and why, and every saved state |
| `tag`, `tag_cluster`, `document_type`, `project`, `tag_proposal` | The taxonomy the AI model picks from, and tags it asked for |
| `webhook_sync` | What the webhook receiver should hold of each note, and whether it has it |
| `audit_event` | Append-only log of every state change |
| `notification_delivery` | Slack and email messages; only the worker sends them |
| `slack_event` | Direct messages to the Slack bot, by Slack's event ID, until the worker has handled them |
| `email_message` | Emails to the intake mailbox the worker has handled, by Message-ID, with the outcome (no subject or body) |
| `tag_subscription` | Tags each person follows for their weekly email |

A source has at most one note. Originals are stored once; a second upload of
the same file, link, or DOI becomes a reason on the existing note.

## The way of an upload

The worker (`src/lib/library/pipeline.ts`) takes each upload through fixed
steps. Only the draft uses the AI model.

1. **Received.** The web process stores the original (files) or the link.
2. **Text.** PDF (pages marked `[Page N]`), Word, web page (reader view), or
   text; OCR for scans when `OCR_COMMAND` is set. Links are downloaded with
   every address checked against private networks.
3. **Screen** (`screen.ts`): hidden instructions for AI models, credentials,
   and lists of prohibited data (bank details, payment cards, contact lists,
   personnel documents). A finding quarantines the upload until a steward
   releases or deletes it.
4. **Duplicates**: the same source, or another with the same DOI, already has
   a note. A source whose draft was discarded stays blocked.
5. **AI budget**: at most `AI_DAILY_LIMIT` drafts a day; the rest waits.
6. **Draft** (`draft.ts`): the model returns one JSON object. Code checks it
   against the schema and the closed lists, drops quotes that are not in the
   source, and turns unknown tags into proposals. An invalid answer is asked
   again once, then the upload is parked for a steward. A model that cannot be
   reached is retried after 5 and 30 minutes.
7. **Note**: a draft owned by the uploader, in their team. The uploader gets
   a message.

A submission is claimed with `FOR UPDATE SKIP LOCKED`, so several workers can
run. A submission left in `processing` for 30 minutes (a stopped worker) is
taken up again.

## The Slack bot

Optional. People send the bot a direct message with a link or a file and one
line on why (`src/lib/library/slack-intake.ts`).

1. `POST /api/slack/events` checks Slack's signature (HMAC-SHA256 with the
   signing secret, at most five minutes old), answers Slack's URL check, and
   stores direct messages from people (no bots, no edits) in `slack_event`,
   keyed by the event ID, so Slack's retries count once. It downloads
   nothing and answers at once.
2. The worker looks every 5 seconds. It asks Slack for the sender's email
   address (`users.info`) and finds the person with access by
   `work_email`. Unknown people and people without access get one fixed
   answer with no data from the library.
3. Links come from Slack's `<url|label>` markup; the rest of the text is the
   reason (at least 3 characters, else the bot asks for one). Files are
   downloaded with the bot token through `fetchLink`, only from
   `files.slack.com`, within `UPLOAD_MAX_MB` and the accepted types.
4. Each link and file goes through `submitLink` or `submitFile` (channel
   `slack`), and the reply ("Added …", "Not added: …") is a notification row,
   all in one transaction. The draft follows as a direct message, as for web
   uploads.

Slack errors are retried after 1, 5, 15, and 60 minutes; a permanent error (a
missing scope, a bad token) stops at once and shows in `slack_event.last_error`.

## Email intake

Optional. People send or forward an email to one mailbox
(`src/lib/library/email-intake.ts`). Every 2 minutes the worker reads its
unseen messages over IMAP (`src/lib/email/imap.ts`) and takes a message only
when:

1. it is not automatic (auto-replies, bounces, list mail),
2. the From address is in an allowed domain (`EMAIL_INTAKE_DOMAINS`),
3. the topmost `Authentication-Results` header, which the receiving mail
   server adds, shows `dkim=pass` for that domain (`header.d` or `header.i`)
   or `spf=pass` for it (`smtp.mailfrom`), and
4. the address is the `work_email` of a person with access.

Messages failing 1 to 3 are refused without an answer; an authenticated sender
without access gets one fixed answer. Attached files of the accepted types go
through `submitFile`, web links in the sender's own text (not the signature,
not forwarded or quoted text, not the organization's own domains) through
`submitLink`, on the `email` channel. The reason is the subject without
"Re:"/"Fwd:", or else the first line of the body. The reply, the uploads,
and the `email_message` row are written in one transaction; the message is
then moved to `EMAIL_INTAKE_DONE_MAILBOX`, or marked as seen without one. A
message that failed for another reason (the database, storage) stays unseen
for the next run. A message larger than one file at `UPLOAD_MAX_MB` is
answered without being loaded.

## Weekly digests

Mondays at 09:00 (server time), the worker records the weekly digests
(`src/lib/library/digest.ts`): notes published since the Monday 09:00
before, grouped by the cluster of each note's first tag ("Other" without
one), each with its number, title, link, core, document type, and tags, plus
the newest quote as the quote of the week. No AI model is involved.

| Goes to | Gets |
|---|---|
| `DIGEST_SLACK_CHANNEL_ID` (Slack) | Notes for everyone |
| `DIGEST_EMAIL_TO` (a list address) | Notes for everyone |
| A team's Slack channel (stewards set it under **Admin → Teams**) | The team's notes for everyone or for the team |
| Each person who follows tags (**Settings**), by email | Notes by others with one of their tags that they may see (`visibleNotes`) |

Private notes never go to a channel or a list. Nobody gets an empty digest.
Each message's delivery key names the ISO week (and the person), so a retried
job records it once. A list address is a notification with the channel
`email_address`, sent through the email transport.

A digest records which notes it lists and for whom. Just before each send,
also after a retry, the worker rebuilds it from the notes as they are: a note
that became private, moved to a team, or was unpublished since is left out,
and a digest with no note left is not sent. The week runs from one Monday
09:00 to the next in the server's time zone, so a retry later in the week
lists the same week.

## Review and publishing

`src/lib/library/review.ts` holds the commands; each checks, writes, and
records its effects in one transaction.

| Who | Can |
|---|---|
| The owner (uploader) | Correct the draft against the original, then publish it ("Everyone", "My team", or "Only me") or discard it. Edit and delete their published notes |
| A steward (admin) | All of the above for every note that is not private; mark published notes as checked; release or delete quarantined uploads; retry or delete parked ones |

Publishing needs 3 to 7 key points and 2 to 5 tags (when the taxonomy has
tags). Every save is a new version. Discarding blocks the source, so later
uploads of it are not drafted again. Deleting removes the note, its source,
every upload of it, and the stored originals; the audit log keeps the note's
number and the reason.

Owners get a reminder after a week; stewards hear of drafts open after 30
days. The **Steward** page lists uploads on hold, overdue drafts, and
published notes not yet checked.

## Webhook

Commands that can change what the receiver should hold (save, publish,
check, delete) set a request in `webhook_sync`, in their transaction. The
worker (`src/lib/webhook/sync.ts`) handles requests every minute: a
published, non-private note goes out as `note.changed` (a payload hash skips
unchanged notes), anything else as `note.removed`. Failed deliveries are
retried with backoff; a nightly run at 02:30 requests every published note
again. Rows are claimed with `FOR UPDATE SKIP LOCKED`, so several workers
never send the same note. See [webhook](webhooks.md) for the payload and the
signature.

## Access

`src/lib/library/access.ts` holds one rule, as a function for pages and as an
SQL condition for lists and search; a test checks that both agree. See
[identity and access](identity-and-access.md#who-sees-a-note).

## Untrusted content

Every upload may contain instructions meant for the AI model. The defences are
structural: the model has no tools and no write access, the source text is
fenced and labelled as untrusted data, the answer must fit a schema, and the
uploader reviews every draft before anyone else sees it. The screen catches
copy-pasted boilerplate; it is not a trust boundary.
