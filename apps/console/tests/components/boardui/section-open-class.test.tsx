import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { useSectionOpenClass } from "../../../src/components/boardui/board-sidebar";

afterEach(() => cleanup());

describe("useSectionOpenClass", () => {
  test("une section déjà ouverte au montage (un rechargement) n'anime pas ses rangées", () => {
    const { result } = renderHook(() => useSectionOpenClass(false));
    expect(result.current).toBeUndefined();
  });

  test("une section que l'utilisateur déplie anime ses rangées, pas celle qu'il replie", () => {
    const { result, rerender } = renderHook(({ collapsed }) => useSectionOpenClass(collapsed), {
      initialProps: { collapsed: true },
    });
    expect(result.current).toBeUndefined();
    rerender({ collapsed: false });
    expect(result.current).toBe("bui-section-open");
    rerender({ collapsed: true });
    expect(result.current).toBeUndefined();
  });
});
