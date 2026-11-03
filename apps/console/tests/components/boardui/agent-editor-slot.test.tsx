import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { EDITOR_FADE_MS, EDITOR_SLOT_WIDTH, InlineEditorSlot } from "../../../src/components/boardui/agent-editor-slot";

afterEach(cleanup);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));

function slotOf(container: HTMLElement) {
  const slot = container.querySelector<HTMLElement>("[data-editor-slot]")!;
  return { slot, panel: slot.firstElementChild as HTMLElement };
}

describe("InlineEditorSlot", () => {
  test("ouvert : la place est prise d'un coup, sans transition de largeur", async () => {
    const { container, rerender } = render(<InlineEditorSlot visible={false}>éditeur</InlineEditorSlot>);
    expect(slotOf(container).slot.style.width).toBe("0px");
    rerender(<InlineEditorSlot visible>éditeur</InlineEditorSlot>);
    const { slot, panel } = slotOf(container);
    expect(slot.style.width).toBe(`${EDITOR_SLOT_WIDTH}px`);
    expect(slot.className).not.toContain("transition");
    expect(panel.style.opacity).toBe("0");
    await act(frames);
    expect(panel.style.opacity).toBe("1");
    expect(slot.getAttribute("aria-hidden")).toBe("false");
  });

  test("fermé : le panneau sort d'abord, la place se libère ensuite", async () => {
    const { container, rerender } = render(<InlineEditorSlot visible>éditeur</InlineEditorSlot>);
    rerender(<InlineEditorSlot visible={false}>éditeur</InlineEditorSlot>);
    const { slot, panel } = slotOf(container);
    expect(panel.style.opacity).toBe("0");
    expect(slot.style.width).toBe(`${EDITOR_SLOT_WIDTH}px`);
    expect(slot.hasAttribute("inert")).toBe(true);
    await act(() => sleep(EDITOR_FADE_MS + 20));
    expect(slot.style.width).toBe("0px");
  });

  test("rouvert pendant la sortie : la place reste prise", async () => {
    const { container, rerender } = render(<InlineEditorSlot visible>éditeur</InlineEditorSlot>);
    rerender(<InlineEditorSlot visible={false}>éditeur</InlineEditorSlot>);
    rerender(<InlineEditorSlot visible>éditeur</InlineEditorSlot>);
    await act(() => sleep(EDITOR_FADE_MS + 20));
    const { slot, panel } = slotOf(container);
    expect(slot.style.width).toBe(`${EDITOR_SLOT_WIDTH}px`);
    expect(panel.style.opacity).toBe("1");
  });
});
