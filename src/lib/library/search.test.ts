import { describe, expect, it, vi } from "vitest";
import { findNotes, libraryHref } from "./search";

describe("findNotes", () => {
  const signal = new AbortController().signal;
  const answer = (body: unknown, status = 200) => vi.fn(async () => Response.json(body, { status }));

  it("shows the notes of /api/search with their number as the reference and the document type as the kind", async () => {
    const request = answer({
      results: [
        { ref: "LIB-12", title: "Heat in small towns", kind: "Study", href: "/n/12" },
        { ref: "LIB-3", title: "Untyped note", kind: null, href: "/n/3" },
      ],
    });
    await expect(findNotes(" heat ", signal, request)).resolves.toEqual([
      { href: "/n/12", title: "Heat in small towns", reference: "LIB-12", kind: "Study" },
      { href: "/n/3", title: "Untyped note", reference: "LIB-3", kind: undefined },
    ]);
    expect(request).toHaveBeenCalledWith("/api/search?q=heat", { signal });
  });

  it("asks the server from two characters on, or for one digit", async () => {
    const request = answer({ results: [] });
    await expect(findNotes("h", signal, request)).resolves.toEqual([]);
    await expect(findNotes(" ", signal, request)).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
    await findNotes("7", signal, request);
    await findNotes("he", signal, request);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("fails when the search does not answer, so the frame says so", async () => {
    await expect(findNotes("heat", signal, answer({ error: "unauthorized" }, 401))).rejects.toThrow("401");
  });
});

describe("libraryHref", () => {
  it("opens the library filtered by the query", () => {
    expect(libraryHref("LIB-12 heat & shade")).toBe("/?q=LIB-12+heat+%26+shade");
  });
});
