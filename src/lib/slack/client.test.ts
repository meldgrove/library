import { describe, expect, it, vi } from "vitest";
import type { fetchLink } from "@/lib/library/fetch-link";
import { createSlackIntakeClient, SlackApiError } from "./client";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Slack intake client", () => {
  it("reads the sender's email address with the bot token", async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, user: { id: "U1", is_email_confirmed: true, profile: { email: "Ada@Example.org " } } }));
    const client = createSlackIntakeClient("xoxb-test", { fetchImpl });
    expect(await client.userEmail("U1")).toBe("Ada@Example.org");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://slack.com/api/users.info?user=U1");
    expect(init.headers).toEqual({ Authorization: "Bearer xoxb-test" });
  });

  it("knows no address for unknown, deleted, and bot users, nor an unconfirmed one", async () => {
    const answers = [json({ ok: false, error: "user_not_found" }), json({ ok: true, user: { deleted: true, profile: { email: "x@example.org" } } }), json({ ok: true, user: { is_bot: true } }), json({ ok: true, user: { is_email_confirmed: true, profile: {} } }), json({ ok: true, user: { is_email_confirmed: false, profile: { email: "unconfirmed@example.org" } } }), json({ ok: true, user: { profile: { email: "unknown@example.org" } } })];
    const client = createSlackIntakeClient("xoxb-test", { fetchImpl: async () => answers.shift()! });
    for (let i = 0; i < 6; i += 1) expect(await client.userEmail("U1")).toBeNull();
  });

  it("tells permanent from temporary errors", async () => {
    const answer = (response: Response) => createSlackIntakeClient("xoxb-test", { fetchImpl: async () => response }).userEmail("U1");
    await expect(answer(json({ ok: false, error: "missing_scope" }))).rejects.toMatchObject({ permanent: true });
    await expect(answer(json({ ok: false, error: "ratelimited" }))).rejects.toMatchObject({ permanent: false });
    await expect(answer(new Response("", { status: 503 }))).rejects.toMatchObject({ permanent: false });
    await expect(answer(new Response("", { status: 429 }))).rejects.toBeInstanceOf(SlackApiError);
  });

  it("downloads files only from Slack's file server, with the token", async () => {
    const download = vi.fn<typeof fetchLink>(async (url) => ({ url, contentType: "application/pdf", bytes: new Uint8Array([1, 2]) }));
    const client = createSlackIntakeClient("xoxb-test", { download });
    expect(await client.downloadFile({ url: "https://files.slack.com/files-pri/T1-F1/download/study.pdf", mimetype: "application/pdf" }, 100)).toEqual(new Uint8Array([1, 2]));
    expect(download).toHaveBeenCalledWith("https://files.slack.com/files-pri/T1-F1/download/study.pdf", { maxBytes: 100, headers: { Authorization: "Bearer xoxb-test" } });
    await expect(client.downloadFile({ url: "https://evil.example/files.slack.com/x.pdf" }, 100)).rejects.toThrow(/not on Slack's file server/);
    await expect(client.downloadFile({ url: "http://files.slack.com/x.pdf" }, 100)).rejects.toThrow(/not on Slack's file server/);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("refuses Slack's sign-in page instead of the file", async () => {
    const signIn = createSlackIntakeClient("xoxb-test", { download: async () => ({ url: "https://acme.slack.com/?redir=x", contentType: "text/html", bytes: new Uint8Array() }) });
    await expect(signIn.downloadFile({ url: "https://files.slack.com/files-pri/T1-F1/download/a.pdf", mimetype: "application/pdf" }, 100)).rejects.toThrow(/files:read/);
    const page = createSlackIntakeClient("xoxb-test", { download: async (url) => ({ url, contentType: "text/html", bytes: new Uint8Array() }) });
    await expect(page.downloadFile({ url: "https://files.slack.com/files-pri/T1-F1/download/a.pdf", mimetype: "application/pdf" }, 100)).rejects.toThrow(/files:read/);
    expect(await page.downloadFile({ url: "https://files.slack.com/files-pri/T1-F1/download/a.html", mimetype: "text/html" }, 100)).toEqual(new Uint8Array());
  });
});
