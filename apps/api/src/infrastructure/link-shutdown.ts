/**
 * On stop, the link broker's pending writes are flushed, but bounded: a
 * database that no longer answers must not hold the process past its stop.
 */
export async function flushLinkPersistence(
  broker: { flushPersistence(): Promise<void> },
  onError: (error: unknown) => void,
  timeoutMs = 5_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      broker.flushPersistence(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Link persistence shutdown timeout")), timeoutMs); }),
    ]);
  } catch (error) {
    onError(error);
  } finally {
    clearTimeout(timer);
  }
}
