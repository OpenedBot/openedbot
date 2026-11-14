/**
 * The single clock of the faces, and the eye that says which ones are on screen.
 *
 * One `requestAnimationFrame` per chip was tenable while only one
 * lived at a time (an editor preview). The product shows thirty: the
 * sidebar, the thread, the mentions, the bot table. Thirty loops are
 * thirty callbacks the browser schedules separately, thirty deltas
 * computed, and above all thirty chances to drift from one another.
 *
 * Here there is one. It runs only if there is at least one subscriber, it
 * stops when the tab goes to the background, and it does not start at all under
 * `prefers-reduced-motion`. Its delta is bounded: a tab hidden then
 * shown again resumes where it was instead of jumping a minute.
 *
 * The bloub engine being a pure function of time, a shared clock
 * is enough: provided each face is offset (`phaseDuVisage`), otherwise the
 * thirty chips blink as one.
 */

type Abonne = (secondes: number) => void

const abonnes = new Set<Abonne>()

let raf = 0
let derniereImage = 0
let secondes = 0

/** Bounded delta, like the loop it replaces: 64 ms, about ~4 frames. */
const DELTA_MAX = 0.064

function reduit(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function image(ms: number): void {
  raf = requestAnimationFrame(image);
  const dt = derniereImage ? Math.min((ms - derniereImage) / 1000, DELTA_MAX) : 0;
  derniereImage = ms;
  secondes += dt;
  for (const abonne of abonnes) abonne(secondes);
}

function reveiller(): void {
  if (raf !== 0 || abonnes.size === 0) return;
  if (reduit()) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  derniereImage = 0;
  raf = requestAnimationFrame(image);
}

function dormir(): void {
  if (raf === 0) return;
  cancelAnimationFrame(raf);
  raf = 0;
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") dormir();
    else reveiller();
  });
}

if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const sync = () => {
    if (media.matches) dormir();
    else reveiller();
  };
  if (typeof media.addEventListener === "function") media.addEventListener("change", sync);
}

/**
 * Subscribes a face to the clock. The callback receives the seconds elapsed since
 * the session's first subscription: a shared time, not a time of its own.
 */
export function abonnerAuTemps(abonne: Abonne): () => void {
  abonnes.add(abonne);
  reveiller();
  return () => {
    abonnes.delete(abonne);
    if (abonnes.size === 0) dormir();
  };
}

/** The current time, to set a frozen frame consistent with the others. */
export function tempsDesVisages(): number {
  return secondes;
}

/** `true` when the system asks that nothing move. */
export function mouvementRefuse(): boolean {
  return reduit();
}

/**
 * A face's own offset, in seconds.
 *
 * Derived from the seed, so stable from one render to the next and from one session
 * to the next: two bots in the same list do not breathe together, and the same
 * bot keeps its rhythm. Twelve seconds amply cover the longest
 * blink cycle.
 */
export function phaseDuVisage(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (Math.imul(hash, 31) + seed.charCodeAt(index)) >>> 0;
  }
  return (hash % 12000) / 1000;
}

/* ----------------------------------------------------- what is on screen */

const vus = new WeakMap<Element, (visible: boolean) => void>();

let oeil: IntersectionObserver | null = null;

function observateur(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  if (!oeil) {
    oeil = new IntersectionObserver(
      (entrees) => {
        for (const entree of entrees) vus.get(entree.target)?.(entree.isIntersecting);
      },
      // A margin of one screen height: a chip that arrives by
      // scrolling is already alive when it enters, with no start hitch.
      { rootMargin: "100% 0px" },
    );
  }
  return oeil;
}

/**
 * Signals a face's entry and exit from the screen, via ONE shared observer.
 *
 * Without that, a thread of two hundred messages would animate two hundred chips of which
 * twelve are visible. Where the API is missing (jsdom, old WebKit), everything is considered
 * visible: the fallback animates too much, never too little.
 */
export function observerLeVisage(node: Element, dire: (visible: boolean) => void): () => void {
  const observe = observateur();
  if (!observe) {
    dire(true);
    return () => {};
  }
  vus.set(node, dire);
  observe.observe(node);
  return () => {
    observe.unobserve(node);
    vus.delete(node);
  };
}
