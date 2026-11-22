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

  test("le quota LLM et le runtime tiennent dans une seule pilule « Modèles », avant le séparateur (demande du 17-11-2026)", () => {
    const rails = read("src/components/boardui/board-rails.tsx");
    expect(rails.indexOf("<RailModelsPill")).toBeGreaterThan(-1);
    expect(rails.indexOf("<RailModelsPill")).toBeLessThan(rails.indexOf("<div aria-hidden className={RAIL_DIVIDER} />"));
    expect(rails).not.toContain("<RailRuntimeHealth");
  });

  test("la mise à jour de l'app de bureau se pose juste au-dessus de Réglages, sous le séparateur", () => {
    const rails = read("src/components/boardui/board-rails.tsx");
    const button = rails.indexOf("<DesktopUpdateRailButton");
    expect(button).toBeGreaterThan(rails.indexOf("<div aria-hidden className={RAIL_DIVIDER} />"));
    expect(button).toBeLessThan(rails.indexOf('<RailTip label={t("navUser.settings")} side="top">'));
    // One surface at a time: the rail shell's card foot replaces the list-foot pill.
    expect(read("src/components/boardui/board-sidebar.tsx")).toContain("railShell ? <RailFooter /> : <AccountUpdatePill />");
  });

  test("le thème et la langue se règlent dans Réglages > Apparence, plus dans le rail", () => {
    const rails = read("src/components/boardui/board-rails.tsx");
    expect(rails).not.toContain("useTheme");
    expect(rails).not.toContain("setLocale");
    // The skeleton and the silhouette of `index.html` follow the rail, otherwise it jumps on load.
    expect(read("src/components/skeletons/frame-skeletons.tsx")).not.toMatch(/RiSunLine|RiMoonLine/);
    expect(read("index.html")).not.toMatch(/class="(sun|moon|lang)"/);

    const appearance = read("src/screens/settings/general/appearance.tsx");
    expect(appearance).toContain("onChange={setLocale}");
    expect(appearance).toContain("onChange={theme.setMode}");
  });
});
