import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { I18nProvider } from "../../src/lib/i18n";
import { Composer } from "../../src/components/composer";
import { ComposerAttachmentTile } from "../../src/components/composer-attachment-tile";

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "en");
});
afterEach(cleanup);

const BOTS = [
  { id: "b1", name: "Neo", slug: "neo", face: null },
  { id: "b2", name: "Camille", slug: "camille", face: null },
];

/** The screen owns the draft, as in the thread: a controlled composer. */
function Harness({
  initial = "",
  onValue,
  mentionables = BOTS,
  running = false,
  onCancel = () => {},
  ...rest
}: {
  initial?: string;
  onValue?: (value: string) => void;
  mentionables?: typeof BOTS;
  running?: boolean;
  onCancel?: () => void;
} & Partial<React.ComponentProps<typeof Composer>>) {
  const [value, setValue] = useState(initial);
  return (
    <I18nProvider>
      <Composer
        value={value}
        onChange={(next) => {
          setValue(next);
          onValue?.(next);
        }}
        onSubmit={() => {}}
        onCancel={onCancel}
        botName="Hermes"
        disabled={false}
        running={running}
        mentionables={mentionables}
        {...rest}
      />
    </I18nProvider>
  );
}

function field(): HTMLTextAreaElement {
  return document.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!;
}

function type(text: string) {
  const el = field();
  fireEvent.change(el, { target: { value: text, selectionStart: text.length, selectionEnd: text.length } });
  el.setSelectionRange(text.length, text.length);
  fireEvent.keyUp(el);
}

test("typing @ opens the menu; arrows move, Enter picks, the value stays plain @slug", () => {
  let last = "";
  render(<Harness onValue={(value) => (last = value)} />);
  type("hi @");
  const options = screen.getAllByRole("option");
  expect(options.length).toBe(2);
  expect(options[0]!.getAttribute("aria-selected")).toBe("true");

  fireEvent.keyDown(field(), { key: "ArrowDown" });
  expect(screen.getAllByRole("option")[1]!.getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(field(), { key: "Enter" });

  expect(last).toBe("hi @camille ");
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("Escape closes the menu without touching the draft", () => {
  let last = "";
  render(<Harness onValue={(value) => (last = value)} />);
  type("@");
  expect(screen.getByRole("listbox")).toBeTruthy();
  fireEvent.keyDown(field(), { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(last).toBe("@");
});

test("a picked mention is painted as a tinted chip over the same characters", () => {
  const { container } = render(<Harness initial="hello @neo and more" />);
  const chip = container.querySelector("[data-composer-mention-chip]");
  expect(chip?.textContent).toBe("@neo");
  // The textarea keeps the plain text; only the mirror layer paints.
  expect(field().value).toBe("hello @neo and more");
  expect(container.querySelector("[data-composer-mcp-highlight]")?.textContent).toBe("hello @neo and more");
});

test("an unknown @word is not a chip", () => {
  const { container } = render(<Harness initial="hello @nobody" />);
  expect(container.querySelector("[data-composer-mention-chip]")).toBeNull();
});

test("Backspace right after a chip removes the whole @slug", () => {
  let last = "";
  render(<Harness initial="hello @neo" onValue={(value) => (last = value)} />);
  const el = field();
  el.setSelectionRange(10, 10);
  fireEvent.keyDown(el, { key: "Backspace" });
  expect(last).toBe("hello ");
});

test("Backspace inside a plain word still removes one letter (native behaviour)", () => {
  let last = "unchanged";
  render(<Harness initial="hello world" onValue={(value) => (last = value)} />);
  const el = field();
  el.setSelectionRange(11, 11);
  const notPrevented = fireEvent.keyDown(el, { key: "Backspace" });
  expect(notPrevented).toBe(true);
  expect(last).toBe("unchanged");
});

test("no @ toolbar button: typing @ is the only way to open the menu", () => {
  const { container } = render(<Harness initial="hey" />);
  expect(container.querySelector("[data-composer-mention-button]")).toBeNull();
  type("hey @");
  expect(screen.getByRole("listbox")).toBeTruthy();
});

test("busy: Stop is the tertiary circle and Escape stops on desktop", () => {
  let stopped = 0;
  const { container } = render(<Harness running onCancel={() => stopped++} />);
  const stop = container.querySelector("[data-composer-stop-action]")!;
  expect(stop.className).toContain("bg-background-tertiary-default");
  fireEvent.keyDown(field(), { key: "Escape" });
  expect(stopped).toBe(1);
});

test("status line: real left and right facts under the card, nothing without them", () => {
  const { container, rerender } = render(
    <Harness statusLeft={<span data-test-left="">pilote</span>} contextMeter={<span data-test-meter="">0,6 %</span>} />,
  );
  const line = container.querySelector("[data-composer-statusline]")!;
  expect(line.className).toContain("h-[26px]");
  expect(line.querySelector("[data-test-left]")).not.toBeNull();
  expect(line.querySelector("[data-test-meter]")?.textContent).toBe("0,6 %");
  // The line follows the card in the DOM.
  expect(container.querySelector("[data-composer-shell]")!.nextElementSibling).toBe(line);

  rerender(<Harness />);
  expect(container.querySelector("[data-composer-statusline]")).toBeNull();
});

test("@ lists bots first, then the connectors whose name starts with the query", () => {
  render(<Harness mcpPlugins={["mcp-notion", "github"]} />);
  type("@");
  expect(screen.getAllByRole("option").length).toBe(4);
  type("@n");
  const options = screen.getAllByRole("option");
  expect(options[0]!.textContent).toContain("@neo");
  expect(options[1]!.textContent).toContain("mcp-notion");
  expect(options[1]!.textContent).toContain("Connector");
  expect(options.length).toBe(2);
});

test("no bot to mention: the list still opens for a connector, and picking writes its plain name", () => {
  let last = "";
  render(<Harness mentionables={[]} mcpPlugins={["mcp-notion"]} onValue={(value) => (last = value)} />);
  type("ask @no");
  const options = screen.getAllByRole("option");
  expect(options.length).toBe(1);
  expect(options[0]!.textContent).toContain("mcp-notion");
  expect(options[0]!.textContent).toContain("Connector");
  fireEvent.keyDown(field(), { key: "Enter" });
  expect(last).toBe("ask mcp-notion ");
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("a click on a connector row replaces @query, and the salon offers no connector", () => {
  let last = "";
  const { unmount } = render(<Harness mentionables={[]} mcpPlugins={["notion"]} onValue={(value) => (last = value)} />);
  type("@not");
  fireEvent.click(screen.getByRole("option"));
  expect(last).toBe("notion ");
  unmount();
  render(<Harness mentionables={[]} mcpPlugins={["notion"]} showPlugins={false} />);
  type("@no");
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("no mic: an empty field leaves the send button there, disabled", () => {
  const { container } = render(<Harness />);
  expect(container.querySelector("[data-composer-voice]")).toBeNull();
  const send = container.querySelector<HTMLButtonElement>("[data-composer-send-action]");
  expect(send?.disabled).toBe(true);
  expect(send?.hasAttribute("data-voice-mode")).toBe(false);
});

test("upload tile: the ring and percentage follow the real progress, then give way to dismiss", () => {
  const { container, rerender } = render(
    <ul>
      <ComposerAttachmentTile name="notes.md" progress={42} removeLabel="Remove notes.md" />
    </ul>,
  );
  const tile = () => container.querySelector("[data-composer-attachment-tile]")!;
  expect(tile().hasAttribute("data-uploading")).toBe(true);
  expect(container.querySelector("[data-composer-tile-percent]")?.textContent).toBe("42%");
  expect(container.querySelector("path[stroke-dasharray]")?.getAttribute("stroke-dasharray")).toBe("42 200");
  const dismiss = screen.getByRole("button", { name: "Remove notes.md" }) as HTMLButtonElement;
  expect(dismiss.disabled).toBe(true);

  rerender(
    <ul>
      <ComposerAttachmentTile name="notes.md" removeLabel="Remove notes.md" landed />
    </ul>,
  );
  expect(tile().hasAttribute("data-uploading")).toBe(false);
  expect((screen.getByRole("button", { name: "Remove notes.md" }) as HTMLButtonElement).disabled).toBe(false);
});
