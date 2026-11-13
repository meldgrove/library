import type { NoteStatus, SubmissionStatus, Visibility } from "@/lib/library/constants";

/* Labels and badge styles for statuses, shared by the pages. */

export const SUBMISSION_STATUS_LABELS: Record<SubmissionStatus, string> = {
  received: "Waiting",
  processing: "Processing",
  quarantined: "On hold",
  duplicate: "Already in the library",
  blocked: "Not drafted",
  parked: "On hold",
  drafted: "Drafted",
};

export const NOTE_STATUS_LABELS: Record<NoteStatus, string> = {
  draft: "Draft",
  published: "Published",
  discarded: "Discarded",
};

export const VISIBILITY_DESCRIPTIONS: Record<Visibility, string> = {
  private: "Only you. Never in a digest or sent to connected tools.",
  team: "Your team, also in your team's digest and connected tools.",
  all: "Everyone in the organization, also in the weekly digest and connected tools.",
};

export function submissionBadgeVariant(status: SubmissionStatus): "default" | "secondary" | "outline" | "destructive" {
  if (status === "quarantined" || status === "parked") return "destructive";
  if (status === "drafted") return "default";
  if (status === "received" || status === "processing") return "outline";
  return "secondary";
}

/** "2.4 MB" */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "";
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(0)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
