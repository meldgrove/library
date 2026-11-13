/*
 * Types shared by the schema, the notification commands, and the worker. No
 * imports, so the schema can use them without a cycle.
 */

/** A channel-neutral message. The worker formats it for Slack or email. */
export interface NotificationMessage {
  /** Email subject; also the first line of a Slack message's preview. */
  subject: string;
  /** The linked heading, e.g. "LIB-12 · Title" or "Weekly digest". */
  title: string;
  /** What happened and what the recipient should do. May hold date tokens. */
  text: string;
  /** Path in the library, e.g. "/n/12". The worker adds the base URL. */
  path: string;
  /** Digests: notes listed under the text, by section. */
  sections?: DigestSection[];
  /** Why the reader gets the message; the last line of an email. */
  footer?: string;
  /**
   * A digest: rebuilt from the notes as they are just before each send, so a
   * note that changed since (private, another team, unpublished) is left out.
   */
  digest?: DigestSpec;
}

export interface DigestSpec {
  /** The notes the digest was recorded with. */
  noteIds: string[];
  /** Who reads it: everyone, one team's channel, or one person (by their access). */
  audience: { kind: "all" } | { kind: "team"; teamId: string } | { kind: "person" };
  /** Passed to the rebuild as recorded. */
  options: { audience?: string; title?: string; footer?: string };
}

export interface DigestSection {
  heading: string;
  items: DigestItem[];
}

export interface DigestItem {
  /** "LIB-12". */
  ref: string;
  title: string;
  /** Path in the library. */
  path: string;
  /** The note's core. */
  summary: string;
  /** Tags or the document type, shown after the summary. */
  meta?: string;
}

/** How the worker sends each channel: for real, to the log, or not at all. */
export type ChannelMode = "live" | "console" | "off";

export interface NotificationChannels {
  slack: ChannelMode;
  email: ChannelMode;
  /** Sending published notes to the webhook: live or off. */
  webhook?: ChannelMode;
}
