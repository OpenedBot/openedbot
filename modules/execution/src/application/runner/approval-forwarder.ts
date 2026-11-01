/** Regroupe les déclenchements concurrents pendant l'envoi d'une autorisation. */
export function createApprovalForwarder(forward: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return () => {
    if (inFlight) return inFlight;
    const task = Promise.resolve().then(forward);
    inFlight = task.finally(() => { inFlight = null; });
    return inFlight;
  };
}
