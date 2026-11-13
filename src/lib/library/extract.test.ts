import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectFileType, extractText, fromHtml, mergeOcrPages, parseSidecar, tidyText } from "./extract";

const fixture = async (name: string) => new Uint8Array(await readFile(path.resolve(import.meta.dirname, "../../../tests/fixtures/files", name)));
const noOcr = { languages: "deu+eng" };

describe("detectFileType", () => {
  it("trusts the first bytes over the name", async () => {
    expect(detectFileType(await fixture("study.pdf"), "renamed.txt")).toBe("pdf");
    expect(detectFileType(await fixture("guideline.docx"), "guideline.docx")).toBe("docx");
    expect(detectFileType(await fixture("guideline.docx"), "sheet.xlsx")).toBeNull();
    expect(detectFileType(await fixture("guideline.docx"), "/files/guideline", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx");
    expect(detectFileType(new TextEncoder().encode("<!DOCTYPE html><html></html>"), "page")).toBe("html");
    expect(detectFileType(new TextEncoder().encode("# Notes\nplain"), "notes.md")).toBe("text");
    expect(detectFileType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]), "image.png")).toBeNull();
  });
});

describe("extractText", () => {
  it("reads the text and title of a PDF, page by page", async () => {
    const result = await extractText(await fixture("study.pdf"), "pdf", noOcr);
    expect(result).toMatchObject({ method: "pdf", title: "Municipal climate adaptation", pages: 2 });
    expect(result.text).toContain("[Page 1]");
    expect(result.text).toContain("42 percent lack funding");
    expect(result.text).toContain("[Page 2]");
  });

  it("refuses a scan when OCR is not set up", async () => {
    await expect(extractText(await fixture("scan.pdf"), "pdf", noOcr)).rejects.toThrow(/no text layer/);
  });

  it("keeps the digital pages of a mixed PDF and recognises only its scanned pages", async () => {
    const command = path.resolve(import.meta.dirname, "../../../tests/fixtures/bin/fake-ocrmypdf");
    const result = await extractText(await fixture("mixed.pdf"), "pdf", { command, languages: "deu+eng" });
    expect(result.method).toBe("ocr");
    expect(result.text).toMatch(/^\[Page 1\]\nMunicipal climate adaptation in Germany[\s\S]*\[Page 2\]\nRecommendations from the scanned page/);
    expect(result.text).not.toContain("OCR skipped");
    // Without OCR, the digital page is kept.
    const digitalOnly = await extractText(await fixture("mixed.pdf"), "pdf", noOcr);
    expect(digitalOnly).toMatchObject({ method: "pdf", pages: 2 });
    expect(digitalOnly.text).toContain("42 percent lack funding");
  });

  it("reports a failing OCR command instead of hanging", async () => {
    await expect(extractText(await fixture("scan.pdf"), "pdf", { command: "/nonexistent/ocrmypdf", languages: "eng" })).rejects.toThrow(
      /OCR\) failed/,
    );
  });

  it("reads Word files", async () => {
    const result = await extractText(await fixture("guideline.docx"), "docx", noOcr);
    expect(result.method).toBe("docx");
    expect(result.text).toContain("Funding guideline 2026");
    expect(result.text).toContain("Applications close on 31 March.");
  });

  it("takes the first line of a text file as its title", async () => {
    const result = await extractText(new TextEncoder().encode("# Field notes\n\nSome   text."), "text", noOcr);
    expect(result).toEqual({ text: "# Field notes\n\nSome text.", method: "text", title: "Field notes" });
  });

  it("reads Latin-1 text files", async () => {
    const result = await extractText(new Uint8Array([0x46, 0xfc, 0x72]), "text", noOcr);
    expect(result.text).toBe("Für");
  });
});

describe("fromHtml", () => {
  it("keeps the article and drops navigation", () => {
    const paragraph = "Cities need shade. ".repeat(30);
    const html = `<html><head><title>Heat report | Example</title></head><body><nav>Home About Contact</nav><article><h1>Heat report</h1><p>${paragraph}</p><p>${paragraph}</p></article><footer>Imprint</footer></body></html>`;
    const result = fromHtml(html);
    expect(result.method).toBe("html");
    expect(result.title).toContain("Heat report");
    expect(result.text).toContain("Cities need shade.");
    expect(result.text).not.toContain("Imprint");
  });
});

describe("OCR sidecar", () => {
  it("places recognised pages after a run of skipped pages", () => {
    expect(parseSidecar("[OCR skipped on page(s) 1-2]\fRecommendations\n", 3)).toEqual([undefined, undefined, "Recommendations\n"]);
    expect(parseSidecar("Scan one\f[OCR skipped on page(s) 2]\fScan three", 3)).toEqual(["Scan one", undefined, "Scan three"]);
  });

  it("keeps a short digital page that OCR skipped", () => {
    const digital = ["Climate report 2026", "A long digital page about heat plans and funding.", ""];
    const scanned = [true, false, true];
    expect(mergeOcrPages(digital, scanned, "[OCR skipped on page(s) 1-2]\fScanned annex")).toEqual([
      "Climate report 2026",
      "A long digital page about heat plans and funding.",
      "Scanned annex",
    ]);
  });
});

describe("tidyText", () => {
  it("collapses spaces and blank lines", () => {
    expect(tidyText("a  \t b\r\n\n\n\nc ")).toBe("a b\n\nc");
  });
});
