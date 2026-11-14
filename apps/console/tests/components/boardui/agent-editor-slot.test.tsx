import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { EDITOR_SLOT_WIDTH, InlineEditorSlot } from "../../../src/components/boardui/agent-editor-slot";
import { COLLAPSE_MOTION } from "../../../src/components/boardui/board-chrome";

afterEach(cleanup);

function slotOf(container: HTMLElement) {
  const slot = container.querySelector<HTMLElement>("[data-editor-slot]")!;
  return { slot, panel: slot.firstElementChild as HTMLElement };
}

describe("InlineEditorSlot", () => {
  test("ouvre et ferme avec la transition de largeur de la sidebar", () => {
    const { container, rerender } = render(<InlineEditorSlot visible={false}><button>éditeur</button></InlineEditorSlot>);
    const { slot, panel } = slotOf(container);
    const button = panel.firstElementChild;
    expect(slot.style.width).toBe("0px");
    expect(slot.hasAttribute("inert")).toBe(true);
    expect(slot.className).toContain("transition-[width]");
    expect(slot.className).toContain(COLLAPSE_MOTION);
    expect(slot.className).toContain("overflow-clip");

    rerender(<InlineEditorSlot visible><button>éditeur</button></InlineEditorSlot>);
    expect(slot.style.width).toBe(`${EDITOR_SLOT_WIDTH}px`);
    expect(slot.getAttribute("aria-hidden")).toBe("false");
    expect(slot.hasAttribute("inert")).toBe(false);
    expect(panel.style.width).toBe(`${EDITOR_SLOT_WIDTH}px`);

    rerender(<InlineEditorSlot visible={false}><button>éditeur</button></InlineEditorSlot>);
    expect(slot.style.width).toBe("0px");
    expect(slot.getAttribute("aria-hidden")).toBe("true");
    expect(slot.hasAttribute("inert")).toBe(true);
    expect(panel.style.width).toBe(`${EDITOR_SLOT_WIDTH}px`);
    expect(panel.firstElementChild).toBe(button);
  });

  test("une inversion immédiate conserve le panneau et suit le dernier état", () => {
    const { container, rerender } = render(<InlineEditorSlot visible>éditeur</InlineEditorSlot>);
    const { slot, panel } = slotOf(container);
    rerender(<InlineEditorSlot visible={false}>éditeur</InlineEditorSlot>);
    rerender(<InlineEditorSlot visible>éditeur</InlineEditorSlot>);
    expect(slot.style.width).toBe(`${EDITOR_SLOT_WIDTH}px`);
    expect(slot.hasAttribute("inert")).toBe(false);
    expect(slot.firstElementChild).toBe(panel);
  });
});
