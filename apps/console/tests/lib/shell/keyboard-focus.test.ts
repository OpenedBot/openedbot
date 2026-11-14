import { afterEach, describe, expect, test } from "bun:test";
import { KEYBOARD_FOCUS_ATTRIBUTE, trackKeyboardFocus } from "../../../src/lib/shell/keyboard-focus";

let stop: (() => void) | null = null;

afterEach(() => {
  stop?.();
  stop = null;
  document.body.innerHTML = "";
});

function setup() {
  stop = trackKeyboardFocus(document);
  document.body.innerHTML = `<button id="rail">runtime</button><input id="field" /><button id="next">next</button>`;
  return {
    rail: document.getElementById("rail") as HTMLButtonElement,
    field: document.getElementById("field") as HTMLInputElement,
    next: document.getElementById("next") as HTMLButtonElement,
  };
}

const keyboardFocus = () => document.documentElement.hasAttribute(KEYBOARD_FOCUS_ATTRIBUTE);
const press = (key: string, init: KeyboardEventInit = {}) =>
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
const click = (el: HTMLElement) => {
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  el.focus();
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("trackKeyboardFocus", () => {
  test("un focus posé par script (autoFocus, dialogue) n'affiche rien", () => {
    const { field, next } = setup();
    field.focus();
    expect(keyboardFocus()).toBe(false);
    next.focus();
    expect(keyboardFocus()).toBe(false);
  });

  test("Tab et Maj+Tab qui déplacent le focus l'affichent", () => {
    const { rail, field, next } = setup();
    click(rail);
    press("Tab");
    field.focus();
    expect(keyboardFocus()).toBe(true);
    press("Tab", { shiftKey: true });
    next.focus();
    expect(keyboardFocus()).toBe(true);
  });

  test("les flèches d'un groupe itinérant l'affichent", () => {
    const { rail, next } = setup();
    rail.focus();
    press("ArrowDown");
    next.focus();
    expect(keyboardFocus()).toBe(true);
  });

  test("taper dans un champ atteint au clavier le garde", () => {
    const { field } = setup();
    press("Tab");
    field.focus();
    press("a");
    press("Shift");
    expect(keyboardFocus()).toBe(true);
  });

  test("le focus rendu après Échap ou Entrée (menu, dialogue fermés) n'affiche rien", () => {
    const { rail, next } = setup();
    press("Tab");
    rail.focus();
    press("Enter");
    next.focus();
    expect(keyboardFocus()).toBe(false);
    press("Escape");
    rail.focus();
    expect(keyboardFocus()).toBe(false);
  });

  test("un raccourci n'est pas une navigation : retour dans la fenêtre après Cmd+Tab", () => {
    const { rail, next } = setup();
    rail.focus();
    press("Tab", { metaKey: true });
    next.focus();
    expect(keyboardFocus()).toBe(false);
    press("ArrowLeft", { ctrlKey: true });
    rail.focus();
    expect(keyboardFocus()).toBe(false);
  });

  test("un focus posé par script après la touche ne compte plus", async () => {
    const { rail, next } = setup();
    rail.focus();
    press("Tab");
    await tick();
    next.focus();
    expect(keyboardFocus()).toBe(false);
  });

  test("un clic retire l'anneau posé au clavier", () => {
    const { rail, next } = setup();
    press("Tab");
    next.focus();
    expect(keyboardFocus()).toBe(true);
    click(rail);
    expect(keyboardFocus()).toBe(false);
  });

  test("décrocher retire l'attribut et les écouteurs", () => {
    const { rail, next } = setup();
    press("Tab");
    next.focus();
    stop?.();
    stop = null;
    expect(keyboardFocus()).toBe(false);
    press("Tab");
    rail.focus();
    expect(keyboardFocus()).toBe(false);
  });
});
