import type { Metadata } from "next";
import Link from "next/link";
import { submissionBadgeVariant, SUBMISSION_STATUS_LABELS } from "@/components/library/labels";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getFormatter, requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { notePath, noteRef } from "@/lib/library/constants";
import { listMySubmissions } from "@/lib/library/submissions";

export const metadata: Metadata = { title: "My uploads" };

export default async function UploadsPage({ searchParams }: PageProps<"/uploads">) {
  const { person } = await requireUser();
  const [fmt, rows, params] = await Promise.all([getFormatter(), listMySubmissions(getDb(), person.id), searchParams]);
  const waiting = rows.some((row) => row.status === "received" || row.status === "processing");
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="My uploads"
        description="Everything you added, and what became of it. Drafts wait for your review."
        actions={
          <Button asChild>
            <Link href="/upload">Add to library</Link>
          </Button>
        }
      />
      {params.added ? (
        <Alert>
          <AlertDescription>
            Thanks. The AI draft usually takes a minute or two; you get a Slack message when it is ready.
          </AlertDescription>
        </Alert>
      ) : null}
      {rows.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No uploads yet</EmptyTitle>
            <EmptyDescription>Add a study, report, or article you found useful.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card className="py-2">
          <CardContent className="px-2">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Added</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap">{fmt.dateTime(row.createdAt)}</TableCell>
                    <TableCell className="max-w-80 whitespace-normal">
                      <span className="font-medium">{row.detectedTitle ?? row.fileName ?? row.url}</span>
                      {row.reason ? <span className="block text-xs text-muted-foreground">{row.reason}</span> : null}
                    </TableCell>
                    <TableCell className="max-w-72 whitespace-normal">
                      <Badge variant={submissionBadgeVariant(row.status)}>{SUBMISSION_STATUS_LABELS[row.status]}</Badge>
                      {row.statusReason && row.status !== "drafted" ? (
                        <span className="mt-1 block text-xs text-muted-foreground">{row.statusReason}</span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {row.noteNumber ? (
                        <Link href={notePath(row.noteNumber)} className="underline underline-offset-4">
                          {noteRef(row.noteNumber)}
                          {row.noteStatus === "draft" ? " · review" : ""}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      {waiting ? <p className="text-sm text-muted-foreground">Reload the page to see new drafts.</p> : null}
    </div>
  );
}
