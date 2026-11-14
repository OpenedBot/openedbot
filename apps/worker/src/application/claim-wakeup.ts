export type RunQueueNotifications = {
  start(wake: () => void): void;
  stop(): Promise<void>;
};

/** Notifications are hints. The generation retains a hint received during an empty claim. */
export function createClaimWakeup() {
  let generation = 0;
  let waiting: (() => void) | null = null;
  return {
    generation: () => generation,
    notify: () => {
      generation += 1;
      waiting?.();
    },
    wait: (since: number, timeoutMs: number, signal: AbortSignal): Promise<void> => {
      if (signal.aborted || generation !== since) return Promise.resolve();
      return new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", finish);
          if (waiting === finish) waiting = null;
          resolve();
        };
        const timeout = setTimeout(finish, timeoutMs);
        waiting = finish;
        signal.addEventListener("abort", finish, { once: true });
      });
    },
  };
}
