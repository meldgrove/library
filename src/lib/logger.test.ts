import { DrizzleQueryError } from "drizzle-orm";
import { expect, it } from "vitest";
import { createLogger, errorMessage } from "./logger";

it("omits database inputs from structured and string diagnostics", () => {
  const output: string[] = [];
  const logger = createLogger({ write: (line) => { output.push(line); } });
  logger.level = "warn";

  const cause = Object.assign(new Error("Invalid input: Example source text"), {
    code: "22P02",
    severity: "ERROR",
    detail: "The value was Example source text",
  });
  const error = new DrizzleQueryError("insert into source_text values ($1)", ["Example source text"], cause);
  const plain = { ...error, message: error.message, stack: error.stack };
  logger.warn({ err: plain, error: errorMessage(error) }, "database write failed");
  logger.warn({ err: cause, error: errorMessage(cause) }, "query failed");
  logger.warn({ err: plain });
  logger.warn(error);

  expect(output.join("")).not.toContain("Example source text");
  expect(JSON.parse(output[0]!)).toMatchObject({
    err: { message: "Database query failed (PostgreSQL 22P02)" },
    error: "Database query failed (PostgreSQL 22P02)",
    msg: "database write failed",
  });
  expect(JSON.parse(output[1]!)).toMatchObject({
    err: { message: "PostgreSQL error (22P02)" },
    error: "PostgreSQL error (22P02)",
  });
  for (const line of output.slice(2)) {
    expect(JSON.parse(line)).toMatchObject({
      msg: "Database query failed (PostgreSQL 22P02)",
      err: { message: "Database query failed (PostgreSQL 22P02)" },
    });
  }
});

it("keeps the message and stack for ordinary errors", () => {
  const output: string[] = [];
  const logger = createLogger({ write: (line) => { output.push(line); } });
  logger.level = "warn";
  const error = new Error("The service is unavailable.");
  logger.warn({ err: error }, "request failed");
  expect(JSON.parse(output[0]!)).toMatchObject({ err: { type: "Error", message: error.message, stack: error.stack } });
  expect(errorMessage(error)).toBe(error.message);
});

it("redacts the secret fields of the settings' bodies", () => {
  const output: string[] = [];
  const logger = createLogger({ write: (line) => { output.push(line); } });
  logger.level = "info";
  const body = {
    botToken: "xoxb-logged",
    signingSecret: "signing-logged",
    smtpUrl: "smtps://u:smtp-logged@mail.example.org",
    mailersendToken: "mlsn-logged",
    apiKey: "key-logged",
    imapUrl: "imaps://u:imap-logged@imap.example.org",
    secret: "webhook-logged",
    url: "https://hooks.example.org/url-logged",
  };
  logger.info({ body }, "a body");
  expect(output.join("")).not.toMatch(/logged/);
  expect(JSON.parse(output[0]!).body.apiKey).toBe("[redacted]");
});
