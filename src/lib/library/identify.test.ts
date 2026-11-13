import { describe, expect, it } from "vitest";
import { findDoi, normalizeUrl, sha256Hex } from "./identify";

describe("normalizeUrl", () => {
  it("drops tracking parameters, the fragment, www, and trailing slashes", () => {
    expect(normalizeUrl("HTTPS://www.Example.org/report/?utm_source=x&b=2&a=1#section")).toBe("https://example.org/report?a=1&b=2");
    expect(normalizeUrl("http://example.org/")).toBe("https://example.org");
    expect(normalizeUrl("https://example.org/a/b/")).toBe("https://example.org/a/b");
  });

  it("treats the same document behind http and https as one", () => {
    expect(normalizeUrl("http://example.org/x.pdf")).toBe(normalizeUrl("https://example.org/x.pdf"));
  });

  it("refuses anything but web links", () => {
    expect(normalizeUrl("ftp://example.org/file")).toBeNull();
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });

  it("drops credentials in the link", () => {
    expect(normalizeUrl("https://user:secret@example.org/x")).toBe("https://example.org/x");
  });
});

describe("findDoi", () => {
  it("finds a DOI in text and in a link, lower-cased and without trailing punctuation", () => {
    expect(findDoi("See doi:10.1038/S41586-020-2649-2.")).toBe("10.1038/s41586-020-2649-2");
    expect(findDoi("https://doi.org/10.1371%2Fjournal.pone.0001")).toBe("10.1371/journal.pone.0001");
    expect(findDoi("No identifier here")).toBeNull();
  });
});

describe("sha256Hex", () => {
  it("hashes bytes", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
