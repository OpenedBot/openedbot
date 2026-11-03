import { describe, expect, test } from "bun:test";
import { artifactObjectKey, isValidArtifactObjectKey } from "../src/application/artifact-store";

describe("artifact object keys", () => {
  test("namespaces every object under its organization", () => {
    const organizationId = "00000000-0000-4000-8000-000000000001";
    const objectId = "00000000-0000-4000-8000-000000000002";
    expect(artifactObjectKey(organizationId, objectId)).toBe(`org/${organizationId}/${objectId}`);
  });

  test("rejects traversal and arbitrary keys", () => {
    expect(isValidArtifactObjectKey("org/../../secret")).toBe(false);
    expect(isValidArtifactObjectKey("public/file")).toBe(false);
  });
});
