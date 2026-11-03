import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { useThreadEditAvailability } from "../../src/lib/thread/thread-edit-availability";
import {
  MessageInteractionShell,
  reactionPickerPosition,
  type MessageInteractionLabels,
} from "../../src/components/message-interactions";

const labels: MessageInteractionLabels = {
  reply: "Répondre",
  helpful: "Réponse utile",
  unhelpful: "Réponse inutile",
  copyResponse: "Copier la réponse",
  react: "Réagir",
  removeReaction: "Retirer la réaction",
  more: "Plus d’actions sur le message",
  quoteFrom: (author) => `Voir le message de ${author}`,
  operator: "Vous",
  assistant: "Assistant",
  speak: "Lire la réponse",
  stopSpeaking: "Arrêter la lecture",
  speechFailed: "La lecture vocale a échoué.",
  copy: "Copier le message",
  copied: "Message copié",
  copyFailed: "Impossible de copier le message.",
  copyMessageId: "Copier l’ID du message",
  edit: "Modifier dans une nouvelle tâche",
  regenerate: "Régénérer dans une nouvelle tâche",
  previousVersion: "Version précédente",
  nextVersion: "Version suivante",
  versionCount: (current, total) => `${current}/${total}`,
};

afterEach(() => { cleanup(); useThreadEditAvailability.getState().setCanEdit(true); });

describe("MessageInteractionShell", () => {
  test("closed message actions do not render again when a run changes edit permission", () => {
    let commits = 0;
    render(<Profiler id="message" onRender={() => { commits += 1; }}>
      <MessageInteractionShell messageId="m" align="end" labels={labels}
        copyText="Hello" onEdit={() => {}}><p>Hello</p></MessageInteractionShell>
    </Profiler>);
    const initial = commits;
    act(() => useThreadEditAvailability.getState().setCanEdit(false));
    act(() => useThreadEditAvailability.getState().setCanEdit(true));
    expect(commits).toBe(initial);
  });

  test("an open menu still tracks the latest edit permission", () => {
    useThreadEditAvailability.getState().setCanEdit(false);
    render(<MessageInteractionShell messageId="m" align="end" labels={labels}
      copyText="Hello" onEdit={() => {}}><p>Hello</p></MessageInteractionShell>);
    fireEvent.pointerDown(screen.getByRole("button", { name: labels.more }), { button: 0, ctrlKey: false });
    expect(screen.queryByText(labels.edit)).toBeNull();
    act(() => useThreadEditAvailability.getState().setCanEdit(true));
    expect(screen.getByText(labels.edit)).toBeTruthy();
    act(() => useThreadEditAvailability.getState().setCanEdit(false));
    expect(screen.queryByText(labels.edit)).toBeNull();
  });

  test("exposes Grok-style hover actions beside the bubble, not a bottom toolbar", () => {
    const { container } = render(
      <MessageInteractionShell
        messageId="msg-1"
        align="start"
        labels={labels}
        copyText="hello"
        onReply={() => {}}
        onReaction={() => {}}
      >
        <p>hello</p>
      </MessageInteractionShell>,
    );

    const actions = container.querySelector("[data-message-hover-actions]");
    expect(actions).not.toBeNull();
    expect(actions?.parentElement?.querySelector("p")?.textContent).toBe("hello");
    expect(screen.getByRole("button", { name: "Réagir" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Répondre" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Plus d’actions sur le message" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copier le message" })).toBeNull();
  });

  test("puts copy and speak in a bar below a flat assistant article", () => {
    const { container } = render(
      <MessageInteractionShell
        messageId="msg-1"
        align="start"
        surface="card"
        width="fill"
        actions="below"
        persistentActions
        labels={labels}
        copyText="hello"
        onReply={() => {}}
        onReaction={() => {}}
        speaker={{ status: "idle", onToggle: () => {} }}
      >
        <p>hello</p>
      </MessageInteractionShell>,
    );

    const actions = container.querySelector<HTMLElement>("[data-message-hover-actions]");
    expect(actions?.getAttribute("data-message-actions-placement")).toBe("below");
    expect(actions?.className).not.toContain("opacity-0");
    // Sous le texte, pas à côté : la ligne d'actions (template BoardUI) suit
    // le contenu dans une colonne ; répondre, lire et réagir passent dans « Plus ».
    expect(actions?.parentElement?.parentElement?.className).toContain("flex-col");
    expect(actions?.parentElement?.previousElementSibling?.querySelector("p")?.textContent).toBe("hello");
    expect(screen.getByRole("button", { name: "Réponse utile" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Réponse inutile" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copier la réponse" })).toBeTruthy();
    expect(screen.getByRole("button", { name: labels.more })).toBeTruthy();
  });

  test("menu mode leaves the bubble bare, as Grok Bot's thread: right-click or the Menu key on the focused bubble", () => {
    const { container } = render(
      <MessageInteractionShell
        messageId="msg-1"
        align="start"
        surface="card"
        width="fill"
        actions="menu"
        labels={labels}
        copyText="hello"
        onReply={() => {}}
        onReaction={() => {}}
      >
        <p>hello</p>
      </MessageInteractionShell>,
    );

    expect(container.querySelector("[data-message-hover-actions]")).toBeNull();
    expect(container.querySelector("[data-message-actions-row]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copier la réponse" })).toBeNull();
    const bubble = container.querySelector("p")!.closest<HTMLElement>("[tabindex='0']");
    expect(bubble).not.toBeNull();
    expect(bubble!.className).toContain("w-full");
    expect(container.querySelector("[data-message-align]")?.getAttribute("data-message-align")).toBe("start");
  });

  test("places hover actions to the left of an operator bubble", () => {
    const { container } = render(
      <MessageInteractionShell
        messageId="msg-user"
        align="end"
        labels={labels}
        copyText="yo"
        onReply={() => {}}
      >
        <p>yo</p>
      </MessageInteractionShell>,
    );

    const actions = container.querySelector("[data-message-hover-actions]");
    expect(actions?.className).toContain("order-first");
  });

  test("anchors operator actions to the bubble instead of its question context", () => {
    const { container } = render(
      <MessageInteractionShell
        messageId="msg-answer"
        align="end"
        labels={labels}
        copyText="Économie"
        onReply={() => {}}
        context={<p data-answered-question>Quelle priorité ?</p>}
      >
        <p data-answer-bubble>Économie</p>
      </MessageInteractionShell>,
    );

    const actions = container.querySelector("[data-message-hover-actions]");
    const actionRow = actions?.parentElement;
    expect(actionRow?.querySelector("[data-answer-bubble]")).not.toBeNull();
    expect(actionRow?.querySelector("[data-answered-question]")).toBeNull();
    expect(container.querySelector("[data-answered-question]")?.parentElement).toBe(actionRow?.parentElement);
  });

  test("shows only copy and more below an assistant response on touch", () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;

    try {
      const { container } = render(
        <MessageInteractionShell
          surface="chrome"
          messageId="msg-assistant"
          align="start"
          labels={labels}
          copyText="hello"
          onReply={() => {}}
        >
          <p>hello</p>
        </MessageInteractionShell>,
      );

      const actions = container.querySelector("[data-message-touch-actions]");
      expect(actions).not.toBeNull();
      expect(actions?.className).toContain("gap-0");
      expect(actions?.className).not.toContain("gap-1");
      expect(screen.getByRole("button", { name: labels.copy })).toBeTruthy();
      expect(screen.getByRole("button", { name: labels.more })).toBeTruthy();
      expect(screen.queryByRole("button", { name: labels.reply })).toBeNull();
      for (const button of actions?.querySelectorAll("button") ?? []) {
        expect(button.className).toContain("h-11");
        expect(button.className).toContain("w-8");
        expect(button.className).not.toContain("size-11");
      }

      fireEvent.click(screen.getByRole("button", { name: labels.more }));
      expect(screen.getByRole("dialog", { name: labels.more })).toBeTruthy();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  test("does not add assistant actions below an operator message on touch", () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;

    try {
      const { container } = render(
        <MessageInteractionShell
          messageId="msg-operator"
          align="end"
          labels={labels}
          copyText="hello"
          onReply={() => {}}
        >
          <p>hello</p>
        </MessageInteractionShell>,
      );

      expect(container.querySelector("[data-message-touch-actions]")).toBeNull();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  test("does not create keyboard focus when a long press opens the touch action sheet", async () => {
    const originalMatchMedia = window.matchMedia;
    const focusOwner = document.createElement("input");
    window.matchMedia = ((query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;

    try {
      document.body.append(focusOwner);
      focusOwner.focus();

      const { container } = render(
        <MessageInteractionShell
          messageId="msg-touch"
          align="end"
          labels={labels}
          copyText="hello"
          onReply={() => {}}
        >
          <p>hello</p>
        </MessageInteractionShell>,
      );

      const pressable = container.querySelector<HTMLElement>("[data-message-pressable]");
      expect(pressable).not.toBeNull();
      fireEvent.pointerDown(pressable!, {
        pointerType: "touch",
        isPrimary: true,
        clientX: 20,
        clientY: 20,
      });
      await act(() => new Promise((resolve) => window.setTimeout(resolve, 500)));

      expect(screen.getByRole("dialog", { name: labels.more })).toBeTruthy();
      await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      expect(document.activeElement).toBe(focusOwner);
      // L'appui long arme aussi l'anti-clic fantôme iOS pendant 700 ms.
      // Le laisser expirer pour ne pas avaler le clic du test suivant.
      await act(() => new Promise((resolve) => window.setTimeout(resolve, 750)));
    } finally {
      focusOwner.remove();
      window.matchMedia = originalMatchMedia;
    }
  });

  test("opens the reaction picker above the composer instead of extending the thread", () => {
    expect(reactionPickerPosition(
      { top: 700, bottom: 728, left: 40, right: 68 },
      { width: 800, height: 800 },
      "start",
    )).toEqual({ top: 652, left: 40, side: "top" });
    expect(reactionPickerPosition(
      { top: 80, bottom: 108, left: 40, right: 68 },
      { width: 800, height: 800 },
      "start",
    )).toEqual({ top: 116, left: 40, side: "bottom" });
  });

  test("portals the emoji picker to the document so a last-card click stays in view", async () => {
    render(
      <MessageInteractionShell
        messageId="msg-last"
        align="start"
        labels={labels}
        copyText="hello"
        onReply={() => {}}
        onReaction={() => {}}
      >
        <p>hello</p>
      </MessageInteractionShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Réagir" }));
    const picker = await screen.findByRole("group", { name: "Réagir" });
    expect(picker.parentElement).toBe(document.body);
    expect(picker.style.position).toBe("fixed");
  });
});

describe("clic droit sur un message", () => {
  test("ouvre réactions, répondre, copier et l'ID du message", async () => {
    render(<MessageInteractionShell messageId="msg-42" align="start" labels={labels}
      copyText="Bonjour" onReply={() => {}} onReaction={() => {}}><p>Bonjour</p></MessageInteractionShell>);
    fireEvent.contextMenu(screen.getByText("Bonjour"));
    expect(await screen.findByRole("menuitem", { name: "Répondre" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Copier le message" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Copier l’ID du message" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Réagir" })).toBeTruthy();
  });

  test("copier l'ID écrit l'identifiant du message", async () => {
    const written: string[] = [];
    const clipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { written.push(value); } } });
    try {
      render(<MessageInteractionShell messageId="msg-42" align="start" labels={labels}
        copyText="Bonjour"><p>Bonjour</p></MessageInteractionShell>);
      fireEvent.contextMenu(screen.getByText("Bonjour"));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Copier l’ID du message" }));
      await act(async () => {});
      expect(written).toEqual(["msg-42"]);
    } finally {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
    }
  });

  test("un lien garde le menu du navigateur", () => {
    render(<MessageInteractionShell messageId="msg-42" align="start" labels={labels}
      copyText="Voir"><a href="https://example.com">Voir</a></MessageInteractionShell>);
    const event = fireEvent.contextMenu(screen.getByText("Voir"));
    expect(event).toBe(true);
    expect(screen.queryByRole("menuitem", { name: "Copier l’ID du message" })).toBeNull();
  });
});

