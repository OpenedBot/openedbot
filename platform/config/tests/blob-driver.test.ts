import { describe, expect, test } from "bun:test";
import { fileBlobRoot, r2ConfigurationProblems, resolveBlobDriver } from "../src/blob-driver";

const r2 = {
  R2_BUCKET: "ohb-files",
  R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  R2_ACCESS_KEY_ID: "key-id",
  R2_SECRET_ACCESS_KEY: "secret",
};

describe("resolveBlobDriver", () => {
  test("keeps R2 when its four values are real", () => {
    expect(resolveBlobDriver({ BLOB_DRIVER: "r2", ...r2 }, true)).toEqual({ driver: "r2", fallbackReason: null });
    expect(resolveBlobDriver(r2, true)).toEqual({ driver: "r2", fallbackReason: null }); // production sans BLOB_DRIVER
  });

  test("falls back to the volume on neutralized, missing or unresolvable values", () => {
    const neutralized = resolveBlobDriver({ BLOB_DRIVER: "r2", ...r2, R2_ENDPOINT: "https://r2.invalid" }, true);
    expect(neutralized.driver).toBe("file");
    expect(neutralized.fallbackReason).toContain(".invalid");
    const placeholder = resolveBlobDriver({ BLOB_DRIVER: "r2", ...r2, R2_BUCKET: "alpha-r2-not-provisioned" }, true);
    expect(placeholder.fallbackReason).toContain("R2_BUCKET neutralisé");
    const empty = resolveBlobDriver({ BLOB_DRIVER: "r2" }, true);
    expect(empty.driver).toBe("file");
    expect(empty.fallbackReason).toContain("R2_ENDPOINT absent");
    expect(resolveBlobDriver({ BLOB_DRIVER: "r2", ...r2, R2_ENDPOINT: "pas une url" }, true).fallbackReason).toContain("pas une URL");
  });

  test("an explicit file driver and development are not fallbacks", () => {
    expect(resolveBlobDriver({ BLOB_DRIVER: "file", ...r2 }, true)).toEqual({ driver: "file", fallbackReason: null });
    expect(resolveBlobDriver({}, false)).toEqual({ driver: "file", fallbackReason: null });
    expect(() => resolveBlobDriver({ BLOB_DRIVER: "s3" }, false)).toThrow(/file or r2/);
  });

  test("lists every problem and places the volume by environment", () => {
    expect(r2ConfigurationProblems(r2)).toEqual([]);
    expect(r2ConfigurationProblems({ ...r2, R2_ACCESS_KEY_ID: " " }).join()).toContain("R2_ACCESS_KEY_ID absent");
    expect(fileBlobRoot({}, true)).toBe("/var/lib/ohb/blobs");
    expect(fileBlobRoot({}, false)).toBe(".data/blobs");
    expect(fileBlobRoot({ BLOB_FILE_ROOT: " /mnt/blobs " }, true)).toBe("/mnt/blobs");
  });
});
