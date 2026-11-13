import { createHash } from "node:crypto";

/*
 * What makes two uploads the same source: the file's SHA-256, the link
 * without tracking parameters, or the DOI in the text. Pure functions.
 */

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Query parameters that only track where a click came from. */
const TRACKING_PARAMETER = /^(?:utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|ref|ref_src|igshid|yclid|s_kwcid)$/i;

/**
 * The link as the library compares it: lower-case scheme and host, no
 * fragment, no default port, no tracking parameters, sorted remaining
 * parameters, no trailing slash. Returns null for anything but http(s).
 */
export function normalizeUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  url.username = "";
  url.password = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  const kept = [...url.searchParams.entries()].filter(([name]) => !TRACKING_PARAMETER.test(name));
  kept.sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  url.search = new URLSearchParams(kept).toString();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  let normalized = url.toString();
  if (url.pathname === "/" && !url.search) normalized = normalized.replace(/\/$/, "");
  // http and https lead to the same document.
  return normalized.replace(/^http:/, "https:");
}

/** DOIs (10.<registrant>/<suffix>) as printed in papers and links. */
const DOI = /\b(10\.\d{4,9}\/[^\s"'<>]+)/i;

/** The first DOI in the text or link, lower-cased, without trailing punctuation. */
export function findDoi(text: string): string | null {
  const head = text.slice(0, 20_000);
  // Links may carry the DOI URL-encoded (10.1371%2Fjournal…).
  const match = DOI.exec(head) ?? DOI.exec(head.replace(/%2F/gi, "/"));
  if (!match?.[1]) return null;
  let doi = match[1];
  try {
    doi = decodeURIComponent(doi);
  } catch {
    // Keep it as printed.
  }
  return doi.replace(/[.,;:)\]}]+$/, "").toLowerCase();
}
