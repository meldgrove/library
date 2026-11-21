import { describe, expect, it } from "vitest";
import { idParam, pageParam } from "./list-params";

describe("the library page's query parameters", () => {
  it("reads a page number, and takes anything else as page 1", () => {
    expect(pageParam("3")).toBe(3);
    expect(pageParam(["2", "9"])).toBe(2);
    for (const value of [undefined, "", "0", "-1", "1.5", "1e30", "0x10", "Infinity", "12345678901234567890", "abc"]) expect(pageParam(value)).toBe(1);
  });

  it("reads a UUID, and nothing else", () => {
    const id = "0b1f6a0e-5d2c-4c53-9a3e-7c1d2e3f4a5b";
    expect(idParam(id)).toBe(id);
    expect(idParam(id.toUpperCase())).toBe(id.toUpperCase());
    for (const value of [undefined, "", "-".repeat(36), "0b1f6a0e5d2c-4c53-9a3e-7c1d-2e3f4a5b----", `${id}x`]) expect(idParam(value)).toBeUndefined();
  });
});
