/*
 * Closed lists and shared types of the library. No imports, so the schema
 * can use them without a cycle.
 */

export const SOURCE_KINDS = ["file", "link"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const EXTRACTION_METHODS = ["pdf", "docx", "html", "text", "ocr"] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

/** How an upload arrived. `import` is the one-off import of existing notes. */
export const SUBMISSION_CHANNELS = ["web", "slack", "email"] as const;
export type SubmissionChannel = (typeof SUBMISSION_CHANNELS)[number];

export const SUBMISSION_STATUSES = [
  "received",
  "processing",
  "quarantined",
  "duplicate",
  "blocked",
  "parked",
  "drafted",
] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

/** Submissions the worker still has to finish. */
export const OPEN_SUBMISSION_STATUSES = ["received", "processing"] as const satisfies readonly SubmissionStatus[];

export const NOTE_STATUSES = ["draft", "published", "discarded"] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

/**
 * Who can see a note: only its owner, the owner's team, or all staff.
 * Private notes never leave the library.
 */
export const VISIBILITIES = ["private", "team", "all"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const VISIBILITY_LABELS: Record<Visibility, string> = {
  private: "Only me",
  team: "My team",
  all: "Everyone",
};

export const TAG_PROPOSAL_STATUSES = ["pending", "accepted", "rejected"] as const;
export type TagProposalStatus = (typeof TAG_PROPOSAL_STATUSES)[number];

export interface NoteQuote {
  text: string;
  /** Where in the source, such as "p. 12". */
  location?: string;
}

/** Why the screen stopped a submission. Never the matched text itself. */
export interface ScreenFinding {
  rule: string;
  /** What kind of content: prohibited data, a credential, or hidden instructions. */
  category: "prohibited_data" | "credential" | "prompt_injection";
  /** How often the rule matched. */
  count: number;
}

/** Limits of the note template. */
export const NOTE_LIMITS = {
  title: 300,
  core: 1_200,
  keyPoints: { min: 3, max: 7, item: 500 },
  quotes: { max: 5, item: 800 },
  citation: 600,
  tags: { min: 2, max: 5 },
  reason: 300,
} as const;

/** The text that goes to the AI model, cut at this many characters. */
export const DRAFT_TEXT_LIMIT = 60_000;

/** Upload rules shown on the upload page; the uploader confirms them. */
export const UPLOAD_RULES = [
  "External reading only: studies, reports, articles, funder material.",
  "No bank details, health or other special-category data, criminal records, credentials, or personnel files.",
  "Paid studies only when their licence allows sharing inside the organization.",
] as const;

export const UPLOAD_CONFIRMATION = "I confirm that this upload follows the rules above.";

/** A Slack channel ID: public (C…) or private (G…). Direct messages (D…) are not channels. */
export const SLACK_CHANNEL_ID_PATTERN = /^[CG][A-Z0-9]{6,}$/;

/** A file shared in a Slack message, as the Events API describes it. */
export interface SlackSharedFile {
  id: string;
  name: string;
  mimetype?: string;
  size?: number;
  /** Where the bot downloads the file, with its token. */
  urlPrivateDownload?: string;
  /** "hosted" for uploaded files; "external" (e.g. Google Drive) and "tombstone" (deleted) have no file to download. */
  mode?: string;
}

/** A direct message to the Slack bot: its text in Slack's markup and the shared files. */
export interface SlackMessage {
  text: string;
  ts: string;
  files: SlackSharedFile[];
}

/** Shown as LIB-<number>. */
export const notePath = (number: number) => `/n/${number}`;
export const noteRef = (number: number) => `LIB-${number}`;

/** The number in a note path ("/n/12"), or undefined for anything else. */
export function parseNoteNumber(value: string): number | undefined {
  return /^\d{1,9}$/.test(value) ? Number(value) : undefined;
}

/** One hit of the search in the sidebar (⌘K). */
export interface NoteSearchResult {
  ref: string;
  title: string;
  /** The document type, if the note has one. */
  kind: string | null;
  href: string;
}

/** The number of a reference typed into the search ("LIB-12", "lib 12", "12"), or undefined. */
export function parseNoteRef(value: string): number | undefined {
  const match = /^(?:lib[-\s]?)?(\d{1,9})$/i.exec(value.trim());
  return match ? Number(match[1]) : undefined;
}
