import nodemailer from "nodemailer";
import { logger } from "@/lib/logger";
import type { EmailValues, UnreadableChannels } from "@/lib/settings/runtime";
import { safeSmtpUrl } from "@/lib/settings/smtp-url";
import { isPermanentSlackError, isPermanentSlackStatus } from "@/lib/slack/errors";
import type { ChannelMode, NotificationChannels } from "./types";

/*
 * Slack over its Web API, email over SMTP or the MailerSend API, plus console
 * transports for development and tests, which only log.
 */

/**
 * A failed send. A permanent error (a bad token, a missing scope, a rejected
 * address) stays until someone changes something, so the worker tries the
 * other channel at once. Other errors are retried with backoff, at most 5
 * attempts, and the last attempt tries the other channel too.
 */
export class DeliveryError extends Error {
  readonly code?: string;
  readonly retryAfterMs?: number;
  readonly permanent: boolean;
  constructor(message: string, options: { code?: string; retryAfterMs?: number; permanent?: boolean } = {}) {
    super(message);
    this.name = "DeliveryError";
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
    this.permanent = options.permanent ?? false;
  }
}

/** HTTP statuses that may pass: timeouts, rate limits, and server errors. Other 4xx answers are permanent. */
const temporaryStatus = (status: number) => status === 408 || status === 429 || status >= 500;

/** "unreadable": the channel is set up, but its saved secret cannot be read, so every send fails. */
export type TransportMode = "live" | "console" | "unreadable";

export interface SlackTransport {
  mode: TransportMode;
  /** The Slack user ID for a work email, or null if there is no such (active) user. */
  lookupUserByEmail(email: string): Promise<string | null>;
  /** Sends a direct message from the app to a Slack user. */
  postMessage(userId: string, text: string): Promise<void>;
}

export interface Email {
  to: string;
  /** The recipient's name; none for a list address. */
  toName?: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailTransport {
  mode: TransportMode;
  /** "smtp", "mailersend", "console", or "unreadable". */
  kind: string;
  send(email: Email): Promise<void>;
}

export interface Transports {
  slack?: SlackTransport;
  email?: EmailTransport;
  /** LIBRARY_BASE_URL, for links in messages. */
  baseUrl: string;
}

/** What the admin page shows for each channel: one whose secret cannot be read counts as off. */
export function channelModes(transports: Transports): NotificationChannels {
  const mode = (t: { mode: TransportMode } | undefined): ChannelMode => (!t || t.mode === "unreadable" ? "off" : t.mode);
  return { slack: mode(transports.slack), email: mode(transports.email) };
}

const TIMEOUT_MS = 15_000;

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

interface SlackResponse {
  ok: boolean;
  error?: string;
  user?: { id: string; deleted?: boolean };
}

function slackError(method: string, error: string | undefined): DeliveryError {
  return new DeliveryError(`Slack ${method}: ${error ?? "unknown error"}`, { code: error, permanent: isPermanentSlackError(error) });
}

export function createSlackTransport(token: string, fetchImpl: typeof fetch = fetch): SlackTransport {
  async function call(method: string, init: { query?: Record<string, string>; body?: Record<string, unknown> }): Promise<SlackResponse> {
    const url = new URL(`https://slack.com/api/${method}`);
    for (const [name, value] of Object.entries(init.query ?? {})) url.searchParams.set(name, value);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: init.body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json; charset=utf-8" } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new DeliveryError(`Slack ${method}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 429) throw new DeliveryError(`Slack ${method}: rate limited`, { code: "ratelimited", retryAfterMs: retryAfterMs(response) });
    if (!response.ok) throw new DeliveryError(`Slack ${method}: HTTP ${response.status}`, { permanent: isPermanentSlackStatus(response.status) });
    return (await response.json()) as SlackResponse;
  }

  return {
    mode: "live",
    async lookupUserByEmail(email) {
      const result = await call("users.lookupByEmail", { query: { email } });
      if (!result.ok) {
        if (result.error === "users_not_found") return null;
        throw slackError("users.lookupByEmail", result.error);
      }
      return result.user && !result.user.deleted ? result.user.id : null;
    },
    async postMessage(userId, text) {
      const result = await call("chat.postMessage", { body: { channel: userId, text, unfurl_links: false, unfurl_media: false } });
      if (!result.ok) throw slackError("chat.postMessage", result.error);
    },
  };
}

export function createMailerSendTransport(
  options: { token: string; from: string; fromName: string },
  fetchImpl: typeof fetch = fetch,
): EmailTransport {
  return {
    mode: "live",
    kind: "mailersend",
    async send(email) {
      let response: Response;
      try {
        response = await fetchImpl("https://api.mailersend.com/v1/email", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.token}`,
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: JSON.stringify({
            from: { email: options.from, name: options.fromName },
            to: [email.toName ? { email: email.to, name: email.toName } : { email: email.to }],
            subject: email.subject,
            text: email.text,
            html: email.html,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        throw new DeliveryError(`MailerSend: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.ok) return;
      const body = (await response.text().catch(() => "")).slice(0, 300);
      throw new DeliveryError(`MailerSend: HTTP ${response.status} ${body}`.trim(), {
        retryAfterMs: retryAfterMs(response),
        permanent: !temporaryStatus(response.status),
      });
    },
  };
}

/**
 * Mail servers answer 4xx for temporary and 5xx for permanent errors. Failed
 * authentication is permanent too; connection errors are temporary.
 */
interface SmtpError extends Error {
  responseCode?: number;
  code?: string;
}

export function createSmtpTransport(
  options: { url: string; from: string; fromName: string },
  createTransport: typeof nodemailer.createTransport = nodemailer.createTransport,
): EmailTransport {
  // The URL sets host, port, TLS, and credentials; the timeouts apply on top.
  // Nodemailer would also take options that run a program from it: those are left out.
  const transporter = createTransport({
    url: safeSmtpUrl(options.url),
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });
  return {
    mode: "live",
    kind: "smtp",
    async send(email) {
      try {
        await transporter.sendMail({
          from: { name: options.fromName, address: options.from },
          to: email.toName ? { name: email.toName, address: email.to } : email.to,
          subject: email.subject,
          text: email.text,
          html: email.html,
        });
      } catch (error) {
        const smtp = error as SmtpError;
        const detail = smtp.responseCode ? `SMTP ${smtp.responseCode}` : (smtp.code ?? "SMTP");
        throw new DeliveryError(`${detail}: ${smtp.message}`.slice(0, 500), {
          code: smtp.code,
          permanent: (smtp.responseCode ?? 0) >= 500 || smtp.code === "EAUTH",
        });
      }
    },
  };
}

/** Logs Slack messages instead of sending them (development and tests). */
export function createConsoleSlackTransport(): SlackTransport {
  return {
    mode: "console",
    lookupUserByEmail: async () => null,
    async postMessage(userId, text) {
      logger.info({ channel: "slack", to: userId, text }, "notification (console transport)");
    },
  };
}

/** Logs emails instead of sending them (development and tests). */
export function createConsoleEmailTransport(): EmailTransport {
  return {
    mode: "console",
    kind: "console",
    async send(email) {
      logger.info({ channel: "email", to: email.to, subject: email.subject, text: email.text }, "notification (console transport)");
    },
  };
}

/*
 * A channel that is set up, but whose saved secret cannot be read (a changed
 * BETTER_AUTH_SECRET). It is not off: a message goes out on the other channel
 * or is tried again, and ends as failed, not skipped.
 */
const secretUnreadable = (secret: string) =>
  new DeliveryError(`${secret} cannot be read: enter it again under Admin › Integrations.`, { permanent: true });

function createUnreadableSlackTransport(): SlackTransport {
  const fail = async (): Promise<never> => {
    throw secretUnreadable("The Slack bot token");
  };
  return { mode: "unreadable", lookupUserByEmail: fail, postMessage: fail };
}

function createUnreadableEmailTransport(secret: string): EmailTransport {
  return {
    mode: "unreadable",
    kind: "unreadable",
    async send() {
      throw secretUnreadable(secret);
    },
  };
}

/** The live email transport of the `email` setting. */
export function createEmailTransport(email: EmailValues): EmailTransport {
  return email.provider === "smtp"
    ? createSmtpTransport({ url: email.smtpUrl, from: email.from, fromName: email.fromName })
    : createMailerSendTransport({ token: email.token, from: email.from, fromName: email.fromName });
}

/**
 * The transports for the current settings. A channel without its settings is
 * off, and one whose secret is in `unreadable` fails each send; with
 * NOTIFICATION_TRANSPORT=console both only log.
 */
export function createTransports(options: {
  mode: "live" | "console";
  /** LIBRARY_BASE_URL. */
  baseUrl: string;
  slackToken: string | null;
  email: EmailValues | null;
  /** Saved secrets that could not be opened, if the channel needs them. */
  unreadable?: UnreadableChannels;
}): Transports {
  if (options.mode === "console") {
    return {
      baseUrl: options.baseUrl,
      slack: createConsoleSlackTransport(),
      email: createConsoleEmailTransport(),
    };
  }
  return {
    baseUrl: options.baseUrl,
    slack: options.slackToken ? createSlackTransport(options.slackToken) : options.unreadable?.slack ? createUnreadableSlackTransport() : undefined,
    email: options.email ? createEmailTransport(options.email) : options.unreadable?.email ? createUnreadableEmailTransport(options.unreadable.email) : undefined,
  };
}

/** What a test button reports. */
export interface CheckResult {
  ok: boolean;
  message: string;
}

/** The test of the `slack` setting: Slack's auth.test with the bot token. Sends no message. */
export async function checkSlackToken(token: string, fetchImpl: typeof fetch = fetch): Promise<CheckResult> {
  let response: Response;
  try {
    response = await fetchImpl("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, message: "Slack could not be reached." };
  }
  if (!response.ok) return { ok: false, message: `Slack answered HTTP ${response.status}.` };
  const result = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; team?: string; user?: string } | null;
  if (!result?.ok) return { ok: false, message: `Slack refused the bot token: ${result?.error ?? "unknown error"}.` };
  return { ok: true, message: `Slack accepts the bot token: the bot ${result.user ?? "(unnamed)"} in the workspace ${result.team ?? "(unnamed)"}.` };
}
