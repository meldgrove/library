import { z } from "zod";
import type { NoteDraft } from "./draft";

/*
 * The replay test before launch: known items with their correct tags,
 * document type, and project, drafted again and compared. Pure functions;
 * `src/scripts/replay.ts` runs it.
 */

export const replayItemSchema = z
  .object({
    /** A file next to the test-set file, or a link. */
    file: z.string().min(1).optional(),
    url: z.url().optional(),
    reason: z.string().default(""),
    expected: z.object({
      tags: z.array(z.string()).default([]),
      documentType: z.string().nullable().optional(),
      project: z.string().nullable().optional(),
    }),
  })
  .refine((item) => Boolean(item.file) !== Boolean(item.url), { message: "Give either file or url." });

export const replaySetSchema = z.object({ items: z.array(replayItemSchema).min(1) });

export type ReplayItem = z.infer<typeof replayItemSchema>;

export interface ItemScore {
  /** Expected tags the draft found, as a share of the expected tags. */
  tagRecall: number;
  /** Tags of the draft that were expected, as a share of the draft's tags. */
  tagPrecision: number;
  documentType: boolean | null;
  project: boolean | null;
  /** The draft set a project where none was expected: the error the colleague's blind test found. */
  inventedProject: boolean;
}

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

export function scoreItem(expected: ReplayItem["expected"], draft: NoteDraft): ItemScore {
  const expectedTags = new Set(expected.tags.map((t) => t.toLowerCase()));
  const draftTags = new Set(draft.tags.map((t) => t.toLowerCase()));
  const hits = [...draftTags].filter((t) => expectedTags.has(t)).length;
  return {
    tagRecall: expectedTags.size === 0 ? 1 : hits / expectedTags.size,
    tagPrecision: draftTags.size === 0 ? (expectedTags.size === 0 ? 1 : 0) : hits / draftTags.size,
    documentType: expected.documentType === undefined ? null : same(expected.documentType, draft.documentType),
    project: expected.project === undefined ? null : same(expected.project, draft.project),
    inventedProject: !expected.project && Boolean(draft.project),
  };
}

export interface ReplaySummary {
  items: number;
  failed: number;
  tagRecall: number;
  tagPrecision: number;
  documentTypeAccuracy: number | null;
  projectAccuracy: number | null;
  inventedProjects: number;
}

const mean = (values: number[]) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);

export function summarize(scores: ItemScore[], failed: number): ReplaySummary {
  const types = scores.flatMap((s) => (s.documentType === null ? [] : [s.documentType ? 1 : 0]));
  const projects = scores.flatMap((s) => (s.project === null ? [] : [s.project ? 1 : 0]));
  return {
    items: scores.length + failed,
    failed,
    tagRecall: mean(scores.map((s) => s.tagRecall)) ?? 0,
    tagPrecision: mean(scores.map((s) => s.tagPrecision)) ?? 0,
    documentTypeAccuracy: mean(types),
    projectAccuracy: mean(projects),
    inventedProjects: scores.filter((s) => s.inventedProject).length,
  };
}
