# Webhook

With `WEBHOOK_URL` and `WEBHOOK_SECRET` set, the worker posts published notes
to that URL as JSON, for example to keep a search index, a knowledge base, or
an AI assistant up to date. The receiver gets finished notes that a person
has confirmed; it needs no AI model of its own.

## What is sent

- Published notes with the visibility "Everyone" (`all`) or "My team"
  (`team`).
- Never drafts, discarded notes, or notes with the visibility "Only me".

A note is sent when it is published, and again whenever it changes: an edit,
a new visibility, or a steward's check. Every request carries the whole note
as it is now, so a receiver stores it by `note.id` and replaces what it had.
When a note becomes private or is deleted, the receiver gets a removal.

Changes go out within a minute, up to 50 notes a minute. Every night at 02:30
(server time) the worker re-sends any note whose content differs from what
the receiver last got, for example after a team or a person was renamed; the
first nightly run after the webhook is turned on sends every published note.

### `note.changed`

```json
{
  "event": "note.changed",
  "note": {
    "id": "0196f1e2-…",
    "ref": "LIB-12",
    "url": "https://library.example.org/n/12",
    "title": "Keeping Volunteers: Retention in Small Nonprofits",
    "core": "Most volunteers who leave small nonprofits do so in their first six months.",
    "key_points": ["Survey of 412 organizations", "38 percent leave within six months", "A named contact person halves early drop-out"],
    "quotes": [{ "text": "The first month decides whether a volunteer stays for years.", "location": "p. 7" }],
    "citation": "Example Institute (2026). Keeping Volunteers. Berlin.",
    "language": "en",
    "text": "Core, key points, quotes, and citation as one text",
    "visibility": "team",
    "team": { "name": "Programs", "directory_id": "4f0c…" },
    "owner": "Erika Example",
    "document_type": "Study",
    "project": null,
    "tags": ["Governance", "Volunteering"],
    "source_url": null,
    "doi": "10.1234/example",
    "checked": true,
    "ai_drafted": true,
    "published_at": "2026-11-04T09:00:00.000Z",
    "changed_at": "2026-11-06T14:30:00.000Z"
  }
}
```

- `ref` is the number shown in the library, `url` the note's page there.
- `text` is the note as one plain text, as a search index or an AI assistant
  should read it. It ends with a line that says the summary was drafted by
  an AI model, confirmed by the owner, and (when `checked`) checked by a
  steward.
- `visibility`: `all` for everyone with access to the library, `team` for
  the owner's team only. A receiver that shows notes to people must apply
  this itself.
- `team` is the owner's team, or null. `directory_id` is the team's group ID
  in Keycloak with `DIRECTORY=keycloak`, and null for teams managed in the
  library.
- `language` is the ISO 639-1 code of the source's language, or null.
- `quotes[].location`, `document_type`, `project`, `source_url` (links only),
  and `doi` can be null.
- `checked` is true once a steward has checked the note against its source.
- `ai_drafted` is always true.
- `changed_at` is the time of the last edit, or `published_at` without one.

### `note.removed`

```json
{ "event": "note.removed", "note": { "id": "0196f1e2-…" } }
```

Delete the note with this ID. Answer with a 2xx status also for an ID the
receiver never had: the library may send a removal for a note whose earlier
delivery it could not confirm.

## Signature

Every request has these headers:

| Header | Value |
|---|---|
| `Library-Timestamp` | Unix time in seconds when the request was sent |
| `Library-Signature` | `sha256=` and the hex HMAC-SHA256 of `<timestamp>.<raw body>`, keyed with `WEBHOOK_SECRET` |
| `Library-Delivery` | A random ID of this request |

Check the signature against the raw body before parsing it, compare in
constant time, and reject old timestamps:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function isFromLibrary(rawBody, headers, secret) {
  const timestamp = headers["library-timestamp"];
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
  const received = headers["library-signature"] ?? "";
  return expected.length === received.length && timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}
```

## Delivery

Any 2xx answer counts as delivered. Anything else, or no answer within 30
seconds, is retried after 1, 5, 15, and 60 minutes, then every 6 hours.
Redirects are not followed. Every change of a note starts its attempts anew.
The admin page shows how many notes were delivered, which are waiting, and
which keep failing, with the last error.
