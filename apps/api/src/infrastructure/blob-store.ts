import { isStrictUuid } from "@openedbot/contracts-primitives";
import { mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { createHmac } from "node:crypto";
import type { ApiConfig } from "./config";

export type BlobStore = {
  readonly driver: "file" | "r2";
  readonly metrics: BlobMetrics;
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Blob>;
  delete(key: string): Promise<void>;
  deliveryUrl(key: string, expiresInSeconds?: number): string | null;
};

export type BlobMetricsSnapshot = {
  writes: number;
  deletes: number;
  bytesWritten: number;
  bytesDeleted: number;
  errors: number;
};

export class BlobMetrics {
  private writes = 0;
  private deletes = 0;
  private bytesWritten = 0;
  private bytesDeleted = 0;
  private errors = 0;

  recordWrite(bytes: number): void {
    this.writes += 1;
    this.bytesWritten += bytes;
  }

  recordDelete(bytes = 0): void {
    this.deletes += 1;
    this.bytesDeleted += bytes;
  }

  recordError(): void {
    this.errors += 1;
  }

  snapshot(): BlobMetricsSnapshot {
    return {
      writes: this.writes,
      deletes: this.deletes,
      bytesWritten: this.bytesWritten,
      bytesDeleted: this.bytesDeleted,
      errors: this.errors,
    };
  }
}

export function createBlobStore(config: ApiConfig["blob"]): BlobStore {
  return config.driver === "file" ? new FileBlobStore(config.root) : new R2BlobStore(config);
}

export function objectKey(organizationId: string, objectId: string): string {
  if (!isStrictUuid(organizationId) || !isStrictUuid(objectId)) throw new Error("Invalid blob identity.");
  return `org/${organizationId}/${objectId}`;
}

export function isValidObjectKey(key: string): boolean {
  const shape = /^(org|support)\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/i.test(key);
  return shape && !key.includes("..") && !key.includes("\\");
}

class FileBlobStore implements BlobStore {
  readonly driver = "file" as const;
  readonly metrics = new BlobMetrics();
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(key: string, data: Uint8Array, _contentType: string): Promise<void> {
    try {
      const path = this.path(key);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await Bun.write(path, data);
      this.metrics.recordWrite(data.byteLength);
    } catch (error) {
      this.metrics.recordError();
      throw error;
    }
  }

  async get(key: string): Promise<Blob> {
    const file = Bun.file(this.path(key));
    if (!(await file.exists())) throw new Error("Blob not found.");
    return file;
  }

  async delete(key: string): Promise<void> {
    try {
      const file = Bun.file(this.path(key));
      if (await file.exists()) {
        const bytes = file.size;
        await file.delete();
        this.metrics.recordDelete(bytes);
      }
    } catch (error) {
      this.metrics.recordError();
      throw error;
    }
  }

  deliveryUrl(): null {
    return null;
  }

  private path(key: string): string {
    if (!isValidObjectKey(key)) throw new Error("Invalid blob key.");
    const path = resolve(this.root, key);
    if (path !== this.root && !path.startsWith(`${this.root}${sep}`)) throw new Error("Blob path escaped root.");
    return path;
  }
}

class R2BlobStore implements BlobStore {
  readonly driver = "r2" as const;
  readonly metrics = new BlobMetrics();
  private readonly client: Bun.S3Client;

  constructor(private readonly config: Extract<ApiConfig["blob"], { driver: "r2" }>) {
    this.client = new Bun.S3Client({
      bucket: config.bucket,
      endpoint: config.endpoint,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: "auto",
    });
  }

  async put(key: string, data: Uint8Array, contentType: string): Promise<void> {
    try {
      this.assertKey(key);
      await this.client.write(key, data, { type: contentType, acl: "private" });
      this.metrics.recordWrite(data.byteLength);
    } catch (error) {
      this.metrics.recordError();
      throw error;
    }
  }

  async get(key: string): Promise<Blob> {
    this.assertKey(key);
    return this.client.file(key);
  }

  async delete(key: string): Promise<void> {
    try {
      this.assertKey(key);
      await this.client.delete(key);
      this.metrics.recordDelete();
    } catch (error) {
      this.metrics.recordError();
      throw error;
    }
  }

  deliveryUrl(key: string, expiresInSeconds = 300): string {
    this.assertKey(key);
    const ttl = Math.max(1, Math.min(300, Math.floor(expiresInSeconds)));
    const expires = Math.floor(Date.now() / 1_000) + ttl;
    const signature = createHmac("sha256", this.config.cdnSigningKey)
      .update(`${key}\n${expires}`)
      .digest("base64url");
    const url = new URL(`${this.config.cdnUrl}/files/${key}`);
    url.searchParams.set("expires", String(expires));
    url.searchParams.set("signature", signature);
    return url.toString();
  }

  private assertKey(key: string): void {
    if (!isValidObjectKey(key)) throw new Error("Invalid R2 object key.");
  }
}
