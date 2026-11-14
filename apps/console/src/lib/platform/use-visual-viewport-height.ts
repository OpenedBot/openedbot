import { useEffect, useRef, useState } from "react";

export const KEYBOARD_THRESHOLD = 120;

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

export type VisualViewportInset = {
  height: number;
  offsetTop: number;
};

export function sameVisualViewportInset(
  left: VisualViewportInset | null,
  right: VisualViewportInset | null,
): boolean {
  return left?.height === right?.height && left?.offsetTop === right?.offsetTop;
}

/** An address-bar change must never be taken for a keyboard. */
export function hasFocusedTextEntry(document: Document): boolean {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement) return !active.disabled && !active.readOnly;
  if (active instanceof HTMLInputElement) {
    return !active.disabled && !active.readOnly && !NON_TEXT_INPUT_TYPES.has(active.type);
  }
  return active instanceof HTMLElement && active.isContentEditable;
}

/**
 * Useful keyboard geometry. We open only if a field has focus (Safari's
 * address bar is not a keyboard). Once open, we FOLLOW
 * the visualViewport until the delta falls back under the threshold: a
 * blur (Send tap, 123, suggestion bar) must not snap the
 * shell to 100 vh while the keyboard is still there.
 *
 * `offsetTop`: Safari sometimes pans the visual viewport. Sticking only
 * the height leaves a gap between the composer and the keyboard.
 */
export function readVisualViewportInset(
  viewport: Pick<VisualViewport, "height" | "offsetTop">,
  innerHeight: number,
  focused: boolean,
  alreadyOpen: boolean,
): VisualViewportInset | null {
  const keyboard = innerHeight - viewport.height - viewport.offsetTop;
  if (keyboard > KEYBOARD_THRESHOLD && (focused || alreadyOpen)) {
    return {
      height: Math.round(viewport.height),
      offsetTop: Math.round(viewport.offsetTop),
    };
  }
  return null;
}

/**
 * The height ACTUALLY visible when the keyboard is up: the web
 * equivalent of the template's `KeyboardAvoidingView`.
 *
 * Safari iOS does not shrink the layout viewport when the
 * keyboard opens: it scrolls the document to show the field, and a shell
 * of `overflow: hidden` at 100 dvh ends up shifted, composer under the keyboard.
 * `visualViewport` gives the useful geometry; we copy the shell's height onto
 * it, translate it by `offsetTop`, and bring the document back to zero.
 * Chromium Android already honors `interactive-widget=resizes-content` (see
 * `index.html`): the viewport shrinks on its own there and this measure then
 * equals its own.
 *
 * `null` until a keyboard is detected: the shell keeps `100dvh` and
 * does not oscillate with the address bar.
 */
export function useVisualViewportInset(enabled: boolean): VisualViewportInset | null {
  const [inset, setInset] = useState<VisualViewportInset | null>(null);
  const openRef = useRef(false);
  const publishedRef = useRef<VisualViewportInset | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      openRef.current = false;
      publishedRef.current = null;
      setInset(null);
      return;
    }
    const viewport = window.visualViewport;
    if (!viewport) {
      openRef.current = false;
      publishedRef.current = null;
      setInset(null);
      return;
    }

    const apply = (next: VisualViewportInset | null) => {
      openRef.current = next !== null;
      if (!sameVisualViewportInset(publishedRef.current, next)) {
        publishedRef.current = next;
        setInset(next);
      }
      if (next && window.scrollY !== 0) window.scrollTo(0, 0);
    };

    const measure = () => {
      apply(
        readVisualViewportInset(
          viewport,
          window.innerHeight,
          hasFocusedTextEntry(document),
          openRef.current,
        ),
      );
    };

    const onFocusOut = () => {
      requestAnimationFrame(measure);
    };

    measure();
    viewport.addEventListener("resize", measure);
    viewport.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    document.addEventListener("focusin", measure);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      viewport.removeEventListener("resize", measure);
      viewport.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      document.removeEventListener("focusin", measure);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [enabled]);

  return enabled ? inset : null;
}
