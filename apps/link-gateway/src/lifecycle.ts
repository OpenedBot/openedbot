import { API_INSTANCE_DEAD_AFTER_MS, type InstanceRegistry } from "@openedbot/runtime-link/application/instances";

/**
 * Bail de routage de la passerelle : les autres instances ne joignent ses
 * runtimes que tant que `api_instances.last_seen_at` a moins de 60 s
 * (`runtime_link_owner()`). `SELECT 1` peut répondre alors que le heartbeat
 * échoue ou reste suspendu : la santé lit donc le dernier heartbeat RÉUSSI.
 * L'instant retenu est celui du départ de l'appel, jamais postérieur à
 * `now()` côté base : le bail n'est pas surestimé.
 */
export function routingLease(registry: InstanceRegistry, now: () => number = Date.now) {
  let renewedAt: number | null = null;
  return {
    async heartbeat(): Promise<void> {
      const startedAt = now();
      await registry.heartbeat();
      renewedAt = renewedAt === null ? startedAt : Math.max(renewedAt, startedAt);
    },
    fresh(): boolean {
      return renewedAt !== null && now() - renewedAt < API_INSTANCE_DEAD_AFTER_MS;
    },
  };
}

/** Une étape d'arrêt au-delà de son échéance : le processus doit pouvoir sortir quand même. */
export class ShutdownDeadlineError extends Error {
  constructor(step: string) {
    super(`Gateway shutdown step exceeded its deadline: ${step}`);
    this.name = "ShutdownDeadlineError";
  }
}

/** `work` avant `deadline` (horloge `Date.now()`), sinon rejet ; le travail suspendu n'est pas attendu. */
export async function beforeDeadline<T>(work: Promise<T>, deadline: number, step: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ShutdownDeadlineError(step)), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Budget de chaque étape d'arrêt (heartbeat et vidage, retrait du registre, fermeture du pool). */
export const SHUTDOWN_STEP_TIMEOUT_MS = 5_000;

/**
 * Arrêt de la persistance, après la fermeture des transports. Chaque attente
 * PostgreSQL a son échéance : un heartbeat suspendu sur une requête établie ne
 * bloque ni le vidage ni le retrait du registre. La fermeture du pool, bornée
 * elle aussi par l'appelant, libère ensuite la requête suspendue.
 */
export async function stopPersistence(steps: {
  heartbeatWork: Promise<void>;
  flush: () => Promise<void>;
  stopRegistry: () => Promise<void>;
  stepTimeoutMs?: number;
}): Promise<void> {
  const budget = steps.stepTimeoutMs ?? SHUTDOWN_STEP_TIMEOUT_MS;
  try {
    await beforeDeadline(Promise.all([steps.heartbeatWork, steps.flush()]), Date.now() + budget, "heartbeat and persistence flush");
  } finally {
    await beforeDeadline(steps.stopRegistry(), Date.now() + budget, "instance registry stop");
  }
}
