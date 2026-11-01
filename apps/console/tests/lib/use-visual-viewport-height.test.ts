import { afterEach, describe, expect, test } from "bun:test";
import {
  hasFocusedTextEntry,
  KEYBOARD_THRESHOLD,
  readVisualViewportInset,
  sameVisualViewportInset,
} from "../../src/lib/use-visual-viewport-height";

afterEach(() => {
  document.body.replaceChildren();
});

describe("hasFocusedTextEntry", () => {
  test("n'active l'évitement clavier que pour un champ de texte focalisé", () => {
    const textarea = document.createElement("textarea");
    const button = document.createElement("button");
    document.body.append(textarea, button);

    button.focus();
    expect(hasFocusedTextEntry(document)).toBe(false);

    textarea.focus();
    expect(hasFocusedTextEntry(document)).toBe(true);

    textarea.readOnly = true;
    expect(hasFocusedTextEntry(document)).toBe(false);
  });

  test("ignore les inputs qui n'ouvrent pas le clavier", () => {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    document.body.append(checkbox);
    checkbox.focus();

    expect(hasFocusedTextEntry(document)).toBe(false);
  });
});

describe("readVisualViewportInset", () => {
  const innerHeight = 852;

  test("ouvre seulement avec un champ focalisé et un delta > seuil", () => {
    const viewport = { height: innerHeight - 336, offsetTop: 0 };
    expect(readVisualViewportInset(viewport, innerHeight, false, false)).toBeNull();
    expect(readVisualViewportInset(viewport, innerHeight, true, false)).toEqual({
      height: 516,
      offsetTop: 0,
    });
  });

  test("une barre d'adresse sous le seuil n'ouvre pas", () => {
    const viewport = { height: innerHeight - (KEYBOARD_THRESHOLD - 10), offsetTop: 0 };
    expect(readVisualViewportInset(viewport, innerHeight, true, false)).toBeNull();
  });

  test("reste ouvert après blur tant que le clavier est là", () => {
    const viewport = { height: innerHeight - 336, offsetTop: 0 };
    expect(readVisualViewportInset(viewport, innerHeight, false, true)).toEqual({
      height: 516,
      offsetTop: 0,
    });
  });

  test("ferme quand le delta retombe, même si on était ouvert", () => {
    const viewport = { height: innerHeight, offsetTop: 0 };
    expect(readVisualViewportInset(viewport, innerHeight, false, true)).toBeNull();
  });

  test("propage offsetTop : Safari panne le visual viewport", () => {
    const viewport = { height: innerHeight - 336, offsetTop: 47 };
    expect(readVisualViewportInset(viewport, innerHeight, true, false)).toEqual({
      height: 516,
      offsetTop: 47,
    });
  });
});

describe("sameVisualViewportInset", () => {
  test("considère identiques deux mesures qui ne changent pas la géométrie", () => {
    expect(sameVisualViewportInset({ height: 516, offsetTop: 0 }, { height: 516, offsetTop: 0 })).toBe(true);
    expect(sameVisualViewportInset({ height: 516, offsetTop: 0 }, { height: 515, offsetTop: 0 })).toBe(false);
    expect(sameVisualViewportInset(null, null)).toBe(true);
  });
});
