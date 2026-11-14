import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Profiler } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { BotFaceSpec } from "@openedbot/contracts-api";
import { FaceMotionProvider } from "../../src/lib/faces/face-motion";
import { BotFace } from "../../src/components/bot-face";

/**
 * What this file locks in, and what is not obvious from reading it:
 *
 * 1. a face moves EVERYWHERE by default, and stays still in the settings
 *    subtree: the product rule, in one assertion;
 * 2. it moves WITHOUT a React re-render. That is the only reason thirty of
 *    them can be animated: the `Profiler` counts renders, and the count must
 *    not move while the pose itself does;
 * 3. the outline is not rebuilt: the same `d` string from one frame to the
 *    next, only the transform changes;
 * 4. two bots in the same list do not breathe together.
 *
 * A regression on (2) or (3) is not visible on screen: it shows up at the
 * fan, three screens away. Hence the test.
 */

/* `IntersectionObserver` does not exist in happy-dom; the real component
   animates only what is on screen, so without this stub we would test the
   « tout visible » fallback and not the real path. */
class ObservateurBouchon {
  private readonly dire: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void;
  constructor(cb: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void) {
    this.dire = cb;
  }
  observe(target: Element) {
    this.dire([{ target, isIntersecting: true }]);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
globalThis.IntersectionObserver = ObservateurBouchon as unknown as typeof IntersectionObserver;

/* The face clock is driven by hand: `face-clock` resolves
   `requestAnimationFrame` on every call, so replacing the global is enough. */
let enAttente: FrameRequestCallback[] = [];
const vraiRaf = globalThis.requestAnimationFrame;
const vraiCancel = globalThis.cancelAnimationFrame;

function avancer(ms: number): void {
  const images = enAttente;
  enAttente = [];
  act(() => {
    for (const image of images) image(ms);
  });
}

beforeEach(() => {
  enAttente = [];
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    enAttente.push(cb);
    return enAttente.length;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
});

afterEach(() => {
  cleanup();
  globalThis.requestAnimationFrame = vraiRaf;
  globalThis.cancelAnimationFrame = vraiCancel;
});

/** A vector face: `artwork` absent, so the bloub engine is what renders. */
const VISAGE: BotFaceSpec = { shape: "galet", palette: "encre", eyes: "neutre" };

function corps(hote: HTMLElement): SVGPathElement {
  const node = hote.querySelector("mask path");
  if (!node) throw new Error("le contour du corps est introuvable");
  return node as SVGPathElement;
}

describe("un visage vit partout", () => {
  test("il bouge par défaut, sans re-rendu React ni contour reconstruit", () => {
    let rendus = 0;
    const { container } = render(
      <Profiler id="visage" onRender={() => { rendus += 1; }}>
        <BotFace name="Cahier2" seed="cahier2" face={VISAGE} className="size-8" />
      </Profiler>,
    );

    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("data-face-animated")).toBe("true");

    // a first frame to arm the clock (zero delta), then real frames
    avancer(0);
    const path = corps(container as unknown as HTMLElement);
    const contourAvant = path.getAttribute("d");
    const poseAvant = path.getAttribute("transform");
    const rendusAvant = rendus;
    // guard: without an observed render or a pose set, the two assertions that
    // follow would pass on their own and prove nothing.
    expect(rendusAvant).toBeGreaterThan(0);
    expect(poseAvant).toMatch(/^translate\(/);

    for (let i = 1; i <= 30; i += 1) avancer(i * 16);

    expect(path.getAttribute("transform")).not.toBe(poseAvant);
    expect(path.getAttribute("d")).toBe(contourAvant);
    expect(rendus).toBe(rendusAvant);
  });

  test("les réglages le figent, et rien d'autre ne le fige", () => {
    const { container } = render(
      <FaceMotionProvider anime={false}>
        <BotFace name="Cahier2" seed="cahier2" face={VISAGE} className="size-8" />
      </FaceMotionProvider>,
    );

    expect(container.querySelector("svg")?.getAttribute("data-face-animated")).toBe("false");
    const path = corps(container as unknown as HTMLElement);
    const poseAvant = path.getAttribute("transform");
    for (let i = 1; i <= 30; i += 1) avancer(i * 16);
    expect(path.getAttribute("transform")).toBe(poseAvant);
  });

  test("deux bots d'une même liste ne respirent pas ensemble", () => {
    const { container } = render(
      <>
        <BotFace name="A" seed="bot-a" face={VISAGE} className="size-8" />
        <BotFace name="B" seed="bot-b" face={VISAGE} className="size-8" />
      </>,
    );
    avancer(0);
    for (let i = 1; i <= 10; i += 1) avancer(i * 16);

    const poses = [...container.querySelectorAll("mask path")]
      .filter((node) => node.getAttribute("fill") === "#fff")
      .map((node) => node.getAttribute("transform"));
    expect(poses).toHaveLength(2);
    expect(poses[0]).not.toBe(poses[1]);
  });

  test("un artwork respire en CSS, et se tait dans les réglages", () => {
    const anime = render(<BotFace name="A" seed="artwork-a" face={null} className="size-8" />);
    expect(anime.container.querySelector("img")?.getAttribute("class")).toContain("bot-artwork-idle");
    cleanup();

    const fige = render(
      <FaceMotionProvider anime={false}>
        <BotFace name="A" seed="artwork-a" face={null} className="size-8" />
      </FaceMotionProvider>,
    );
    expect(fige.container.querySelector("img")?.getAttribute("class")).not.toContain("bot-artwork-idle");
  });

  test("un portrait d'artwork a les coins arrondis", () => {
    const portrait: BotFaceSpec = { ...VISAGE, artwork: "selene" };
    const { container } = render(<BotFace name="Sélène" seed="selene" face={portrait} className="size-8" />);
    expect(container.querySelector("span")?.getAttribute("class")).toContain("rounded-2xl");
    expect(container.querySelector("span")?.getAttribute("class")).toContain("overflow-hidden");
  });

  test("un chat se dessine en SVG, vit en CSS et se tait dans les réglages", async () => {
    const chat: BotFaceSpec = { shape: "chat", palette: "orange", eyes: "pill", accessory: "antenna" };
    const anime = render(<BotFace name="Rafale" seed="rafale" face={chat} className="size-8" />);
    // The cat's drawing loads on demand: until then, an empty chip of the same size.
    await waitFor(() => expect(anime.container.querySelector("[data-face-kind='chat']")).not.toBeNull());
    expect(anime.container.querySelector("svg path[fill='#f08a24']")).not.toBeNull();
    expect(anime.container.querySelectorAll(".mascot-eye")).toHaveLength(2);
    expect(anime.container.querySelector("img")).toBeNull();
    cleanup();

    const fige = render(
      <FaceMotionProvider anime={false}>
        <BotFace name="Rafale" seed="rafale" face={chat} className="size-8" />
      </FaceMotionProvider>,
    );
    await waitFor(() => expect(fige.container.querySelector("svg")).not.toBeNull());
    expect(fige.container.querySelectorAll(".mascot-eye")).toHaveLength(0);
    expect(fige.container.querySelector("svg")?.getAttribute("class")).not.toContain("bot-artwork-idle");
  });
});
