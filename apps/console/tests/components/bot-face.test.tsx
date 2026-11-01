import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Profiler } from "react";
import { act, cleanup, render } from "@testing-library/react";
import type { BotFaceSpec } from "@openedbot/contracts-api";
import { FaceMotionProvider } from "../../src/lib/face-motion";
import { BotFace } from "../../src/components/bot-face";

/**
 * Ce que ce fichier verrouille, et qui n'a rien d'évident à la lecture :
 *
 * 1. un visage bouge PARTOUT par défaut, et se tait dans le sous-arbre des
 *    réglages : la règle produit, en une assertion ;
 * 2. il bouge SANS re-rendu React. C'est la seule raison pour laquelle on peut
 *    en animer trente : le `Profiler` compte les rendus, et le compte ne doit
 *    pas bouger pendant que la pose, elle, bouge ;
 * 3. le contour n'est pas reconstruit : même chaîne `d` d'une image à l'autre,
 *    seule la transformation change ;
 * 4. deux bots d'une même liste ne respirent pas ensemble.
 *
 * Une régression sur (2) ou (3) ne se voit pas à l'écran : elle se voit au
 * ventilateur, trois écrans plus loin. D'où le test.
 */

/* `IntersectionObserver` n'existe pas dans happy-dom ; le vrai composant ne
   s'anime que pour ce qui est à l'écran, donc sans ce bouchon on testerait le
   repli « tout visible » et pas le chemin réel. */
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

/* L'horloge des visages est pilotée à la main : `face-clock` résout
   `requestAnimationFrame` à chaque appel, donc remplacer le global suffit. */
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

/** Un visage vectoriel : `artwork` absent, donc c'est le moteur bloub qui rend. */
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

    // une première image pour armer l'horloge (delta nul), puis de vraies images
    avancer(0);
    const path = corps(container as unknown as HTMLElement);
    const contourAvant = path.getAttribute("d");
    const poseAvant = path.getAttribute("transform");
    const rendusAvant = rendus;
    // garde-fou : sans rendu observé ni pose posée, les deux assertions qui
    // suivent passeraient toutes seules et ne prouveraient rien.
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
});
