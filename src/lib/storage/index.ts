import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getStorageConfig, type StorageConfig } from "@/lib/config";

/*
 * Where originals are kept. Keys are paths such as "originals/ab/abcdef…";
 * callers never build file paths or bucket URLs themselves.
 */

export interface Storage {
  kind: "filesystem" | "s3";
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** The bytes, or null when the key does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  exists(key: string): Promise<boolean>;
  /** Deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
}

/** Keys are made by the library: letters, digits, dashes, dots, and slashes, never "..". */
export function assertSafeKey(key: string): void {
  if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(key) || key.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`Invalid storage key: ${key}`);
  }
}

/** The key of an original, by its SHA-256. One copy per file. */
export function originalKey(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Invalid SHA-256");
  return `originals/${sha256.slice(0, 2)}/${sha256}`;
}

export function createFilesystemStorage(directory: string): Storage {
  const fileOf = (key: string) => {
    assertSafeKey(key);
    return path.join(directory, key);
  };
  return {
    kind: "filesystem",
    async put(key, bytes) {
      const file = fileOf(key);
      await mkdir(path.dirname(file), { recursive: true });
      // Write, then rename: a reader never sees half a file.
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes);
      await rename(temporary, file);
    },
    async get(key) {
      try {
        return new Uint8Array(await readFile(fileOf(key)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async exists(key) {
      try {
        return (await stat(fileOf(key))).isFile();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    async delete(key) {
      await rm(fileOf(key), { force: true });
    },
  };
}

const isNotFound = (error: unknown) => {
  const named = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return named.name === "NoSuchKey" || named.name === "NotFound" || named.$metadata?.httpStatusCode === 404;
};

export function createS3Storage(config: Extract<StorageConfig, { STORAGE_DRIVER: "s3" }>, client?: S3Client): Storage {
  const s3 =
    client ??
    new S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY },
      // Hetzner and MinIO do not support the newer default checksums on every operation.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  const Bucket = config.S3_BUCKET;
  return {
    kind: "s3",
    async put(key, bytes, contentType) {
      assertSafeKey(key);
      await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: bytes, ContentType: contentType }));
    },
    async get(key) {
      assertSafeKey(key);
      try {
        const response = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
        return response.Body ? await response.Body.transformToByteArray() : new Uint8Array();
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async exists(key) {
      assertSafeKey(key);
      try {
        await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
        return true;
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },
    async delete(key) {
      assertSafeKey(key);
      await s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}

export function createStorage(config: StorageConfig): Storage {
  return config.STORAGE_DRIVER === "s3" ? createS3Storage(config) : createFilesystemStorage(config.STORAGE_DIR);
}

const globalForStorage = globalThis as unknown as { libraryStorage?: Storage };

export function getStorage(): Storage {
  globalForStorage.libraryStorage ??= createStorage(getStorageConfig());
  return globalForStorage.libraryStorage;
}
