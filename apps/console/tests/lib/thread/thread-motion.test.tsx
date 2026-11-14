import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { StrictMode, useRef, type ReactNode } from "react";
import {
  animateComposerExpand,
  STREAM_SPRING_MS,
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

// The thread's turns live in rows (`data-thread-turn`, virtual rows of D1d).
const turn = (key: string, children: ReactNode[]) => <div key={key} data-row={`turn-${key}`} data-thread-turn={key}>{children}</div>;
const spacer = <div key="spacer" data-row="spacer" data-thread-spacer="bottom" />;
const date = <div key="d" data-row="date" data-thread-date="">Aujourd'hui</div>;

describe("entrée des messages, rangées de tours", () => {
  test("un tour neuf au bout fait monter ses messages, pas sa puce de date", async () => {
    const view = render(<Thread>{[turn("u1", [user("u1", "bonjour"), answer("a1")])]}</Thread>);
    view.rerender(<Thread>{[turn("u1", [user("u1", "bonjour"), answer("a1")]), turn("u2", [date, user("u2", "et toi ?")])]}</Thread>);
    await Promise.resolve();
    expect(animated.map((entry) => entry.split("|")[0])).toEqual(["u2"]);
  });

  test("une réponse ajoutée à la rangée du dernier tour monte ; dans un tour plus haut, non", async () => {
    const view = render(<Thread>{[turn("u1", [user("u1", "bonjour")]), turn("u2", [user("u2", "et toi ?")])]}</Thread>);
    view.rerender(<Thread>{[turn("u1", [user("u1", "bonjour"), answer("a1")]), turn("u2", [user("u2", "et toi ?")])]}</Thread>);
    await Promise.resolve();
    expect(animated).toEqual([]);
    view.rerender(<Thread>{[turn("u1", [user("u1", "bonjour"), answer("a1")]), turn("u2", [user("u2", "et toi ?"), answer("a2")])]}</Thread>);
    await Promise.resolve();
    expect(animated.map((entry) => entry.split("|")[0])).toEqual(["a2"]);
  });

  test("un tour remonté par le défilement ne rejoue pas son entrée", async () => {
    const last = turn("u2", [user("u2", "et toi ?"), answer("a2")]);
    const view = render(<Thread>{[turn("u1", [user("u1", "bonjour")]), last]}</Thread>);
    // Scrolled up: the last turn is a spacer, then it comes back at the bottom.
    view.rerender(<Thread>{[turn("u1", [user("u1", "bonjour")]), spacer]}</Thread>);
    await Promise.resolve();
    view.rerender(<Thread>{[turn("u1", [user("u1", "bonjour")]), last]}</Thread>);
    await Promise.resolve();
    expect(animated).toEqual([]);
  });

  test("un tour monté au-dessus d'un espaceur n'est pas un ajout au bout", async () => {
    const view = render(<Thread>{[turn("u1", [user("u1", "bonjour")]), spacer]}</Thread>);
    view.rerender(<Thread>{[turn("u1", [user("u1", "bonjour")]), turn("u2", [user("u2", "plus bas")]), spacer]}</Thread>);
    await Promise.resolve();
    expect(animated).toEqual([]);
  });
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
