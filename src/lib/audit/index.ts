import type { Database, Transaction } from "@/lib/db/client";
import { auditEvent } from "@/lib/db/schema";

export type AuditAction =
  | "submission.received"
  | "submission.processing"
  | "submission.quarantined"
  | "submission.duplicate"
  | "submission.blocked"
  | "submission.parked"
  | "submission.released"
  | "submission.retried"
  | "submission.deleted"
  | "note.drafted"
  | "note.edited"
  | "note.published"
  | "note.discarded"
  | "note.checked"
  | "note.deleted"
  | "note.reason_added"
  | "note.imported"
  | "source.deleted"
  | "tag.created"
  | "tag.renamed"
  | "tag.activated"
  | "tag.deactivated"
  | "tag_proposal.accepted"
  | "tag_proposal.rejected"
  | "taxonomy.changed"
  | "person.invited"
  | "person.linked"
  | "person.first_admin"
  | "person.access_granted"
  | "person.access_revoked"
  | "person.admin_granted"
  | "person.admin_revoked"
  | "person.updated"
  | "team.created"
  | "team.renamed"
  | "team.activated"
  | "team.deactivated"
  | "team.digest_channel_changed";

export type AuditSubject = "note" | "submission" | "source" | "tag" | "tag_proposal" | "document_type" | "project" | "person" | "team";

/** Appends an audit event in the caller's transaction. Rows are never changed or deleted. */
export async function recordAudit(
  db: Database | Transaction,
  event: {
    actorId: string | null;
    action: AuditAction;
    subjectType: AuditSubject;
    subjectId?: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(auditEvent).values({
    actorId: event.actorId,
    action: event.action,
    subjectType: event.subjectType,
    subjectId: event.subjectId ?? null,
    payload: event.payload ?? {},
  });
}
