import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../src/lib/i18n";
import { api } from "../../src/lib/api";
import { AttachmentCanvasProvider, useAttachmentCanvas } from "../../src/components/attachment-canvas";
import { AttachmentTile } from "../../src/components/thread-attachment-tile";

const original = api.attachment;
beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
  api.attachment = mock(async () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }));
});
afterEach(() => {
  api.attachment = original;
  cleanup();
});

let opened: unknown = "unread";
function CanvasProbe() {
  opened = useAttachmentCanvas()?.opened;
  return null;
}

test("an image of the thread opens in a modal at 75% of the view, never in the canvas", async () => {
  render(
    <I18nProvider>
      <AttachmentCanvasProvider>
        <AttachmentTile attachment={{ type: "attachment", id: "file-1", name: "superagent.png", contentType: "image/png", kind: "image", bytes: 50_000 }} />
        <CanvasProbe />
      </AttachmentCanvasProvider>
    </I18nProvider>,
  );
  const thumbnail = await screen.findByRole("button", { name: "Ouvrir superagent.png" });
  await act(async () => { fireEvent.click(thumbnail); });
  const dialog = await screen.findByRole("dialog");
  expect(dialog.className).toContain("w-[75vw]");
  expect(dialog.className).toContain("h-[75vh]");
  const image = dialog.querySelector("img");
  expect(image?.getAttribute("alt")).toBe("superagent.png");
  // Never enlarged past its own pixels: a small image stays sharp.
  expect(image?.className).toContain("max-w-full");
  expect(image?.className).not.toContain("size-full");
  expect(opened).toBeNull();
  await act(async () => { fireEvent.keyDown(document, { key: "Escape" }); });
});
