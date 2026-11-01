import { afterEach, describe, expect, test } from "bun:test";
import { POINTER_FOCUS_ATTRIBUTE, trackPointerFocus } from "../../src/lib/pointer-focus";

let stop: (() => void) | null = null;

afterEach(() => {
  stop?.();
  stop = null;
  document.body.innerHTML = "";
});

function setup() {
  stop = trackPointerFocus(document);
  document.body.innerHTML = `<button id="rail">runtime</button><button id="next">next</button>`;
  return {
    rail: document.getElementById("rail") as HTMLButtonElement,
    next: document.getElementById("next") as HTMLButtonElement,
  };
}

const pointerFocus = () => document.documentElement.hasAttribute(POINTER_FOCUS_ATTRIBUTE);
const press = (key: string, init: KeyboardEventInit = {}) =>
  document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
const click = (el: HTMLElement) => {
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  el.focus();
};

describe("trackPointerFocus", () => {
  test("au clavier seul, l'attribut n'est jamais posé", () => {
    const { rail, next } = setup();
    rail.focus();
    press("Tab");
    next.focus();
    expect(pointerFocus()).toBe(false);
  });

  test("un clic pose l'attribut ; Échap sans déplacer le focus le garde", () => {
    const { rail } = setup();
    click(rail);
    expect(pointerFocus()).toBe(true);
    press("Escape");
    press("a");
    expect(pointerFocus()).toBe(true);
  });

  test("une touche qui déplace le focus rend l'anneau", () => {
    const { rail, next } = setup();
    click(rail);
    press("Tab");
    next.focus();
    expect(pointerFocus()).toBe(false);
  });

  test("un modificateur ou un raccourci n'est pas une navigation au clavier", () => {
    const { rail, next } = setup();
    click(rail);
    press("Meta");
    press("Tab", { metaKey: true });
    press("k", { ctrlKey: true });
    // Le focus rendu au retour dans la fenêtre, après Cmd+Tab.
    next.focus();
    expect(pointerFocus()).toBe(true);
  });

  test("un clic après le clavier repose l'attribut", () => {
    const { rail, next } = setup();
    click(rail);
    press("Tab");
    next.focus();
    click(rail);
    expect(pointerFocus()).toBe(true);
  });

  test("décrocher retire l'attribut et les écouteurs", () => {
    const { rail } = setup();
    click(rail);
    stop?.();
    stop = null;
    expect(pointerFocus()).toBe(false);
    click(rail);
    expect(pointerFocus()).toBe(false);
  });
});
