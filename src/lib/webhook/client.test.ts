import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createWebhookClient, signWebhook, WebhookError } from "./client";
import { noteRemovedPayload } from "./payload";

const SECRET = "a-long-enough-secret";

function setup(response: Response | Error = new Response(null, { status: 204 })) {
  const fetchImpl = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  const client = createWebhookClient({ url: "https://hooks.example.org/library", secret: SECRET, fetch: fetchImpl as unknown as typeof fetch, now: () => 1_700_000_000_000 });
  return { client, fetchImpl };
}

describe("createWebhookClient", () => {
  it("posts the payload signed over the timestamp and the raw body", async () => {
    const { client, fetchImpl } = setup();
    await client.send(noteRemovedPayload("n1"));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.example.org/library");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    const headers = init.headers as Record<string, string>;
    expect(headers["library-timestamp"]).toBe("1700000000");
    const expected = `sha256=${createHmac("sha256", SECRET).update(`1700000000.${String(init.body)}`).digest("hex")}`;
    expect(headers["library-signature"]).toBe(expected);
    expect(headers["library-delivery"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(String(init.body))).toEqual({ event: "note.removed", note: { id: "n1" } });
  });

  it("signs like the documented receiver check", () => {
    expect(signWebhook(SECRET, 1, "{}")).toBe(`sha256=${createHmac("sha256", SECRET).update("1.{}").digest("hex")}`);
  });

  it("reports answers other than 2xx and failed requests", async () => {
    await expect(setup(new Response("nope", { status: 500 })).client.send(noteRemovedPayload("n1"))).rejects.toThrow("The webhook answered HTTP 500 nope");
    const error = await setup(new TypeError("fetch failed")).client.send(noteRemovedPayload("n1")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebhookError);
    expect((error as Error).message).toBe("Request to https://hooks.example.org failed: fetch failed");
  });
});
