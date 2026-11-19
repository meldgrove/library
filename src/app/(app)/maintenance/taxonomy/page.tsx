import { Badge } from "@meldgrove/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@meldgrove/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@meldgrove/ui/table";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionButton } from "@/components/admin/directory-forms";
import { NameForm } from "@/components/form/name-forms";
import { EntryForm, ProposalForm, TagForm } from "@/components/library/taxonomy-forms";
import { PageHeader } from "@/components/page-header";
import { requireMaintainer } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { notePath, noteRef } from "@/lib/library/constants";
import { viewerOf } from "@/lib/library/access";
import { getTaxonomy } from "@/lib/library/taxonomy";
import type { FormState } from "@/lib/form-state";
import {
  acceptTagProposalAction,
  createClusterAction,
  createDocumentTypeAction,
  createTagAction,
  createTopicAreaAction,
  deleteClusterAction,
  rejectTagProposalAction,
  renameClusterAction,
  setDocumentTypeActiveAction,
  setTagActiveAction,
  setTopicAreaActiveAction,
  updateDocumentTypeAction,
  updateTagAction,
  updateTopicAreaAction,
} from "./actions";

export const metadata: Metadata = { title: "Taxonomy" };

/**
 * The closed lists the AI model picks from. Entries on notes are never
 * deleted: a deactivated tag stays on its notes but is no longer offered.
 * Clusters only group tags, so they can be deleted.
 */
export default async function TaxonomyPage() {
  const { person } = await requireMaintainer();
  const taxonomy = await getTaxonomy(getDb(), viewerOf(person));
  const activeTags = taxonomy.tags.filter((t) => t.isActive);
  const clusterName = new Map(taxonomy.clusters.map((cluster) => [cluster.id, cluster.name]));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Taxonomy"
        description="Tags, topic areas, and document types the AI model chooses from. New tags come only from here or from accepted proposals."
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

      <Card role="region" aria-labelledby="clusters">
        <CardHeader>
          <CardTitle>
            <h2 id="clusters">Clusters</h2>
          </CardTitle>
          <CardDescription>Groups of tags, for the forms, the weekly digest, and the AI model. Deleting a cluster keeps its tags, without a cluster.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <NameForm action={createClusterAction} id="new-cluster" label="New cluster" submitLabel="Add cluster" clearOnSuccess />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cluster</TableHead>
                <TableHead className="text-right">Tags</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {taxonomy.clusters.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-muted-foreground">
                    No clusters yet.
                  </TableCell>
                </TableRow>
              ) : (
                taxonomy.clusters.map((cluster) => (
                  <TableRow key={cluster.id}>
                    <TableCell>
                      <NameForm action={renameClusterAction.bind(null, cluster.id)} id={`cluster-${cluster.id}`} label={`Name of the cluster ${cluster.name}`} defaultValue={cluster.name} submitLabel="Save" />
                    </TableCell>
                    <TableCell className="text-right">{cluster.tags}</TableCell>
                    <TableCell>
                      <ActionButton action={deleteClusterAction.bind(null, cluster.id)} label="Delete" />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <EntryCard
        id="topic-areas"
        title="Topic areas"
        kind="Topic area"
        description="The one area a note is mainly about, besides its tags. The library can be filtered by it. The description tells the AI model what an area covers."
        rows={taxonomy.topicAreas.map((area) => ({
          ...area,
          update: updateTopicAreaAction.bind(null, area.id),
          toggle: setTopicAreaActiveAction.bind(null, area.id, !area.isActive),
        }))}
        create={createTopicAreaAction}
      />

      <EntryCard
        id="types"
        title="Document types"
        kind="Document type"
        description="What kind of source a note is about. The description tells the AI model what a type covers."
        rows={taxonomy.types.map((type) => ({
          ...type,
          update: updateDocumentTypeAction.bind(null, type.id),
          toggle: setDocumentTypeActiveAction.bind(null, type.id, !type.isActive),
        }))}
        create={createDocumentTypeAction}
      />
    </div>
  );
}

type Action = (state: FormState, formData: FormData) => Promise<FormState>;

/** A list of document types or topic areas: name and description, how many notes use each, and whether it is offered. */
function EntryCard({
  id,
  title,
  kind,
  description,
  create,
  rows,
}: {
  id: string;
  title: string;
  kind: string;
  description: string;
  create: Action;
  rows: { id: string; name: string; description: string; isActive: boolean; notes: number; update: Action; toggle: Action }[];
}) {
  return (
    <Card role="region" aria-labelledby={id}>
      <CardHeader>
        <CardTitle>
          <h2 id={id}>{title}</h2>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <EntryForm action={create} kind={kind} submitLabel={`Add ${kind.toLowerCase()}`} clearOnSuccess />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{kind}</TableHead>
              <TableHead className="text-right">Notes</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground">
                  None yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <EntryForm action={row.update} kind={kind} defaults={{ name: row.name, description: row.description }} submitLabel="Save" />
                  </TableCell>
                  <TableCell className="text-right">{row.notes}</TableCell>
                  <TableCell>
                    <Badge variant={row.isActive ? "secondary" : "outline"}>{row.isActive ? "Active" : "Inactive"}</Badge>
                  </TableCell>
                  <TableCell>
                    <ActionButton action={row.toggle} label={row.isActive ? "Deactivate" : "Activate"} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
