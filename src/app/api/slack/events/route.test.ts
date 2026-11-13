import { beforeEach, describe, expect, it, vi } from "vitest";
import { slackSignature } from "@/lib/slack/signature";

const SECRET = "test-signing-secret";
const mocks = vi.hoisted(() => ({ recordSlackEvent: vi.fn(), secret: "test-signing-secret" as string | undefined }));

vi.mock("@/lib/config", () => ({ getSlackIntakeConfig: () => ({ SLACK_SIGNING_SECRET: mocks.secret }) }));
vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/library/slack-intake", async (importOriginal) => ({ ...(await importOriginal<object>()), recordSlackEvent: mocks.recordSlackEvent }));

const { POST } = await import("./route");

const send = (body: string, options: { timestamp?: number; signature?: string } = {}) => {
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  return POST(
    new Request("https://library.example/api/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": options.signature ?? slackSignature(SECRET, timestamp, body),
      },
      body,
    }),
  );
};

const message = JSON.stringify({
  type: "event_callback",
  event_id: "Ev01",
  event: { type: "message", channel_type: "im", user: "U0ADA", channel: "D0ADA", text: "<https://example.org> why", ts: "1.2" },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.secret = SECRET;
});

describe("POST /api/slack/events", () => {
  it("is off without a signing secret", async () => {
    mocks.secret = undefined;
    expect((await send(message)).status).toBe(404);
  });

  it("refuses unsigned, wrongly signed, and old requests", async () => {
    expect((await send(message, { signature: "v0=00" })).status).toBe(401);
    expect((await send(message, { timestamp: Math.floor(Date.now() / 1000) - 600 })).status).toBe(401);
    expect(mocks.recordSlackEvent).not.toHaveBeenCalled();
  });

  it("answers the URL check with the challenge", async () => {
    const response = await send(JSON.stringify({ type: "url_verification", challenge: "abc123" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "abc123" });
  });

  it("stores a direct message for the worker and answers at once", async () => {
    const response = await send(message);
    expect(response.status).toBe(200);
    expect(mocks.recordSlackEvent).toHaveBeenCalledWith({}, expect.objectContaining({ eventId: "Ev01", slackUserId: "U0ADA", channelId: "D0ADA" }));
  });

  it("acknowledges events it does not act on", async () => {
    const fromBot = JSON.parse(message) as { event: Record<string, unknown> };
    fromBot.event.bot_id = "B1";
    expect((await send(JSON.stringify(fromBot))).status).toBe(200);
    expect(mocks.recordSlackEvent).not.toHaveBeenCalled();
  });

  it("refuses bodies larger than an event and bodies that are not JSON", async () => {
    expect((await send("x".repeat(300 * 1_024))).status).toBe(413);
    expect((await send("not json")).status).toBe(400);
  });
});
