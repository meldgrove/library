import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
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
    const error = await setup(new TypeError("fetch failed")).client.send(noteRemovedPayload("n1")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebhookError);
    expect((error as Error).message).toBe("Request to https://hooks.example.org failed: fetch failed");
  });

  it("names only the server in errors, also when fetch quotes the URL it refuses", async () => {
    const client = createWebhookClient({ url: "https://user:info-token@hooks.example.org/path-token?key=query-token", secret: SECRET });
    const error = await client.send(noteRemovedPayload("n1")).catch((e: unknown) => e);
    expect((error as Error).message).toBe("Request to https://hooks.example.org failed: Request cannot be constructed from a URL that includes credentials: https://hooks.example.org");
    expect(String((error as Error).cause)).not.toContain("token");
  });

  it.each([200, 500])("cancels the response body for HTTP %i and uses the status alone", async (status) => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("receiver diagnostics"));
        controller.close();
      },
      cancel,
    }), { status });
    const sent = setup(response).client.send(noteRemovedPayload("n1"));
    if (status === 200) await expect(sent).resolves.toBeUndefined();
    else await expect(sent).rejects.toThrow(/^The webhook answered HTTP 500$/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("reports a redirect without sending the payload to its target", async () => {
    const requests: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url);
      if (request.url === "/library") response.writeHead(307, { location: "/target" }).end();
      else response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const client = createWebhookClient({ url: `http://127.0.0.1:${port}/library`, secret: SECRET, timeoutMs: 1_000 });
      await expect(client.send(noteRemovedPayload("n1"))).rejects.toThrow(/^The webhook answered HTTP 307$/);
      expect(requests).toEqual(["/library"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
