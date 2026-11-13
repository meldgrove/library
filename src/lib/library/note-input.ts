import { z } from "zod";
import { NOTE_LIMITS, VISIBILITIES, type NoteQuote } from "./constants";

/*
 * The review form: what it sends and how lists are written in it. Key points
 * are one per line; quotes are one per line, with an optional location after
 * " | " ("42 percent lack funding | p. 12"). Pure functions, shared by the
 * form and the server.
 */

const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-•*]\s+/, "").trim())
    .filter(Boolean);

export const parseKeyPoints = (text: string): string[] => lines(text);

export function parseQuotes(text: string): NoteQuote[] {
  return lines(text).map((line) => {
    const separator = line.lastIndexOf(" | ");
    if (separator < 0) return { text: line.replace(/^["“„]|["”“]$/g, "") };
    const quote = line.slice(0, separator).trim().replace(/^["“„]|["”“]$/g, "");
    const location = line.slice(separator + 3).trim();
    return location ? { text: quote, location } : { text: quote };
  });
}

/** One line per entry: line breaks inside an entry would split it when the form is saved. */
export const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
export const formatKeyPoints = (points: string[]) => points.map(oneLine).join("\n");
export const formatQuotes = (quotes: NoteQuote[]) =>
  quotes.map((quote) => (quote.location ? `${oneLine(quote.text)} | ${oneLine(quote.location)}` : oneLine(quote.text))).join("\n");

/** New tag names typed by the reviewer, separated by commas. */
export const parseTagNames = (text: string) => [...new Set(text.split(",").map((name) => name.trim()).filter(Boolean))].slice(0, 5);

const optionalId = z.preprocess((value) => (value === "" || value === undefined ? null : value), z.uuid().nullable());

export const noteFormSchema = z.object({
  intent: z.enum(["save", "publish"]),
  title: z.string().trim().min(1, "Enter the title.").max(NOTE_LIMITS.title, `At most ${NOTE_LIMITS.title} characters.`),
  core: z.string().trim().min(1, "Enter the core in 2–3 sentences.").max(NOTE_LIMITS.core, `At most ${NOTE_LIMITS.core} characters.`),
  keyPoints: z
    .string()
    .transform(parseKeyPoints)
    .pipe(z.array(z.string().max(NOTE_LIMITS.keyPoints.item, `A key point has at most ${NOTE_LIMITS.keyPoints.item} characters.`)).max(NOTE_LIMITS.keyPoints.max, `At most ${NOTE_LIMITS.keyPoints.max} key points.`)),
  quotes: z
    .string()
    .default("")
    .transform(parseQuotes)
    .pipe(z.array(z.object({ text: z.string().max(NOTE_LIMITS.quotes.item, `A quote has at most ${NOTE_LIMITS.quotes.item} characters.`), location: z.string().max(40).optional() })).max(NOTE_LIMITS.quotes.max, `At most ${NOTE_LIMITS.quotes.max} quotes.`)),
  citation: z.string().trim().max(NOTE_LIMITS.citation, `At most ${NOTE_LIMITS.citation} characters.`).default(""),
  language: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^([a-z]{2})?$/, "Use a two-letter code such as de or en.")
    .transform((value) => value || null),
  documentTypeId: optionalId,
  projectId: optionalId,
  // A single checked box arrives as a string.
  tagIds: z.preprocess((value) => (typeof value === "string" ? [value] : (value ?? [])), z.array(z.uuid())),
  newTags: z.string().default("").transform(parseTagNames),
  visibility: z.enum(VISIBILITIES),
});

export type NoteFormInput = z.infer<typeof noteFormSchema>;
