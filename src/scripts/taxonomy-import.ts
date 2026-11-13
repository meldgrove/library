import { readFile } from "node:fs/promises";
import { getDatabaseConfig } from "@/lib/config";
import { getDb, getPool } from "@/lib/db/client";
import { importTaxonomy, taxonomyFileSchema } from "@/lib/library/taxonomy";
import { logger } from "@/lib/logger";

// Adds the clusters, tags, document types, and projects of a JSON file that
// are missing: `npm run taxonomy:import -- taxonomy.json`, or in the container
// `node dist/taxonomy-import.mjs /path/taxonomy.json`. Changes and removes
// nothing. The format is in docs/taxonomy.md.
async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: taxonomy-import <taxonomy.json>");
    process.exit(2);
  }
  getDatabaseConfig();
  const parsed = taxonomyFileSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) console.error(`- ${issue.path.join(".")}: ${issue.message}`);
    process.exit(1);
  }
  const counts = await importTaxonomy(getDb(), parsed.data);
  await getPool().end();
  console.log(JSON.stringify({ added: counts }, null, 2));
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "taxonomy import failed");
  process.exit(1);
});
