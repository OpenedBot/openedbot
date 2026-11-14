import { describe, expect, test } from "bun:test";
import { proChunksIn, proModulesIn } from "../../scripts/solo-bundle-check";

const report = (chunks: { name: string; modules: string[] }[]) => ({
  chunks: chunks.map((chunk) => ({ ...chunk, fileName: `assets/${chunk.name}-x.js`, bytes: 1 })),
  assets: [],
});

describe("solo-bundle-check", () => {
  test("a solo bundle with only core modules passes", () => {
    const solo = report([{
      name: "index",
      modules: [
        "apps/console/src/route-tree.tsx",
        "apps/console/src/pro-console/registry.ts",
        "apps/console/src/pro-console/slots.tsx",
        "apps/console/src/components/workspace/workspace-navigation.tsx",
        "apps/console/src/components/workspace/workspace-access-boundary.tsx",
        "contracts/i18n/src/messages.fr.ts",
      ],
    }]);
    expect(proModulesIn(solo)).toEqual([]);
    expect(proChunksIn(solo)).toEqual([]);
  });

  test("catches a pro screen leaked into a core chunk, a pro package file and a pro-named chunk", () => {
    const leaked = report([
      { name: "index", modules: ["../pro/packages/pro-permissions/console/permission-rules.tsx"] },
      { name: "billing", modules: ["../pro/packages/pro-billing/console/billing.tsx"] },
      { name: "chunk", modules: ["../pro/packages/pro-staff/src/x.ts"] },
    ]);
    expect(proModulesIn(leaked).map((hit) => hit.feature)).toEqual(["permissions", "billing", "pro"]);
    expect(proChunksIn(leaked)).toEqual(["assets/billing-x.js"]);
  });
});
