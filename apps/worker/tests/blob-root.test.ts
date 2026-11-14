import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { sharedFileBlobRoot } from "../src/config";

describe("sharedFileBlobRoot", () => {
  test("un chemin absolu reste le magasin commun", () => {
    expect(sharedFileBlobRoot("/var/openedbot/blobs", "/srv/apps/worker")).toBe("/var/openedbot/blobs");
  });

  test("depuis apps/worker, un chemin relatif vise le magasin de l'API", () => {
    expect(sharedFileBlobRoot(".data/blobs", "/repo/apps/worker")).toBe(
      resolve("/repo/apps/api", ".data/blobs"),
    );
  });

  test("hors du paquet worker, le chemin relatif reste local", () => {
    expect(sharedFileBlobRoot(".data/blobs", "/repo")).toBe(resolve("/repo", ".data/blobs"));
  });
});
