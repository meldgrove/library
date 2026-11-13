import type { Metadata } from "next";
import Link from "next/link";
import { ActionButton } from "@/components/admin/directory-forms";
import { NameForm } from "@/components/form/name-forms";
import { ProposalForm, TagForm } from "@/components/library/taxonomy-forms";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireAdmin } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { notePath, noteRef } from "@/lib/library/constants";
import { getTaxonomy } from "@/lib/library/taxonomy";
import {
  acceptTagProposalAction,
  createClusterAction,
  createDocumentTypeAction,
  createProjectAction,
  createTagAction,
  rejectTagProposalAction,
  setDocumentTypeActiveAction,
  setProjectActiveAction,
  setTagActiveAction,
  updateTagAction,
} from "./actions";

export const metadata: Metadata = { title: "Taxonomy" };

/**
 * The closed lists the AI model picks from. Entries are never deleted: a
 * deactivated tag stays on its notes but is no longer offered.
 */
export default async function TaxonomyPage() {
  await requireAdmin();
  const taxonomy = await getTaxonomy(getDb());
  const activeTags = taxonomy.tags.filter((t) => t.isActive);
  const clusterName = new Map(taxonomy.clusters.map((cluster) => [cluster.id, cluster.name]));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Taxonomy"
        description="Tags, document types, and projects the AI model chooses from. New tags come only from here or from accepted proposals."
      />

      <Card role="region" aria-labelledby="proposals">
        <CardHeader>
          <CardTitle>
            <h2 id="proposals">Tag proposals</h2>
          </CardTitle>
          <CardDescription>Tags the AI model wanted that are not in the list. Accept one as a new tag, map it to an existing tag, or reject it.</CardDescription>
        </CardHeader>
        <CardContent>
          {taxonomy.proposals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No open proposals.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Proposed tag</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead>Decision</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {taxonomy.proposals.map((proposal) => (
                  <TableRow key={proposal.id}>
                    <TableCell className="font-medium">{proposal.name}</TableCell>
                    <TableCell className="max-w-64 whitespace-normal">
                      {proposal.noteNumber ? (
                        <Link href={notePath(proposal.noteNumber)} className="underline underline-offset-4">
                          {noteRef(proposal.noteNumber)} {proposal.noteTitle}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-start gap-2">
                        <ProposalForm action={acceptTagProposalAction.bind(null, proposal.id)} name={proposal.name} clusters={taxonomy.clusters} tags={activeTags} />
                        <ActionButton action={rejectTagProposalAction.bind(null, proposal.id)} label="Reject" variant="outline" />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card role="region" aria-labelledby="tags">
        <CardHeader>
          <CardTitle>
            <h2 id="tags">Tags</h2>
          </CardTitle>
          <CardDescription>
            Each note gets 2 to 5 tags. The description tells the AI model what a tag covers. Import a whole list with{" "}
            <code>npm run taxonomy:import</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <TagForm action={createTagAction} clusters={taxonomy.clusters} submitLabel="Add tag" clearOnSuccess />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tag</TableHead>
                <TableHead className="text-right">Notes</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {taxonomy.tags.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    No tags yet.
                  </TableCell>
                </TableRow>
              ) : (
                taxonomy.tags.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>
                      <TagForm
                        action={updateTagAction.bind(null, t.id)}
                        clusters={taxonomy.clusters}
                        defaults={{ name: t.name, description: t.description, clusterId: t.clusterId }}
                        submitLabel="Save"
                      />
                      {t.clusterId ? <span className="sr-only">Cluster {clusterName.get(t.clusterId)}</span> : null}
                    </TableCell>
                    <TableCell className="text-right">{t.notes}</TableCell>
                    <TableCell>
                      <Badge variant={t.isActive ? "secondary" : "outline"}>{t.isActive ? "Active" : "Inactive"}</Badge>
                    </TableCell>
                    <TableCell>
                      <ActionButton action={setTagActiveAction.bind(null, t.id, !t.isActive)} label={t.isActive ? "Deactivate" : "Activate"} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <ListCard
          id="clusters"
          title="Clusters"
          description="Groups of tags, for the steward and the AI model."
          create={<NameForm action={createClusterAction} id="new-cluster" label="New cluster" submitLabel="Add" clearOnSuccess />}
          rows={taxonomy.clusters.map((cluster) => ({ id: cluster.id, name: cluster.name }))}
        />
        <ListCard
          id="types"
          title="Document types"
          description="What kind of source a note is about."
          create={<NameForm action={createDocumentTypeAction} id="new-type" label="New document type" submitLabel="Add" clearOnSuccess />}
          rows={taxonomy.types.map((t) => ({
            id: t.id,
            name: t.name,
            isActive: t.isActive,
            toggle: <ActionButton action={setDocumentTypeActiveAction.bind(null, t.id, !t.isActive)} label={t.isActive ? "Deactivate" : "Activate"} />,
          }))}
        />
        <ListCard
          id="projects"
          title="Projects"
          description="Programs and projects a note can belong to."
          create={<NameForm action={createProjectAction} id="new-project" label="New project" submitLabel="Add" clearOnSuccess />}
          rows={taxonomy.projects.map((p) => ({
            id: p.id,
            name: p.name,
            isActive: p.isActive,
            toggle: <ActionButton action={setProjectActiveAction.bind(null, p.id, !p.isActive)} label={p.isActive ? "Deactivate" : "Activate"} />,
          }))}
        />
      </div>
    </div>
  );
}

function ListCard({
  id,
  title,
  description,
  create,
  rows,
}: {
  id: string;
  title: string;
  description: string;
  create: React.ReactNode;
  rows: { id: string; name: string; isActive?: boolean; toggle?: React.ReactNode }[];
}) {
  return (
    <Card role="region" aria-labelledby={id}>
      <CardHeader>
        <CardTitle>
          <h2 id={id}>{title}</h2>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {create}
        <ul className="flex flex-col divide-y text-sm">
          {rows.length === 0 ? <li className="py-2 text-muted-foreground">None yet.</li> : null}
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-2 py-1.5">
              <span className={row.isActive === false ? "text-muted-foreground line-through" : undefined}>{row.name}</span>
              {row.toggle}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
