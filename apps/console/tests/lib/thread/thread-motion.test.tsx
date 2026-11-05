import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { StrictMode, useRef, type ReactNode } from "react";
import {
  animateComposerExpand,
  GROK_SPRING_MS,
  ROW_ENTER_EASING,
  ROW_ENTER_MS,
  TYPING_EXIT_MS,
  useExitGhost,
  useThreadRowEnter,
} from "../../../src/lib/thread/thread-motion";

let animated: string[] = [];
let delays: number[] = [];
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
  animated = [];
  delays = [];
  setReducedMotion(false);
  HTMLElement.prototype.animate = function (this: HTMLElement, _keyframes: unknown, options?: number | KeyframeAnimationOptions) {
    const timing = typeof options === "object" ? options : {};
    animated.push(`${this.dataset.row}|${timing.duration}|${timing.easing}`);
    delays.push(timing.delay ?? 0);
    return { addEventListener() {} } as unknown as Animation;
  } as typeof HTMLElement.prototype.animate;
});

afterEach(() => {
  cleanup();
  HTMLElement.prototype.animate = originalAnimate;
  window.matchMedia = originalMatchMedia;
});

function Thread({ children, threadKey = "t1" }: { children: ReactNode; threadKey?: string }) {
  const content = useRef<HTMLDivElement>(null);
  useThreadRowEnter(content, threadKey);
  return (
    <div ref={content} data-thread-messages="">
      {children}
      <div data-thread-scroll-anchor="" />
    </div>
  );
}

const user = (id: string, text: string) => (
  <div key={id} data-row={id}><div data-user-bubble="">{text}</div></div>
);
const answer = (id: string) => <div key={id} data-row={id} data-assistant-layout="bubble">ok</div>;
const outgoing = (text: string) => (
  <div key="outgoing" data-row="outgoing" data-thread-outgoing=""><div data-user-bubble="">{text}</div></div>
);

describe("entrée des messages dans le fil", () => {
  test("le premier rendu ne bouge pas, une réponse ajoutée au bout monte de 12 px", async () => {
    const view = render(<Thread>{[user("u1", "bonjour")]}</Thread>);
    expect(animated).toEqual([]);
    view.rerender(<Thread>{[user("u1", "bonjour"), answer("a1")]}</Thread>);
    await Promise.resolve();
    expect(animated).toEqual([`a1|${ROW_ENTER_MS}|${ROW_ENTER_EASING}`]);
  });

  test("l'historique plus ancien, ajouté au-dessus, ne bouge pas", async () => {
    const view = render(<Thread>{[answer("a2")]}</Thread>);
    view.rerender(<Thread>{[user("u0", "plus ancien"), answer("a2")]}</Thread>);
    await Promise.resolve();
    expect(animated).toEqual([]);
  });

  test("la bulle optimiste monte ; enregistrée en pleine montée, sa remplaçante la finit sans la rejouer", async () => {
    const now = performance.now;
    let clock = 1_000;
    performance.now = () => clock;
    try {
      const view = render(<Thread>{[answer("a1")]}</Thread>);
      view.rerender(<Thread>{[answer("a1"), outgoing("salut")]}</Thread>);
      await Promise.resolve();
      expect(animated.map((entry) => entry.split("|")[0])).toEqual(["outgoing"]);
      clock += 80;
      view.rerender(<Thread>{[answer("a1"), user("u2", "salut"), outgoing("salut")]}</Thread>);
      await Promise.resolve();
      view.rerender(<Thread>{[answer("a1"), user("u2", "salut")]}</Thread>);
      await Promise.resolve();
      // The same rise, resumed 80 ms in: a negative delay, never a new 12 px.
      expect(animated.map((entry) => entry.split("|")[0])).toEqual(["outgoing", "u2"]);
      expect(delays.at(-1)).toBe(-80);
    } finally {
      performance.now = now;
    }
  });

  test("enregistrée une fois la montée finie, la remplaçante ne bouge pas", async () => {
    const now = performance.now;
    let clock = 1_000;
    performance.now = () => clock;
    try {
      const view = render(<Thread>{[answer("a1")]}</Thread>);
      view.rerender(<Thread>{[answer("a1"), outgoing("salut")]}</Thread>);
      await Promise.resolve();
      clock += ROW_ENTER_MS + 1;
      view.rerender(<Thread>{[answer("a1"), user("u2", "salut")]}</Thread>);
      await Promise.resolve();
      expect(animated.map((entry) => entry.split("|")[0])).toEqual(["outgoing"]);
    } finally {
      performance.now = now;
    }
  });

  test("un séparateur de date n'anime pas", async () => {
    const view = render(<Thread>{[answer("a1")]}</Thread>);
    view.rerender(<Thread>{[answer("a1"), <div key="d" data-row="date" data-thread-date="">Aujourd'hui 17:08</div>]}</Thread>);
    await Promise.resolve();
    expect(animated).toEqual([]);
  });

  test("mouvement réduit : rien ne bouge", async () => {
    setReducedMotion(true);
    const view = render(<Thread>{[answer("a1")]}</Thread>);
    view.rerender(<Thread>{[answer("a1"), answer("a2")]}</Thread>);
    await Promise.resolve();
    expect(animated).toEqual([]);
  });
});

/** `animate` qui garde ses appels et laisse le test finir l'animation. */
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
    // happy-dom ne met rien en page : la marque mesure 28 px.
    Object.defineProperty(view.container.querySelector("[data-thread-thinking]")!, "offsetHeight", { value: 28 });
    view.rerender(<List thinking={false} />);
    await Promise.resolve();

    const ghost = view.container.querySelector<HTMLElement>("[data-thread-exit-ghost]");
    expect(ghost).not.toBeNull();
    // Inerte : ni région annoncée, ni identifiant en double, ni marque « en cours ».
    expect(ghost!.getAttribute("aria-hidden")).toBe("true");
    expect(ghost!.hasAttribute("data-thread-thinking")).toBe(false);
    expect(ghost!.querySelector("[role]")).toBeNull();
    expect(ghost!.querySelector("[id]")).toBeNull();
    expect(ghost!.style.animation).toBe("none");
    // Dans le flux sans y prendre de place : la réponse entre à sa hauteur.
    expect(ghost!.style.marginBottom).toBe("-28px");
    // À la place de la marque, avant la réponse qui l'a remplacée.
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
    expect(calls[0]!.options.duration).toBe(GROK_SPRING_MS);
    expect(calls[0]!.keyframes).toEqual([
      { height: "44px", borderRadius: "22px" },
      { height: "100px", borderRadius: "18px" },
    ]);
    // Le cadre découpe la carte le temps du ressort, puis rend son débordement.
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
