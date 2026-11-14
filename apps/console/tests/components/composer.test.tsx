import { useState } from "react";
import * as attachmentPreparation from "../../src/lib/composer/attachments";
import { ATTACHMENT_LIMITS, documentAttachment, type MessageAttachmentInput } from "@openedbot/conversation/domain/attachments";
import { beforeEach, afterEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../src/lib/i18n";
import { AttachmentCanvas, AttachmentCanvasProvider } from "../../src/components/attachment-canvas";
import { saveCloudSession } from "../../src/lib/session/cloud-session";
import { useWorkspaceTextDraft } from "../../src/lib/workspace/workspace-draft";
import { Composer } from "../../src/components/composer";

// These cases check FRENCH copy: the language is set explicitly,
// the product default now being English (`DEFAULT_LOCALE`).
beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
});

afterEach(cleanup);

function renderComposer(value: string, running: boolean, onSubmit = () => {}, onCancel = () => {}) {
  return render(
    <I18nProvider>
      <Composer
        value={value}
        onChange={() => {}}
        onSubmit={onSubmit}
        onCancel={onCancel}
        botName="Hermes"
        disabled={false}
        running={running}
      />
    </I18nProvider>,
  );
}

// The status tab is not a free label above the composer:
// it is rendered IN its column, just before the shell, so it sits as one
// with the card. Detached, it floated in the middle of the page.
test("la languette de statut est rendue juste au-dessus de la coque", () => {
  const { container } = render(
    <I18nProvider>
      <Composer
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        botName="Hermes"
        disabled={false}
        running={false}
        statusTab={<span data-test-status="">contexte</span>}
      />
    </I18nProvider>,
  );
  const slot = container.querySelector("[data-composer-status]");
  const row = container.querySelector<HTMLElement>("[data-composer-row]");
  expect(slot?.querySelector("[data-test-status]")).not.toBeNull();
  // BoardUI template: the context state sits in the action row.
  expect(slot?.parentElement).toBe(row);
});

// Without the tab, no empty container is inserted: the composer keeps its
// exact height, which the iOS keyboard alignment depends on.
test("sans languette, aucun conteneur ne s’intercale", () => {
  const { container } = renderComposer("", false);
  expect(container.querySelector("[data-composer-status]")).toBeNull();
});

// The bar is placed BEHIND the card and sticks out at the top: the card
// keeps its four corners, otherwise its top ends become right
// angles where the bar, being narrower, does not cover it.
test("la barre ne prive pas la coque de ses coins hauts", () => {
  const { container } = render(
    <I18nProvider>
      <Composer
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        botName="Hermes"
        disabled={false}
        running={false}
        statusTab={<span data-test-status="">contexte</span>}
      />
    </I18nProvider>,
  );
  const shell = container.querySelector("[data-composer-shell]");
  expect(shell?.className.split(/\s+/)).toContain("rounded-[var(--radius-2-5xl)]");
  expect(shell?.className).not.toContain("rounded-b-[");
});

test("sans barre, la coque garde ses quatre coins", () => {
  const { container } = renderComposer("", false);
  expect(container.querySelector("[data-composer-shell]")?.className.split(/\s+/)).toContain("rounded-[var(--radius-2-5xl)]");
});

// The reply target always applies to the next send: a notice from the
// runtime (drop, then « rétabli » when the send comes back) must not hide
// it, or one would reply to a message one no longer sees.
test("un avis du runtime laisse la réponse en cours visible et annulable", () => {
  let cancelled = 0;
  const { container } = render(
    <I18nProvider>
      <Composer
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        botName="Hermes"
        disabled={false}
        running={false}
        notice={<span data-test-notice="">Runtime hors ligne</span>}
        replyPreview={{ author: "Ada", text: "Le message cité" }}
        onCancelReply={() => cancelled++}
      />
    </I18nProvider>,
  );
  const notice = container.querySelector("[data-composer-notice]");
  const reply = container.querySelector("[data-composer-reply]");
  if (!notice || !reply) throw new Error("avis ou onglet de réponse absent");
  expect(notice.querySelector("[data-test-notice]")).not.toBeNull();
  expect(reply.textContent).toContain("Réponse à Ada");
  // The reply tab comes after the notice, as close as possible to the card.
  expect(notice.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Annuler la réponse" }));
  expect(cancelled).toBe(1);
});

test("on desktop, Escape stops the run in progress when the field is empty", () => {
  let cancelled = 0;
  renderComposer("", true, () => {}, () => { cancelled += 1; });
  fireEvent.keyDown(document.querySelector("textarea[data-composer]")!, { key: "Escape" });
  expect(cancelled).toBe(1);
});

// With a draft, Send replaces Stop: Escape inside a draft is not an order to stop.
test("Escape inside a draft does not stop the run and keeps the draft", () => {
  let cancelled = 0;
  renderComposer("Une suite", true, () => {}, () => { cancelled += 1; });
  const field = document.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!;
  fireEvent.keyDown(field, { key: "Escape" });
  expect(cancelled).toBe(0);
  expect(field.value).toBe("Une suite");
});

// A salon's stop ends the whole room: no shortcut for it.
test("a salon composer does not stop the room on Escape", () => {
  let cancelled = 0;
  render(
    <I18nProvider>
      <Composer value="" onChange={() => {}} onSubmit={() => {}} onCancel={() => { cancelled += 1; }} escapeStopsRun={false} botName="Salon" disabled={false} running />
    </I18nProvider>,
  );
  fireEvent.keyDown(document.querySelector("textarea[data-composer]")!, { key: "Escape" });
  expect(cancelled).toBe(0);
  expect(screen.getByRole("button", { name: "Arrêter la génération" }).hasAttribute("aria-keyshortcuts")).toBe(false);
});

test("Escape stops nothing when no run is in progress", () => {
  let cancelled = 0;
  renderComposer("", false, () => {}, () => { cancelled += 1; });
  fireEvent.keyDown(document.querySelector("textarea[data-composer]")!, { key: "Escape" });
  expect(cancelled).toBe(0);
});

test("the stop button announces its Escape shortcut on desktop", () => {
  renderComposer("", true);
  const stop = screen.getByRole("button", { name: "Arrêter la génération" });
  expect(stop.getAttribute("aria-keyshortcuts")).toBe("Escape");
  expect(stop.getAttribute("title")).toBe("Arrêter la génération (Échap)");
});

// No more glowing band around the card during a run (removed on
// request): « Réfléchit… » in the thread and the Stop button are enough.
test("no band of light runs around the card while a run works", () => {
  renderComposer("", true);
  expect(document.querySelector("[data-composer-shell] svg[data-composer-loader]")).toBeNull();
  expect(screen.getByRole("button", { name: "Arrêter la génération" })).toBeTruthy();
});

test("un run actif garde Stop seul quand le brouillon est vide", () => {
  renderComposer("", true);

  expect(screen.getByRole("button", { name: "Arrêter la génération" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Envoyer" })).toBeNull();
  expect(document.querySelector("[data-composer-stop-action]")).not.toBeNull();
});

test("un brouillon pendant un run remplace Stop par Envoyer", () => {
  let submitted = 0;
  let cancelled = 0;
  const onSubmit = () => { submitted += 1; };
  const onCancel = () => { cancelled += 1; };
  const { container } = renderComposer("Message suivant", true, onSubmit, onCancel);

  const send = screen.getByRole("button", { name: "Envoyer" });
  expect(send.getAttribute("data-composer-action")).toBe("send");
  expect(screen.queryByRole("button", { name: "Arrêter la génération" })).toBeNull();
  expect(container.querySelectorAll("[data-composer-primary-action]").length).toBe(1);

  fireEvent.click(send);
  expect(submitted).toBe(1);
  expect(cancelled).toBe(0);
});

test("un envoi en vol grise Envoyer sans le masquer", () => {
  let submitted = 0;
  render(
    <I18nProvider>
      <Composer
        value="Encore"
        onChange={() => {}}
        onSubmit={() => { submitted += 1; }}
        onCancel={() => {}}
        botName="Hermes"
        disabled={false}
        running={false}
        sending
      />
    </I18nProvider>,
  );

  const send = screen.getByRole("button", { name: "Envoyer" }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(submitted).toBe(0);
});

test("un composer bloqué explique la raison au survol bureau", async () => {
  const reason = "La connexion avec le runtime est interrompue.";
  const { container } = render(
    <I18nProvider>
      <Composer
        value="Message conservé"
        onChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        botName="Hermes"
        disabled
        disabledReason={reason}
        running={false}
      />
    </I18nProvider>,
  );

  const surface = container.querySelector("[data-composer-disabled-surface]");
  expect(surface).not.toBeNull();
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);
  fireEvent.pointerMove(surface!);
  expect((await screen.findByRole("tooltip")).textContent).toContain(reason);
});

test("un composer bloqué ouvre un dialog au clic sur mobile", async () => {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes("pointer: coarse"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;

  try {
    const reason = "La connexion avec le runtime est interrompue.";
    render(
      <I18nProvider>
        <Composer
          value="Message conservé"
          onChange={() => {}}
          onSubmit={() => {}}
          onCancel={() => {}}
          botName="Hermes"
          disabled
          disabledReason={reason}
          running={false}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: reason }));
    const dialog = await screen.findByRole("alertdialog", { name: "Conversation indisponible" });
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain(reason);
  } finally {
    window.matchMedia = originalMatchMedia;
  }
});

test("une image importée devient une miniature ouvrable avant l'envoi", () => {
  const attachment = {
    name: "capture.png",
    contentType: "image/png",
    kind: "image" as const,
    content: [{ type: "image" as const, image: "data:image/png;base64,aGVsbG8=" }],
  };
  const { container } = render(
    <I18nProvider>
      <AttachmentCanvasProvider>
        <div className="flex">
          <Composer
            value=""
            onChange={() => {}}
            onSubmit={() => {}}
            onCancel={() => {}}
            botName="Hermes"
            disabled={false}
            running={false}
            attachments={[attachment]}
            onAttachmentsChange={() => {}}
          />
          <AttachmentCanvas />
        </div>
      </AttachmentCanvasProvider>
    </I18nProvider>,
  );

  expect(container.querySelector("[data-composer-image-attachment]")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Agrandir capture.png" }));
  expect(screen.getByRole("complementary", { name: "Lecture de capture.png" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "capture.png" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Fermer le fichier" })).toBeTruthy();
});

function renderWithPlugins(value: string, mcpPlugins: readonly string[]) {
  return render(
    <I18nProvider>
      <Composer
        value={value}
        onChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        botName="Hermes"
        disabled={false}
        running={false}
        mcpPlugins={mcpPlugins}
      />
    </I18nProvider>,
  );
}

test("le nom d'un plugin MCP connecté se colore dans le champ", () => {
  const { container } = renderWithPlugins("Regarde dans notion la page", ["notion"]);

  const marks = container.querySelectorAll("[data-composer-mcp-plugin]");
  expect(marks.length).toBe(1);
  expect(marks[0]?.textContent).toBe("notion");
  expect(marks[0]?.getAttribute("data-composer-mcp-plugin")).toBe("notion");
  expect(marks[0]?.getAttribute("data-composer-mcp-match")).toBe("exact");
});

test("un nom approché se colore aussi, à un degré distinct", () => {
  const { container } = renderWithPlugins("va sur notino stp", ["notion"]);

  const mark = container.querySelector("[data-composer-mcp-plugin]");
  expect(mark?.textContent).toBe("notino");
  expect(mark?.getAttribute("data-composer-mcp-match")).toBe("approximate");
});

test("chaque lettre du plugin porte sa propre teinte", () => {
  const { container } = renderWithPlugins("ouvre notion", ["notion"]);

  const letters = container.querySelectorAll("[data-composer-mcp-plugin] .openedbot-mcp-letter");
  expect(letters.length).toBe(6);
  expect([...letters].map((letter) => letter.textContent).join("")).toBe("notion");
  const hues = [...letters].map((letter) =>
    (letter as HTMLElement).style.getPropertyValue("--openedbot-mcp-hue"),
  );
  expect(hues[0]).toBe("0deg");
  expect(hues[5]).toBe("300deg");
  expect(new Set(hues).size).toBe(6);
});

test("le champ n'efface son texte que lorsqu'un plugin est à l'écran", () => {
  const { container: withPlugin } = renderWithPlugins("ouvre notion", ["notion"]);
  expect(
    withPlugin.querySelector("[data-composer]")?.getAttribute("data-composer-text"),
  ).toBe("mirrored");

  const { container: without } = renderWithPlugins("ouvre le compte rendu", ["notion"]);
  expect(
    without.querySelector("[data-composer]")?.getAttribute("data-composer-text"),
  ).toBeNull();
});

test("une pré-édition IME rend son texte au champ", () => {
  const { container } = renderWithPlugins("ouvre notion", ["notion"]);
  const field = container.querySelector("[data-composer]")!;

  fireEvent.compositionStart(field);
  expect(container.querySelector("[data-composer-mcp-highlight]")).toBeNull();
  expect(field.getAttribute("data-composer-text")).toBeNull();

  fireEvent.compositionEnd(field);
  expect(container.querySelector("[data-composer-mcp-highlight]")).not.toBeNull();
  expect(field.getAttribute("data-composer-text")).toBe("mirrored");
});

test("le calque miroir rend le texte à l'identique, et reste hors de l'arbre a11y", () => {
  const text = "Regarde dans notion, puis GitHub.";
  const { container } = renderWithPlugins(text, ["notion", "github"]);

  const layer = container.querySelector("[data-composer-mcp-highlight]");
  expect(layer?.textContent).toBe(text);
  expect(layer?.getAttribute("aria-hidden")).toBe("true");
});

test("sans plugin connecté, aucun calque n'est monté", () => {
  const { container } = renderWithPlugins("Regarde dans notion", []);

  expect(container.querySelector("[data-composer-mcp-highlight]")).toBeNull();
});

test("un mot qui ne désigne aucun plugin ne monte pas de calque", () => {
  const { container } = renderWithPlugins("Rédige un compte rendu", ["notion"]);

  expect(container.querySelector("[data-composer-mcp-highlight]")).toBeNull();
});

test("le champ garde sa place dans la rangée : un conteneur marqué, enfant direct de la rangée", () => {
  // The mobile bottom bar sets order, focus width, and the field margins
  // by attribute (`mobile.css`). Wrapping the textarea without copying that
  // mark onto the wrapper took it out of the flex context: the paperclip moved
  // after the field, and the assistant-ui layout at focus no longer formed.
  const { container } = renderComposer("Bonjour", false);

  const field = container.querySelector<HTMLElement>("[data-composer-field]");
  const row = container.querySelector<HTMLElement>("[data-composer-row]");
  expect(field).not.toBeNull();
  expect(field!.parentElement).toBe(row);
  expect(field!.querySelector("textarea[data-composer]")).not.toBeNull();
});

// Pill (desktop): one row while the text fits on one line, a
// card as soon as it wraps, closed again only when the field is empty.
test("une nouvelle ligne ouvre la carte, le champ vidé la referme", () => {
  const { container, rerender } = renderComposer("Bonjour", false);
  const row = () => container.querySelector<HTMLElement>("[data-composer-row]")!;
  const field = () => container.querySelector<HTMLElement>("[data-composer-field]")!;
  expect(row().hasAttribute("data-composer-expanded")).toBe(false);
  expect(field().className).not.toContain("sm:basis-full");

  const rerenderWith = (value: string) =>
    rerender(
      <I18nProvider>
        <Composer value={value} onChange={() => {}} onSubmit={() => {}} onCancel={() => {}} botName="Hermes" disabled={false} running={false} />
      </I18nProvider>,
    );

  rerenderWith("Bonjour\nla suite");
  expect(row().hasAttribute("data-composer-expanded")).toBe(true);
  expect(field().className).toContain("sm:basis-full");
  // Always a direct child of the row: `mobile.css` places it by attribute.
  expect(field().parentElement).toBe(row());

  rerenderWith("");
  expect(row().hasAttribute("data-composer-expanded")).toBe(false);
});

// « Planifier d'abord » is a thread intention: the « + » menu sets or
// clears it, a line under the card recalls it and its cross clears it. No
// permission pill lives in the composer anymore.
test("Planifier d'abord se pose depuis le menu +, se voit et se retire", async () => {
  const changes: boolean[] = [];
  const view = (planFirst: boolean) => (
    <I18nProvider>
      <Composer
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        botName="Hermes"
        disabled={false}
        running={false}
        onAttachmentsChange={() => {}}
        planFirst={planFirst}
        onPlanFirstChange={(next) => changes.push(next)}
      />
    </I18nProvider>
  );
  const { container, rerender } = render(view(false));
  expect(container.querySelector("[data-composer-permission]")).toBeNull();
  expect(container.querySelector("[data-composer-plan-first]")).toBeNull();
  fireEvent.click(container.querySelector<HTMLButtonElement>("[data-composer-attachment]")!);
  const row = await screen.findByRole("button", { name: /Planifier d’abord/ });
  expect(row.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(row);
  expect(changes).toEqual([true]);

  rerender(view(true));
  expect(container.querySelector("[data-composer-plan-first]")?.textContent).toContain("Hermes propose un plan sans rien modifier");
  fireEvent.click(screen.getByRole("button", { name: "Ne plus planifier d’abord" }));
  expect(changes).toEqual([true, false]);
});

test("sans onPlanFirstChange, le menu + ne propose pas de planifier", async () => {
  const { container } = render(
    <I18nProvider>
      <Composer value="" onChange={() => {}} onSubmit={() => {}} onCancel={() => {}} botName="Hermes"
        disabled={false} running={false} onAttachmentsChange={() => {}} />
    </I18nProvider>,
  );
  fireEvent.click(container.querySelector<HTMLButtonElement>("[data-composer-attachment]")!);
  await screen.findByRole("button", { name: /Fichiers et dossiers/ });
  expect(screen.queryByRole("button", { name: /Planifier d’abord/ })).toBeNull();
});

function attachmentHarness(initial: MessageAttachmentInput[] = []) {
  const reads: { resolve: (result: attachmentPreparation.PrepareResult) => void }[] = [];
  const prepare = spyOn(attachmentPreparation, "prepareAttachments").mockImplementation(
    () => new Promise((resolve) => reads.push({ resolve })),
  );
  let submitted = 0;
  const changes: MessageAttachmentInput[][] = [];
  function Harness({ scope }: { scope: string }) {
    const [attachments, setAttachments] = useState(initial);
    return (
      <I18nProvider>
        <Composer value="Message" onChange={() => {}} onSubmit={() => submitted++}
          onCancel={() => {}} botName="Hermes" disabled={false} running={false}
          attachmentScope={scope} attachments={attachments}
          onAttachmentsChange={(next) => { changes.push(next); setAttachments(next); }} />
      </I18nProvider>
    );
  }
  const view = render(<Harness scope="first" />);
  const paste = (name: string) => fireEvent.paste(screen.getByRole("textbox"), {
    clipboardData: { files: [new File(["text"], name, { type: "text/plain" })] },
  });
  const resolve = (index: number, name: string) => {
    reads[index]!.resolve({ attachments: [documentAttachment(name, "text/plain", name)], errors: [] });
  };
  const finish = async (index: number, name: string) => {
    await act(async () => resolve(index, name));
  };
  return { ...view, prepare, changes, paste, finish, resolve, submitted: () => submitted,
    scope: (scope: string) => view.rerender(<Harness scope={scope} />) };
}

test("deux imports terminés en ordre inverse gardent leurs fichiers et bloquent l'envoi jusqu'au dernier", async () => {
  const h = attachmentHarness();
  try {
    h.paste("first.txt");
    h.paste("second.txt");
    await h.finish(1, "second.txt");
    expect((screen.getByRole("button", { name: "Envoyer" }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.container.querySelectorAll("[data-composer-attachments] li").length).toBe(2);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Envoyer" }));
    expect(h.submitted()).toBe(0);
    await h.finish(0, "first.txt");
    expect(h.changes.at(-1)?.map((file) => file.name)).toEqual(["second.txt", "first.txt"]);
    fireEvent.click(screen.getByRole("button", { name: "Envoyer" }));
    expect(h.submitted()).toBe(1);
  } finally { h.prepare.mockRestore(); }
});

test("retirer une pièce jointe pendant un import ne la ressuscite pas", async () => {
  const h = attachmentHarness([documentAttachment("old.txt", "text/plain", "old")]);
  try {
    h.paste("new.txt");
    fireEvent.click(screen.getByRole("button", { name: /Retirer old.txt/ }));
    await h.finish(0, "new.txt");
    expect(h.changes.at(-1)?.map((file) => file.name)).toEqual(["new.txt"]);
  } finally { h.prepare.mockRestore(); }
});

test("des imports concurrents respectent le plafond partagé", async () => {
  const h = attachmentHarness(Array.from({ length: ATTACHMENT_LIMITS.maxCount - 1 }, (_, index) =>
    documentAttachment(`${index}.txt`, "text/plain", "text")));
  try {
    h.paste("first.txt");
    h.paste("second.txt");
    await h.finish(1, "second.txt");
    await h.finish(0, "first.txt");
    expect(h.changes.at(-1)?.length).toBe(ATTACHMENT_LIMITS.maxCount);
    expect(h.changes.at(-1)?.at(-1)?.name).toBe("second.txt");
    expect(screen.getByRole("alert").textContent).toContain(String(ATTACHMENT_LIMITS.maxCount));
  } finally { h.prepare.mockRestore(); }
});

test("changer de conversation invalide les lectures sans débloquer un nouvel import", async () => {
  const h = attachmentHarness();
  try {
    h.paste("old-scope.txt");
    h.scope("second");
    h.paste("new-scope.txt");
    await h.finish(0, "old-scope.txt");
    expect(h.changes).toEqual([]);
    expect((screen.getByRole("button", { name: "Envoyer" }) as HTMLButtonElement).disabled).toBe(true);
    await h.finish(1, "new-scope.txt");
    expect(h.changes.at(-1)?.map((file) => file.name)).toEqual(["new-scope.txt"]);
  } finally { h.prepare.mockRestore(); }
});

test("un import terminé après démontage ne modifie plus le brouillon", async () => {
  const h = attachmentHarness();
  try {
    h.paste("late.txt");
    h.unmount();
    await h.finish(0, "late.txt");
    expect(h.changes).toEqual([]);
  } finally { h.prepare.mockRestore(); }
});


test("deux lectures résolues avant le prochain rendu ne perdent aucun fichier", async () => {
  const h = attachmentHarness();
  try {
    h.paste("first.txt");
    h.paste("second.txt");
    await act(async () => {
      h.resolve(1, "second.txt");
      h.resolve(0, "first.txt");
    });
    expect(h.changes.at(-1)?.map((file) => file.name)).toEqual(["second.txt", "first.txt"]);
  } finally { h.prepare.mockRestore(); }
});


test("un échec de sauvegarde affiche un statut sans perdre la saisie ni bloquer l’envoi", () => {
  saveCloudSession({ organizationId: "a", csrfToken: "csrf", userId: "operator" });
  let submitted = 0;
  function DraftComposer() {
    const [value, onChange, draftUnpersisted] = useWorkspaceTextDraft("composer:quota-status");
    return <Composer value={value} onChange={onChange} draftUnpersisted={draftUnpersisted}
      onSubmit={() => { submitted += 1; }} onCancel={() => {}} botName="Hermes" disabled={false} running={false} />;
  }
  render(<I18nProvider><DraftComposer /></I18nProvider>);
  expect(screen.queryByText(/Brouillon non sauvegardé/)).toBeNull();
  const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage")!;
  const storage = window.localStorage;
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: storage.getItem.bind(storage),
    removeItem: storage.removeItem.bind(storage),
    setItem() { throw new DOMException("Quota exceeded", "QuotaExceededError"); },
  } });
  try {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "À conserver" } });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("À conserver");
    expect(screen.getByText(/Brouillon non sauvegardé/).getAttribute("role")).toBe("status");
    const send = screen.getByRole("button", { name: "Envoyer" }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(submitted).toBe(1);
  } finally { Object.defineProperty(window, "localStorage", descriptor); }
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "À conserver aussi" } });
  expect(screen.queryByText(/Brouillon non sauvegardé/)).toBeNull();
  window.localStorage.removeItem("openedbot:draft:operator:a:composer:quota-status:text");
});
