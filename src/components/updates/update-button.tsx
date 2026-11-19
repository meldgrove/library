"use client";

import { Download, ExternalLink, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { createDateFormatter } from "@/lib/format";
import type { DisplayPreferences } from "@/lib/preferences";
import {
  buttonState,
  canInstall,
  installAction,
  installingVersion,
  installsLine,
  relativeTime,
  reportedFailure,
  runningVersion,
  safeLink,
  stageLabel,
  visibleNotes,
  type ButtonState,
  type Failure,
} from "@/lib/updates/state";
import { CHANNEL_LABELS, type Update, type UpdatesResponse } from "@/lib/updates/types";
import { cn } from "@/lib/utils";
import { updates, useUpdates, type ActionError as ActionErrorValue, type UpdatesSnapshot } from "./use-updates";

const APP_NAME = "Meldgrove Library";
const SERVER_LOG = "journalctl -u meldgrove-updater-library";

interface Confirm {
  update: Update;
  /** An update that needs upgrade steps. */
  attention: boolean;
}

/** The time now, renewed every half minute for "Checked 5 min ago". */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function tooltipFor(state: ButtonState, snapshot: UpdatesSnapshot, failure: Failure | null, error: ActionErrorValue | null): string {
  const { response, wait } = snapshot;
  const running = runningVersion(response);
  if (error) return error.title;
  switch (state) {
    case "loading":
      return "Updates";
    case "checking":
      return "Checking for updates…";
    case "up-to-date":
      return running ? `Up to date · ${running}` : "Up to date";
    case "available":
      return `Update available · ${response?.updater?.available?.version}`;
    case "attention":
      return `${response?.updater?.attention?.version} needs upgrade steps`;
    case "installing":
      return wait?.restarting ? "Restarting…" : `Installing ${installingVersion(response, wait)}…`;
    case "failed":
      return `Update to ${failure?.version} failed`;
    case "off":
      return "Automatic updates are off on this server";
    case "unreachable":
      return "No update service. See the deployment guide.";
  }
}

function StateIcon({ state }: { state: ButtonState }) {
  switch (state) {
    case "available":
    case "attention":
      return <Download aria-hidden="true" />;
    case "installing":
      return <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />;
    case "failed":
      return <TriangleAlert aria-hidden="true" className="text-destructive" />;
    case "checking":
      return <RefreshCw aria-hidden="true" className="text-muted-foreground motion-safe:animate-spin" />;
    case "unreachable":
      return <RefreshCw aria-hidden="true" className="text-muted-foreground opacity-60" />;
    default:
      return <RefreshCw aria-hidden="true" className="text-muted-foreground" />;
  }
}

/**
 * The update button in the header, for admins: it shows whether an update is
 * available, installs it on request, follows the installation, and says why
 * one failed. Every Meldgrove app has the same button.
 */
export function UpdateButton({ preferences }: { preferences: DisplayPreferences }) {
  const snapshot = useUpdates();
  const { response, wait, done } = snapshot;
  const state = buttonState(snapshot);
  const failure = snapshot.failure ?? reportedFailure(response?.updater ?? null);
  const [open, setOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const now = useNow();
  const formatter = useMemo(() => createDateFormatter(preferences), [preferences]);

  // The new version runs: say so, then load the page from it.
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => window.location.reload(), 1_500);
    return () => clearTimeout(timer);
  }, [done]);

  // A failed check or a refused installation where no other panel shows it, such as "Up to date".
  const error = (state === "up-to-date" || state === "off") && snapshot.actionError ? snapshot.actionError : null;
  const hasPanel = state === "available" || state === "attention" || state === "failed" || state === "installing" || error !== null;
  // An installation this page asked for that failed, and an error from this page, open by themselves.
  const popoverOpen = hasPanel && (open || snapshot.failure?.mine === true || error !== null);
  const label = tooltipFor(state, snapshot, failure, error);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next && (snapshot.failure || snapshot.actionError)) updates.dismissFailure();
  };

  const onClick = (event: React.MouseEvent) => {
    if (hasPanel) return;
    // Nothing to show: the click checks (or asks again for an updater that did not answer).
    event.preventDefault();
    if (state === "up-to-date" || state === "off") void updates.check();
    else if (state === "unreachable") void updates.refresh();
  };

  const askToInstall = (update: Update, attention: boolean) => {
    setOpen(false);
    updates.dismissFailure();
    setConfirm({ update, attention });
  };

  const install = () => {
    if (!confirm) return;
    const version = confirm.update.version;
    setConfirm(null);
    setOpen(true);
    void updates.install(version);
  };

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={onOpenChange}>
        <Tooltip open={tooltipOpen && !popoverOpen} onOpenChange={setTooltipOpen}>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="relative rounded-full"
                aria-label={label}
                aria-busy={state === "checking" || state === "installing" ? true : undefined}
                data-update-state={state}
                onClick={onClick}
              >
                {error ? <TriangleAlert aria-hidden="true" className="text-destructive" /> : <StateIcon state={state} />}
                {state === "available" || state === "attention" ? (
                  <span
                    aria-hidden="true"
                    className={cn("absolute top-1 right-1 size-2 rounded-full ring-2 ring-background", state === "available" ? "bg-primary" : "bg-amber-500")}
                  />
                ) : null}
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{label}</TooltipContent>
        </Tooltip>
        <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] p-0" data-testid="update-popover">
          <div className="flex flex-col gap-3 p-4 text-sm">
            {state === "available" && response?.updater?.available ? (
              <AvailablePanel
                update={response.updater.available}
                installable={canInstall(response.updater)}
                now={now}
                formatDateTime={formatter.dateTime}
                onInstall={askToInstall}
                snapshot={snapshot}
              />
            ) : null}
            {state === "attention" && response?.updater?.attention ? (
              <AttentionPanel
                update={response.updater.attention}
                action={installAction(response.updater, true)}
                onInstall={askToInstall}
                snapshot={snapshot}
              />
            ) : null}
            {state === "failed" && failure ? (
              <FailedPanel failure={failure} response={response} onRetry={askToInstall} snapshot={snapshot} />
            ) : null}
            {state === "installing" ? <InstallingPanel snapshot={snapshot} /> : null}
            {error ? <ErrorPanel error={error} /> : null}
          </div>
          <PopoverFooter snapshot={snapshot} now={now} />
        </PopoverContent>
      </Popover>

      <Dialog open={confirm !== null} onOpenChange={(next) => (next ? null : setConfirm(null))}>
        <DialogContent showCloseButton={false}>
          {confirm ? <ConfirmContent confirm={confirm} onInstall={install} /> : null}
        </DialogContent>
      </Dialog>

      {done && !wait ? createPortal(<Toast>Updated to {done}</Toast>, document.body) : null}
    </>
  );
}

function ReleaseNotesLink({ url }: { url: string | null }) {
  const href = safeLink(url);
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-1 font-medium underline underline-offset-4">
      Release notes
      <ExternalLink aria-hidden="true" className="size-3.5" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

function ActionError({ snapshot }: { snapshot: UpdatesSnapshot }) {
  if (!snapshot.actionError) return null;
  return (
    <p role="alert" className="break-words text-destructive">
      <span className="font-medium">{snapshot.actionError.title}.</span> {snapshot.actionError.message}
    </p>
  );
}

/** A failed check or a refused installation, from the "Up to date" and "off" states. */
function ErrorPanel({ error }: { error: ActionErrorValue }) {
  return (
    <PopoverHeader>
      <PopoverTitle>{error.title}</PopoverTitle>
      <p role="alert" className="break-words text-destructive">
        {error.message}
      </p>
    </PopoverHeader>
  );
}

/** The updater refuses installations while automatic updates are off. */
function OffNote() {
  return (
    <p className="text-muted-foreground">
      Automatic updates are off on this server, so nothing can install. Set them up as the deployment guide describes.
    </p>
  );
}

function AvailablePanel(props: {
  update: Update;
  installable: boolean;
  now: number;
  formatDateTime: (value: Date) => string;
  onInstall: (update: Update, attention: boolean) => void;
  snapshot: UpdatesSnapshot;
}) {
  const { update, installable, now, formatDateTime, onInstall, snapshot } = props;
  const published = relativeTime(update.publishedAt, now);
  const { notes, more } = visibleNotes(update);
  const installs = installsLine(update, now, formatDateTime);
  return (
    <>
      <PopoverHeader>
        <PopoverTitle>Update available</PopoverTitle>
        <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
          <span>
            {update.version}
            {published ? ` · ${published}` : ""}
          </span>
          {update.preview ? <Badge variant="outline">Preview</Badge> : null}
        </p>
      </PopoverHeader>
      {notes.length > 0 ? (
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {notes.map((note, index) => (
            <li key={index} className="break-words">
              {note}
            </li>
          ))}
        </ul>
      ) : null}
      {more > 0 ? <p className="text-muted-foreground">and {more === 1 ? "1 more change" : `${more} more changes`}</p> : null}
      <ReleaseNotesLink url={update.url} />
      {installable && installs ? <p className="text-muted-foreground">{installs}</p> : null}
      <ActionError snapshot={snapshot} />
      {installable ? (
        <Button size="sm" className="w-fit" disabled={snapshot.requesting} onClick={() => onInstall(update, false)}>
          Install now
        </Button>
      ) : (
        <OffNote />
      )}
    </>
  );
}

function AttentionPanel(props: {
  update: Update;
  action: "install" | "off" | "locked";
  onInstall: (update: Update, attention: boolean) => void;
  snapshot: UpdatesSnapshot;
}) {
  const { update, action, onInstall, snapshot } = props;
  return (
    <>
      <PopoverHeader>
        <PopoverTitle>{update.version} needs upgrade steps</PopoverTitle>
        <p className="text-muted-foreground">This release changes the setup. Take the upgrade steps from its release notes on the server first.</p>
      </PopoverHeader>
      <ReleaseNotesLink url={update.url} />
      <ActionError snapshot={snapshot} />
      {action === "install" ? (
        <Button size="sm" variant="outline" className="w-fit" disabled={snapshot.requesting} onClick={() => onInstall(update, true)}>
          Install anyway…
        </Button>
      ) : action === "locked" ? (
        <p className="text-muted-foreground">
          The image tag set where {APP_NAME} is deployed does not reach {update.version}. Take the upgrade steps and change the tag there.
        </p>
      ) : (
        <OffNote />
      )}
    </>
  );
}

function FailedPanel(props: {
  failure: Failure;
  response: UpdatesResponse | null;
  onRetry: (update: Update, attention: boolean) => void;
  snapshot: UpdatesSnapshot;
}) {
  const { failure, response, onRetry, snapshot } = props;
  const running = runningVersion(response);
  const updater = response?.updater;
  // Try again only while the version is still offered, and a release with upgrade steps only where the button may install it.
  const available = updater?.available?.version === failure.version && installAction(updater, false) === "install" ? updater.available : null;
  const attention = updater?.attention?.version === failure.version && installAction(updater, true) === "install" ? updater.attention : null;
  const retry = available ?? attention;
  return (
    <>
      <PopoverHeader>
        <PopoverTitle>Update to {failure.version} failed</PopoverTitle>
        {failure.message ? <p className="break-words">{failure.message}</p> : null}
        {running ? <p className="text-muted-foreground">{running} is still running.</p> : null}
      </PopoverHeader>
      <ActionError snapshot={snapshot} />
      {retry ? (
        <Button size="sm" className="w-fit" disabled={snapshot.requesting} onClick={() => onRetry(retry, retry === attention)}>
          Try again
        </Button>
      ) : null}
    </>
  );
}

function InstallingPanel({ snapshot }: { snapshot: UpdatesSnapshot }) {
  const { response, wait, slow } = snapshot;
  const version = installingVersion(response, wait);
  const updater = response?.updater;
  const stage =
    updater?.installing?.version === version
      ? updater.installing.stage
      : updater?.last?.version === version && updater.last.result === "accepted"
        ? "deploying"
        : undefined;
  return (
    <>
      <PopoverHeader>
        <PopoverTitle>Installing {version}…</PopoverTitle>
        <p className="text-muted-foreground" aria-live="polite">
          {wait?.restarting ? "Restarting…" : stageLabel(stage, wait?.from ?? runningVersion(response))}
        </p>
      </PopoverHeader>
      <p>{APP_NAME} restarts. This page reloads when it is back.</p>
      <ActionError snapshot={snapshot} />
      {slow && wait ? (
        <>
          <p role="alert" className="text-destructive">
            This takes longer than expected. Check the server (<code className="font-mono text-xs">{SERVER_LOG}</code>).
          </p>
          <Button size="sm" variant="outline" className="w-fit" onClick={() => updates.stopWaiting()}>
            Stop waiting
          </Button>
        </>
      ) : null}
    </>
  );
}

function PopoverFooter({ snapshot, now }: { snapshot: UpdatesSnapshot; now: number }) {
  const { response, checking, wait } = snapshot;
  const running = runningVersion(response);
  const updater = response?.updater;
  const checked = relativeTime(updater?.checkedAt ?? null, now);
  return (
    <div className="flex items-end justify-between gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span>
          Installed: {running ?? "unknown"}
          {updater ? ` · ${CHANNEL_LABELS[updater.channel]}` : ""}
        </span>
        <span>{checking ? "Checking for updates…" : checked ? `Checked ${checked}` : "Not checked yet"}</span>
      </div>
      <Button variant="link" size="xs" className="h-auto px-0 text-xs" disabled={checking || wait !== null} onClick={() => void updates.check()}>
        Check now
      </Button>
    </div>
  );
}

function ConfirmContent({ confirm, onInstall }: { confirm: Confirm; onInstall: () => void }) {
  const { update, attention } = confirm;
  const notes = safeLink(update.url);
  return (
    <>
      <DialogHeader>
        <DialogTitle>{attention ? `Install ${update.version} without its upgrade steps?` : `Install ${update.version} now?`}</DialogTitle>
        <DialogDescription>
          {attention ? (
            <>
              Its{" "}
              {notes ? (
                <a href={notes} target="_blank" rel="noreferrer" className="font-medium text-foreground underline underline-offset-4">
                  release notes
                </a>
              ) : (
                "release notes"
              )}{" "}
              name steps to take on the server first.{" "}
            </>
          ) : null}
          {APP_NAME} restarts and is unavailable for a moment. Database changes run automatically.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="outline">Cancel</Button>
        </DialogClose>
        <Button variant={attention ? "destructive" : "default"} onClick={onInstall}>
          Install
        </Button>
      </DialogFooter>
    </>
  );
}

function Toast({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" className="fixed right-4 bottom-4 z-50 rounded-md border bg-popover px-4 py-3 text-sm font-medium text-popover-foreground shadow-md">
      {children}
    </div>
  );
}
