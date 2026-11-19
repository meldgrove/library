import { describe, expect, it } from "vitest";
import type { NoteDraft } from "./draft";
import { replaySetSchema, scoreItem, summarize } from "./replay";

const draft = (fields: Partial<NoteDraft>): NoteDraft => ({
  title: "t",
  core: "c",
  keyPoints: [],
  quotes: [],
  citation: "",
  language: "en",
  documentType: null,
  topicArea: null,
  tags: [],
  proposedTags: [],
  visibility: "all",
  uncertainFields: [],
  ...fields,
});

describe("replay", () => {
  it("scores tags, document type, and topic area", () => {
    const score = scoreItem({ tags: ["Climate", "Funding"], documentType: "Study", topicArea: null }, draft({ tags: ["climate", "Cities"], documentType: "study", topicArea: "Climate" }));
    expect(score).toEqual({ tagRecall: 0.5, tagPrecision: 0.5, documentType: true, topicArea: false, inventedTopicArea: true });
  });

  it("skips what the test set does not state", () => {
    expect(scoreItem({ tags: [] }, draft({ topicArea: "Climate" }))).toMatchObject({ tagRecall: 1, documentType: null, topicArea: null, inventedTopicArea: false });
  });

  it("summarizes, counting failed drafts", () => {
    const summary = summarize(
      [
        { tagRecall: 1, tagPrecision: 1, documentType: true, topicArea: null, inventedTopicArea: false },
        { tagRecall: 0.5, tagPrecision: 0.5, documentType: false, topicArea: true, inventedTopicArea: true },
      ],
      1,
    );
    expect(summary).toEqual({ items: 3, failed: 1, tagRecall: 0.75, tagPrecision: 0.75, documentTypeAccuracy: 0.5, topicAreaAccuracy: 1, inventedTopicAreas: 1 });
  });

  it("needs a file or a link per item", () => {
    expect(replaySetSchema.safeParse({ items: [{ expected: { tags: [] } }] }).success).toBe(false);
    expect(replaySetSchema.safeParse({ items: [{ file: "a.pdf", expected: { tags: ["x"] } }] }).success).toBe(true);
  });
});
