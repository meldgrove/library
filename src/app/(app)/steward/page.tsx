import type { Metadata } from "next";
import Link from "next/link";
import { ActionButton } from "@/components/admin/directory-forms";
import { SUBMISSION_STATUS_LABELS } from "@/components/library/labels";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getFormatter, requireAdmin } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { viewerOf } from "@/lib/library/access";
import { notePath, noteRef } from "@/lib/library/constants";
import { stewardQueues } from "@/lib/library/review";
import { deleteSubmissionAction, releaseSubmissionAction, retrySubmissionAction } from "./actions";

export const metadata: Metadata = { title: "Steward" };

/** The exceptions: uploads on hold, drafts nobody reviews, and published notes to check. */
export default async function StewardPage() {
  const { person } = await requireAdmin();
  const [fmt, queues] = await Promise.all([getFormatter(), stewardQueues(getDb(), viewerOf(person))]);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Steward"
        description="Everything that needs a steward. Uploaders review their own drafts; you see only the exceptions."
        actions={
          queues.pendingProposals > 0 ? (
            <Link href="/admin/taxonomy" className="text-sm underline underline-offset-4">
              {queues.pendingProposals === 1 ? "1 tag proposal" : `${queues.pendingProposals} tag proposals`}
            </Link>
          ) : null
        }
      />

      <Card role="region" aria-labelledby="on-hold">
        <CardHeader>
          <CardTitle>
            <h2 id="on-hold">Uploads on hold</h2>
          </CardTitle>
          <CardDescription>
            Quarantined: the screen found possible prohibited data or hidden instructions. Release it when the upload is fine, or delete
            it. Parked: the text or the AI draft failed; try again or delete it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {queues.onHold.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing on hold.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Upload</TableHead>
                  <TableHead>Why</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {queues.onHold.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="max-w-72 whitespace-normal">
                      {row.hasOriginal ? (
                        <a href={`/api/originals/${row.sourceId}`} target="_blank" rel="noopener" className="font-medium underline underline-offset-4">
                          {row.fileName ?? "Original"}
                        </a>
                      ) : (
                        <span className="font-medium break-all">{row.url}</span>
                      )}
                      <span className="block text-xs text-muted-foreground">
                        {row.submitterName} · {fmt.dateTime(row.createdAt)}
                        {row.reason ? ` · ${row.reason}` : ""}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-80 whitespace-normal text-sm">
                      <Badge variant="destructive">{row.status === "quarantined" ? "Quarantined" : SUBMISSION_STATUS_LABELS[row.status]}</Badge>
                      <span className="mt-1 block text-muted-foreground">{row.statusReason}</span>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        {row.status === "quarantined" ? (
                          <ActionButton action={releaseSubmissionAction.bind(null, row.id)} label="Release" variant="outline" />
                        ) : (
                          <ActionButton action={retrySubmissionAction.bind(null, row.id)} label="Try again" variant="outline" />
                        )}
                        <ActionButton action={deleteSubmissionAction.bind(null, row.id)} label="Delete" variant="destructive" />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card role="region" aria-labelledby="overdue">
        <CardHeader>
          <CardTitle>
            <h2 id="overdue">Drafts waiting 30 days</h2>
          </CardTitle>
          <CardDescription>Their owners got a reminder after a week. Review them, or ask the owner.</CardDescription>
        </CardHeader>
        <CardContent>
          <NoteLinks notes={queues.overdue.map((n) => ({ ...n, when: `drafted ${fmt.day(n.draftedAt)}` }))} empty="No draft has waited that long." />
        </CardContent>
      </Card>

      <Card role="region" aria-labelledby="unchecked">
        <CardHeader>
          <CardTitle>
            <h2 id="unchecked">Published, not yet checked</h2>
          </CardTitle>
          <CardDescription>The latest 50. Checking is optional; a checked note carries the mark in the library and in connected tools.</CardDescription>
        </CardHeader>
        <CardContent>
          <NoteLinks notes={queues.unchecked.map((n) => ({ ...n, when: `published ${fmt.day(n.publishedAt)}` }))} empty="Every published note is checked." />
        </CardContent>
      </Card>
    </div>
  );
}

function NoteLinks({ notes, empty }: { notes: { id: string; number: number; title: string; ownerName: string; when: string }[]; empty: string }) {
  if (notes.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="flex flex-col divide-y text-sm">
      {notes.map((n) => (
        <li key={n.id} className="flex flex-wrap justify-between gap-2 py-2">
          <Link href={notePath(n.number)} className="underline underline-offset-4">
            {noteRef(n.number)} {n.title}
          </Link>
          <span className="text-muted-foreground">
            {n.ownerName} · {n.when}
          </span>
        </li>
      ))}
    </ul>
  );
}
