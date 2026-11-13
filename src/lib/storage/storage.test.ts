import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it } from "vitest";
import { assertSafeKey, createFilesystemStorage, createS3Storage, originalKey } from "./index";

const bytes = new TextEncoder().encode("%PDF-1.7 test");
let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("keys", () => {
  it("keeps one original per SHA-256, spread over folders", () => {
    const sha = "a".repeat(64);
    expect(originalKey(sha)).toBe(`originals/aa/${sha}`);
    expect(() => originalKey("not-a-hash")).toThrow();
  });

  it("refuses keys that leave the storage", () => {
    expect(() => assertSafeKey("../etc/passwd")).toThrow();
    expect(() => assertSafeKey("originals//x")).toThrow();
    expect(() => assertSafeKey("/abs")).toThrow();
    expect(() => assertSafeKey("originals/aa/abc")).not.toThrow();
  });
});

describe("filesystem storage", () => {
  it("survives concurrent writes of the same key", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "library-storage-"));
    const storage = createFilesystemStorage(directory);
    await Promise.all(Array.from({ length: 10 }, () => storage.put("originals/aa/same", bytes, "application/pdf")));
    expect(Buffer.from((await storage.get("originals/aa/same"))!).toString()).toBe("%PDF-1.7 test");
  });

  it("stores, reads, and deletes files", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "library-storage-"));
    const storage = createFilesystemStorage(directory);
    await storage.put("originals/aa/one", bytes, "application/pdf");
    expect(await storage.exists("originals/aa/one")).toBe(true);
    expect(Buffer.from((await storage.get("originals/aa/one"))!).toString()).toBe("%PDF-1.7 test");
    await storage.delete("originals/aa/one");
    await storage.delete("originals/aa/one");
    expect(await storage.get("originals/aa/one")).toBeNull();
    expect(await storage.exists("originals/aa/one")).toBe(false);
  });
});

/** Runs against a real bucket when S3_TEST_ENDPOINT is set, e.g. http://localhost:9012 (compose.dev.yaml). */
describe.skipIf(!process.env.S3_TEST_ENDPOINT)("S3 storage", () => {
  it("stores, reads, and deletes objects", async () => {
    const config = {
      STORAGE_DRIVER: "s3" as const,
      S3_ENDPOINT: process.env.S3_TEST_ENDPOINT,
      S3_REGION: "us-east-1",
      S3_BUCKET: "library-test",
      S3_ACCESS_KEY_ID: process.env.S3_TEST_ACCESS_KEY_ID ?? "library",
      S3_SECRET_ACCESS_KEY: process.env.S3_TEST_SECRET_ACCESS_KEY ?? "library-dev-secret",
      S3_FORCE_PATH_STYLE: true,
    };
    const client = new S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: true,
      credentials: { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY },
    });
    await client.send(new CreateBucketCommand({ Bucket: config.S3_BUCKET })).catch((error: { name?: string }) => {
      if (error.name !== "BucketAlreadyOwnedByYou" && error.name !== "BucketAlreadyExists") throw error;
    });
    const storage = createS3Storage(config);
    const key = `test/${Date.now()}`;
    await storage.put(key, bytes, "application/pdf");
    expect(await storage.exists(key)).toBe(true);
    expect(Buffer.from((await storage.get(key))!).toString()).toBe("%PDF-1.7 test");
    await storage.delete(key);
    expect(await storage.get(key)).toBeNull();
    expect(await storage.exists(key)).toBe(false);
  });
});
