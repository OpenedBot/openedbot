import { describe, expect, test } from "bun:test";
import { ProfileDeleteError } from "../src/domain/errors";
import { parseDeleteJobSlugs } from "../src/application/host-profile-delete";

describe("parseDeleteJobSlugs", () => {
  test("accepte une liste unique de slugs valides", () => {
    expect(parseDeleteJobSlugs({ slugs: ["scout", "atlas", "scout"] })).toEqual(["scout", "atlas"]);
  });

  test("refuse default, un slug invalide, une liste vide ou trop longue", () => {
    expect(() => parseDeleteJobSlugs({ slugs: ["default"] })).toThrow(ProfileDeleteError);
    expect(() => parseDeleteJobSlugs({ slugs: ["Scout"] })).toThrow(ProfileDeleteError);
    expect(() => parseDeleteJobSlugs({ slugs: [] })).toThrow(ProfileDeleteError);
    expect(() => parseDeleteJobSlugs({ slugs: Array.from({ length: 65 }, (_, i) => `p${i}`) })).toThrow(ProfileDeleteError);
    expect(() => parseDeleteJobSlugs({})).toThrow(ProfileDeleteError);
  });
});
