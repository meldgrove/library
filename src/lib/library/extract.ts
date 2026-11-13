import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import mammoth from "mammoth";
import { extractText as extractPdfText, getDocumentProxy, getMeta } from "unpdf";
import type { ExtractionMethod } from "./constants";
import type { FileType } from "./file-types";

export { ACCEPTED_TYPES, detectFileType, type FileType } from "./file-types";

/*
 * Text from an original: PDF, Word (.docx), web pages, and plain text. A PDF
 * without a text layer (a scan) goes through OCR when OCR_COMMAND is set.
 */

export interface Extracted {
  text: string;
  method: ExtractionMethod;
  /** From the document's metadata or the page's title. */
  title?: string;
  pages?: number;
}

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}

/** Fewer characters than this per page means a scan without a text layer. */
const SCAN_CHARS_PER_PAGE = 40;

/** Collapses runs of spaces and blank lines that PDFs and HTML leave behind. */
export function tidyText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface OcrOptions {
  /** A command that takes ocrmypdf's arguments, such as "ocrmypdf". Off when unset. */
  command?: string;
  /** Tesseract languages, such as "deu+eng". */
  languages: string;
  timeoutMs?: number;
}

const run = promisify(execFile);

/** Runs OCR on a PDF and returns the recognised text (ocrmypdf's sidecar file). */
async function ocrPdf(bytes: Uint8Array, options: Required<Pick<OcrOptions, "command" | "languages">> & { timeoutMs: number }): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "library-ocr-"));
  try {
    const input = path.join(directory, "in.pdf");
    const sidecar = path.join(directory, "text.txt");
    await writeFile(input, bytes);
    await run(
      options.command,
      ["--skip-text", "--sidecar", sidecar, "-l", options.languages, "--output-type", "pdf", input, path.join(directory, "out.pdf")],
      { timeout: options.timeoutMs, maxBuffer: 10 * 1024 * 1024 },
    );
    return await readFile(sidecar, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * The recognised text of each page from an ocrmypdf sidecar: pages are
 * separated by form feeds, and a run of pages it skipped (they have a text
 * layer) is one marker such as "[OCR skipped on page(s) 1-2]". Undefined for
 * skipped pages.
 */
export function parseSidecar(sidecar: string, pageCount: number): (string | undefined)[] {
  const pages: (string | undefined)[] = Array.from({ length: pageCount }, () => undefined);
  let next = 0;
  for (const chunk of sidecar.split("\f")) {
    const skipped = /^\s*\[OCR skipped on page\(s\) (\d+)(?:-(\d+))?\]\s*$/.exec(chunk);
    if (skipped) {
      next = Number(skipped[2] ?? skipped[1]);
      continue;
    }
    if (next < pageCount) pages[next] = chunk;
    next += 1;
  }
  return pages;
}

/** Each page's digital text, or its recognised text where the page is a scan and OCR found text. */
export function mergeOcrPages(digital: string[], scanned: boolean[], sidecar: string): string[] {
  const recognised = parseSidecar(sidecar, digital.length);
  return digital.map((page, index) => (scanned[index] && recognised[index]?.trim() ? recognised[index]! : page));
}

async function fromPdf(bytes: Uint8Array, ocr: OcrOptions): Promise<Extracted> {
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch (error) {
    throw new ExtractionError(`The PDF could not be read: ${(error as Error).message}`);
  }
  const [{ totalPages, text }, meta] = await Promise.all([
    extractPdfText(pdf, { mergePages: false }),
    getMeta(pdf).catch(() => null),
  ]);
  const title = typeof meta?.info?.Title === "string" && meta.info.Title.trim() ? meta.info.Title.trim() : undefined;
  const join = (pages: string[]) => tidyText(pages.map((page, index) => `[Page ${index + 1}]\n${page}`).join("\n\n"));
  // Pages without a text layer are scans: a whole scanned PDF, or scanned pages in a digital one.
  const scanned = text.map((page) => page.replace(/\s+/g, "").length < SCAN_CHARS_PER_PAGE);
  if (!scanned.some(Boolean)) return { text: join(text), method: "pdf", title, pages: totalPages };
  if (!ocr.command) {
    if (scanned.every(Boolean)) throw new ExtractionError("The PDF has no text layer (a scan), and text recognition (OCR) is not set up.");
    // Without OCR, the digital pages are better than nothing.
    return { text: join(text), method: "pdf", title, pages: totalPages };
  }
  let sidecar: string;
  try {
    sidecar = await ocrPdf(bytes, { command: ocr.command, languages: ocr.languages, timeoutMs: ocr.timeoutMs ?? 300_000 });
  } catch (error) {
    throw new ExtractionError(`Text recognition (OCR) failed: ${(error as Error).message.slice(0, 300)}`);
  }
  const pages = mergeOcrPages(text, scanned, sidecar);
  if (pages.every((page) => !page.trim())) throw new ExtractionError("Text recognition (OCR) found no text in the PDF.");
  return { text: join(pages), method: "ocr", title, pages: totalPages };
}

async function fromDocx(bytes: Uint8Array): Promise<Extracted> {
  try {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return { text: tidyText(result.value), method: "docx" };
  } catch (error) {
    throw new ExtractionError(`The Word file could not be read: ${(error as Error).message}`);
  }
}

/** The readable text of a web page: its main article, as a browser's reader view shows it. */
export function fromHtml(html: string): Extracted {
  const { document } = parseHTML(html);
  const fallbackTitle = document.querySelector("title")?.textContent?.trim() || undefined;
  // Readability changes the document; it runs on its own copy.
  const article = new Readability(parseHTML(html).document as unknown as Document).parse();
  const text = tidyText(article?.textContent ?? document.body?.textContent ?? "");
  return { text, method: "html", title: article?.title?.trim() || fallbackTitle };
}

function decodeText(bytes: Uint8Array): string {
  // UTF-8 first; text files from Windows are often Latin-1.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export async function extractText(bytes: Uint8Array, type: FileType, ocr: OcrOptions): Promise<Extracted> {
  switch (type) {
    case "pdf":
      return fromPdf(bytes, ocr);
    case "docx":
      return fromDocx(bytes);
    case "html":
      return fromHtml(decodeText(bytes));
    case "text": {
      const text = tidyText(decodeText(bytes));
      const firstLine = text.split("\n", 1)[0]?.replace(/^#+\s*/, "").trim();
      return { text, method: "text", title: firstLine && firstLine.length <= 200 ? firstLine : undefined };
    }
  }
}
