import { describe, expect, test } from "bun:test";
import { lockBodyScroll, scheduleDialogEnter } from "./dialog";

describe("le verrou de défilement des boîtes", () => {
  test("fermer la boîte du dessous d'abord garde la page verrouillée jusqu'à la dernière", () => {
    const body = { style: { overflow: "auto" } };
    const releaseBottom = lockBodyScroll(body);
    const releaseTop = lockBodyScroll(body);
    expect(body.style.overflow).toBe("hidden");
    releaseBottom();
    expect(body.style.overflow).toBe("hidden");
    releaseTop();
    expect(body.style.overflow).toBe("auto");
  });

  test("une double libération ne rend pas le défilement à une autre boîte encore ouverte", () => {
    const body = { style: { overflow: "" } };
    const releaseFirst = lockBodyScroll(body);
    const releaseSecond = lockBodyScroll(body);
    releaseFirst();
    releaseFirst();
    expect(body.style.overflow).toBe("hidden");
    releaseSecond();
    expect(body.style.overflow).toBe("");
  });
});


test("a suspended frame cannot leave a mounted dialog transparent, and closing cancels the fallback", () => {
  let frame: FrameRequestCallback | undefined
  let timer: (() => void) | undefined
  let shows = 0
  const clock = {
    requestAnimationFrame: (callback: FrameRequestCallback) => { frame = callback; return 1 },
    cancelAnimationFrame: (_id: number) => { frame = undefined },
    setTimeout: (callback: () => void, _delay?: number) => { timer = callback; return 2 },
    clearTimeout: (_id: number | undefined) => { timer = undefined },
  }
  scheduleDialogEnter(() => { shows++ }, clock)
  timer!()
  expect(shows).toBe(1)
  expect(frame).toBeUndefined()
  const cancel = scheduleDialogEnter(() => { shows++ }, clock)
  cancel()
  expect(timer).toBeUndefined()
  expect(shows).toBe(1)
})
