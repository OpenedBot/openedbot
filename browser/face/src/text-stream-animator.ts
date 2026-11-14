/**
 * Lissage d'affichage du texte streamé : même mécanique que le `useSmooth`
 * d'assistant-ui. Le pipeline livre le texte par rafales (coalescing worker
 * 100 ms + poller SSE, mesuré : +90 à +230 caractères d'un coup) ; sans
 * lissage la bulle avance par à-coups. Ici chaque rafale se déroule caractère
 * par caractère : 5 ms/caractère au plus, et plus vite dès que le retard
 * grandit : tout le retard se résorbe en ~250 ms, quelle que soit la taille
 * de la rafale.
 *
 * La classe est PURE (aucun React, aucune horloge implicite) et vit dans le
 * cœur : le web et les clients natifs animent la même bulle, chacun avec son `io`,
 * `performance.now` + `requestAnimationFrame` dans le navigateur, l'horloge
 * et le rAF de React Native sur le téléphone. Chaque client garde son propre
 * hook de trois lignes ; c'est la mécanique, elle, qui ne doit pas diverger.
 */
const DEFAULT_MAX_MS_PER_CHAR = 5;
const DEFAULT_CATCH_UP_MS = 250;

export type AnimatorIo = {
  now: () => number;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
};

export type TextStreamAnimatorTiming = {
  /** Plafond de durée par unité UTF-16 lorsque le tampon est presque vide. */
  maxMsPerChar?: number;
  /** Horizon dans lequel une grosse rafale doit être absorbée. */
  catchUpMs?: number;
};

export class TextStreamAnimator {
  targetText: string;
  private frameId: number | null = null;
  private lastUpdateTime: number;
  /** Échéance dure (horloge de `io`) avant laquelle tout le retard doit être affiché. */
  private deadline: number | null = null;

  constructor(
    public currentText: string,
    private readonly setText: (text: string) => void,
    private readonly io: AnimatorIo,
    private readonly timing: TextStreamAnimatorTiming = {},
  ) {
    this.targetText = currentText;
    this.lastUpdateTime = io.now();
  }

  /**
   * `withinMs` : borne dure. Tout le retard actuel est affiché au plus tard
   * `withinMs` après cet appel, quelle que soit sa taille (réponse conclue,
   * gros bloc reçu d'un coup). Sans elle, le débit décroît avec le retard
   * restant (5 ms/caractère en queue) et un bloc de plusieurs milliers de
   * caractères se déroule sur plusieurs secondes.
   */
  start(withinMs?: number): void {
    if (withinMs !== undefined) {
      const deadline = this.io.now() + withinMs;
      this.deadline = this.deadline === null ? deadline : Math.min(this.deadline, deadline);
    }
    if (this.frameId !== null) return;
    this.lastUpdateTime = this.io.now();
    this.frameId = this.io.requestFrame(this.animate);
  }

  stop(): void {
    this.deadline = null;
    if (this.frameId === null) return;
    this.io.cancelFrame(this.frameId);
    this.frameId = null;
  }

  /** Le texte cible a été remplacé (refetch du snapshot) : pas d'animation. */
  jumpTo(text: string): void {
    this.stop();
    this.deadline = null;
    this.currentText = text;
    this.targetText = text;
    this.setText(text);
  }

  private animate = (): void => {
    const currentTime = this.io.now();
    let timeToConsume = currentTime - this.lastUpdateTime;
    const remainingChars = this.targetText.length - this.currentText.length;
    if (remainingChars <= 0) {
      this.frameId = null;
      this.deadline = null;
      return;
    }
    const maxMsPerChar = this.timing.maxMsPerChar ?? DEFAULT_MAX_MS_PER_CHAR;
    const catchUpMs = this.timing.catchUpMs ?? DEFAULT_CATCH_UP_MS;
    let timePerChar = Math.min(maxMsPerChar, catchUpMs / remainingChars);
    if (this.deadline !== null) {
      // Le temps restant avant l'échéance, réparti sur le retard : le débit ne
      // peut que monter, et à l'échéance tout ce qui reste est affiché (0 ms
      // par caractère).
      const msLeft = this.deadline - currentTime;
      timePerChar = msLeft <= 0 ? 0 : Math.min(timePerChar, msLeft / remainingChars);
    }

    let charsToAdd = 0;
    while (timeToConsume >= timePerChar && charsToAdd < remainingChars) {
      charsToAdd += 1;
      timeToConsume -= timePerChar;
    }

    this.frameId = charsToAdd === remainingChars ? null : this.io.requestFrame(this.animate);
    if (charsToAdd === remainingChars) this.deadline = null;
    if (charsToAdd === 0) return;
    let sliceEnd = this.currentText.length + charsToAdd;
    // Ne jamais exposer la moitié d'un surrogate UTF-16 à React/Markdown : un
    // emoji arrivait brièvement sous forme de losange de remplacement.
    if (
      sliceEnd < this.targetText.length &&
      isHighSurrogate(this.targetText.charCodeAt(sliceEnd - 1)) &&
      isLowSurrogate(this.targetText.charCodeAt(sliceEnd))
    ) sliceEnd += 1;
    this.currentText = this.targetText.slice(0, sliceEnd);
    this.lastUpdateTime = currentTime - timeToConsume;
    this.setText(this.currentText);
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
