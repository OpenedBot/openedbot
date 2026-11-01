import { describe, expect, test } from "bun:test";
import { isValidObjectKey, objectKey } from "../src/infrastructure/blob-store";

describe("blob object keys", () => {
  test("namespaces every object under its organization", () => {
    const organizationId = "00000000-0000-4000-8000-000000000001";
    const objectId = "00000000-0000-4000-8000-000000000002";
    expect(objectKey(organizationId, objectId)).toBe(`org/${organizationId}/${objectId}`);
  });

  test("rejects traversal and arbitrary keys", () => {
    expect(isValidObjectKey("org/../../secret")).toBe(false);
    expect(isValidObjectKey("public/file")).toBe(false);
  });
});
