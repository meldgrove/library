import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAiLimitsConfig, getDatabaseConfig, getOcrConfig, getUploadConfig } from "@/lib/config";
import { getDb, getPool } from "@/lib/db/client";
import { draftModelFromSettings, draftNote } from "@/lib/library/draft";
import { detectFileType, extractText } from "@/lib/library/extract";
import { fetchLink } from "@/lib/library/fetch-link";
import { replaySetSchema, scoreItem, summarize, type ItemScore } from "@/lib/library/replay";
import { draftLists } from "@/lib/library/taxonomy";
import { logger } from "@/lib/logger";
import { aiValues, createSettingsReader } from "@/lib/settings/runtime";
import { getSettingsKey } from "@/lib/settings/secret-box";

// The replay test before launch (gate B): drafts every item of a test set with
// the AI model of Admin › Integrations and today's taxonomy, and compares tags, document
// type, and topic area with the known answers. Writes nothing.
//   npm run replay -- test-set.json
// The format is in docs/taxonomy.md.
async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: replay <test-set.json>");
    process.exit(2);
  }
  getDatabaseConfig();
  const set = replaySetSchema.parse(JSON.parse(await readFile(file, "utf8")));
  const limits = getAiLimitsConfig();
  const model = draftModelFromSettings(limits.AI_FAKE ? null : aiValues(await createSettingsReader(getDb(), getSettingsKey()).read("ai")), limits);
  if (!model) {
    console.error("No AI model is set up: set one under Admin › Integrations, or with `cli settings apply ai`.");
    await getPool().end();
    process.exit(1);
  }
  const ocrConfig = getOcrConfig();
  const ocr = { command: ocrConfig.OCR_COMMAND, languages: ocrConfig.OCR_LANGUAGES };
  const lists = await draftLists(getDb());
  const maxBytes = getUploadConfig().UPLOAD_MAX_MB * 1_048_576;
  const scores: ItemScore[] = [];
  let failed = 0;
  for (const [index, item] of set.items.entries()) {
    const label = item.file ?? item.url!;
    try {
      let text: string;
      if (item.file) {
        const bytes = new Uint8Array(await readFile(path.resolve(path.dirname(file), item.file)));
        const type = detectFileType(bytes, item.file);
        if (!type) throw new Error("unknown file type");
        text = (await extractText(bytes, type, ocr)).text;
      } else {
        const fetched = await fetchLink(item.url!, { maxBytes });
        const type = detectFileType(fetched.bytes, new URL(fetched.url).pathname, fetched.contentType);
        if (!type) throw new Error("unknown file type");
        text = (await extractText(fetched.bytes, type, ocr)).text;
      }
      const draft = await draftNote(model, { text, reason: item.reason, ...lists });
      const score = scoreItem(item.expected, draft);
      scores.push(score);
      console.log(`${index + 1}. ${label}: tags ${draft.tags.join(", ") || "-"} | recall ${score.tagRecall.toFixed(2)} | type ${score.documentType ?? "-"} | topic area ${score.topicArea ?? "-"}${score.inventedTopicArea ? " (invented)" : ""}`);
    } catch (error) {
      failed += 1;
      console.log(`${index + 1}. ${label}: FAILED ${(error as Error).message}`);
    }
  }
  await getPool().end();
  console.log(JSON.stringify(summarize(scores, failed), null, 2));
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "replay failed");
  process.exit(1);
});
