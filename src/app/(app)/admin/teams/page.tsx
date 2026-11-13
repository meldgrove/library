import type { Metadata } from "next";
import { DigestChannelForm } from "@/components/admin/digest-channel-form";
import { ActionButton } from "@/components/admin/directory-forms";
import { NameForm } from "@/components/form/name-forms";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireAdmin } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { getDirectory } from "@/lib/directory/directory";
import { listTeams } from "@/lib/directory/queries";
import { TEAM_NAME_MAX } from "@/lib/directory/schemas";
import { createTeamAction, renameTeamAction, setTeamActiveAction } from "../directory-actions";
import { setTeamDigestChannelAction } from "./actions";

export const metadata: Metadata = { title: "Teams" };

/** Teams own entries. They are never deleted, only deactivated. */
export default async function TeamsPage() {
  await requireAdmin();
  const editable = getDirectory().editable;
  const teams = await listTeams(getDb());
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader
        title="Teams"
        description={
          editable
            ? "Teams are never deleted. A deactivated team stays on existing entries but cannot be chosen for new ones."
            : "Teams come from Keycloak: every subgroup of the teams group. Change them there."
        }
      />
      {editable ? (
        <Card role="region" aria-labelledby="new-team">
          <CardHeader>
            <CardTitle>
              <h2 id="new-team">New team</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <NameForm action={createTeamAction} id="new-team-name" label="Name of the new team" submitLabel="Add team" maxLength={TEAM_NAME_MAX} clearOnSuccess />
          </CardContent>
        </Card>
      ) : null}
      <p className="text-sm text-muted-foreground">
        Weekly digest: each team can get its new notes (for everyone or for the team) every Monday in a Slack channel. Enter the channel&apos;s ID (in Slack:
        the channel&apos;s details, at the bottom), add the Slack app to the channel, and choose a channel only the team is in.
      </p>
      <Card className="py-2">
        <CardContent className="px-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">People</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Digest channel</TableHead>
                {editable ? (
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {teams.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground">
                    No teams yet.
                  </TableCell>
                </TableRow>
              ) : (
                teams.map((team) => (
                  <TableRow key={team.id}>
                    <TableCell>
                      {editable ? (
                        <NameForm
                          action={renameTeamAction.bind(null, team.id)}
                          id={`team-${team.id}`}
                          label={`Rename ${team.name}`}
                          defaultValue={team.name}
                          submitLabel="Rename"
                          maxLength={TEAM_NAME_MAX}
                        />
                      ) : (
                        <span className="font-medium">{team.name}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{team.members}</TableCell>
                    <TableCell>
                      <Badge variant={team.isActive ? "secondary" : "outline"}>{team.isActive ? "Active" : "Inactive"}</Badge>
                    </TableCell>
                    <TableCell>
                      <DigestChannelForm
                        action={setTeamDigestChannelAction.bind(null, team.id)}
                        id={`digest-${team.id}`}
                        teamName={team.name}
                        defaultValue={team.digestSlackChannelId}
                      />
                    </TableCell>
                    {editable ? (
                      <TableCell>
                        <ActionButton action={setTeamActiveAction.bind(null, team.id, !team.isActive)} label={team.isActive ? "Deactivate" : "Activate"} />
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
