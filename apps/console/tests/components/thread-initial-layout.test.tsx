import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../src/lib/i18n";
import { ThreadInitialLayout, waitForThreadLayout } from "../../src/components/thread-initial-layout";

afterEach(cleanup);
const pause = () => new Promise((resolve) => setTimeout(resolve, 60));

function fixture() {
  const root = document.createElement("div");
  const pending = document.createElement("div");
  pending.setAttribute("data-thread-layout-pending", "");
  root.append(pending);
  return { root, pending };
}

describe("initial transcript layout", () => {
  test("plain text is revealed synchronously", () => {
    let revealed = false;
    const cancel = waitForThreadLayout(document.createElement("div"), () => { revealed = true; });
    expect(revealed).toBe(true);
    cancel();
  });

  test("waits for diagrams and images before revealing once", async () => {
    const { root, pending } = fixture();
    const image = document.createElement("img");
    let complete = false;
    Object.defineProperty(image, "complete", { get: () => complete });
    root.append(image);
    let reveals = 0;
    const cancel = waitForThreadLayout(root, () => { reveals++; });
    pending.removeAttribute("data-thread-layout-pending");
    await pause();
    expect(reveals).toBe(0);
    complete = true;
    image.dispatchEvent(new Event("load"));
    await waitFor(() => expect(reveals).toBe(1));
    root.append(document.createElement("p"));
    await pause();
    expect(reveals).toBe(1);
    cancel();
  });

  test("failed diagrams and images release the initial reveal", async () => {
    const { root, pending } = fixture();
    const image = document.createElement("img");
    let complete = false;
    Object.defineProperty(image, "complete", { get: () => complete });
    root.append(image);
    let revealed = false;
    const cancel = waitForThreadLayout(root, () => { revealed = true; });
    pending.textContent = "Invalid diagram: readable source";
    pending.removeAttribute("data-thread-layout-pending");
    complete = true;
    image.dispatchEvent(new Event("error"));
    await waitFor(() => expect(revealed).toBe(true));
    cancel();
  });

  test("slow or unavailable media cannot block indefinitely", async () => {
    const { root } = fixture();
    let revealed = false;
    const cancel = waitForThreadLayout(root, () => { revealed = true; }, 20);
    await waitFor(() => expect(revealed).toBe(true));
    cancel();
  });

  test("unmount or switching threads cancels stale reveals", async () => {
    const { root, pending } = fixture();
    let revealed = false;
    const cancel = waitForThreadLayout(root, () => { revealed = true; }, 20);
    cancel(); pending.remove();
    await pause();
    expect(revealed).toBe(false);
  });

  test("later media never hides an already visible conversation", async () => {
    const wrap = (pending: boolean, key = "thread-a") => <I18nProvider>
      <ThreadInitialLayout threadKey={key}><div data-thread-layout-pending={pending ? "" : undefined}>History</div></ThreadInitialLayout>
    </I18nProvider>;
    const view = render(wrap(false));
    expect(view.container.querySelector('[data-thread-initial-layout="ready"]')).not.toBeNull();
    view.rerender(wrap(true));
    expect(view.container.querySelector('[data-thread-initial-layout="ready"]')).not.toBeNull();
    view.rerender(wrap(true, "thread-b"));
    expect(view.container.querySelector('[data-thread-initial-layout="pending"]')).not.toBeNull();
    expect(view.container.querySelector('[inert]')).not.toBeNull();
    view.rerender(wrap(false, "thread-b"));
    await waitFor(() => expect(view.container.querySelector('[data-thread-initial-layout="ready"]')).not.toBeNull());
  });
});
