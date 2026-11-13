import { ExternalLink, FileText, Quote, ShieldCheck, Sparkles, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DateFormatter } from "@/lib/format";
import { VISIBILITY_LABELS } from "@/lib/library/constants";
import type { NoteDetail } from "@/lib/library/notes";
import { formatBytes, NOTE_STATUS_LABELS } from "./labels";

const FIELD_LABELS: Record<string, string> = {
  title: "title",
  core: "core",
  keyPoints: "key points",
  quotes: "quotes",
  citation: "citation",
  language: "language",
  documentType: "document type",
  project: "project",
  tags: "tags",
  visibility: "visibility",
};

/** Where the original is: a stored file or a link. */
export function OriginalLink({ detail }: { detail: NoteDetail }) {
  const { source } = detail;
  return (
    <div className="flex flex-col gap-1 text-sm">
      {source.storageKey ? (
        <a href={`/api/originals/${source.id}`} className="inline-flex items-start gap-1.5 break-words underline underline-offset-4" target="_blank" rel="noopener">
          <FileText aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {source.fileName ?? "Original file"}
          {source.sizeBytes ? <span className="whitespace-nowrap text-muted-foreground"> ({formatBytes(source.sizeBytes)})</span> : null}
        </a>
      ) : null}
      {source.url ? (
        <a href={source.url} className="inline-flex items-center gap-1.5 break-all underline underline-offset-4" target="_blank" rel="noopener noreferrer">
          <ExternalLink aria-hidden="true" className="size-4 shrink-0" />
          {source.url}
        </a>
      ) : null}
      {source.doi ? <span className="text-muted-foreground">DOI {source.doi}</span> : null}
    </div>
  );
}

/** The steward's mark on a note, in the list and on the note's page. */
export function CheckedBadge() {
  return (
    <Badge variant="outline" className="border-emerald-600/30 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
      <ShieldCheck aria-hidden="true" />
      Checked by a steward
    </Badge>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/** A note as it reads once published; also the read-only view of a draft. */
export function NoteView({ detail, fmt }: { detail: NoteDetail; fmt: DateFormatter }) {
  const { note } = detail;
  const uncertain = note.uncertainFields.map((field) => FIELD_LABELS[field] ?? field);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={note.status === "published" ? "secondary" : "outline"}>{NOTE_STATUS_LABELS[note.status]}</Badge>
        <Badge variant="outline">{VISIBILITY_LABELS[note.visibility]}</Badge>
        {detail.documentTypeName ? <Badge variant="outline">{detail.documentTypeName}</Badge> : null}
        {note.checkedAt ? <CheckedBadge /> : null}
        <span className="text-muted-foreground">
          {detail.ownerName}
          {detail.teamName ? ` · ${detail.teamName}` : ""}
          {note.publishedAt ? ` · published ${fmt.day(note.publishedAt)}` : ` · drafted ${fmt.day(note.draftedAt)}`}
        </span>
      </div>

      {note.status === "draft" && uncertain.length > 0 ? (
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          The AI model was unsure about: {uncertain.join(", ")}. Check these against the original.
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem] lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          <section aria-labelledby="core">
            <h2 id="core" className="sr-only">
              Core
            </h2>
            <p className="text-lg leading-relaxed text-pretty">{note.core}</p>
          </section>

          <Card className="gap-4">
            <CardHeader>
              <CardTitle>
                <h2>Key points</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-2.5 text-sm">
                {note.keyPoints.map((point, index) => (
                  <li key={index} className="flex gap-3">
                    <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-primary/70" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          {note.quotes.length > 0 ? (
            <Card className="gap-4">
              <CardHeader>
                <CardTitle>
                  <h2>Quotes</h2>
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {note.quotes.map((quote, index) => (
                  <blockquote key={index} className="flex gap-3 text-sm">
                    <Quote aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span>
                      <span className="italic">{quote.text}</span>
                      {quote.location ? <span className="text-muted-foreground"> ({quote.location})</span> : null}
                    </span>
                  </blockquote>
                ))}
              </CardContent>
            </Card>
          ) : null}

          {detail.reasons.length > 0 ? (
            <section aria-labelledby="reasons" className="flex flex-col gap-2">
              <h2 id="reasons" className="text-sm font-medium">
                Who added it and why
              </h2>
              <ul className="flex flex-col gap-1 text-sm">
                {detail.reasons.map((reason) => (
                  <li key={reason.id}>
                    <span className="font-medium">{reason.personName}</span>
                    <span className="text-muted-foreground"> · {fmt.day(reason.createdAt)}: </span>
                    {reason.reason}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Sparkles aria-hidden="true" className="mt-px size-3.5 shrink-0" />
            <span>
              Drafted by an AI model{note.draftModel ? ` (${note.draftModel})` : ""}
              {note.confirmedAt ? ` and confirmed by its owner on ${fmt.day(note.confirmedAt)}` : ""}. Check important details against the original.
            </span>
          </p>
        </div>

        <aside aria-label="Details" className="rounded-xl border bg-muted/30 p-4">
          <dl className="flex flex-col gap-4">
            <Detail label="Original">
              <OriginalLink detail={detail} />
            </Detail>
            <Detail label="Citation">{note.citation || "—"}</Detail>
            <Detail label="Tags">
              <span className="flex flex-wrap gap-1.5">
                {detail.tags.length === 0 ? "—" : null}
                {detail.tags.map((t) => (
                  <Badge key={t.id} variant="secondary">
                    <Link href={`/?tag=${t.id}`}>{t.name}</Link>
                  </Badge>
                ))}
              </span>
            </Detail>
            {detail.projectName ? <Detail label="Project">{detail.projectName}</Detail> : null}
            <Detail label="Language">{note.language ? note.language.toUpperCase() : "—"}</Detail>
          </dl>
        </aside>
      </div>
    </div>
  );
}
