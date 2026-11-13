import path from "node:path";

/*
 * The file types the library takes, and how to recognise them. No heavy
 * imports, so pages and the upload route can use it without the extractors.
 */

export type FileType = "pdf" | "docx" | "html" | "text";

export const ACCEPTED_TYPES: Record<FileType, { label: string; mimeType: string; extensions: string[] }> = {
  pdf: { label: "PDF", mimeType: "application/pdf", extensions: [".pdf"] },
  docx: {
    label: "Word",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extensions: [".docx"],
  },
  html: { label: "Web page", mimeType: "text/html", extensions: [".html", ".htm"] },
  text: { label: "Text", mimeType: "text/plain", extensions: [".txt", ".md", ".markdown"] },
};

/** The `accept` attribute of the upload field. */
export const ACCEPT_ATTRIBUTE = Object.values(ACCEPTED_TYPES)
  .flatMap((type) => [type.mimeType, ...type.extensions])
  .join(",");

const startsWith = (bytes: Uint8Array, prefix: string) => {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) if (bytes[i] !== prefix.charCodeAt(i)) return false;
  return true;
};

/**
 * The type of a file, from its first bytes; the name and the declared MIME
 * type only decide between text formats. Null for anything the library does
 * not take (images, spreadsheets, old .doc files, archives).
 */
export function detectFileType(bytes: Uint8Array, fileName: string, declaredMimeType = ""): FileType | null {
  if (startsWith(bytes, "%PDF-")) return "pdf";
  const extension = path.extname(fileName).toLowerCase();
  // A .docx is a zip file; other zip files (spreadsheets, archives) are not taken.
  if (startsWith(bytes, "PK\u0003\u0004")) return extension === ".docx" || declaredMimeType.startsWith(ACCEPTED_TYPES.docx.mimeType) ? "docx" : null;
  // Binary files have NUL bytes early on; text formats do not.
  if (bytes.subarray(0, 8_192).includes(0)) return null;
  const head = Buffer.from(bytes.subarray(0, 1_024)).toString("utf8").trimStart().toLowerCase();
  if (extension === ".html" || extension === ".htm" || declaredMimeType.startsWith("text/html") || head.startsWith("<!doctype html") || head.startsWith("<html")) {
    return "html";
  }
  if (ACCEPTED_TYPES.text.extensions.includes(extension) || declaredMimeType.startsWith("text/")) return "text";
  return null;
}

/**
 * Whether a file's name or declared type is one the library takes, before it
 * is downloaded (e.g. from Slack). `detectFileType` decides on the bytes.
 */
export function looksAccepted(fileName: string, declaredMimeType = ""): boolean {
  const extension = path.extname(fileName).toLowerCase();
  const mimeType = declaredMimeType.split(";")[0]!.trim().toLowerCase();
  return Object.values(ACCEPTED_TYPES).some((type) => type.extensions.includes(extension) || type.mimeType === mimeType) || mimeType === "text/markdown";
}

/** "PDF, Word, Web page, Text": what the upload rules name. */
export const ACCEPTED_LABELS = Object.values(ACCEPTED_TYPES)
  .map((type) => type.label)
  .join(", ");
