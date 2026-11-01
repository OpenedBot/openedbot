import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../src/lib/i18n";
import { Composer } from "../../src/components/composer";
import {
  RuntimeOfflineBadge,
  formatOfflineSince,
  runtimeRetryDelay,
  useRuntimeOfflineNotice,
} from "../../src/components/runtime-offline-notice";

afterEach(cleanup);

type NoticeProps = Parameters<typeof useRuntimeOfflineNotice>[0];

/** The hook as the conversation screen uses it: its tab in `Composer`'s `notice`. */
function Harness(props: NoticeProps) {
  const notice = useRuntimeOfflineNotice(props);
  return (
    <Composer
      value="Brouillon conservé"
      onChange={() => {}}
      onSubmit={() => {}}
      onCancel={() => {}}
      botName="Hermes"
      disabled={props.offline}
      disabledReason={props.offline ? "En attente du runtime…" : undefined}
      running={false}
      notice={notice}
    />
  );
}

const view = (props: Partial<NoticeProps> = {}) => (
  <I18nProvider>
    <Harness offline since={null} retrying={false} onRetry={() => {}} onOpenRuntime={() => {}} {...props} />
  </I18nProvider>
);

test("retry delay grows, then stays at its ceiling", () => {
  expect([0, 1, 2, 3, 4, 9].map(runtimeRetryDelay)).toEqual([10, 20, 30, 60, 60, 60]);
});

test("since time is HH:MM, null when the link never showed up", () => {
  expect(formatOfflineSince(null, "fr")).toBeNull();
  expect(formatOfflineSince("not a date", "fr")).toBeNull();
  expect(formatOfflineSince("2026-10-14T14:02:00", "fr")).toBe("14:02");
});

test("offline: a status tab on the composer explains, retries now and opens the runtime settings", () => {
  window.localStorage.setItem("ohb:locale", "fr");
  let retries = 0;
  let opened = 0;
  const { container } = render(view({
    since: "2026-10-14T14:02:00",
    onRetry: () => { retries += 1; },
    onOpenRuntime: () => { opened += 1; },
  }));
  const slot = container.querySelector("[data-composer-notice]");
  // BoardUI Composer Panel: the tab sits right above the card, not as a loose row.
  expect(slot?.nextElementSibling?.hasAttribute("data-composer-shell")).toBe(true);
  // The tab explains: no tooltip trigger nor tap veil over the composer.
  expect(container.querySelector("[data-composer-disabled-surface]")).toBeNull();
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("Le runtime ne répond plus.");
  expect(alert.textContent).toContain("Hors ligne depuis 14:02.");
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).placeholder).toBe("En attente du runtime…");
  fireEvent.click(screen.getByRole("button", { name: "Réessayer · 10 s" }));
  expect(retries).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "Détails" }));
  expect(opened).toBe(1);
});

test("retrying disables the retry; recovery is announced; online without history shows no tab", () => {
  window.localStorage.setItem("ohb:locale", "fr");
  const { rerender, container } = render(view({ offline: false }));
  expect(container.querySelector("[data-composer-notice]")).toBeNull();
  rerender(view({ retrying: true }));
  const busy = screen.getAllByText("Reconnexion…").find((node) => node.tagName === "BUTTON") as HTMLButtonElement;
  expect(busy.disabled).toBe(true);
  rerender(view({ offline: false }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("Runtime rétabli");
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Brouillon conservé");
});

test("badge names the outage and opens the runtime settings", () => {
  window.localStorage.setItem("ohb:locale", "fr");
  let opened = 0;
  render(
    <I18nProvider>
      <RuntimeOfflineBadge since="2026-10-14T14:02:00" retrying={false} onClick={() => { opened += 1; }} />
    </I18nProvider>,
  );
  const badge = screen.getByRole("button", { name: "Runtime hors ligne" });
  expect(badge.getAttribute("title")).toBe("Le runtime ne répond plus depuis 14:02");
  fireEvent.click(badge);
  expect(opened).toBe(1);
});

test("the tab and the badge wear the bot's bubble colour, white on it; grey without one", () => {
  window.localStorage.setItem("ohb:locale", "fr");
  const { container } = render(view({ tint: "#ef4444" }));
  const tab = container.querySelector<HTMLElement>("[data-runtime-notice]")!;
  expect(tab.style.backgroundColor).toBe("#ef4444");
  expect(tab.className).not.toContain("bg-background-tertiary-default");
  expect(tab.querySelector(".text-white")).not.toBeNull();
  cleanup();
  render(
    <I18nProvider>
      <RuntimeOfflineBadge since={null} retrying={false} tint="#ef4444" onClick={() => {}} />
    </I18nProvider>,
  );
  expect(screen.getByRole("button", { name: "Runtime hors ligne" }).style.backgroundColor).toBe("#ef4444");
  cleanup();
  const grey = render(view({ tint: null })).container.querySelector<HTMLElement>("[data-runtime-notice]")!;
  expect(grey.style.backgroundColor).toBe("");
  expect(grey.className).toContain("bg-background-tertiary-default");
});
