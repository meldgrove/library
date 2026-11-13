import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { createDb, type Database } from "@/lib/db/client";

export interface TestDatabase {
  pool: Pool;
  db: Database;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** Connects to the test database prepared by global-setup.ts. */
export function connectTestDatabase(): TestDatabase {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TEST_DATABASE_URL is not set");
  const pool = new Pool({ connectionString, max: 5 });
  const db = createDb(pool);
  return {
    pool,
    db,
    async reset() {
      await db.execute(sql`
        truncate table auth_session, auth_account, auth_verification, auth_user,
          notification_delivery, app_setting, audit_event, rate_limit,
          tag_proposal, note_version, note_reason, note_tag, submission, note, source_text, source,
          storage_cleanup, webhook_sync, slack_event, email_message, tag_subscription, tag, tag_cluster, document_type, project,
          person, team, directory_sync_run, worker_heartbeat
        restart identity cascade
      `);
    },
    close: () => pool.end(),
  };
}
