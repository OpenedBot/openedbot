import { describe, expect, test } from "bun:test";
import {
  COMPOSER_DESKTOP_FIELD_MAX_PX,
  COMPOSER_FIELD_MAX_PX,
  composerFieldCeiling,
  composerFieldMaxHeight,
  dismissComposerKeyboardFromThread,
  keepSoftKeyboard,
  releaseComposerKeyboard,
  resizeComposerField,
  shouldSendComposerOnPointerDown,
  shouldSubmitComposerOnEnter,
} from "../../../src/lib/composer/composer-keyboard";

describe("shouldSubmitComposerOnEnter", () => {
  test("bureau : Entrée envoie, Maj+Entrée non", () => {
    expect(shouldSubmitComposerOnEnter({ key: "Enter", shiftKey: false }, false)).toBe(true);
    expect(shouldSubmitComposerOnEnter({ key: "Enter", shiftKey: true }, false)).toBe(false);
    expect(shouldSubmitComposerOnEnter({ key: "a", shiftKey: false }, false)).toBe(false);
  });

  test("doigt : Entrée n'envoie pas : newline natif", () => {
    expect(shouldSubmitComposerOnEnter({ key: "Enter", shiftKey: false }, true)).toBe(false);
    expect(shouldSubmitComposerOnEnter({ key: "Enter", shiftKey: true }, true)).toBe(false);
  });

  test("ignore la validation IME", () => {
    expect(
      shouldSubmitComposerOnEnter(
        { key: "Enter", shiftKey: false, nativeEvent: { isComposing: true } },
        false,
      ),
    ).toBe(false);
  });
});

describe("shouldSendComposerOnPointerDown", () => {
  test("doigt : on envoie au pointerdown, pas au click", () => {
    expect(shouldSendComposerOnPointerDown(true)).toBe(true);
    expect(shouldSendComposerOnPointerDown(false)).toBe(false);
  });
});

describe("keepSoftKeyboard", () => {
  test("preventDefault pour que le bouton ne vole pas le focus", () => {
    let called = false;
    keepSoftKeyboard({ preventDefault: () => { called = true; } });
    expect(called).toBe(true);
  });
});

describe("dismissComposerKeyboardFromThread", () => {
  test("blur le composer au tap du fil, pas d'un bouton", () => {
    const composer = document.createElement("textarea");
    composer.setAttribute("data-composer", "");
    const thread = document.createElement("div");
    const button = document.createElement("button");
    thread.append(button);
    document.body.append(composer, thread);
    composer.focus();
    expect(document.activeElement).toBe(composer);

    dismissComposerKeyboardFromThread({ target: button });
    expect(document.activeElement).toBe(composer);

    dismissComposerKeyboardFromThread({ target: thread });
    expect(document.activeElement === composer).toBe(false);

    document.body.replaceChildren();
  });
});

describe("resizeComposerField", () => {
  test("collapse à 0 puis pose la hauteur du contenu", () => {
    let height = "36px";
    const element = {
      style: {
        get height() {
          return height;
        },
        set height(value: string) {
          height = value;
        },
        overflowY: "auto",
      },
      get scrollHeight() {
        // Without the collapse, WebKit returns the current height (36).
        return height === "0px" ? 120 : 36;
      },
    };

    expect(resizeComposerField(element, COMPOSER_FIELD_MAX_PX)).toEqual({
      height: 120,
      scrollable: false,
    });
    expect(height).toBe("120px");
    expect(element.style.overflowY).toBe("hidden");
  });

  test("au-delà du plafond le champ scrolle", () => {
    const element = {
      style: { height: "", overflowY: "" },
      scrollHeight: 400,
    };
    expect(resizeComposerField(element, 200)).toEqual({ height: 200, scrollable: true });
    expect(element.style.overflowY).toBe("auto");
  });
});

describe("releaseComposerKeyboard", () => {
  test("blur le composer, ignore un autre champ", () => {
    const composer = document.createElement("textarea");
    composer.setAttribute("data-composer", "");
    const other = document.createElement("input");
    document.body.append(composer, other);
    composer.focus();
    releaseComposerKeyboard();
    expect(document.activeElement === composer).toBe(false);

    other.focus();
    releaseComposerKeyboard();
    expect(document.activeElement).toBe(other);
    document.body.replaceChildren();
  });
});

describe("composerFieldMaxHeight", () => {
  test("desktop: six whole 24 px lines under the 10 px top padding, below the touch ceiling", () => {
    expect(COMPOSER_DESKTOP_FIELD_MAX_PX).toBe(154);
    expect(COMPOSER_DESKTOP_FIELD_MAX_PX).toBeLessThan(COMPOSER_FIELD_MAX_PX);
  });

  test("the ceiling given wins until the window is short, then 40 % of its height", () => {
    const original = window.innerHeight;
    try {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 1000 });
      expect(composerFieldMaxHeight()).toBe(COMPOSER_FIELD_MAX_PX);
      expect(composerFieldMaxHeight(COMPOSER_DESKTOP_FIELD_MAX_PX)).toBe(154);
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 300 });
      expect(composerFieldMaxHeight(COMPOSER_DESKTOP_FIELD_MAX_PX)).toBe(120);
    } finally {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: original });
    }
  });
  test("a mouse gets the six desktop lines, a finger keeps the touch ceiling", () => {
    const original = window.innerHeight;
    try {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 1000 });
      expect(composerFieldCeiling(false)).toBe(COMPOSER_DESKTOP_FIELD_MAX_PX);
      expect(composerFieldCeiling(true)).toBe(COMPOSER_FIELD_MAX_PX);
    } finally {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: original });
    }
  });
});
