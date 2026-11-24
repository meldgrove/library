import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isOperator, operator } from "@/lib/settings/actor";

const SRC = path.resolve(import.meta.dirname, "..");

const callers = (pattern: RegExp) =>
  readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .filter((file) => pattern.test(readFileSync(path.join(SRC, file), "utf8")))
    .filter((file) => file !== path.join("lib", "settings", "actor.ts"));

describe("the operator", () => {
  it("is created only by the command line, never by a page, a Server Action, or a route", () => {
    // A call, or an import of operator (also under another name).
    const files = callers(/\boperator\(|import\s*\{[^}]*\boperator\b[^}]*\}\s*from\s*"[^"]*settings\/actor"/);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file) => file.startsWith(`cli${path.sep}`)), files.join()).toBe(true);
  });

  it("does not survive JSON, so no request body or Server Action argument can stand for it", () => {
    expect(isOperator(operator("cli settings apply email"))).toBe(true);
    expect(isOperator(JSON.parse(JSON.stringify(operator("cli settings apply email"))))).toBe(false);
    expect(isOperator({ command: "cli settings apply email" })).toBe(false);
  });
});
