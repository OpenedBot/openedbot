import { describe, expect, test } from "bun:test";
import {
  COMPOSER_FIELD_MAX_PX,
  dismissComposerKeyboardFromThread,
  keepSoftKeyboard,
  releaseComposerKeyboard,
  resizeComposerField,
  shouldSendComposerOnPointerDown,
  shouldSubmitComposerOnEnter,
} from "../../src/lib/composer-keyboard";

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
        // Sans le collapse, WebKit renvoie la hauteur courante (36).
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
