import { describe, expect, it } from "vitest";
import { parseSlackText, readSlackRequest } from "./slack-intake";

describe("parseSlackText", () => {
  it("finds links in Slack's markup and keeps the rest as the reason", () => {
    expect(parseSlackText("<https://example.org/study?a=1&amp;b=2|example.org/study> - numbers on heat in small towns")).toEqual({
      links: ["https://example.org/study?a=1&b=2"],
      reason: "numbers on heat in small towns",
    });
    expect(parseSlackText("Good for the climate program: <https://example.org/a> and <http://example.org/b>")).toEqual({
      links: ["https://example.org/a", "http://example.org/b"],
      reason: "Good for the climate program: and",
    });
  });

  it("drops mentions and special words, keeps channel names, and decodes entities", () => {
    expect(parseSlackText("<@U123ABC> <!here> for <#C123ABC|climate> &amp; <mailto:ada@example.org|Ada>")).toEqual({
      links: [],
      reason: "for #climate & Ada",
    });
  });

  it("lists each link once and leaves no reason when there is only a link", () => {
    expect(parseSlackText("<https://example.org/a>  <https://example.org/a|again>")).toEqual({ links: ["https://example.org/a"], reason: "" });
    expect(parseSlackText("  ")).toEqual({ links: [], reason: "" });
  });

  it("takes only web links", () => {
    expect(parseSlackText("<ftp://example.org/x> <slack://open> why").links).toEqual([]);
  });
});

const event = (overrides: Record<string, unknown> = {}) => ({
  type: "event_callback",
  event_id: "Ev01",
  team_id: "T1",
  event: { type: "message", channel_type: "im", user: "U0ADA", channel: "D0ADA", text: "<https://example.org> why", ts: "1.2", ...overrides },
});

describe("readSlackRequest", () => {
  it("answers Slack's URL check", () => {
    expect(readSlackRequest({ type: "url_verification", token: "x", challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" })).toEqual({
      kind: "challenge",
      challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
    });
  });

  it("takes direct messages from people, with their files", () => {
    const request = readSlackRequest(
      event({
        subtype: "file_share",
        files: [{ id: "F1", name: "study.pdf", mimetype: "application/pdf", size: 1200, url_private_download: "https://files.slack.com/f/study.pdf", mode: "hosted" }],
      }),
    );
    expect(request).toEqual({
      kind: "message",
      event: {
        eventId: "Ev01",
        slackUserId: "U0ADA",
        channelId: "D0ADA",
        message: {
          text: "<https://example.org> why",
          ts: "1.2",
          files: [{ id: "F1", name: "study.pdf", mimetype: "application/pdf", size: 1200, urlPrivateDownload: "https://files.slack.com/f/study.pdf", mode: "hosted" }],
        },
      },
    });
  });

  it("ignores bots, edits, channels, and other events", () => {
    expect(readSlackRequest(event({ bot_id: "B1" })).kind).toBe("ignored");
    expect(readSlackRequest(event({ subtype: "message_changed" })).kind).toBe("ignored");
    expect(readSlackRequest(event({ channel_type: "channel", channel: "C0ABC" })).kind).toBe("ignored");
    expect(readSlackRequest(event({ type: "app_mention" })).kind).toBe("ignored");
    expect(readSlackRequest(event({ user: undefined })).kind).toBe("ignored");
    expect(readSlackRequest({ type: "app_rate_limited" }).kind).toBe("ignored");
    expect(readSlackRequest("nonsense").kind).toBe("ignored");
  });
});
