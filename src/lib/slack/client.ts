import { fetchLink, LinkError } from "@/lib/library/fetch-link";

/*
 * What the worker asks Slack while it handles a message to the bot: the
 * sender's email address (users.info, scope users:read.email) and the shared
 * files (scope files:read). Files are downloaded through `fetchLink` like
 * every other link, with the bot token, and only from Slack's file server,
 * so the token never goes anywhere else.
 */

/** A failed Slack API call. A permanent one (a bad token, a missing scope) stays until someone changes the app. */
export class SlackApiError extends Error {
  readonly permanent: boolean;
  constructor(message: string, options: { permanent?: boolean } = {}) {
    super(message);
    this.name = "SlackApiError";
    this.permanent = options.permanent ?? false;
  }
}

export interface SlackFileDownload {
  url: string;
  /** The type Slack reports for the file. */
  mimetype?: string;
}

export interface SlackIntakeClient {
  /** The email address of a Slack user, or null for an unknown, deleted, or bot user, or one without an address. */
  userEmail(userId: string): Promise<string | null>;
  /** Downloads a shared file. Throws LinkError when it cannot be had. */
  downloadFile(file: SlackFileDownload, maxBytes: number): Promise<Uint8Array>;
}

/** Slack's file server; the bot token goes nowhere else. */
export const SLACK_FILE_HOST = "files.slack.com";

/** Slack errors that may pass. Every other one is permanent. */
const TEMPORARY = new Set(["ratelimited", "rate_limited", "internal_error", "fatal_error", "service_unavailable", "request_timeout"]);
/** Errors that mean there is no such (usable) user. */
const NO_USER = new Set(["user_not_found", "user_not_visible", "account_inactive"]);

interface UsersInfoResponse {
  ok: boolean;
  error?: string;
  user?: { deleted?: boolean; is_bot?: boolean; is_email_confirmed?: boolean; profile?: { email?: string } };
}

export function createSlackIntakeClient(
  token: string,
  options: { fetchImpl?: typeof fetch; download?: typeof fetchLink } = {},
): SlackIntakeClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const download = options.download ?? fetchLink;
  return {
    async userEmail(userId) {
      const url = new URL("https://slack.com/api/users.info");
      url.searchParams.set("user", userId);
      let response: Response;
      try {
        response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
      } catch (error) {
        throw new SlackApiError(`Slack users.info: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!response.ok) {
        throw new SlackApiError(`Slack users.info: HTTP ${response.status}`, { permanent: response.status !== 429 && response.status < 500 });
      }
      const result = (await response.json()) as UsersInfoResponse;
      if (!result.ok) {
        if (result.error && NO_USER.has(result.error)) return null;
        throw new SlackApiError(`Slack users.info: ${result.error ?? "unknown error"}`, { permanent: !result.error || !TEMPORARY.has(result.error) });
      }
      if (!result.user || result.user.deleted || result.user.is_bot) return null;
      // An address the person has not confirmed in Slack proves nothing.
      if (result.user.is_email_confirmed !== true) return null;
      return result.user.profile?.email?.trim() || null;
    },

    async downloadFile(file, maxBytes) {
      let url: URL;
      try {
        url = new URL(file.url);
      } catch {
        throw new LinkError("Slack sent no usable link to the file.");
      }
      if (url.protocol !== "https:" || url.hostname !== SLACK_FILE_HOST) throw new LinkError("The file is not on Slack's file server.");
      const fetched = await download(url.toString(), { maxBytes, headers: { Authorization: `Bearer ${token}` } });
      // Without the files:read scope, Slack answers with its sign-in page instead of the file.
      const landed = new URL(fetched.url);
      if (landed.hostname !== SLACK_FILE_HOST || (fetched.contentType === "text/html" && file.mimetype !== "text/html")) {
        throw new LinkError("Slack did not hand out the file. The Slack app needs the files:read scope.");
      }
      return fetched.bytes;
    },
  };
}
