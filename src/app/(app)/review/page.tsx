import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { getFormatter, requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { notePath, noteRef } from "@/lib/library/constants";
import { listMyDrafts } from "@/lib/library/review";

export const metadata: Metadata = { title: "My review" };

export default async function ReviewPage() {
  const { person } = await requireUser();
  const [fmt, drafts] = await Promise.all([getFormatter(), listMyDrafts(getDb(), person.id)]);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="My review" description="AI drafts of your uploads. Check each against its original, then publish or discard it." />
      {drafts.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>Nothing to review</EmptyTitle>
            <EmptyDescription>New drafts appear here a minute or two after you add something.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {drafts.map((draft) => (
            <li key={draft.id} className="flex flex-wrap items-center justify-between gap-2 p-4">
              <Link href={notePath(draft.number)} className="font-medium underline-offset-4 hover:underline">
                <span className="text-muted-foreground">{noteRef(draft.number)}</span> {draft.title}
              </Link>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                {draft.uncertainFields.length > 0 ? <Badge variant="outline">{draft.uncertainFields.length} fields to check</Badge> : null}
                drafted {fmt.day(draft.draftedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
