import { describe, expect, it } from "vitest";
import { slackSignature, verifySlackSignature } from "./signature";

// The example from Slack's documentation on verifying requests.
const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const BODY =
  "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
const TIMESTAMP = "1531420618";
const SIGNATURE = "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503";
const at = (seconds: number) => new Date(seconds * 1000);

describe("verifySlackSignature", () => {
  it("computes Slack's signature", () => {
    expect(slackSignature(SECRET, TIMESTAMP, BODY)).toBe(SIGNATURE);
  });

  it("accepts a fresh, correctly signed request", () => {
    expect(verifySlackSignature({ signingSecret: SECRET, signature: SIGNATURE, timestamp: TIMESTAMP, body: BODY, now: at(1531420618 + 60) })).toBe(true);
  });

  it("refuses a changed body, another secret, or a wrong signature", () => {
    const base = { signingSecret: SECRET, signature: SIGNATURE, timestamp: TIMESTAMP, body: BODY, now: at(1531420618) };
    expect(verifySlackSignature({ ...base, body: `${BODY}&x=1` })).toBe(false);
    expect(verifySlackSignature({ ...base, signingSecret: "another-secret" })).toBe(false);
    expect(verifySlackSignature({ ...base, signature: "v0=abc" })).toBe(false);
    expect(verifySlackSignature({ ...base, signature: SIGNATURE.replace(/.$/, "4") })).toBe(false);
    expect(verifySlackSignature({ ...base, signature: null })).toBe(false);
  });

  it("refuses requests older or newer than five minutes, and odd timestamps", () => {
    const base = { signingSecret: SECRET, signature: SIGNATURE, timestamp: TIMESTAMP, body: BODY };
    expect(verifySlackSignature({ ...base, now: at(1531420618 + 301) })).toBe(false);
    expect(verifySlackSignature({ ...base, now: at(1531420618 - 301) })).toBe(false);
    expect(verifySlackSignature({ ...base, now: at(1531420618 + 300) })).toBe(true);
    expect(verifySlackSignature({ ...base, timestamp: "1531420618.5", now: at(1531420618) })).toBe(false);
    expect(verifySlackSignature({ ...base, timestamp: null })).toBe(false);
  });
});
