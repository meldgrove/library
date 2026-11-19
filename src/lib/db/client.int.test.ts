import { expect, it } from "vitest";
import { createPool } from "./client";
import { getDatabaseConfig } from "@/lib/config";

it("replaces an idle connection that PostgreSQL closes", async () => {
  const url = getDatabaseConfig().DATABASE_URL;
  const pool = createPool(url, "library-pool-test");
  const admin = createPool(url, "library-pool-test-admin");
  try {
    const { rows: [before] } = await pool.query<{ pid: number }>("select pg_backend_pid() as pid");
    // pg-pool emits an error after removing a broken idle client. An
    // unhandled error event would terminate the application process.
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
    await admin.query("select pg_terminate_backend($1, 5000)", [before!.pid]);
    await expect.poll(() => pool.idleCount).toBe(0);
    const { rows: [after] } = await pool.query<{ pid: number }>("select pg_backend_pid() as pid");
    expect(after!.pid).not.toBe(before!.pid);
  } finally {
    await Promise.all([pool.end(), admin.end()]);
  }
});
