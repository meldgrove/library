import { FileUp, ListFilter, Search, X } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SearchForm } from "@/components/form/search-form";
import { NoteList } from "@/components/library/note-list";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { getFormatter, requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { viewerOf } from "@/lib/library/access";
import { filterOptions, listNotes } from "@/lib/library/notes";

export const metadata: Metadata = { title: "Library" };

const PAGE_SIZE = 25;
const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
const uuid = (value: string | undefined) => (value && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined);

export default async function LibraryPage({ searchParams }: PageProps<"/">) {
  // Layouts are not re-rendered on every navigation, so each page checks access.
  const { person } = await requireUser();
  const params = await searchParams;
  const page = Math.max(1, Number(one(params.page)) || 1);
  const filters = {
    q: one(params.q)?.slice(0, 200),
    tagId: uuid(one(params.tag)),
    documentTypeId: uuid(one(params.type)),
    projectId: uuid(one(params.project)),
    teamId: uuid(one(params.team)),
  };
  const db = getDb();
  const [fmt, { notes, total }, options] = await Promise.all([
    getFormatter(),
    listNotes(db, viewerOf(person), { ...filters, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    filterOptions(db),
  ]);
  const filtered = Object.values(filters).some(Boolean);
  const pageHref = (target: number) => {
    const query = new URLSearchParams(Object.entries({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, one(v) ?? ""])), page: String(target) }).filter(([, v]) => v));
    return `/?${query}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Library"
        description="Studies, reports, and articles colleagues found useful, each with a checked summary."
        actions={
          <Button asChild>
            <Link href="/upload">
              <FileUp aria-hidden="true" />
              Add to library
            </Link>
          </Button>
        }
      />
      <SearchForm action="/" role="search" aria-label="Search the library" className="flex flex-col gap-3">
        <div className="flex gap-2">
          <InputGroup className="h-10 flex-1">
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput name="q" defaultValue={filters.q} placeholder="Search titles, summaries, quotes, and tags" aria-label="Search" />
          </InputGroup>
          <Button type="submit" className="h-10">
            Search
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ListFilter aria-hidden="true" className="size-4 text-muted-foreground" />
          <NativeSelect name="tag" defaultValue={filters.tagId ?? ""} aria-label="Tag" size="sm">
            <NativeSelectOption value="">All tags</NativeSelectOption>
            {options.tags.map((t) => (
              <NativeSelectOption key={t.id} value={t.id}>
                {t.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <NativeSelect name="type" defaultValue={filters.documentTypeId ?? ""} aria-label="Document type" size="sm">
            <NativeSelectOption value="">All types</NativeSelectOption>
            {options.types.map((t) => (
              <NativeSelectOption key={t.id} value={t.id}>
                {t.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {options.projects.length > 0 ? (
            <NativeSelect name="project" defaultValue={filters.projectId ?? ""} aria-label="Project" size="sm">
              <NativeSelectOption value="">All projects</NativeSelectOption>
              {options.projects.map((p) => (
                <NativeSelectOption key={p.id} value={p.id}>
                  {p.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : null}
          {options.teams.length > 0 ? (
            <NativeSelect name="team" defaultValue={filters.teamId ?? ""} aria-label="Team" size="sm">
              <NativeSelectOption value="">All teams</NativeSelectOption>
              {options.teams.map((t) => (
                <NativeSelectOption key={t.id} value={t.id}>
                  {t.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : null}
          {filtered ? (
            <Button asChild variant="ghost" size="sm">
              <Link href="/">
                <X aria-hidden="true" />
                Clear
              </Link>
            </Button>
          ) : null}
        </div>
      </SearchForm>

      {notes.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>{filtered ? "No notes match" : "No published notes yet"}</EmptyTitle>
            <EmptyDescription>
              {filtered ? "Try other words or fewer filters." : "Add a study, report, or article; its note appears here once you publish it."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {total === 1 ? "1 note" : `${total} notes`}
            {filtered ? " match" : ""}
          </p>
          <NoteList notes={notes} fmt={fmt} />
          {total > PAGE_SIZE ? (
            <nav aria-label="Pages" className="flex items-center justify-between text-sm">
              {page > 1 ? <Link href={pageHref(page - 1)} className="underline underline-offset-4">Newer</Link> : <span />}
              <span className="text-muted-foreground">
                Page {page} of {Math.ceil(total / PAGE_SIZE)}
              </span>
              {page * PAGE_SIZE < total ? <Link href={pageHref(page + 1)} className="underline underline-offset-4">Older</Link> : <span />}
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}
