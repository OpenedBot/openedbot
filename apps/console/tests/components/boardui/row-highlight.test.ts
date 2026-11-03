import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { BUI_MENU_ITEM, BUI_PANEL_ITEM } from "../../../src/components/boardui/menu";
import { NAV_ROW } from "../../../src/components/boardui/board-sidebar";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

// A fading row highlight trails the pointer down a list as a grey flash: rows
// are tagged `ohb-row` and carry no colour transition of their own.
test("menu, panel and sidebar rows switch their highlight without a fade", () => {
  for (const row of [BUI_MENU_ITEM, BUI_PANEL_ITEM, NAV_ROW]) {
    expect(row.split(" ")).toContain("ohb-row");
    expect(row).not.toMatch(/\btransition(-colors|-all)?\b/);
  }
});

test("the global rule drops the colour fade on every ARIA row and .ohb-row", () => {
  const css = read("../../../../../browser/ui-kit/src/styles/app.css");
  const rule = css.match(/:is\(\[role="menuitem"\][^{]*\{[^}]*\}/)?.[0] ?? "";
  for (const target of ['[role="option"]', '[role="menuitemcheckbox"]', ".ohb-row", ".ohb-row).ohb-press"]) {
    expect(rule).toContain(target);
  }
  expect(rule).toMatch(/transition-property:\s*transform, translate, scale, opacity;/);
});

test("a panel highlights one row: the hovered one wins over the focused one", () => {
  const css = read("../../../src/styles/components/boardui.css");
  expect(css).toContain(
    '.bui-popover:has(.ohb-row:hover) .ohb-row:focus-visible:not(:hover, [data-highlighted], [aria-selected="true"], [aria-checked="true"])',
  );
});
