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

/** Un changement de barre d'adresse ne doit jamais être pris pour un clavier. */
export function hasFocusedTextEntry(document: Document): boolean {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement) return !active.disabled && !active.readOnly;
  if (active instanceof HTMLInputElement) {
    return !active.disabled && !active.readOnly && !NON_TEXT_INPUT_TYPES.has(active.type);
  }
  return active instanceof HTMLElement && active.isContentEditable;
}

/**
 * Géométrie utile du clavier. On n'ouvre que si un champ a le focus (la
 * barre d'adresse Safari n'est pas un clavier). Une fois ouvert, on SUIT
 * le visualViewport jusqu'à ce que le delta retombe sous le seuil : un
 * blur (tap Envoyer, 123, barre de suggestions) ne doit pas snapper la
 * coque à 100 vh pendant que le clavier est encore là.
 *
 * `offsetTop` : Safari panne parfois le visual viewport. Coller seulement
 * la hauteur laisse un trou entre le composer et le clavier.
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
 * La hauteur RÉELLEMENT visible quand le clavier est déployé : l'équivalent
 * web du `KeyboardAvoidingView` du template.
 *
 * Safari iOS ne rétrécit pas le viewport de mise en page à l'ouverture du
 * clavier : il fait défiler le document pour montrer le champ, et une coque
 * `overflow: hidden` de 100 dvh se retrouve décalée, composer sous le clavier.
 * `visualViewport` donne la géométrie utile ; on lui calque la hauteur de la
 * coque, on la translate de `offsetTop`, et on ramène le document à zéro.
 * Chromium Android honore déjà `interactive-widget=resizes-content` (voir
 * `index.html`) : le viewport y rétrécit tout seul et cette mesure vaut
 * alors la sienne.
 *
 * `null` tant qu'aucun clavier n'est détecté : la coque garde `100dvh` et
 * n'oscille pas au gré de la barre d'adresse.
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
