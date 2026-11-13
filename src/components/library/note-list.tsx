import { BookOpen, FileText, Globe, Landmark, Newspaper, Presentation, ScrollText, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { CheckedBadge } from "@/components/library/note-view";
import { Badge } from "@/components/ui/badge";
import type { DateFormatter } from "@/lib/format";
import { notePath, noteRef, VISIBILITY_LABELS, type Visibility } from "@/lib/library/constants";

export interface NoteListItem {
  id: string;
  number: number;
  title: string;
  core: string;
  visibility: Visibility;
  publishedAt: Date | null;
  checkedAt?: Date | null;
  ownerName: string;
  teamName: string | null;
  documentTypeName: string | null;
  tags: { id: string; name: string }[];
}

/** An icon for the default document types; anything else is a page. */
const TYPE_ICONS: Record<string, LucideIcon> = {
  study: ScrollText,
  report: FileText,
  article: Newspaper,
  "policy paper": Landmark,
  "funder guideline": Landmark,
  book: BookOpen,
  presentation: Presentation,
  website: Globe,
};

/** Published notes as a list: title, core, and what the note is about. */
export function NoteList({ notes, fmt }: { notes: NoteListItem[]; fmt: DateFormatter }) {
  return (
    <ul className="flex flex-col gap-3">
      {notes.map((item) => {
        const Icon = TYPE_ICONS[item.documentTypeName?.toLowerCase() ?? ""] ?? FileText;
        return (
          <li key={item.id} className="group relative flex gap-4 rounded-xl border bg-card p-4 shadow-xs transition-colors hover:border-foreground/20 hover:bg-accent/40">
            <span aria-hidden="true" className="hidden size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground sm:flex">
              <Icon className="size-5" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <Link href={notePath(item.number)} className="font-medium leading-snug after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none">
                  {item.title}
                </Link>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {noteRef(item.number)} · {fmt.day(item.publishedAt)}
                </span>
              </div>
              <p className="line-clamp-2 text-sm text-muted-foreground">{item.core}</p>
              <div className="relative flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                {item.documentTypeName ? <Badge variant="outline">{item.documentTypeName}</Badge> : null}
                {item.tags.map((t) => (
                  <Badge key={t.id} variant="secondary" asChild>
                    <Link href={`/?tag=${t.id}`} className="relative z-10 hover:bg-secondary/70">
                      {t.name}
                    </Link>
                  </Badge>
                ))}
                {item.visibility !== "all" ? <Badge variant="outline">{VISIBILITY_LABELS[item.visibility]}</Badge> : null}
                {item.checkedAt ? <CheckedBadge /> : null}
                <span className="ml-auto">
                  {item.ownerName}
                  {item.teamName ? ` · ${item.teamName}` : ""}
                </span>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
