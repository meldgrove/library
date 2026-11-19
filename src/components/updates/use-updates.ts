"use client";

import { useEffect, useSyncExternalStore } from "react";
import { installOutcome, isSlow, startWait, type Failure, type InstallWait } from "@/lib/updates/state";
import { isUpdatesResponse, UPDATES_API, type Channel, type UpdatesResponse } from "@/lib/updates/types";

/*
 * The update status in the browser, shared by the update button in the header
 * and the "Updates" card on /admin. It asks /api/admin/updates on page load,
 * every 5 minutes, and when the window regains focus (at most once a minute);
 * it never checks for updates by itself. While an installation runs, it asks
 * every 2 seconds and keeps asking while the library restarts.
 */

export interface UpdatesSnapshot {
  response: UpdatesResponse | null;
  /** A check from this page runs. */
  checking: boolean;
  /** An install request from this page runs. */
  requesting: boolean;
  /** A channel change from this page runs. */
  saving: boolean;
  /** Why the last action from this page was refused. */
  actionError: string | null;
  wait: InstallWait | null;
  /** The installation this page waited for has not ended after 15 minutes. */
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

type Fetched = { kind: "answer"; httpStatus: number; body: UpdatesResponse } | { kind: "down" };

/** Asks the library. "down": no answer, a gateway error, or no JSON, as while it restarts. */
async function request(path: string, body?: Record<string, unknown>): Promise<Fetched> {
  try {
    const response = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    if (response.status >= 502 && response.status <= 504) return { kind: "down" };
    const json: unknown = await response.json().catch(() => null);
    return isUpdatesResponse(json) ? { kind: "answer", httpStatus: response.status, body: json } : { kind: "down" };
  } catch {
    return { kind: "down" };
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
    const wait = JSON.parse(stored) as InstallWait;
    return typeof wait.version === "string" && typeof wait.since === "number" ? wait : null;
  } catch {
    return null;
  }
}

let lastFetch = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

function setWait(wait: InstallWait | null): void {
  saveWait(wait);
  update({ wait, slow: wait ? isSlow(wait, Date.now()) : false });
}

function schedulePoll(): void {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => void poll(), POLL_MS);
}

/** One request while an installation runs. */
async function poll(): Promise<void> {
  const wait = snapshot.wait;
  if (!wait) return;
  const fetched = await request(UPDATES_API);
  lastFetch = Date.now();
  if (snapshot.wait !== wait) return;
  if (fetched.kind === "down") {
    setWait({ ...wait, outage: true, restarting: true });
    schedulePoll();
    return;
  }
  const current = { ...wait, restarting: false };
  update({ response: fetched.body });
  const outcome = installOutcome(current, fetched.body);
  if (outcome === "done") {
    setWait(null);
    update({ done: current.version });
    return;
  }
  if (outcome === "failed") {
    setWait(null);
    if (current.mine) update({ failure: { version: current.version, message: fetched.body.updater?.last?.message ?? null } });
    return;
  }
  if (outcome === "gone") {
    setWait(null);
    return;
  }
  setWait(current);
  schedulePoll();
}

/** Takes a new answer; follows an installation the updater reports. */
function receive(body: UpdatesResponse): void {
  update({ response: body });
  const installing = body.updater?.installing;
  if (installing && !snapshot.wait) {
    setWait(startWait(installing.version, body, false, Date.now()));
    schedulePoll();
  }
}

async function refresh(): Promise<void> {
  if (snapshot.wait) return;
  lastFetch = Date.now();
  const fetched = await request(UPDATES_API);
  if (fetched.kind === "answer") receive(fetched.body);
}

async function check(): Promise<void> {
  if (snapshot.checking) return;
  update({ checking: true, actionError: null });
  const fetched = await request(`${UPDATES_API}/check`, {});
  lastFetch = Date.now();
  if (fetched.kind === "answer") {
    receive(fetched.body);
    update({ actionError: fetched.httpStatus === 200 ? null : fetched.body.error });
  } else {
    update({ actionError: "The library did not answer. Try again." });
  }
  update({ checking: false });
}

/** Asks the updater to install a version now; the page then waits for it. */
async function install(version: string): Promise<void> {
  if (snapshot.requesting || snapshot.wait) return;
  update({ requesting: true, actionError: null, failure: null });
  const fetched = await request(`${UPDATES_API}/install`, { version });
  lastFetch = Date.now();
  if (fetched.kind === "down") {
    update({ requesting: false, actionError: "The library did not answer. Try again." });
    return;
  }
  update({ requesting: false, response: fetched.body });
  if (fetched.httpStatus !== 202) {
    update({ actionError: fetched.body.error ?? "The update service did not accept the installation." });
    return;
  }
  setWait(startWait(version, fetched.body, true, Date.now()));
  schedulePoll();
}

/** Switches the channel; answers the reason when it was refused. */
async function setChannel(channel: Channel): Promise<string | null> {
  update({ saving: true, actionError: null });
  const fetched = await request(`${UPDATES_API}/channel`, { channel });
  lastFetch = Date.now();
  let error: string | null = null;
  if (fetched.kind === "answer") {
    receive(fetched.body);
    if (fetched.httpStatus !== 200) error = fetched.body.error ?? "The update service did not switch the channel.";
    else if (!fetched.body.reachable) error = fetched.body.error;
  } else {
    error = "The library did not answer. Try again.";
  }
  update({ saving: false });
  return error;
}

function dismissFailure(): void {
  update({ failure: null, actionError: null });
}

export const updates = { refresh, check, install, setChannel, dismissFailure };

let users = 0;
let stopPolling: (() => void) | undefined;

/** Starts asking when the first component needs the status; stops after the last. */
function start(): () => void {
  users += 1;
  if (users === 1) {
    const resumed = snapshot.wait ?? loadWait();
    if (resumed) {
      update({ wait: resumed, slow: isSlow(resumed, Date.now()) });
      void poll();
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
