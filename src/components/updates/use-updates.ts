"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  afterInstallAnswer,
  channelError,
  checkError,
  dismissal,
  gaveUp,
  installOutcome,
  isDismissed,
  isSlow,
  newAttempt,
  RECONCILE_MS,
  SLOW_INSTALL_MS,
  startWait,
  unconfirmedError,
  type Dismissed,
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
 * (docs/deployment.md, The update button). When the session ends, it stops
 * asking until the next page load.
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
const DISMISSED_KEY = "library.update-dismissed";

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

function seconds(ms: number): string {
  const count = Math.max(1, Math.round(ms / 1_000));
  return count === 1 ? "1 second" : `${count} seconds`;
}

/**
 * Asks the library. "down": no answer, a server error, or a body that cannot
 * be read, as while it restarts. "denied": the session ended, and the page
 * stops asking by itself.
 */
async function request(path: string, timeoutMs: number, body?: Record<string, unknown>): Promise<Fetched> {
  const fetched = await send(path, timeoutMs, body);
  if (fetched.kind === "denied") signOut();
  return fetched;
}

async function send(path: string, timeoutMs: number, body?: Record<string, unknown>): Promise<Fetched> {
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
    // Admins only: anyone else, such as someone signed out, gets 404.
    if (response.status === 401 || response.status === 403 || response.status === 404) return { kind: "denied" };
    // The sign-in page of a proxy in front of the library instead of JSON; an error page (5xx) is an outage.
    if (response.status < 500 && response.headers.get("content-type")?.includes("text/html")) return { kind: "denied" };
    const json: unknown = await response.json().catch(() => null);
    if (response.status < 500 && isUpdatesResponse(json)) return { kind: "answer", httpStatus: response.status, body: json };
    const error = isUpdatesResponse(json) ? json.error : null;
    return { kind: "down", httpStatus: response.status, reason: error ?? `The library answered with HTTP ${response.status}.` };
  } catch (error) {
    const timeout = error instanceof DOMException && error.name === "TimeoutError";
    return { kind: "down", reason: timeout ? `The library did not answer within ${seconds(timeoutMs)}.` : "The library did not answer." };
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
      startedAt: null,
      earlier: null,
      mine: false,
      confirmed: true,
      giveUpAt: null,
      reason: null,
      error: null,
      answered: false,
      outage: false,
      restarting: false,
    };
    return { ...defaults, ...wait, version: wait.version, since: wait.since };
  } catch {
    return null;
  }
}

function saveDismissed(value: Dismissed | null): void {
  try {
    if (value) sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(DISMISSED_KEY);
  } catch {
    // Without storage, the next page load follows that installation again.
  }
}

function loadDismissed(): Dismissed | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(DISMISSED_KEY) ?? "null") as Partial<Dismissed> | null;
    if (typeof value?.version !== "string" || typeof value.since !== "number") return null;
    return { version: value.version, startedAt: typeof value.startedAt === "string" ? value.startedAt : null, since: value.since };
  } catch {
    return null;
  }
}

let lastFetch = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
/** Ends an attempt without a clear answer RECONCILE_MS after it started, whatever the requests return. */
let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
/** Shows Stop waiting after SLOW_INSTALL_MS, also while no request returns. */
let slowTimer: ReturnType<typeof setTimeout> | undefined;
/** Components that use the status; the page asks only while there is one. */
let users = 0;
/** The session ended: no request by itself until the next page load. */
let signedOut = false;
/** Ends the requests every 5 minutes and on focus. */
let stopPolling: (() => void) | undefined;
/** An installation an admin stopped waiting for: not followed again. */
let dismissed: Dismissed | null = null;

function setWait(wait: InstallWait | null): void {
  saveWait(wait);
  update({ wait, slow: wait ? isSlow(wait, Date.now()) : false });
  armTimers(wait);
}

/** The timers of the installation the page follows, only while a component uses the status. */
function armTimers(wait: InstallWait | null): void {
  clearTimeout(deadlineTimer);
  clearTimeout(slowTimer);
  deadlineTimer = slowTimer = undefined;
  if (!wait || users === 0) return;
  if (!wait.confirmed && wait.giveUpAt !== null && !signedOut) {
    deadlineTimer = setTimeout(() => deadline(wait.since), Math.max(0, wait.giveUpAt - Date.now()));
  }
  if (!snapshot.slow) {
    slowTimer = setTimeout(() => {
      if (snapshot.wait?.since === wait.since) update({ slow: true });
    }, Math.max(0, wait.since + SLOW_INSTALL_MS - Date.now()) + 1);
  }
}

/** The next request while the page follows an installation, only while a component uses the status. */
function schedulePoll(): void {
  clearTimeout(pollTimer);
  pollTimer = users > 0 && snapshot.wait && !signedOut ? setTimeout(() => void poll(), POLL_MS) : undefined;
}

/** No status reported the attempt in time: forget it, say why, and show what runs. */
function deadline(since: number): void {
  const wait = snapshot.wait;
  if (!wait || wait.since !== since || wait.confirmed) return;
  // A timer may fire a moment early.
  if (!gaveUp(wait, Date.now())) return armTimers(wait);
  clearTimeout(pollTimer);
  setWait(null);
  update({ actionError: unconfirmedError(wait) });
  void refresh();
}

/** The session ended: stop every request the page sends by itself; an attempt stays for the next page load. */
function signOut(): void {
  signedOut = true;
  clearTimeout(pollTimer);
  clearTimeout(deadlineTimer);
  pollTimer = deadlineTimer = undefined;
  stopPolling?.();
  stopPolling = undefined;
}

/** Follows an installation that an answer reports. */
function adopt(body: UpdatesResponse): void {
  const installing = body.updater?.installing;
  if (!installing || snapshot.wait || snapshot.done || isDismissed(dismissed, installing)) return;
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
      setWait(outcome.wait);
      schedulePoll();
  }
}

/** One request while the page follows an installation. */
async function poll(): Promise<void> {
  const wait = snapshot.wait;
  if (!wait || signedOut) return;
  // An attempt without a clear answer: each request gets at most the time left.
  const left = !wait.confirmed && wait.giveUpAt !== null ? wait.giveUpAt - Date.now() : TIMEOUT_MS.status;
  if (left <= 0) return deadline(wait.since);
  const sentAt = Date.now();
  const fetched = await request(UPDATES_API, Math.min(TIMEOUT_MS.status, left));
  lastFetch = Date.now();
  const current = snapshot.wait;
  // The page stopped following it, or follows another one.
  if (!current || current.version !== wait.version || current.since !== wait.since) return;
  if (fetched.kind === "answer") return receive(fetched.body, sentAt);
  if (fetched.kind === "denied") {
    // Keep the attempt: the next page load after signing in follows it again.
    update({ actionError: { title: "Your session ended", message: "Sign in again to follow the installation." } });
    return;
  }
  setWait({ ...current, outage: true, restarting: true, error: fetched.reason });
  schedulePoll();
}

async function refresh(): Promise<void> {
  if (snapshot.wait || signedOut) return;
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
  saveDismissed(null);
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
  dismissed = dismissal(wait);
  saveDismissed(dismissed);
  clearTimeout(pollTimer);
  setWait(null);
  update({ actionError: null });
  void refresh();
}

function dismissFailure(): void {
  update({ failure: null, actionError: null });
}

export const updates = { refresh, check, install, setChannel, stopWaiting, dismissFailure };

/** Starts asking when the first component needs the status; stops after the last. */
export function start(): () => void {
  users += 1;
  if (users === 1 && !signedOut) {
    dismissed ??= loadDismissed();
    let resumed = snapshot.wait;
    if (!resumed) {
      const stored = loadWait();
      // A page left before its install request was answered: look for that installation until its deadline.
      resumed = stored && !stored.confirmed && stored.giveUpAt === null ? { ...stored, giveUpAt: stored.since + RECONCILE_MS } : stored;
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
      stopPolling = undefined;
      clearTimeout(pollTimer);
      pollTimer = undefined;
      armTimers(null);
    }
  };
}

/** The status as it is now. */
export function readUpdates(): UpdatesSnapshot {
  return snapshot;
}

/** The shared update status; starts asking while a component uses it. */
export function useUpdates(): UpdatesSnapshot {
  useEffect(() => start(), []);
  return useSyncExternalStore(subscribe, readUpdates, () => INITIAL);
}
