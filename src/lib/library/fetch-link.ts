import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import type { LookupFunction } from "node:net";

/*
 * Downloads a shared link for the worker. Links come from staff, so a link
 * must not reach the internal network: every address the host name resolves to
 * is checked when the connection is made (not before, which DNS could
 * change), redirects are followed by hand and checked the same way, and
 * the body is cut off at the upload limit.
 */

export class LinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkError";
  }
}

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["64:ff9b::", 96],
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

/** Loopback, private, link-local, and other addresses that are not on the public internet. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 6) {
    // IPv4-mapped IPv6 (::ffff:10.0.0.1) is checked as IPv4.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return blocked.check(mapped[1]!, "ipv4");
    return blocked.check(address, "ipv6");
  }
  return blocked.check(address, "ipv4");
}

/** A DNS lookup that refuses names resolving to non-public addresses. */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error, "", 4);
    const allowed = addresses.filter((entry) => !isPrivateAddress(entry.address));
    if (allowed.length === 0 || allowed.length !== addresses.length) {
      return callback(new LinkError(`The link points to an address that is not on the public internet.`), "", 4);
    }
    if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, allowed);
    callback(null, allowed[0]!.address, allowed[0]!.family);
  });
};

export interface FetchedLink {
  /** The URL after redirects. */
  url: string;
  /** The response's MIME type, lower-case, without parameters. */
  contentType: string;
  bytes: Uint8Array;
}

export interface FetchLinkOptions {
  maxBytes: number;
  /** Longest silence on the connection. */
  timeoutMs?: number;
  /** Longest time for one request, however slowly the site sends. */
  deadlineMs?: number;
  maxRedirects?: number;
  /**
   * Extra request headers, such as the Slack bot's token for a shared file.
   * Sent only to the link's own origin: a redirect to another host gets none.
   */
  headers?: Record<string, string>;
  /** Tests only: allow loopback addresses. */
  allowPrivateAddresses?: boolean;
}

const USER_AGENT = "Meldgrove-Library/1.0 (link fetcher)";

function requestOnce(
  url: URL,
  options: FetchLinkOptions,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; location?: string; contentType: string; bytes: Uint8Array }> {
  return new Promise((resolveRequest, rejectRequest) => {
    // A site that sends a byte now and then would otherwise hold the worker forever.
    const deadline = setTimeout(() => {
      const error = new LinkError("The download took too long.");
      rejectRequest(error);
      request.destroy(error);
    }, options.deadlineMs ?? 120_000);
    const resolve: typeof resolveRequest = (value) => {
      clearTimeout(deadline);
      resolveRequest(value);
    };
    const reject = (error: unknown) => {
      clearTimeout(deadline);
      rejectRequest(error);
    };
    const client = url.protocol === "https:" ? https : http;
    const literal = isIP(url.hostname.replace(/^\[|\]$/g, ""));
    if (literal && !options.allowPrivateAddresses && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ""))) {
      reject(new LinkError("The link points to an address that is not on the public internet."));
      return;
    }
    const request = client.request(
      url,
      {
        method: "GET",
        headers: { ...extraHeaders, "user-agent": USER_AGENT, accept: "text/html,application/pdf,text/plain;q=0.9,*/*;q=0.5" },
        lookup: options.allowPrivateAddresses ? undefined : publicOnlyLookup,
        timeout: options.timeoutMs ?? 30_000,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const contentType = String(response.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
        if (status >= 300 && status < 400) {
          response.resume();
          resolve({ status, location: response.headers.location, contentType, bytes: new Uint8Array() });
          return;
        }
        const declared = Number(response.headers["content-length"]);
        if (Number.isFinite(declared) && declared > options.maxBytes) {
          response.destroy();
          reject(new LinkError(`The linked file is larger than ${Math.round(options.maxBytes / 1_048_576)} MB.`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            response.destroy();
            reject(new LinkError(`The linked file is larger than ${Math.round(options.maxBytes / 1_048_576)} MB.`));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({ status, contentType, bytes: new Uint8Array(Buffer.concat(chunks)) }));
        response.on("error", (error) => reject(new LinkError(`The download failed: ${error.message}`)));
      },
    );
    request.on("timeout", () => request.destroy(new LinkError("The site did not answer in time.")));
    request.on("error", (error) => reject(error instanceof LinkError ? error : new LinkError(`The site could not be reached: ${error.message}`)));
    request.end();
  });
}

/** Downloads a link, following at most `maxRedirects` redirects. */
export async function fetchLink(link: string, options: FetchLinkOptions): Promise<FetchedLink> {
  let url = new URL(link);
  const origin = url.origin;
  for (let redirects = 0; ; redirects += 1) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new LinkError("Only web links (http and https) can be added.");
    const response = await requestOnce(url, options, url.origin === origin ? options.headers : undefined);
    if (response.status >= 300 && response.status < 400) {
      if (!response.location) throw new LinkError(`The site answered HTTP ${response.status} without a target.`);
      if (redirects >= (options.maxRedirects ?? 5)) throw new LinkError("The link redirects too often.");
      url = new URL(response.location, url);
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new LinkError(`The site answered HTTP ${response.status}.`);
    return { url: url.toString(), contentType: response.contentType, bytes: response.bytes };
  }
}
