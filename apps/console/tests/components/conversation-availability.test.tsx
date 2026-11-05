import { afterEach, expect, test } from "bun:test";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../src/lib/i18n";
import { ConversationAvailability } from "../../src/components/conversation-availability";

afterEach(cleanup);

test.each(["button", "backdrop"])("dismissal via %s enables the composer and allows another alert", (method) => {
  window.localStorage.setItem("openedbot:locale", "fr");
  function Conversation() {
    const [blocked, setBlocked] = useState(true);
    return (
      <I18nProvider>
        <ConversationAvailability modal blocked={blocked} message="Runtime indisponible" retrying={false}
          onRetry={() => {}} onDismiss={() => setBlocked(false)}>
          <textarea aria-label="Message" defaultValue="Mon brouillon" disabled={blocked} />
          <button onClick={() => setBlocked(true)}>Envoyer</button>
        </ConversationAvailability>
      </I18nProvider>
    );
  }
  render(<Conversation />);
  const dialog = screen.getByRole("alertdialog");
  fireEvent.click(method === "button" ? screen.getByRole("button", { name: "Fermer" }) : dialog.parentElement!);
  const composer = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(composer.disabled).toBe(false);
  expect(composer.value).toBe("Mon brouillon");
  expect(composer.parentElement?.hasAttribute("inert")).toBe(false);
  fireEvent.change(composer, { target: { value: "Nouveau message" } });
  expect(composer.value).toBe("Nouveau message");
  fireEvent.click(screen.getByRole("button", { name: "Envoyer" }));
  expect(composer.disabled).toBe(true);
  expect(screen.getByRole("alertdialog")).toBeTruthy();
});

test.each([
  "Aucun runtime n’est configuré. Le bot ne peut pas répondre.",
  "HTTP 400 : requête refusée.",
  "HTTP 500 : service indisponible.",
])("opens a modal for a blocked send: %s", (message) => {
  window.localStorage.setItem("openedbot:locale", "fr");
  const view = (blocked: boolean) => (
    <I18nProvider>
      <ConversationAvailability modal blocked={blocked} message={message} retrying={false} onRetry={() => {}}>
        <textarea aria-label="Message" defaultValue="Mon message" />
      </ConversationAvailability>
    </I18nProvider>
  );
  const { rerender } = render(view(false));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  rerender(view(true));
  const dialog = screen.getByRole("alertdialog", { name: "Conversation indisponible" });
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(dialog.textContent).toContain(message);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(dialog.textContent).not.toContain("L’envoi est suspendu");
  expect(dialog.textContent).not.toContain("Votre brouillon est conservé");
  expect(screen.getByRole("button", { name: "Fermer" }).className).toContain("openedbot-settings-action");
  expect((screen.getByRole("textbox", { hidden: true }) as HTMLTextAreaElement).value).toBe("Mon message");
  fireEvent.click(screen.getByRole("button", { name: "Fermer" }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Réessayer" })).toBeNull();
  expect(screen.getByRole("textbox").parentElement?.hasAttribute("inert")).toBe(false);
});

test("blocks the cached conversation, retries, and preserves the draft after recovery", () => {
  window.localStorage.setItem("openedbot:locale", "fr");
  let retries = 0;
  const view = (blocked: boolean, retrying = false) => (
    <I18nProvider>
      <ConversationAvailability
        blocked={blocked}
        message="La connexion avec le runtime est interrompue."
        retrying={retrying}
        onRetry={() => { retries += 1; }}
      >
        <textarea aria-label="Message" defaultValue="Brouillon conservé" />
      </ConversationAvailability>
    </I18nProvider>
  );
  const { rerender } = render(view(false));
  const draft = screen.getByRole("textbox") as HTMLTextAreaElement;
  rerender(view(true));
  expect(screen.getByRole("alert").textContent).toContain("La connexion avec le runtime");
  expect(draft.parentElement?.hasAttribute("inert")).toBe(true);
  expect(draft.parentElement?.getAttribute("aria-hidden")).toBe("true");
  expect(screen.getByRole("button", { name: "Réessayer" }).className).toContain("openedbot-settings-action");
  fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
  expect(retries).toBe(1);
  rerender(view(true, true));
  expect((screen.getByRole("button", { name: "Réessayer" }) as HTMLButtonElement).disabled).toBe(true);
  rerender(view(false));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("textbox")).toBe(draft);
  expect(draft.value).toBe("Brouillon conservé");
  expect(draft.parentElement?.hasAttribute("inert")).toBe(false);
});
