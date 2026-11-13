import { CircleAlert, Tags, Users, UsersRound } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getFormatter, requireAdmin } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { getDirectory } from "@/lib/directory/directory";
import { getDirectoryStatus } from "@/lib/directory/queries";
import { notePath } from "@/lib/library/constants";
import { countOpenSubmissions } from "@/lib/library/submissions";
import { countPendingCleanups } from "@/lib/library/originals";
import { openProblemCount } from "@/lib/library/pipeline";
import { getWebhookStatus } from "@/lib/webhook/sync";
import { getNotificationStatus } from "@/lib/notifications/queries";
import type { ChannelMode } from "@/lib/notifications/types";
import { SyncNowForm } from "./sync-now-form";

export const metadata: Metadata = { title: "Admin" };

const CHANNEL_LABELS = { slack: "Slack direct messages", slack_channel: "Slack channel posts", email: "Email", email_address: "Email to a list" } as const;

export default async function AdminPage() {
  await requireAdmin();
  const fmt = await getFormatter();
  const sync = getDirectory().sync;
  const [status, notifications, openUploads, problems, webhook, pendingCleanups] = await Promise.all([
    getDirectoryStatus(getDb()),
    getNotificationStatus(getDb()),
    countOpenSubmissions(getDb()),
    openProblemCount(getDb()),
    getWebhookStatus(getDb()),
    countPendingCleanups(getDb()),
  ]);
  const channels = status.workerHeartbeat?.channels;
  const lastRun = status.recentRuns[0];
  const heartbeatAt = status.workerHeartbeat?.beatAt;
  const workerHealthy = status.workerHealthy;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Admin"
        description="The worker, people and teams, notifications, and the webhook."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/admin/people">
                <Users aria-hidden="true" />
                People
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/admin/teams">
                <UsersRound aria-hidden="true" />
                Teams
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/admin/taxonomy">
                <Tags aria-hidden="true" />
                Taxonomy
              </Link>
            </Button>
          </div>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{sync ? "Directory sync" : "Directory"}</h2>
          </CardTitle>
          <CardDescription>
            {sync
              ? `People and teams come from Keycloak every 15 minutes. Members of ${sync.accessGroup} have access.`
              : "People and teams are managed in the library. Admins invite people on the People page."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Fact label="People with access" value={String(status.peopleWithAccess)} />
            <Fact label="Active teams" value={String(status.activeTeams)} />
            {sync ? <Fact label="Last successful sync" value={fmt.dateTime(status.lastSuccessfulRun?.finishedAt)} /> : null}
            <Fact
              label="Worker"
              value={
                <span className="flex items-center gap-2">
                  <Badge variant={workerHealthy ? "secondary" : "destructive"}>
                    {workerHealthy ? "Running" : "No heartbeat"}
                  </Badge>
                  <span className="text-muted-foreground">{fmt.dateTime(heartbeatAt)}</span>
                </span>
              }
            />
          </dl>

          {sync && lastRun?.status === "failed" ? (
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertDescription>
                The last sync failed: {lastRun.error}. The library keeps the previous access list.
              </AlertDescription>
            </Alert>
          ) : null}

          {sync ? <SyncNowForm /> : null}

          {sync ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">People</TableHead>
                  <TableHead className="text-right">Access granted</TableHead>
                  <TableHead className="text-right">Access removed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {status.recentRuns.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-muted-foreground">
                      No sync has run yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  status.recentRuns.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell>{fmt.dateTime(run.startedAt)}</TableCell>
                      <TableCell>{run.trigger}</TableCell>
                      <TableCell>
                        <Badge variant={run.status === "failed" ? "destructive" : "secondary"}>{run.status}</Badge>
                      </TableCell>
                      <TableCell className="text-right">{run.peopleReceived ?? "—"}</TableCell>
                      <TableCell className="text-right">{run.accessGranted ?? "—"}</TableCell>
                      <TableCell className="text-right">{run.accessRemoved ?? "—"}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Notifications</h2>
          </CardTitle>
          <CardDescription>
            Uploaders get Slack direct messages about their drafts; stewards get emails about uploads on hold. When one
            channel is off or cannot reach a person, the message goes out on the other. Each message goes out once.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            <Fact label="Slack" value={<ChannelBadge mode={channels?.slack} variable="SLACK_BOT_TOKEN" />} />
            <Fact label="Email" value={<ChannelBadge mode={channels?.email} variable="SMTP_URL or MAILERSEND_API_TOKEN, and MAIL_FROM," />} />
          </dl>

          {notifications.failedTotal > 0 ? (
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertDescription>
                {notifications.failedTotal === 1 ? "1 message" : `${notifications.failedTotal} messages`} could not be sent
                after 5 attempts in the last 30 days. The latest are listed below.
              </AlertDescription>
            </Alert>
          ) : null}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Last 7 days</TableHead>
                <TableHead className="text-right">Sent</TableHead>
                <TableHead className="text-right">Skipped</TableHead>
                <TableHead className="text-right">Failed</TableHead>
                <TableHead className="text-right">Waiting</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(["slack", "slack_channel", "email"] as const).map((channel) => {
                const totals = notifications.lastWeek[channel];
                return (
                  <TableRow key={channel}>
                    <TableCell>{CHANNEL_LABELS[channel]}</TableCell>
                    <TableCell className="text-right">{totals.sent}</TableCell>
                    <TableCell className="text-right">{totals.skipped}</TableCell>
                    <TableCell className="text-right">{totals.failed}</TableCell>
                    <TableCell className="text-right">{totals.pending}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          {notifications.failed.length > 0 ? (
            <section aria-labelledby="failed-messages" className="flex flex-col gap-2">
              <h3 id="failed-messages" className="text-sm font-medium">
                Latest failed messages
              </h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Created</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead>Recipient</TableHead>
                    <TableHead>Message</TableHead>
                    <TableHead>Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {notifications.failed.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{fmt.dateTime(row.createdAt)}</TableCell>
                      <TableCell>{CHANNEL_LABELS[row.channel]}</TableCell>
                      <TableCell>{row.recipientName ?? "Slack channel"}</TableCell>
                      <TableCell>
                        <Link className="underline underline-offset-2" href={row.noteNumber ? notePath(row.noteNumber) : "/"}>
                          {row.subject}
                        </Link>
                      </TableCell>
                      <TableCell className="whitespace-normal text-muted-foreground">{row.lastError}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          ) : null}

          {channels?.slack === "live" ? (
            <section aria-labelledby="without-slack" className="flex flex-col gap-2">
              <h3 id="without-slack" className="text-sm font-medium">
                People without a Slack account
              </h3>
              <p className="text-sm text-muted-foreground">
                No Slack user matches their email address, so they get emails instead. The library looks again after a week.
              </p>
              {notifications.withoutSlack.length === 0 ? (
                <p className="text-sm">Everyone was found in Slack.</p>
              ) : (
                <ul className="flex flex-col gap-1 text-sm">
                  {notifications.withoutSlack.map((p) => (
                    <li key={p.id}>
                      {p.displayName}
                      <span className="text-muted-foreground">
                        {" "}
                        · {p.workEmail ?? "no email address"} · since {fmt.dateTime(p.since)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Uploads</h2>
          </CardTitle>
          <CardDescription>
            The worker extracts the text of each upload, screens it, checks for duplicates, and has the AI model draft
            a note. Uploads on hold wait for a steward.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            <Fact label="Waiting for the worker" value={String(openUploads)} />
            <Fact
              label="On hold (quarantined or parked)"
              value={problems > 0 ? <Badge variant="destructive">{problems}</Badge> : "0"}
            />
            <Fact label="Originals waiting for deletion" value={String(pendingCleanups)} />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Webhook</h2>
          </CardTitle>
          <CardDescription>
            Published notes that are not private go to the webhook within a minute of each change, for example to a search
            index or an AI assistant; deleted, discarded, and private ones are sent as removed. A nightly run compares
            everything again.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Fact label="Webhook" value={<ChannelBadge mode={channels?.webhook} variable="WEBHOOK_URL and WEBHOOK_SECRET" />} />
            <Fact label="Notes delivered" value={String(webhook.delivered)} />
            <Fact label="Waiting" value={String(webhook.waiting)} />
            <Fact label="Last sent" value={fmt.dateTime(webhook.lastDeliveredAt)} />
          </dl>
          {webhook.failingCount > 0 ? (
            <section aria-labelledby="webhook-failures" className="flex flex-col gap-2">
              <h3 id="webhook-failures" className="text-sm font-medium">
                Notes that could not be sent
              </h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Note</TableHead>
                    <TableHead className="text-right">Attempts</TableHead>
                    <TableHead>Next attempt</TableHead>
                    <TableHead>Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {webhook.failing.map((row) => (
                    <TableRow key={row.noteId}>
                      <TableCell>{row.number ? <Link className="underline underline-offset-2" href={notePath(row.number)}>{row.title}</Link> : "A private or deleted note"}</TableCell>
                      <TableCell className="text-right">{row.attempts}</TableCell>
                      <TableCell>{fmt.dateTime(row.nextAttemptAt)}</TableCell>
                      <TableCell className="whitespace-normal text-muted-foreground">{row.lastError}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Admins</h2>
          </CardTitle>
          <CardDescription>
            {sync
              ? `Members of ${sync.adminGroup} in Keycloak are admins, the library's stewards. Change them in Keycloak.`
              : "Admins are the library's stewards: they maintain the taxonomy, decide uploads on hold, and delete notes. Change them on the People page."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-1 text-sm">
            {status.admins.map((admin) => (
              <li key={admin.id}>
                {admin.displayName}
                {admin.workEmail ? <span className="text-muted-foreground"> · {admin.workEmail}</span> : null}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function ChannelBadge({ mode, variable }: { mode: ChannelMode | undefined; variable: string }) {
  if (mode === undefined) return <span className="text-muted-foreground">Unknown until the worker reports</span>;
  if (mode === "live") return <Badge variant="secondary">On</Badge>;
  if (mode === "console") return <Badge variant="outline">Log only (development)</Badge>;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Badge variant="destructive">Off</Badge>
      <span className="text-muted-foreground">Set {variable} for the worker.</span>
    </span>
  );
}
