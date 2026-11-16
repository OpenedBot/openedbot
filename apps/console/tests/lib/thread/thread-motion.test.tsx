import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { StrictMode, useRef } from "react";
import {
  animateComposerExpand,
  STREAM_SPRING_MS,
  TYPING_EXIT_MS,
  useExitGhost,
} from "../../../src/lib/thread/thread-motion";

const originalAnimate = HTMLElement.prototype.animate;
const originalMatchMedia = window.matchMedia;

function setReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes("reduce"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  setReducedMotion(false);
  HTMLElement.prototype.animate = function () {
    return { addEventListener() {} } as unknown as Animation;
  } as typeof HTMLElement.prototype.animate;
});

afterEach(() => {
  cleanup();
  HTMLElement.prototype.animate = originalAnimate;
  window.matchMedia = originalMatchMedia;
});

/** `animate` that keeps its calls and lets the test finish the animation. */
function recordAnimations() {
  const calls: Array<{ element: HTMLElement; keyframes: Keyframe[]; options: KeyframeAnimationOptions; finish: () => void }> = [];
  HTMLElement.prototype.animate = function (this: HTMLElement, keyframes: unknown, options?: number | KeyframeAnimationOptions) {
    const listeners: Array<() => void> = [];
    calls.push({
      element: this,
      keyframes: keyframes as Keyframe[],
      options: typeof options === "object" ? options : {},
      finish: () => listeners.splice(0).forEach((listener) => listener()),
    });
    return {
      addEventListener: (type: string, listener: () => void) => {
        if (type === "finish") listeners.push(listener);
      },
    } as unknown as Animation;
  } as typeof HTMLElement.prototype.animate;
  return calls;
}

function Mark() {
  const node = useRef<HTMLDivElement>(null);
  useExitGhost(node);
  return (
    <div ref={node} data-thread-thinking="" className="openedbot-typing-enter">
      <span role="status" id="label">Réfléchit…</span>
    </div>
  );
}

function List({ thinking }: { thinking: boolean }) {
  return (
    <div data-thread-messages="">
      <div data-row="u1">bonjour</div>
      {thinking ? <Mark /> : <div data-row="a1">ok</div>}
    </div>
  );
}

describe("sortie de la marque d'activité", () => {
  test("une copie inerte rétrécit à 0,92 et s'efface en 140 ms, puis quitte le fil", async () => {
    const calls = recordAnimations();
    const view = render(<List thinking />);
    // happy-dom lays nothing out: the mark measures 28 px.
    Object.defineProperty(view.container.querySelector("[data-thread-thinking]")!, "offsetHeight", { value: 28 });
    view.rerender(<List thinking={false} />);
    await Promise.resolve();

    const ghost = view.container.querySelector<HTMLElement>("[data-thread-exit-ghost]");
    expect(ghost).not.toBeNull();
    // Inert: no announced region, no duplicate identifier, no « en cours » mark.
    expect(ghost!.getAttribute("aria-hidden")).toBe("true");
    expect(ghost!.hasAttribute("data-thread-thinking")).toBe(false);
    expect(ghost!.querySelector("[role]")).toBeNull();
    expect(ghost!.querySelector("[id]")).toBeNull();
    expect(ghost!.style.animation).toBe("none");
    // In the flow without taking any space there: the reply comes in at its height.
    expect(ghost!.style.marginBottom).toBe("-28px");
    // In the mark's place, before the reply that replaced it.
    expect(ghost!.previousElementSibling?.getAttribute("data-row")).toBe("u1");
    expect(ghost!.nextElementSibling?.getAttribute("data-row")).toBe("a1");

    const exit = calls.find((call) => call.element === ghost)!;
    expect(exit.options.duration).toBe(TYPING_EXIT_MS);
    expect(exit.keyframes.at(-1)).toEqual({ opacity: 0, transform: "scale(0.92)" });
    exit.finish();
    expect(view.container.querySelector("[data-thread-exit-ghost]")).toBeNull();
  });

  test("mouvement réduit : la marque part d'un coup", async () => {
    recordAnimations();
    setReducedMotion(true);
    const view = render(<List thinking />);
    view.rerender(<List thinking={false} />);
    await Promise.resolve();
    expect(view.container.querySelector("[data-thread-exit-ghost]")).toBeNull();
  });

  test("le double montage de StrictMode ne laisse pas de fantôme : la marque n'est pas partie", async () => {
    recordAnimations();
    const view = render(<StrictMode><List thinking /></StrictMode>);
    await Promise.resolve();
    expect(view.container.querySelector("[data-thread-exit-ghost]")).toBeNull();
    expect(view.container.querySelectorAll("[data-thread-thinking]")).toHaveLength(1);
  });
});

describe("ressort du composer", () => {
  function frameOf(height: number, radius: string) {
    const frame = document.createElement("div");
    frame.style.borderRadius = radius;
    frame.getBoundingClientRect = () => ({ height }) as DOMRect;
    document.body.append(frame);
    return frame;
  }

  test("la pilule devient carte : hauteur et rayon (22 → 18) suivent le ressort", () => {
    const calls = recordAnimations();
    const frame = frameOf(100, "18px");
    animateComposerExpand(frame, { height: 44, radius: "22px" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.duration).toBe(STREAM_SPRING_MS);
    expect(calls[0]!.keyframes).toEqual([
      { height: "44px", borderRadius: "22px" },
      { height: "100px", borderRadius: "18px" },
    ]);
    // The frame clips the card for the length of the spring, then gives back its overflow.
    expect(frame.style.overflow).toBe("clip");
    calls[0]!.finish();
    expect(frame.style.overflow).toBe("");
    frame.remove();
  });

  test("rien à animer quand la hauteur ne change pas, ni sous mouvement réduit", () => {
    const calls = recordAnimations();
    const frame = frameOf(44, "22px");
    animateComposerExpand(frame, { height: 44, radius: "22px" });
    setReducedMotion(true);
    frame.getBoundingClientRect = () => ({ height: 100 }) as DOMRect;
    animateComposerExpand(frame, { height: 44, radius: "22px" });
    expect(calls).toHaveLength(0);
    frame.remove();
  });
});
