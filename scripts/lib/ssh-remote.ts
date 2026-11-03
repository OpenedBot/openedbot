/**
 * Une commande jouée sur le VPS par SSH, toujours bornée.
 *
 * Mesuré le 11 septembre 2026 : le réseau tombe pendant la sonde de santé
 * `ssh HOST curl -fsS --max-time 3 .../health`. Le `--max-time` borne le
 * `curl` qui tourne SUR le VPS, jamais la session `ssh` qui le porte : celle
 * du jour est restée pendue neuf heures sur un `await child.exited` sans
 * échéance. La boucle de relance du tunnel de `link-dev` attendait derrière,
 * si bien que le lien connecteur est resté fermé longtemps après le retour du
 * VPS, sans qu'aucune ligne ne le dise.
 *
 * Trois bornes, du plus fin au plus grossier : `ConnectTimeout` pour la
 * poignée de main, les `ServerAlive*` pour une session déjà ouverte qui cesse
 * de répondre (environ 15 s), et le minuteur dur ci-dessous qui récolte ce que
 * `ssh` ne rend toujours pas. Ne retirer aucune des trois.
 */

/** Code rendu quand la commande distante a été tuée sur minuteur, comme `timeout(1)`. */
export const REMOTE_TIMED_OUT = 124;

/** Borne par défaut d'une commande distante ordinaire (sonde, inventaire, statut). */
export const REMOTE_TIMEOUT_MS = 30_000;

export type RemoteResult = { code: number; stdout: string; stderr: string; timedOut: boolean };

export type RemoteOptions = {
  /** Exécutable SSH, surchargeable par `--ssh` / `LINK_TUNNEL_SSH` (et par les tests). */
  ssh: string;
  host: string;
  argv: string[];
  /** Écrit sur l'entrée standard puis fermé ; un ticket ne passe jamais par argv. */
  stdin?: string;
  timeoutMs?: number;
};

/** Les options qui bornent la session elle-même, avant tout minuteur local. */
export function sshGuardArgs(): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=3",
  ];
}

export async function sshRemote(options: RemoteOptions): Promise<RemoteResult> {
  const timeoutMs = options.timeoutMs ?? REMOTE_TIMEOUT_MS;
  const child = Bun.spawn([options.ssh, ...sshGuardArgs(), options.host, ...options.argv], {
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.stdin !== undefined && child.stdin) {
    child.stdin.write(options.stdin);
    child.stdin.end();
  }
  const collected = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  // Lire les flux jusqu'au bout ne suffit PAS à rendre la main : un descendant
  // du processus tué garde le tube ouvert, et l'attente reprend là où elle
  // devait s'arrêter (prouvé par le test « a hung session is reaped »). Le
  // minuteur gagne donc la course lui-même, puis annule ce qui traîne.
  let expire: (() => void) | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    expire = () => resolve("timeout");
  });
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    expire?.();
  }, timeoutMs);
  try {
    const outcome = await Promise.race([collected, deadline]);
    if (outcome !== "timeout") {
      const [stdout, stderr, code] = outcome;
      return { code, stdout, stderr, timedOut: false };
    }
    void collected.catch(() => {});
    void child.stdout.cancel?.().catch(() => {});
    void child.stderr.cancel?.().catch(() => {});
    return {
      code: REMOTE_TIMED_OUT,
      stdout: "",
      stderr: `ssh ${options.host} : abandon après ${Math.round(timeoutMs / 1_000)} s sans réponse.`,
      timedOut: true,
    };
  } finally {
    clearTimeout(timer);
  }
}
