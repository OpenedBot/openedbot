import { describe, expect, test } from "bun:test";
import { isStrongCopyleft, isWeakCopyleft, licenseFromText, lockEntries, normalize } from "../license-scan";

describe("license-scan", () => {
  test("GPL and AGPL fail unless a non-copyleft alternative exists; LGPL is not GPL", () => {
    expect(isStrongCopyleft("GPL-3.0-only")).toBe(true);
    expect(isStrongCopyleft("AGPL-3.0-or-later")).toBe(true);
    expect(isStrongCopyleft("(GPL-2.0 OR GPL-3.0)")).toBe(true);
    expect(isStrongCopyleft("GPL (LICENSE file)")).toBe(true);
    expect(isStrongCopyleft("(MIT OR GPL-3.0)")).toBe(false);
    expect(isStrongCopyleft("LGPL-3.0-or-later")).toBe(false);
    expect(isStrongCopyleft("MIT")).toBe(false);
    expect(isWeakCopyleft("LGPL-2.1")).toBe(true);
    expect(isWeakCopyleft("(MPL-2.0 OR Apache-2.0)")).toBe(true);
    expect(isWeakCopyleft("Apache-2.0")).toBe(false);
  });

  test("reads bun.lock entries, skips workspaces, and marks other platforms with what nests under them", () => {
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "root" } },
      "packages": {
        "a": ["a@1.0.0", "", {}, "sha512-x"],
        "@s/b": ["@s/b@2.0.0", "", { "os": "linux" }, "sha512-y"],
        "@s/b/c": ["c@3.0.0", "", {}, "sha512-z"],
        "w": ["w@workspace:packages/w"],
      },
    }`;
    expect(lockEntries(lock)).toEqual([
      { key: "a", name: "a", version: "1.0.0", platformOnly: false },
      { key: "@s/b", name: "@s/b", version: "2.0.0", platformOnly: true },
      { key: "@s/b/c", name: "c", version: "3.0.0", platformOnly: true },
    ]);
  });

  test("normalizes manifest licences and recognizes LICENSE files", () => {
    expect(normalize({ type: "MIT" })).toBe("MIT");
    expect(normalize([{ type: "MIT" }, "Apache-2.0"])).toBe("(MIT OR Apache-2.0)");
    expect(normalize("")).toBeNull();
    expect(licenseFromText("                    GNU AFFERO GENERAL PUBLIC LICENSE\n Version 3")).toBe("AGPL (LICENSE file)");
    expect(licenseFromText("GNU LESSER GENERAL PUBLIC LICENSE")).toBe("LGPL (LICENSE file)");
  });
});
