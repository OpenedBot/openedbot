import { isStrictUuid } from "@openedbot/contracts-primitives";
import { mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { createHmac } from "node:crypto";
import type { ApiConfig } from "./config";
import type { BlobOtherBackend } from "@openedbot/platform-config/blob-driver";

export type BlobDriver = "file" | "r2";

/**
 * `driver` est celui qui écrit. Lire, supprimer et servir un objet passent
 * par le driver que SA ligne a persisté (`attachments.driver`) : après une
 * bascule disque ↔ R2, un objet ancien reste lisible là où il a été écrit, et
 * une suppression ne se confirme jamais sur le mauvais magasin.
 */
export type BlobStore = {
  readonly driver: BlobDriver;
  readonly metrics: BlobMetrics;
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  get(key: string, driver: BlobDriver): Promise<Blob>;
  delete(key: string, driver: BlobDriver): Promise<void>;
  deliveryUrl(key: string, driver: BlobDriver, expiresInSeconds?: number): string | null;
};

/** L'objet vit sur un magasin que ce déploiement ne sait plus joindre. */
export class BlobDriverUnavailableError extends Error {
  constructor(readonly driver: BlobDriver) {
    super(`Blob driver ${driver} is not configured on this deployment.`);
    this.name = "BlobDriverUnavailableError";
  }
}

type DriverStore = {
  readonly driver: BlobDriver;
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

export function createBlobStore(config: ApiConfig["blob"], other: BlobOtherBackend): BlobStore {
  const metrics = new BlobMetrics();
  const primary: DriverStore = config.driver === "file"
    ? new FileBlobStore(config.root, metrics)
    : new R2BlobStore(config, config, metrics);
  const secondary: DriverStore | null = !other
    ? null
    : other.driver === "file"
      ? new FileBlobStore(other.root, metrics)
      // Sans CDN pour l'ancien magasin R2 : l'API sert l'objet elle-même.
      : new R2BlobStore(other, null, metrics);
  return new RoutedBlobStore(primary, secondary, metrics);
}

class RoutedBlobStore implements BlobStore {
  readonly driver: BlobDriver;

  constructor(
    private readonly primary: DriverStore,
    private readonly secondary: DriverStore | null,
    readonly metrics: BlobMetrics,
  ) {
    this.driver = primary.driver;
  }

  put(key: string, data: Uint8Array, contentType: string): Promise<void> {
    return this.primary.put(key, data, contentType);
  }

  async get(key: string, driver: BlobDriver): Promise<Blob> {
    return this.store(driver).get(key);
  }

  async delete(key: string, driver: BlobDriver): Promise<void> {
    return this.store(driver).delete(key);
  }

  deliveryUrl(key: string, driver: BlobDriver, expiresInSeconds?: number): string | null {
    return this.store(driver).deliveryUrl(key, expiresInSeconds);
  }

  private store(driver: BlobDriver): DriverStore {
    if (this.primary.driver === driver) return this.primary;
    if (this.secondary?.driver === driver) return this.secondary;
    throw new BlobDriverUnavailableError(driver);
  }
}

export function objectKey(organizationId: string, objectId: string): string {
  if (!isStrictUuid(organizationId) || !isStrictUuid(objectId)) throw new Error("Invalid blob identity.");
  return `org/${organizationId}/${objectId}`;
}

export function isValidObjectKey(key: string): boolean {
  const shape = /^(org|support)\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/i.test(key);
  return shape && !key.includes("..") && !key.includes("\\");
}

class FileBlobStore implements DriverStore {
  readonly driver = "file" as const;
  private readonly root: string;

  constructor(root: string, private readonly metrics: BlobMetrics) {
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

type R2Access = { bucket: string; endpoint: string; accessKeyId: string; secretAccessKey: string };

class R2BlobStore implements DriverStore {
  readonly driver = "r2" as const;
  private readonly client: Bun.S3Client;

  constructor(
    config: R2Access,
    private readonly cdn: { cdnUrl: string; cdnSigningKey: string } | null,
    private readonly metrics: BlobMetrics,
  ) {
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

  deliveryUrl(key: string, expiresInSeconds = 300): string | null {
    this.assertKey(key);
    if (!this.cdn) return null;
    const ttl = Math.max(1, Math.min(300, Math.floor(expiresInSeconds)));
    const expires = Math.floor(Date.now() / 1_000) + ttl;
    const signature = createHmac("sha256", this.cdn.cdnSigningKey)
      .update(`${key}\n${expires}`)
      .digest("base64url");
    const url = new URL(`${this.cdn.cdnUrl}/files/${key}`);
    url.searchParams.set("expires", String(expires));
    url.searchParams.set("signature", signature);
    return url.toString();
  }

  private assertKey(key: string): void {
    if (!isValidObjectKey(key)) throw new Error("Invalid R2 object key.");
  }
}
