/**
 * L'erreur de toute trame refusée. Dans son propre fichier pour que les
 * décodeurs annexes (`relay-frames-yolo.ts`) la lèvent sans importer
 * `relay-frames.ts`, qui leur délègue : pas de cycle d'imports.
 */
export class RelayFrameError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RelayFrameError";
  }
}
