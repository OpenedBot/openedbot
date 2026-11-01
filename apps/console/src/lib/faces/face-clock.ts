/**
 * L'horloge unique des visages, et l'œil qui dit lesquels sont à l'écran.
 *
 * Un `requestAnimationFrame` par pastille, c'était tenable tant qu'une seule
 * vivait à la fois (l'aperçu d'un éditeur). Le produit en montre trente : la
 * barre latérale, le fil, les mentions, la table des bots. Trente boucles, ce
 * sont trente rappels que le navigateur ordonnance séparément, trente deltas
 * calculés, et surtout trente occasions de dériver les unes des autres.
 *
 * Ici il y en a une. Elle ne tourne que s'il existe au moins un abonné, elle
 * s'arrête quand l'onglet passe en fond, et elle ne démarre pas du tout sous
 * `prefers-reduced-motion`. Son delta est borné : un onglet masqué puis
 * réaffiché reprend où il en était au lieu de sauter d'une minute.
 *
 * Le moteur bloub étant une fonction pure du temps, une horloge partagée
 * suffit : à condition de décaler chaque visage (`phaseDuVisage`), sinon les
 * trente pastilles clignent d'un seul homme.
 */

type Abonne = (secondes: number) => void

const abonnes = new Set<Abonne>()

let raf = 0
let derniereImage = 0
let secondes = 0

/** Delta borné, comme la boucle qu'elle remplace : 64 ms, soit ~4 images. */
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
 * Abonne un visage à l'horloge. Le rappel reçoit les secondes écoulées depuis
 * le premier abonnement de la session : un temps partagé, pas un temps propre.
 */
export function abonnerAuTemps(abonne: Abonne): () => void {
  abonnes.add(abonne);
  reveiller();
  return () => {
    abonnes.delete(abonne);
    if (abonnes.size === 0) dormir();
  };
}

/** Le temps courant, pour poser une image figée cohérente avec les autres. */
export function tempsDesVisages(): number {
  return secondes;
}

/** `true` quand le système demande qu'on ne bouge rien. */
export function mouvementRefuse(): boolean {
  return reduit();
}

/**
 * Le décalage propre d'un visage, en secondes.
 *
 * Dérivé de la graine, donc stable d'un rendu à l'autre et d'une session à
 * l'autre : deux bots de la même liste ne respirent pas ensemble, et un même
 * bot garde son rythme. Douze secondes couvrent largement le cycle de
 * clignement le plus long.
 */
export function phaseDuVisage(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (Math.imul(hash, 31) + seed.charCodeAt(index)) >>> 0;
  }
  return (hash % 12000) / 1000;
}

/* ----------------------------------------------------- ce qui est à l'écran */

const vus = new WeakMap<Element, (visible: boolean) => void>();

let oeil: IntersectionObserver | null = null;

function observateur(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  if (!oeil) {
    oeil = new IntersectionObserver(
      (entrees) => {
        for (const entree of entrees) vus.get(entree.target)?.(entree.isIntersecting);
      },
      // Une marge d'une hauteur d'écran : une pastille qui arrive par le
      // défilement est déjà vivante quand elle entre, sans à-coup de départ.
      { rootMargin: "100% 0px" },
    );
  }
  return oeil;
}

/**
 * Signale l'entrée et la sortie d'écran d'un visage, via UN observateur partagé.
 *
 * Sans cela, un fil de deux cents messages animerait deux cents pastilles dont
 * douze sont visibles. Là où l'API manque (jsdom, vieux WebKit), on considère
 * tout visible : le repli anime trop, jamais trop peu.
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
