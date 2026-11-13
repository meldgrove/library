import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkAuthentication, emailLinks, emailReason, isAutomatic, readEmail, trimLink } from "./email-intake";

const fixture = async (name: string) => new Uint8Array(await readFile(path.resolve(import.meta.dirname, "../../../tests/fixtures/email", name)));

describe("checkAuthentication", () => {
  it("accepts DKIM signed by the sender's domain, also as header.i", () => {
    expect(checkAuthentication(["mx.example.net; dkim=pass header.d=example.org header.s=sel"], "example.org")).toEqual({ ok: true, reason: "dkim" });
    expect(checkAuthentication(["mx.google.com;\r\n       dkim=pass header.i=@Example.org header.s=google"], "example.org").ok).toBe(true);
  });

  it("accepts SPF for the sender's domain", () => {
    expect(checkAuthentication(["mx.example.net; dkim=none; spf=pass (mx: domain of a@example.org designates 192.0.2.1) smtp.mailfrom=a@example.org"], "example.org")).toEqual({
      ok: true,
      reason: "spf",
    });
    expect(checkAuthentication(["mx.example.net; spf=pass smtp.mailfrom=example.org"], "example.org").ok).toBe(true);
  });

  it("refuses failures, other domains, subdomains, and a missing header", () => {
    expect(checkAuthentication(["mx.example.net; dkim=fail header.d=example.org; spf=softfail smtp.mailfrom=a@example.org"], "example.org").ok).toBe(false);
    expect(checkAuthentication(["mx.example.net; dkim=pass header.d=mailer.example; spf=pass smtp.mailfrom=bounce@mailer.example"], "example.org").ok).toBe(false);
    expect(checkAuthentication(["mx.example.net; dkim=pass header.d=sub.example.org"], "example.org").ok).toBe(false);
    expect(checkAuthentication(["mx.example.net; dkim=pass header.d=example.org.evil.example"], "example.org").ok).toBe(false);
    expect(checkAuthentication(["mx.example.net; dmarc=pass header.from=example.org"], "example.org").ok).toBe(false);
    expect(checkAuthentication([], "example.org")).toEqual({ ok: false, reason: "no Authentication-Results header" });
  });

  it("trusts only the topmost header, which the receiving server adds", () => {
    expect(checkAuthentication(["mx.example.net; dkim=fail header.d=example.org", "mx.example.net; dkim=pass header.d=example.org"], "example.org").ok).toBe(false);
  });

  it("does not take a pass from inside a comment", () => {
    expect(checkAuthentication(["mx.example.net; dkim=neutral (dkim=pass header.d=example.org) header.d=example.org"], "example.org").ok).toBe(false);
  });
});

describe("isAutomatic", () => {
  const line = (key: string, value: string) => ({ key, line: `${key}: ${value}` });
  it("knows auto-replies, bounces, and list mail", () => {
    expect(isAutomatic([line("auto-submitted", "auto-replied")], "a@example.org")).toBe(true);
    expect(isAutomatic([line("precedence", "bulk")], "a@example.org")).toBe(true);
    expect(isAutomatic([line("list-id", "<news.example.org>")], "a@example.org")).toBe(true);
    expect(isAutomatic([line("return-path", "<>")], "a@example.org")).toBe(true);
    expect(isAutomatic([], "MAILER-DAEMON@example.org")).toBe(true);
    expect(isAutomatic([line("auto-submitted", "no"), line("return-path", "<a@example.org>")], "a@example.org")).toBe(false);
  });
});

describe("trimLink", () => {
  it("drops sentence punctuation and unmatched brackets, and keeps brackets the link opened", () => {
    expect(trimLink("https://en.wikipedia.org/wiki/Heat_(thermodynamics)")).toBe("https://en.wikipedia.org/wiki/Heat_(thermodynamics)");
    expect(trimLink("https://en.wikipedia.org/wiki/Heat_(thermodynamics).")).toBe("https://en.wikipedia.org/wiki/Heat_(thermodynamics)");
    expect(trimLink("https://example.org/report)")).toBe("https://example.org/report");
    expect(trimLink("https://example.org/a?x=1!).")).toBe("https://example.org/a?x=1");
  });
});

describe("emailLinks and emailReason", () => {
  it("takes links from the sender's own text only, without the organisation's domains", () => {
    const text = [
      "Worth reading: https://www.example.com/a?x=1&y=2, and (https://example.net/b).",
      "Our page: https://www.example.org/team and https://example.org",
      "> https://quoted.example.com/c",
      "-- ",
      "Ada · https://social.example.net/@ada",
    ].join("\n");
    expect(emailLinks(text, ["example.org"])).toEqual(["https://www.example.com/a?x=1&y=2", "https://example.net/b"]);
    expect(emailLinks("See below\n---------- Forwarded message ---------\nhttps://news.example.com/x", [])).toEqual([]);
    expect(emailLinks("https://a.example.com/x\nOn Mon, 9 Nov 2026 at 10:00, Dan <dan@example.org> wrote:\nhttps://b.example.com", [])).toEqual(["https://a.example.com/x"]);
  });

  it("takes the subject without reply prefixes, or the first line of the body", () => {
    expect(emailReason("Fwd: WG: Numbers on heat", "")).toBe("Numbers on heat");
    expect(emailReason("RE: AW:", "https://x.example.com\n\nGood overview of funding rules\nmore")).toBe("Good overview of funding rules");
    expect(emailReason(undefined, "https://x.example.com")).toBe("");
    expect(emailReason("", "The guide [https://x.example.com/guide]")).toBe("The guide");
  });
});

describe("readEmail", () => {
  it("reads sender, subject, text, authentication, and attachments", async () => {
    const email = await readEmail(await fixture("forwarded-study.eml"));
    expect(email).toMatchObject({ messageId: "<study-1@mail.example.org>", from: "ada@example.org", subject: "Fwd: Numbers on heat in small towns", automatic: false });
    expect(email.authenticationResults).toHaveLength(2);
    expect(checkAuthentication(email.authenticationResults, "example.org")).toEqual({ ok: true, reason: "dkim" });
    expect(email.attachments.map((a) => [a.fileName, a.contentType, a.inline])).toEqual([
      ["logo.png", "image/png", true],
      ["study.pdf", "application/pdf", false],
      ["numbers.xls", "application/vnd.ms-excel", false],
    ]);
    expect(Buffer.from(email.attachments[1]!.bytes).subarray(0, 5).toString()).toBe("%PDF-");
    expect(emailLinks(email.text, ["example.org"])).toEqual(["https://www.example.com/articles/heat-small-towns?utm_source=newsletter"]);
  });

  it("reads links from an HTML-only email", async () => {
    const email = await readEmail(await fixture("html-only.eml"));
    expect(emailLinks(email.text, ["example.org"])).toEqual(["https://funding.example.com/guide"]);
    expect(emailReason(email.subject, email.text)).toBe("Good overview of municipal funding rules");
    expect(checkAuthentication(email.authenticationResults, "example.org").ok).toBe(true);
  });

  it("finds spoofed and automatic messages", async () => {
    const spoofed = await readEmail(await fixture("spoofed.eml"));
    expect(checkAuthentication(spoofed.authenticationResults, "example.org").ok).toBe(false);
    expect((await readEmail(await fixture("auto-reply.eml"))).automatic).toBe(true);
  });
});
