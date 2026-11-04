import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(import.meta.dir, "../../..", path), "utf8");

describe("le rail d'icônes", () => {
  test("le compte reste à plat : ni menu, ni avatar, ni déconnexion", () => {
    const rails = read("src/components/boardui/board-rails.tsx");
    for (const gone of ["AccountMenu", "RailSignOut", "RailAccountButton", "OperatorBlob"]) {
      expect(rails).not.toContain(gone);
    }
  });

  test("le quota LLM restant se pose juste au-dessus du runtime (demande du 04-11-2026)", () => {
    const rails = read("src/components/boardui/board-rails.tsx");
    expect(rails.indexOf("<RailLlmQuotas")).toBeGreaterThan(-1);
    expect(rails.indexOf("<RailLlmQuotas")).toBeLessThan(rails.indexOf("<RailRuntimeHealth"));
  });

  test("le thème et la langue se règlent dans Réglages > Apparence, plus dans le rail", () => {
    const rails = read("src/components/boardui/board-rails.tsx");
    expect(rails).not.toContain("useTheme");
    expect(rails).not.toContain("setLocale");
    // Le squelette et la silhouette d'`index.html` suivent le rail, sinon il saute au chargement.
    expect(read("src/components/skeletons/frame-skeletons.tsx")).not.toMatch(/RiSunLine|RiMoonLine/);
    expect(read("index.html")).not.toMatch(/class="(sun|moon|lang)"/);

    const appearance = read("src/screens/settings/general/appearance.tsx");
    expect(appearance).toContain("onChange={setLocale}");
    expect(appearance).toContain("onChange={theme.setMode}");
  });
});
