"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  afterInstallAnswer,
  channelError,
  checkError,
  gaveUp,
  installOutcome,
  isSlow,
  newAttempt,
  RECONCILE_MS,
  startWait,
  type Failure,
  type Fetched,
  type InstallWait,
} from "@/lib/updates/state";
import { isUpdatesResponse, UPDATES_API, type Channel, type UpdatesResponse } from "@/lib/updates/types";

/*
 * The update status in the browser, shared by the update button in the header
 * and the "Updates" card on /admin. It asks /api/admin/updates on page load,
 * every 5 minutes, and when the window regains focus (at most once a minute);
 * it never checks for updates by itself. While it follows an installation, it
 * asks every 2 seconds and keeps asking while the library restarts
 * (docs/deployment.md, The update button).
 */

/** Why an action from this page failed, for the button's popover. */
export interface ActionError {
  title: string;
  message: string;
}

export interface UpdatesSnapshot {
  response: UpdatesResponse | null;
  /** A check from this page runs. */
  checking: boolean;
  /** An install request from this page runs. */
  requesting: boolean;
  /** A channel change from this page runs. */
  saving: boolean;
  /** Why the last check or installation from this page failed or was refused. */
  actionError: ActionError | null;
  wait: InstallWait | null;
  /** The installation this page follows has not ended after 15 minutes. */
  slow: boolean;
  failure: Failure | null;
  /** The version this page waited for runs: the page reloads. */
  done: string | null;
}

const INITIAL: UpdatesSnapshot = {
  response: null,
  checking: false,
  requesting: false,
  saving: false,
  actionError: null,
  wait: null,
  slow: false,
  failure: null,
  done: null,
};

const REFRESH_MS = 5 * 60_000;
const FOCUS_MS = 60_000;
const POLL_MS = 2_000;
/** The browser's limits; the library's own calls to the updater take at most 3, 10 and 35 seconds. */
const TIMEOUT_MS = { status: 10_000, install: 20_000, long: 45_000 } as const;
const STORAGE_KEY = "library.update-install";

let snapshot = INITIAL;
const listeners = new Set<() => void>();

function update(patch: Partial<UpdatesSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Asks the library. "down": no answer, a server error, or no JSON, as while it restarts. */
async function request(path: string, timeoutMs: number, body?: Record<string, unknown>): Promise<Fetched> {
  try {
    const response = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      // A redirect leads to the sign-in page: the session ended.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.type === "opaqueredirect") return { kind: "denied" };
    const json: unknown = await response.json().catch(() => null);
    if (response.status < 500 && isUpdatesResponse(json)) return { kind: "answer", httpStatus: response.status, body: json };
    // Admins only: anyone else, such as someone signed out, gets 404.
    if (response.status === 401 || response.status === 403 || response.status === 404) return { kind: "denied" };
    return { kind: "down", reason: `The library answered with HTTP ${response.status}.` };
  } catch (error) {
    const timeout = error instanceof DOMException && error.name === "TimeoutError";
    return { kind: "down", reason: timeout ? `The library did not answer within ${timeoutMs / 1_000} seconds.` : "The library did not answer." };
  }
}

function saveWait(wait: InstallWait | null): void {
  try {
    if (wait) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(wait));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage may be unavailable; the page then forgets the installation on reload.
  }
}

function loadWait(): InstallWait | null {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const wait = JSON.parse(stored) as Partial<InstallWait> | null;
    if (typeof wait?.version !== "string" || typeof wait.since !== "number") return null;
    const defaults: Omit<InstallWait, "version" | "since"> = {
      from: null,
      requestedAt: null,
      before: null,
      mine: false,
      confirmed: true,
      giveUpAt: null,
      reason: null,
      outage: false,
      restarting: false,
    };
    return { ...defaults, ...wait, version: wait.version, since: wait.since };
  } catch {
    return null;
  }
}

let lastFetch = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
/** Components that use the status; the page asks only while there is one. */
let users = 0;
/** An installation an admin stopped waiting for: not followed again. */
let dismissed: { version: string; startedAt: string | null } | null = null;

function setWait(wait: InstallWait | null): void {
  saveWait(wait);
  update({ wait, slow: wait ? isSlow(wait, Date.now()) : false });
}

/** The next request while the page follows an installation, only while a component uses the status. */
function schedulePoll(): void {
  clearTimeout(pollTimer);
  pollTimer = users > 0 && snapshot.wait ? setTimeout(() => void poll(), POLL_MS) : undefined;
}

function didNotStart(wait: InstallWait): ActionError {
  return { title: "The installation did not start", message: wait.reason ?? `The update service did not report an installation of ${wait.version}.` };
}

/** Follows an installation that an answer reports. */
function adopt(body: UpdatesResponse): void {
  const installing = body.updater?.installing;
  if (!installing || snapshot.wait || snapshot.done) return;
  if (dismissed?.version === installing.version && (dismissed.startedAt === null || dismissed.startedAt === installing.startedAt)) return;
  setWait(startWait(installing.version, body, false, Date.now()));
  schedulePoll();
}

/** Takes an answer: settles the installation the page follows, or follows one the answer reports. */
function receive(body: UpdatesResponse, sentAt: number): void {
  update({ response: body });
  const wait = snapshot.wait;
  if (!wait) return adopt(body);
  // Only answers to requests sent after the attempt started count.
  if (sentAt < wait.since) return;
  const outcome = installOutcome(wait, body);
  switch (outcome.kind) {
    case "done":
      setWait(null);
      update({ done: wait.version, actionError: null });
      return;
    case "failed":
      setWait(null);
      update({ failure: { version: wait.version, message: outcome.message, mine: wait.mine } });
      return;
    case "other":
      setWait(null);
      return adopt(body);
    case "waiting":
      if (gaveUp(outcome.wait, Date.now())) {
        setWait(null);
        update({ actionError: didNotStart(outcome.wait) });
        return adopt(body);
      }
      setWait(outcome.wait);
      schedulePoll();
  }
}

/** One request while the page follows an installation. */
async function poll(): Promise<void> {
  const wait = snapshot.wait;
  if (!wait) return;
  const sentAt = Date.now();
  const fetched = await request(UPDATES_API, TIMEOUT_MS.status);
  lastFetch = Date.now();
  const current = snapshot.wait;
  // The page stopped following it, or follows another one.
  if (!current || current.version !== wait.version || current.since !== wait.since) return;
  if (fetched.kind === "answer") return receive(fetched.body, sentAt);
  if (fetched.kind === "denied") {
    // Keep the attempt: the next page load after signing in follows it again.
    clearTimeout(pollTimer);
    update({ actionError: { title: "Your session ended", message: "Sign in again to follow the installation." } });
    return;
  }
  const next = { ...current, outage: true, restarting: true };
  if (gaveUp(next, Date.now())) {
    setWait(null);
    update({ actionError: didNotStart(next) });
    return;
  }
  setWait(next);
  schedulePoll();
}

async function refresh(): Promise<void> {
  if (snapshot.wait) return;
  const sentAt = Date.now();
  lastFetch = sentAt;
  const fetched = await request(UPDATES_API, TIMEOUT_MS.status);
  if (fetched.kind === "answer") receive(fetched.body, sentAt);
}

async function check(): Promise<void> {
  if (snapshot.checking || snapshot.wait) return;
  update({ checking: true, actionError: null });
  const sentAt = Date.now();
  const fetched = await request(`${UPDATES_API}/check`, TIMEOUT_MS.long, {});
  lastFetch = Date.now();
  if (fetched.kind === "answer") receive(fetched.body, sentAt);
  const error = checkError(fetched);
  update({ checking: false, actionError: error ? { title: "Could not check for updates", message: error } : null });
}

/** Asks the updater to install a version now; the page then follows it. */
async function install(version: string): Promise<void> {
  if (snapshot.requesting || snapshot.wait) return;
  // Remembered before the request: the deployment may restart the library before it answers.
  const attempt = newAttempt(version, snapshot.response, Date.now());
  dismissed = null;
  setWait(attempt);
  update({ requesting: true, actionError: null, failure: null });
  const fetched = await request(`${UPDATES_API}/install`, TIMEOUT_MS.install, { version });
  lastFetch = Date.now();
  update({ requesting: false });
  // Read again: it may have changed during the request.
  const current = (snapshot as UpdatesSnapshot).wait;
  if (!current || current.since !== attempt.since) return;
  const { wait, error } = afterInstallAnswer(current, fetched, Date.now());
  setWait(wait);
  if (error) update({ actionError: { title: `Could not install ${version}`, message: error } });
  if (fetched.kind === "answer") receive(fetched.body, attempt.since);
  schedulePoll();
}

/** Switches the channel; answers the reason when it was not saved. */
async function setChannel(channel: Channel): Promise<string | null> {
  update({ saving: true, actionError: null });
  const sentAt = Date.now();
  const fetched = await request(`${UPDATES_API}/channel`, TIMEOUT_MS.long, { channel });
  lastFetch = Date.now();
  if (fetched.kind === "answer") receive(fetched.body, sentAt);
  update({ saving: false });
  return channelError(fetched, channel);
}

/** Forgets the installation the page follows and goes back to asking every 5 minutes. */
function stopWaiting(): void {
  const wait = snapshot.wait;
  if (!wait) return;
  dismissed = { version: wait.version, startedAt: wait.requestedAt };
  clearTimeout(pollTimer);
  setWait(null);
  update({ actionError: null });
  void refresh();
}

function dismissFailure(): void {
  update({ failure: null, actionError: null });
}

export const updates = { refresh, check, install, setChannel, stopWaiting, dismissFailure };

let stopPolling: (() => void) | undefined;

/** Starts asking when the first component needs the status; stops after the last. */
function start(): () => void {
  users += 1;
  if (users === 1) {
    let resumed = snapshot.wait;
    if (!resumed) {
      const stored = loadWait();
      // A page left before its install request was answered: look for that installation.
      resumed = stored && !stored.confirmed && stored.giveUpAt === null ? { ...stored, giveUpAt: Date.now() + RECONCILE_MS } : stored;
    }
    if (resumed) {
      setWait(resumed);
      // A running install request schedules the first request itself.
      if (!snapshot.requesting) void poll();
    } else if (!snapshot.response || Date.now() - lastFetch > FOCUS_MS) {
      void refresh();
    }
    const interval = setInterval(() => void refresh(), REFRESH_MS);
    const onFocus = () => {
      if (Date.now() - lastFetch > FOCUS_MS) void refresh();
    };
    window.addEventListener("focus", onFocus);
    stopPolling = () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }
  return () => {
    users -= 1;
    if (users === 0) {
      stopPolling?.();
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  };
}

/** The shared update status; starts asking while a component uses it. */
export function useUpdates(): UpdatesSnapshot {
  useEffect(() => start(), []);
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => INITIAL,
  );
}
