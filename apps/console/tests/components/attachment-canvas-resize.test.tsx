import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../src/lib/i18n";
import {
  AttachmentCanvas,
  AttachmentCanvasProvider,
  CANVAS_MIN_WIDTH,
  clampCanvasWidth,
  readCanvasWidth,
  useAttachmentCanvas,
  writeCanvasWidth,
} from "../../src/components/attachment-canvas";

const KEY = "ohb:attachment-canvas-width";

beforeEach(() => {
  window.localStorage.setItem("ohb:locale", "fr");
  window.localStorage.removeItem(KEY);
});
afterEach(cleanup);

test("the width never goes under the minimum nor squeezes the thread under its own", () => {
  expect(clampCanvasWidth(100, 1200)).toBe(CANVAS_MIN_WIDTH);
  expect(clampCanvasWidth(500.4, 1200)).toBe(500);
  expect(clampCanvasWidth(2000, 1200)).toBe(1200 - 360);
  // A row too narrow for both still gives the canvas its minimum.
  expect(clampCanvasWidth(500, 500)).toBe(CANVAS_MIN_WIDTH);
  expect(clampCanvasWidth(2000, null)).toBe(2000);
});

test("the stored width is read back, and garbage falls back to the default", () => {
  writeCanvasWidth(480);
  expect(readCanvasWidth()).toBe(480);
  window.localStorage.setItem(KEY, "abc");
  expect(readCanvasWidth()).toBeNull();
  window.localStorage.setItem(KEY, "12");
  expect(readCanvasWidth()).toBeNull();
  writeCanvasWidth(null);
  expect(window.localStorage.getItem(KEY)).toBeNull();
});

function Opener() {
  const canvas = useAttachmentCanvas();
  return <button type="button" onClick={() => canvas?.openPanel({ id: "context", label: "Contexte" })}>open</button>;
}

function renderCanvas() {
  render(
    <I18nProvider>
      <AttachmentCanvasProvider>
        <div style={{ display: "flex" }}>
          <div style={{ flex: 1 }} />
          <AttachmentCanvas />
        </div>
        <Opener />
      </AttachmentCanvasProvider>
    </I18nProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "open" }));
  return document.querySelector<HTMLElement>("[data-attachment-canvas]")!;
}

test("the handle resizes from the keyboard, remembers it, and a double-click restores the default", () => {
  const aside = renderCanvas();
  const handle = screen.getByRole("separator", { name: /Redimensionner le panneau/ });
  expect(aside.style.width).toBe("");
  let measured = 0;
  aside.getBoundingClientRect = () => ({ width: measured }) as DOMRect;

  fireEvent.keyDown(handle, { key: "Home" });
  expect(aside.style.width).toBe(`${CANVAS_MIN_WIDTH}px`);
  expect(window.localStorage.getItem(KEY)).toBe(String(CANVAS_MIN_WIDTH));
  // ArrowLeft widens: the handle sits on the thread's side, at the left.
  measured = CANVAS_MIN_WIDTH;
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  expect(aside.style.width).toBe(`${CANVAS_MIN_WIDTH + 32}px`);

  fireEvent.doubleClick(handle);
  expect(aside.style.width).toBe("");
  expect(window.localStorage.getItem(KEY)).toBeNull();
});

test("dragging the handle follows the pointer without the width animation, then stores the width", () => {
  const aside = renderCanvas();
  const handle = screen.getByRole("separator", { name: /Redimensionner le panneau/ });
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 400, width: 400, height: 800, toJSON: () => ({}) };
  aside.getBoundingClientRect = () => rect as DOMRect;
  handle.setPointerCapture = () => {};

  act(() => { fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 600 }); });
  expect(aside.className.split(" ")).toContain("transition-none");
  act(() => { fireEvent.pointerMove(handle, { pointerId: 1, clientX: 500 }); });
  expect(aside.style.width).toBe("500px");
  // Not stored mid-drag: only on release.
  expect(window.localStorage.getItem(KEY)).toBeNull();
  act(() => { fireEvent.pointerUp(handle, { pointerId: 1, clientX: 500 }); });
  expect(aside.className.split(" ")).not.toContain("transition-none");
  expect(window.localStorage.getItem(KEY)).toBe("500");
});
