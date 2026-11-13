import { describe, expect, it, vi } from "vitest";
import { createDateFormatter, dateToken } from "@/lib/format";
import { emailContent, slackText } from "./format-message";
import { createMailerSendTransport, createSlackTransport, createSmtpTransport, DeliveryError } from "./transports";
import type { NotificationMessage } from "./types";

const MESSAGE: NotificationMessage = {
  subject: "Review your draft: LIB-12 Tools <& costs>",
  title: "LIB-12 · Tools <& costs>",
  text: "The AI draft of your upload is ready. Check it and publish it.",
  path: "/n/12",
};

const fmt = createDateFormatter();

describe("message formats", () => {
  it("link the title in Slack and escape control characters", () => {
    expect(slackText(MESSAGE, "https://library.example/", fmt)).toBe(
      [
        "*<https://library.example/n/12|LIB-12 · Tools &lt;&amp; costs&gt;>*",
        "The AI draft of your upload is ready. Check it and publish it.",
      ].join("\n"),
    );
  });

  it("write dates in the reader's format", () => {
    const message = { ...MESSAGE, text: `Uploaded on ${dateToken("2026-11-06")}.` };
    expect(slackText(message, "https://library.example", createDateFormatter({ dateFormat: "MM/DD/YYYY" })).split("\n")[1]).toBe(
      "Uploaded on Friday, 11/06/2026.",
    );
  });

  it("list digest sections with linked notes, summary, and tags", () => {
    const digest: NotificationMessage = {
      subject: "Library: 1 new note",
      title: "Weekly digest",
      text: "1 new note this week.",
      path: "/",
      sections: [
        {
          heading: "Climate <policy>",
          items: [{ ref: "LIB-3", title: "Heat & cities", path: "/n/3", summary: "Cities heat up.", meta: "Study · climate" }],
        },
      ],
    };
    expect(slackText(digest, "https://library.example", fmt).split("\n")).toEqual([
      "*<https://library.example/|Weekly digest>*",
      "1 new note this week.",
      "",
      "*Climate &lt;policy&gt;*",
      "• <https://library.example/n/3|LIB-3 · Heat &amp; cities>: Cities heat up. _Study · climate_",
    ]);
    const email = emailContent(digest, "Ana", "https://library.example", fmt);
    expect(email.text).toContain("Climate <policy>\n- LIB-3 · Heat & cities: Cities heat up. (Study · climate)\n  https://library.example/n/3");
    expect(email.html).toContain('<li><a href="https://library.example/n/3">LIB-3 · Heat &amp; cities</a>: Cities heat up. <em>Study · climate</em></li>');
  });

  it("write emails in text and escaped HTML", () => {
    const email = emailContent(MESSAGE, "Ana <Admin>", "https://library.example", fmt);
    expect(email.subject).toBe(MESSAGE.subject);
    expect(email.text).toContain("Hello Ana <Admin>,\n\nThe AI draft of your upload is ready.");
    expect(email.text).toContain("https://library.example/n/12");
    expect(email.html).toContain("Hello Ana &lt;Admin&gt;,");
    expect(email.html).toContain('<a href="https://library.example/n/12">LIB-12 · Tools &lt;&amp; costs&gt;</a>');
  });
});

function fakeFetch(...responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("no response");
    return next;
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });

describe("Slack", () => {
  it("looks up a user by work email with the bot token", async () => {
    const { fetchImpl, calls } = fakeFetch(json({ ok: true, user: { id: "U123" } }));
    await expect(createSlackTransport("xoxb-1", fetchImpl).lookupUserByEmail("ana@example.org")).resolves.toBe("U123");
    expect(calls[0]!.url).toBe("https://slack.com/api/users.lookupByEmail?email=ana%40example.org");
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: "Bearer xoxb-1" });
  });

  it("treats an unknown or deactivated user as no Slack account", async () => {
    const { fetchImpl } = fakeFetch(json({ ok: false, error: "users_not_found" }), json({ ok: true, user: { id: "U9", deleted: true } }));
    const slack = createSlackTransport("xoxb-1", fetchImpl);
    await expect(slack.lookupUserByEmail("x@example.org")).resolves.toBeNull();
    await expect(slack.lookupUserByEmail("y@example.org")).resolves.toBeNull();
  });

  it("sends a direct message to the user ID, without link previews", async () => {
    const { fetchImpl, calls } = fakeFetch(json({ ok: true }));
    await createSlackTransport("xoxb-1", fetchImpl).postMessage("U123", "Hello");
    expect(calls[0]!.url).toBe("https://slack.com/api/chat.postMessage");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ channel: "U123", text: "Hello", unfurl_links: false, unfurl_media: false });
  });

  it("reports Slack errors and rate limits so the worker can retry", async () => {
    const { fetchImpl } = fakeFetch(json({ ok: false, error: "invalid_auth" }), new Response("", { status: 429, headers: { "Retry-After": "30" } }));
    const slack = createSlackTransport("xoxb-1", fetchImpl);
    await expect(slack.postMessage("U1", "x")).rejects.toMatchObject({ name: "DeliveryError", code: "invalid_auth" });
    const limited = await slack.postMessage("U1", "x").catch((error: unknown) => error);
    expect(limited).toBeInstanceOf(DeliveryError);
    expect((limited as DeliveryError).retryAfterMs).toBe(30_000);
  });

  it("marks errors that trying again cannot fix as permanent", async () => {
    const { fetchImpl } = fakeFetch(
      json({ ok: false, error: "invalid_auth" }),
      json({ ok: false, error: "missing_scope" }),
      json({ ok: false, error: "channel_not_found" }),
      json({ ok: false, error: "internal_error" }),
      json({ ok: false, error: "ratelimited" }),
      json({ ok: false, error: "rate_limited" }),
      new Response("", { status: 429 }),
      new Response("", { status: 503 }),
      new Response("", { status: 404 }),
      json({ ok: false }),
    );
    const slack = createSlackTransport("xoxb-1", fetchImpl);
    const permanent = async (send: Promise<unknown>) => ((await send.catch((error: unknown) => error)) as DeliveryError).permanent;
    expect(await permanent(slack.postMessage("U1", "x"))).toBe(true);
    expect(await permanent(slack.lookupUserByEmail("ana@example.org"))).toBe(true);
    expect(await permanent(slack.postMessage("U1", "x"))).toBe(true);
    expect(await permanent(slack.postMessage("U1", "x"))).toBe(false);
    expect(await permanent(slack.postMessage("U1", "x"))).toBe(false);
    expect(await permanent(slack.postMessage("U1", "x"))).toBe(false);
    expect(await permanent(slack.postMessage("U1", "x"))).toBe(false);
    expect(await permanent(slack.postMessage("U1", "x"))).toBe(false);
    expect(await permanent(slack.postMessage("U1", "x"))).toBe(true);
    expect(await permanent(slack.postMessage("U1", "x"))).toBe(false); // no error code
    expect(await permanent(slack.postMessage("U1", "x"))).toBe(false); // no response at all
  });
});

describe("MailerSend", () => {
  const options = { token: "mlsn.secret", from: "library@example.org", fromName: "Meldgrove Library" };
  const email = { to: "ana@example.org", toName: "Ana", subject: "S", text: "T", html: "<p>T</p>" };

  it("sends from the configured address", async () => {
    const { fetchImpl, calls } = fakeFetch(new Response(null, { status: 202 }));
    await createMailerSendTransport(options, fetchImpl).send(email);
    expect(calls[0]!.url).toBe("https://api.mailersend.com/v1/email");
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: "Bearer mlsn.secret" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      from: { email: "library@example.org", name: "Meldgrove Library" },
      to: [{ email: "ana@example.org", name: "Ana" }],
      subject: "S",
      text: "T",
      html: "<p>T</p>",
    });
  });

  it("reports a rejected email with the status and body", async () => {
    const { fetchImpl } = fakeFetch(new Response('{"message":"The from.email domain must be verified"}', { status: 422 }));
    await expect(createMailerSendTransport(options, fetchImpl).send(email)).rejects.toThrow(/HTTP 422 .*must be verified/);
  });

  it("treats a rejected email as permanent, and outages and rate limits as temporary", async () => {
    const { fetchImpl } = fakeFetch(new Response("", { status: 401 }), new Response("", { status: 429 }), new Response("", { status: 502 }));
    const transport = createMailerSendTransport(options, fetchImpl);
    const permanent = async () => ((await transport.send(email).catch((error: unknown) => error)) as DeliveryError).permanent;
    expect([await permanent(), await permanent(), await permanent(), await permanent()]).toEqual([true, false, false, false]);
  });
});

describe("SMTP", () => {
  const email = { to: "ana@example.org", toName: "Ana", subject: "S", text: "T", html: "<p>T</p>" };

  function fakeNodemailer(sendMail: (message: unknown) => Promise<unknown>) {
    const created: unknown[] = [];
    const createTransport = ((options: unknown) => {
      created.push(options);
      return { sendMail };
    }) as unknown as Parameters<typeof createSmtpTransport>[1];
    return { createTransport, created };
  }

  it("sends through the SMTP URL from the configured address", async () => {
    const sendMail = vi.fn(async () => ({ messageId: "1" }));
    const { createTransport, created } = fakeNodemailer(sendMail);
    await createSmtpTransport({ url: "smtps://user:pass@mail.example.org:465", from: "library@example.org", fromName: "Meldgrove Library" }, createTransport).send(email);
    expect(created[0]).toEqual({
      url: "smtps://user:pass@mail.example.org:465",
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 15_000,
    });
    expect(sendMail).toHaveBeenCalledWith({
      from: { name: "Meldgrove Library", address: "library@example.org" },
      to: { name: "Ana", address: "ana@example.org" },
      subject: "S",
      text: "T",
      html: "<p>T</p>",
    });
  });

  it("reports a rejected email with the server's reply code", async () => {
    const error = Object.assign(new Error("Mailbox unavailable"), { responseCode: 550, code: "EENVELOPE" });
    const { createTransport } = fakeNodemailer(async () => Promise.reject(error));
    const transport = createSmtpTransport({ url: "smtp://mail.example.org", from: "library@example.org", fromName: "Meldgrove Library" }, createTransport);
    await expect(transport.send(email)).rejects.toThrow(/SMTP 550: Mailbox unavailable/);
    await expect(transport.send(email)).rejects.toBeInstanceOf(DeliveryError);
  });

  it("treats 5xx replies and failed logins as permanent, 4xx replies and connection errors as temporary", async () => {
    const errors = [
      Object.assign(new Error("Mailbox unavailable"), { responseCode: 550, code: "EENVELOPE" }),
      Object.assign(new Error("Invalid login"), { responseCode: 535, code: "EAUTH" }),
      Object.assign(new Error("Missing credentials"), { code: "EAUTH" }),
      Object.assign(new Error("Try again later"), { responseCode: 421, code: "EENVELOPE" }),
      Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" }),
    ];
    const { createTransport } = fakeNodemailer(async () => Promise.reject(errors.shift()));
    const transport = createSmtpTransport({ url: "smtp://mail.example.org", from: "library@example.org", fromName: "Meldgrove Library" }, createTransport);
    const permanent = async () => ((await transport.send(email).catch((error: unknown) => error)) as DeliveryError).permanent;
    expect([await permanent(), await permanent(), await permanent(), await permanent(), await permanent()]).toEqual([true, true, true, false, false]);
  });
});
