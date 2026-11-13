import { createHash } from "node:crypto";
import { noteRef, notePath, type NoteQuote, type Visibility } from "@/lib/library/constants";

/*
 * What the webhook receives (docs/webhooks.md). Pure functions, tested.
 * Every `note.changed` carries the whole note as it is now, so a receiver
 * stores it by `note.id` and replaces what it had; `note.removed` names only
 * the ID.
 */

export interface NoteForWebhook {
  id: string;
  number: number;
  title: string;
  core: string;
  keyPoints: string[];
  quotes: NoteQuote[];
  citation: string;
  language: string | null;
  visibility: Exclude<Visibility, "private">;
  publishedAt: Date;
  editedAt: Date | null;
  team: { name: string; directoryId: string | null } | null;
  ownerName: string;
  documentType: string | null;
  project: string | null;
  tags: string[];
  sourceUrl: string | null;
  doi: string | null;
  checked: boolean;
}

export interface NoteChangedPayload {
  event: "note.changed";
  note: {
    id: string;
    ref: string;
    url: string;
    title: string;
    core: string;
    key_points: string[];
    quotes: { text: string; location: string | null }[];
    citation: string;
    language: string | null;
    /** The note as one text, as a search index or an AI assistant should read it. */
    text: string;
    visibility: "all" | "team";
    team: { name: string; directory_id: string | null } | null;
    owner: string;
    document_type: string | null;
    project: string | null;
    tags: string[];
    source_url: string | null;
    doi: string | null;
    checked: boolean;
    ai_drafted: true;
    published_at: string;
    changed_at: string;
  };
}

export interface NoteRemovedPayload {
  event: "note.removed";
  note: { id: string };
}

export type WebhookPayload = NoteChangedPayload | NoteRemovedPayload;

/** Core, key points, quotes, and citation, as an agent should read them. */
export function noteText(note: NoteForWebhook): string {
  const parts = [note.core, "", "Key points:", ...note.keyPoints.map((point) => `- ${point}`)];
  if (note.quotes.length > 0) parts.push("", "Quotes:", ...note.quotes.map((quote) => `- "${quote.text}"${quote.location ? ` (${quote.location})` : ""}`));
  if (note.citation) parts.push("", `Citation: ${note.citation}`);
  if (note.sourceUrl) parts.push(`Source: ${note.sourceUrl}`);
  if (note.doi) parts.push(`DOI: ${note.doi}`);
  parts.push("", `Summary drafted by an AI model and confirmed by ${note.ownerName}${note.checked ? ", checked by a steward" : ""}. Check details against the source.`);
  return parts.join("\n");
}

export function noteChangedPayload(note: NoteForWebhook, baseUrl: string): NoteChangedPayload {
  return {
    event: "note.changed",
    note: {
      id: note.id,
      ref: noteRef(note.number),
      url: `${baseUrl.replace(/\/+$/, "")}${notePath(note.number)}`,
      title: note.title,
      core: note.core,
      key_points: note.keyPoints,
      quotes: note.quotes.map((quote) => ({ text: quote.text, location: quote.location ?? null })),
      citation: note.citation,
      language: note.language,
      text: noteText(note),
      visibility: note.visibility,
      team: note.team ? { name: note.team.name, directory_id: note.team.directoryId } : null,
      owner: note.ownerName,
      document_type: note.documentType,
      project: note.project,
      tags: note.tags,
      source_url: note.sourceUrl,
      doi: note.doi,
      checked: note.checked,
      ai_drafted: true,
      published_at: note.publishedAt.toISOString(),
      changed_at: (note.editedAt ?? note.publishedAt).toISOString(),
    },
  };
}

export function noteRemovedPayload(noteId: string): NoteRemovedPayload {
  return { event: "note.removed", note: { id: noteId } };
}

/** Stable across key order, so an unchanged note is not sent again. */
export function payloadHash(payload: unknown): string {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]))
        : value;
  return createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex");
}
