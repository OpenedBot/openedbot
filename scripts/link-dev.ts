#!/usr/bin/env bun
/**
 * The whole dev link from the workstation, run by `make link-dev-up` (link-dev-pass.sh).
 *
 * One command does what the runbook used to spread over two terminals and a
 * copy-paste: it opens the reverse SSH tunnel (VPS loopback:<port of this
 * instance> -> the local API or link listener), asks the LOCAL openedbot for an enrollment ticket, links a
 * NAMED connector instance on the VPS with that ticket on stdin, waits for the
 * enrollment to complete, then keeps the tunnel open until Ctrl-C.
 *
 * Re-linking always replaces the link of the instance it targets, so the same
 * command flips a slot between a development openedbot and production.
 * The default instance is named after this workstation (`homelab-01`,
 * `dev-macbook-pro`) and owns its own VPS port, so an unqualified run never
 * takes production over and two workstations never share a slot;
 * LINK_DEV_INSTANCE=default opts into the single production slot. An instance
 * already linked to this tunnel is reused without a ticket. `--plan` prints
 * `<instance> <VPS port>` and touches nothing.
 *
 * `--ticket-file <path>` links with a ticket opened in the console instead
 * (Settings, Installation, pairing dialog), so the runtime lands in the
 * workspace of whoever opened it, a Google account included: the dev
 * account's login is skipped. Such a ticket always re-links the instance,
 * even one already linked, since moving it is the point. The file (0600,
 * written by link-dev-pass.sh) is deleted as soon as it is read; the console
 * dialog confirms the pairing and offers to activate the runtime.
 *
 * Secrets: the ticket goes to the VPS on stdin and is never logged; the
 * password of the local dev account is read from the environment only.
 */
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { gatewayStaleness, localCredentials, planLinkDev, type LinkDevPlan, remoteConnectorRestartCommand, remoteLinkCommand, remoteLinkState, remoteShell } from "./lib/link-dev";
import { passwordLogin } from "./lib/password-login";
import { sshRemote } from "./lib/ssh-remote";

const C_OK = "\x1b[32m", C_WARN = "\x1b[33m", C_ERR = "\x1b[31m", C_RESET = "\x1b[0m";
const say = (text: string) => console.log(`${C_OK}[link-dev]${C_RESET} ${text}`);
const warn = (text: string) => console.error(`${C_WARN}[link-dev]${C_RESET} ${text}`);
const die = (text: string, code = 1): never => {
  console.error(`${C_ERR}[link-dev]${C_RESET} ${text}`);
  process.exit(code);
};

function readArgs(argv: string[]) {
  const options = { host: process.env.HOST ?? "", instance: undefined as string | undefined, runtimeName: undefined as string | undefined, ssh: process.env.LINK_TUNNEL_SSH || "ssh", check: false, plan: false, ticketFile: undefined as string | undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = () => argv[++index] ?? die(`${arg} attend une valeur`, 2);
    if (arg === "--host") options.host = next();
    else if (arg === "--instance") options.instance = next();
    else if (arg === "--runtime-name") options.runtimeName = next();
    else if (arg === "--ssh") options.ssh = next();
    else if (arg === "--check") options.check = true;
    else if (arg === "--ticket-file") options.ticketFile = next();
    else if (arg === "--plan") options.plan = true;
    else die(`argument inconnu : ${arg}`, 2);
  }
  if (!options.plan && !options.host.trim()) die("HOST est requis : make link-dev-up HOST=user@vps", 2);
  return options;
}

async function healthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Enveloppe du module borné : voir `scripts/lib/ssh-remote.ts` pour les trois
 * échéances et la régression qu'elles ferment. Aucun appel distant d'ici ne
 * doit contourner ce chemin.
 */
async function remote(
  ssh: string,
  host: string,
  argv: string[],
  stdin?: string,
  timeoutMs?: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await sshRemote({ ssh, host, argv, stdin, timeoutMs });
  return { code, stdout, stderr };
}

/**
 * Ce que le VPS dit de l'instance visée. Lève sur un `edge-setup status`
 * en échec ou illisible : un état inconnu n'est jamais pris pour « absent ».
 */
async function remoteState(ssh: string, host: string, plan: LinkDevPlan): Promise<ReturnType<typeof remoteLinkState>> {
  const status = await remote(ssh, host, ["sudo", "-n", "edge-setup", "status", "--json"]);
  if (status.code !== 0) throw new Error(`edge-setup status --json a échoué sur le VPS : ${status.stderr.trim() || status.stdout.trim()}`);
  return remoteLinkState(JSON.parse(status.stdout), plan);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(argv: string[]): Promise<string> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
  const [text] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return text.trim();
}

/** Best effort: any failure here means "no hint", never a blocked link. */
async function stalenessHints(mode: "embedded" | "separate"): Promise<string[]> {
  if (mode !== "separate") return [];
  try {
    const monotonicUs = Number(await run(["systemctl", "--user", "show", "-p", "ExecMainStartTimestampMonotonic", "--value", "openedbot-runtime-link-gateway"]));
    const uptimeS = Number((await Bun.file("/proc/uptime").text()).split(" ")[0]);
    if (!Number.isFinite(monotonicUs) || monotonicUs <= 0 || !Number.isFinite(uptimeS)) return [];
    const gatewayStartedAtMs = Date.now() - (uptimeS - monotonicUs / 1_000_000) * 1_000;
    const headCommittedAtMs = Number(await run(["git", "log", "-1", "--format=%ct"])) * 1_000;
    const dir = new URL("../db/migrations/", import.meta.url).pathname;
    const migrationMtimesMs = await Promise.all((await readdir(dir)).filter((name) => name.endsWith(".sql")).map(async (name) => (await stat(dir + name)).mtimeMs));
    return gatewayStaleness({ gatewayStartedAtMs, headCommittedAtMs, migrationMtimesMs });
  } catch {
    return [];
  }
}

/**
 * La session du compte de dev dans l'openedbot locale : de quoi ouvrir un enrôlement
 * et relire ses runtimes. Lève une `Error` lisible si la connexion est refusée.
 */
async function devSession(api: string): Promise<Record<string, string>> {
  const credentials = localCredentials(process.env);
  const origin = (process.env.WEB_APP_URL ?? "http://localhost:1420").replace(/\/+$/u, "");
  const login = await passwordLogin(api, {
    email: credentials.email,
    password: credentials.password,
    ...(process.env.LINK_DEV_ORGANIZATION_SLUG ? { organizationSlug: process.env.LINK_DEV_ORGANIZATION_SLUG } : {}),
  }, {
    headers: { "Content-Type": "application/json", Origin: origin },
  });
  if (!login.ok) {
    throw new Error(`Connexion à l'API locale refusée (${login.status}) pour ${credentials.email} : make db-seed, ou LINK_DEV_EMAIL / LINK_DEV_PASSWORD.`);
  }
  const session = (await login.json()) as { csrfToken: string };
  const cookie = login.headers.getSetCookie().map((entry) => entry.split(";")[0]!).join("; ");
  return { "Content-Type": "application/json", Origin: origin, Cookie: cookie, "X-CSRF-Token": session.csrfToken };
}

/**
 * Un lien vivant côté VPS ne prouve rien côté openedbot : après « Repartir de zéro »
 * ou un `make db-reset`, la base locale a pu oublier le runtime que ce lien
 * sert, et le connecteur se présente avec un jeton qu'elle refuse. Vrai quand
 * l'espace du compte de dev n'a plus aucun runtime en service ; `null` quand
 * on ne peut pas le savoir (API ou compte indisponible).
 */
async function localRuntimeForgotten(api: string): Promise<boolean | null> {
  try {
    const current = await fetch(`${api}/api/runtimes`, { headers: await devSession(api) });
    if (!current.ok) return null;
    return ((await current.json()) as { runtime?: unknown }).runtime == null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const options = readArgs(process.argv.slice(2));
  let plan: LinkDevPlan;
  try {
    plan = planLinkDev(process.env, { instance: options.instance, runtimeName: options.runtimeName });
  } catch (error) {
    return die(error instanceof Error ? error.message : String(error), 2);
  }
  if (options.plan) {
    console.log(`${plan.instance} ${plan.remotePort}`);
    return;
  }

  // `--check` : 0 si l'instance est liée à l'origine de ce tunnel, 3 si elle ne
  // l'est plus (VM revenue à un snapshot, `edge-setup reset`), 1 si le VPS n'a
  // pas pu répondre. link-dev-pass.sh s'en sert avant de réutiliser un lien vivant.
  if (options.check) {
    try {
      const state = await remoteState(options.ssh, options.host, plan);
      // Lié sur le VPS mais oublié par la base locale : à réenrôler, comme absent.
      const forgotten = state === "linked" && await localRuntimeForgotten(`http://127.0.0.1:${plan.apiPort}`) === true;
      console.log(forgotten ? "forgotten" : state);
      process.exit(state === "linked" && !forgotten ? 0 : 3);
    } catch (error) {
      return die(error instanceof Error ? error.message : String(error));
    }
  }

  // Read and delete at once: the ticket must not outlive this process on disk.
  let consoleTicket = "";
  if (options.ticketFile) {
    try {
      consoleTicket = (await readFile(options.ticketFile, "utf8")).trim();
    } finally {
      await rm(options.ticketFile, { force: true });
    }
    if (!consoleTicket) die("Le ticket collé est vide.", 2);
  }

  const api = `http://127.0.0.1:${plan.apiPort}`;

  if (!(await healthy(`${api}/api/health`))) die(`L'API locale ne répond pas sur ${api}/api/health : lancer make dev-api (ou make dev).`);
  if (!(await healthy(`http://127.0.0.1:${plan.localPort}${plan.healthPath}`))) {
    die(`Le service à exposer ne répond pas sur 127.0.0.1:${plan.localPort}${plan.healthPath} (${plan.mode}).`);
  }

  for (const hint of await stalenessHints(plan.mode)) warn(hint);

  say(`Tunnel vers ${options.host} : loopback VPS:${plan.remotePort} -> loopback locale:${plan.localPort} (${plan.mode}).`);
  // Le tunnel est le point faible du lien dev : une bascule de VPN, une veille
  // ou un changement d'IP le tuent. Mesuré : `Read from remote host: Can't
  // assign requested address`, puis le connecteur du VPS rappelant une
  // loopback muette toutes les 60 s sans que rien ici ne le dise. Les
  // ServerAlive* bornent la détection à ~15 s au lieu d'un pendu indéfini, et
  // la surveillance en fin de `main` le relève tant que la commande vit.
  const tunnelArgv = [
    options.ssh, "-N",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=3",
    "-R", `127.0.0.1:${plan.remotePort}:127.0.0.1:${plan.localPort}`,
    options.host,
  ];
  /**
   * Qui tient le port distant de CE tunnel, et le libère s'il est mort.
   *
   * Mesuré : couper un VPN tue le client SSH, mais le VPS garde le port du
   * `-R` réservé pour cette session jusqu'à ce que `sshd` la récolte, six
   * minutes plus tard avec le durcissement `edge-setup`
   * (`ClientAliveInterval 120` fois `ClientAliveCountMax 3`). Pendant tout ce
   * temps chaque relance repart dans le mur sur `remote port forwarding
   * failed`, et le lien dev reste fermé sans que personne ne sache pourquoi.
   *
   * Mesuré aussi (2026-10-12) : le port peut être tenu par le tunnel VIVANT
   * d'un autre poste, réglé sur la même instance. Le tuer couperait ce poste.
   * La différence se voit d'une requête : un tunnel vivant répond (n'importe
   * quel code HTTP), celui d'un client mort laisse la connexion sans réponse.
   * Un port qui répond n'est donc jamais libéré : `live`, avec l'adresse du
   * poste qui le tient quand `ss -p` la donne.
   *
   * Appelé seulement quand NOTRE tunnel ne tourne pas : le processus qui tient
   * le port n'est donc jamais le nôtre. Le nom de commande doit en plus être
   * une session `sshd`, sinon rien n'est tué. `ss -p` n'associe le socket à son
   * processus qu'avec privilège, d'où le `sudo -n` ; sans lui le pid manque et
   * l'état rendu est `held`.
   */
  const inspectForward = async (): Promise<{ state: "free" | "cleared" | "live" | "held"; peer?: string }> => {
    const listen = `ss -ltnpH 'sport = :${plan.remotePort}' 2>/dev/null`;
    const script = [
      `holder=$( sudo -n ${listen} || ${listen} )`,
      `[ -n "$holder" ] || exit 3`,
      `pid=$( echo "$holder" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 )`,
      `code=$( curl -s -o /dev/null -w '%{http_code}' --max-time 3 '${plan.remoteOrigin}${plan.healthPath}' )`,
      `if [ "$code" != "000" ]; then [ -n "$pid" ] && sudo -n ss -tnpH state established '( sport = :22 )' 2>/dev/null | grep "pid=$pid," | awk '{print $4}' | head -1; exit 5; fi`,
      `[ -n "$pid" ] || exit 4`,
      `case "$(ps -o comm= -p "$pid" 2>/dev/null)" in sshd*) sudo -n kill "$pid" 2>/dev/null || kill "$pid" ;; *) exit 4 ;; esac`,
    ].join("; ");
    const result = await remote(options.ssh, options.host, remoteShell(script));
    if (result.code === 0) return { state: "cleared" };
    if (result.code === 3) return { state: "free" };
    if (result.code === 5) return { state: "live", peer: result.stdout.trim() || undefined };
    return { state: "held" };
  };

  /** Le port est servi par un autre poste : l'arrêt dit lequel et comment s'en sortir. */
  const heldByAnotherWorkstation = (peer: string | undefined): string =>
    `VPS:${plan.remotePort} (instance ${plan.instance}) est déjà servi par le tunnel vivant d'un autre poste`
    + `${peer ? ` (${peer.replace(/:\d+$/u, "")})` : ""} : rien n'a été coupé. Deux postes ne peuvent pas tenir la même instance.`
    + ` Sans réglage, chaque poste prend une instance à son nom ; si ce poste en force une (LINK_DEV_INSTANCE ou LINK_TUNNEL_PORT dans .env.local),`
    + ` lui en donner une autre, puis relancer make link-dev-up.`;

  // Avant d'ouvrir quoi que ce soit : un tunnel d'un autre poste sur ce port
  // ferait échouer le nôtre, et pire, répondrait à notre sonde à sa place.
  const before = await inspectForward();
  if (before.state === "live") die(heldByAnotherWorkstation(before.peer));
  if (before.state === "cleared") warn(`Le port VPS:${plan.remotePort} restait tenu par une session SSH morte : libérée.`);

  const spawnTunnel = () => Bun.spawn(tunnelArgv, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  let tunnel = spawnTunnel();
  let stopping = false;
  const stop = () => {
    stopping = true;
    if (tunnel.exitCode === null) tunnel.kill("SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  /**
   * Le VPS joint-il la loopback rendue par le tunnel ? Une passe bornée.
   *
   * Une réponse ne vaut que si notre ssh vit encore après elle : avec
   * `ExitOnForwardFailure`, un `-R` refusé ne sort qu'une fois la réponse du
   * serveur reçue, et pendant ce temps la sonde pouvait atteindre le tunnel
   * d'un autre poste sur le même port (mesuré : « Tunnel rétabli » toutes les
   * secondes, sur un lien qui n'était pas le nôtre).
   */
  const reachesThroughTunnel = async (attempts: number): Promise<boolean> => {
    for (let attempt = 0; attempt < attempts && !stopping; attempt += 1) {
      if (tunnel.exitCode !== null) return false;
      const probe = await remote(options.ssh, options.host, ["curl", "-fsS", "--max-time", "3", `${plan.remoteOrigin}${plan.healthPath}`], undefined, 15_000);
      if (probe.code === 0) {
        await Promise.race([tunnel.exited, sleep(2_000)]);
        return tunnel.exitCode === null;
      }
      await sleep(1_000);
    }
    return false;
  };

  if (!(await reachesThroughTunnel(15))) {
    if (tunnel.exitCode !== null) {
      const holder = await inspectForward();
      if (holder.state === "live") die(heldByAnotherWorkstation(holder.peer));
      die(`Le tunnel s'est fermé (code ${tunnel.exitCode}). Le port VPS:${plan.remotePort} est-il tenu ? (ssh ${options.host} 'ss -ltnp | grep ${plan.remotePort}')`);
    }
    stop();
    die(`Depuis le VPS, ${plan.remoteOrigin}${plan.healthPath} ne répond pas à travers le tunnel.`);
  }
  say(`Le VPS atteint ${plan.remoteOrigin} à travers le tunnel.`);

  let state: ReturnType<typeof remoteLinkState>;
  try {
    state = await remoteState(options.ssh, options.host, plan);
  } catch (error) {
    stop();
    return die(error instanceof Error ? error.message : String(error));
  }

  // Le VPS tient le lien, mais la base locale a pu oublier son runtime (remise
  // à zéro de dev) : le connecteur serait refusé à chaque reconnexion. On
  // réenrôle alors, sans attendre un geste.
  const forgotten = state === "linked" && !consoleTicket && await localRuntimeForgotten(api) === true;
  if (forgotten) warn(`Instance ${plan.instance} liée sur le VPS, mais la base locale ne connaît plus son runtime (remise à zéro ?) : réenrôlement automatique.`);

  if (state === "linked" && !consoleTicket && !forgotten) {
    // Déjà lié : le connecteur attend la fin de son backoff (jusqu'à 60 s) sans
    // savoir que le tunnel vient de rouvrir. Le redémarrer repart à 1 s.
    const restarted = await remote(options.ssh, options.host, remoteConnectorRestartCommand(plan));
    if (restarted.code === 0) {
      say(`Instance ${plan.instance} déjà liée à ${plan.remoteOrigin} : connecteur redémarré pour se reconnecter tout de suite, aucun ticket consommé.`);
    } else {
      warn(`Instance ${plan.instance} déjà liée à ${plan.remoteOrigin} ; redémarrage du connecteur refusé (${restarted.stderr.trim() || `code ${restarted.code}`}) : il se reconnecte seul, jusqu'à 60 s.`);
    }
  } else if (consoleTicket) {
    // Ticket de la console : pas de connexion au compte dev, pas de sondage
    // (il faudrait la session de celui qui l'a ouvert). La fenêtre
    // d'appairage de la console suit l'enrôlement et propose l'activation.
    if (state !== "absent") warn(`L'instance ${plan.instance} est déjà liée : le ticket de la console la reprend, dans l'espace du compte qui l'a ouvert. L'ancien runtime reste listé là où il était, à révoquer.`);
    const linked = await remote(options.ssh, options.host, remoteLinkCommand(plan), `${consoleTicket}\n`, 120_000);
    consoleTicket = "";
    if (linked.stdout.trim()) console.log(linked.stdout.trimEnd());
    if (linked.code !== 0) {
      stop();
      die(`edge-setup link a échoué sur le VPS (code ${linked.code}) : ${linked.stderr.trim()}`);
    }
    say(`Ticket de la console consommé par l'instance ${plan.instance} : la fenêtre d'appairage confirme la connexion.`);
  } else {
    if (state === "elsewhere") {
      warn(`L'instance ${plan.instance} est liée à une autre origine openedbot : ce ticket la reprend ici. L'openedbot quitté garde un runtime que le VPS ne rappellera plus, à retirer là-bas.`);
    }
    const credentials = localCredentials(process.env);
    let headers: Record<string, string>;
    try {
      headers = await devSession(api);
    } catch (error) {
      stop();
      return die(error instanceof Error ? error.message : String(error));
    }

    // A fixture workspace must be proven before enrollment can change a runtime.
    if (process.env.LINK_DEV_ORGANIZATION_SLUG) {
      const me = await fetch(`${api}/api/auth/me`, { headers });
      const identity = me.ok ? await me.json() as { user?: { email?: string }; organization?: { slug?: string }; role?: string } : null;
      if (identity?.organization?.slug !== process.env.LINK_DEV_ORGANIZATION_SLUG
        || identity.user?.email !== credentials.email || identity.role !== "owner") {
        stop();
        die("Le compte propriétaire et l'espace de recette doivent être confirmés avant l'enrôlement.");
      }
    }

    const opened = await fetch(`${api}/api/runtime-enrollments/open`, { method: "POST", headers, body: JSON.stringify({ name: plan.runtimeName }) });
    if (!opened.ok) {
      stop();
      die(`Ouverture de l'enrôlement refusée (${opened.status}) : ${(await opened.text()).slice(0, 300)}`);
    }
    const enrollment = (await opened.json()) as { enrollmentId: string; ticket: string; expiresAt: string };
    say(`Ticket d'enrôlement ouvert dans l'openedbot local (runtime « ${plan.runtimeName} », instance ${plan.instance}) ; il part sur le VPS par stdin, jamais affiché.`);

    const linked = await remote(options.ssh, options.host, remoteLinkCommand(plan), `${enrollment.ticket}\n`, 120_000);
    if (linked.stdout.trim()) console.log(linked.stdout.trimEnd());
    if (linked.code !== 0) {
      stop();
      die(`edge-setup link a échoué sur le VPS (code ${linked.code}) : ${linked.stderr.trim()}`);
    }

    /**
     * L'enrôlement n'active le nouveau runtime que si aucun autre ne l'est
     * (gateway.ts, enrollConnectorRuntime). Après une VM revenue à son
     * snapshot, l'actif est l'ancien runtime de ce même lien, mort : la PWA
     * resterait dessus. On remplace l'ancien par le nouveau seulement dans ce
     * cas, un lien connector fermé ; un runtime actif encore servant n'est
     * jamais pris. Le remplacement révoque l'ancien.
     */
    const takeOverDeadActiveRuntime = async (runtimeId: string) => {
      const current = await fetch(`${api}/api/runtimes`, { headers });
      const active = current.ok
        ? ((await current.json()) as { runtime?: { id: string; name: string; isActive: boolean; reachability: string; link?: { connected?: boolean } | null } | null }).runtime ?? null
        : null;
      if (!active?.isActive || active.id === runtimeId) return;
      if (active.reachability !== "connector" || active.link?.connected !== false) {
        warn(`Le runtime actif reste « ${active.name} » (${active.id}), encore servant : le nouveau n'est pas activé. Pour le remplacer : PWA, Réglages, Edge, Remplacer.`);
        return;
      }
      // Juste après `completed`, le connecteur rouvre sa session avec le jeton
      // de lien qu'il vient de recevoir : le remplacement sonde par le tuyau et
      // répond 503 HERMES_UNREACHABLE pendant ces quelques secondes (mesuré).
      let activated = await fetch(`${api}/api/runtimes/${runtimeId}/replace`, { method: "POST", headers });
      for (let attempt = 0; attempt < 15 && activated.status === 503; attempt += 1) {
        await sleep(2_000);
        activated = await fetch(`${api}/api/runtimes/${runtimeId}/replace`, { method: "POST", headers });
      }
      if (!activated.ok) {
        warn(`Remplacement par le nouveau runtime refusé (${activated.status}) : ${(await activated.text()).slice(0, 300)}. L'actif reste ${active.id}, déconnecté.`);
        return;
      }
      say(`Runtime ${runtimeId} en service à la place de ${active.id}, dont le lien était fermé ; l'ancien est révoqué.`);
    };

    let completed = false;
    for (let attempt = 0; attempt < 30 && !completed; attempt += 1) {
      const poll = await fetch(`${api}/api/runtime-enrollments/${enrollment.enrollmentId}/status`, { headers });
      const body = (await poll.json()) as { state: string; runtimeId: string | null };
      if (body.state === "completed") {
        completed = true;
        say(`Enrôlement terminé : runtime ${body.runtimeId} dans l'openedbot local.`);
        if (body.runtimeId) await takeOverDeadActiveRuntime(body.runtimeId);
      } else if (body.state === "expired") {
        stop();
        die("Le ticket a expiré avant que le VPS ne se présente.");
      } else {
        await sleep(2_000);
      }
    }
    if (!completed) warn("L'enrôlement n'est pas encore `completed` après 60 s ; le connecteur peut encore se présenter, vérifier dans la PWA.");
  }

  const final = await remote(options.ssh, options.host, ["sudo", "-n", "edge-setup", "status"]);
  for (const line of final.stdout.split("\n")) if (line.startsWith("connector")) console.log(`  ${line}`);
  const spared = plan.instance === "default"
    ? "cette instance porte le lien du VPS, la production a été reprise"
    : `les autres instances, dont le lien par défaut, ne sont pas concernées`;
  say(`Tunnel ouvert. La PWA locale voit le runtime tant que cette commande tourne ; Ctrl-C pour fermer (${spared}).`);

  // Le lien reste à nous tant que la commande vit : une coupure réseau ferme
  // le tunnel, la relance le rouvre, et le connecteur du VPS se reconnecte
  // seul derrière, sans ticket et sans nouvel enrôlement.
  let backoffMs = 1_000;
  for (;;) {
    const code = await tunnel.exited;
    if (stopping) process.exit(code === 0 || code === 143 ? 0 : code);
    // Un port encore tenu n'est pas une panne à laisser reposer : attendre ne
    // le libère pas, seule la session morte le rend. On retente donc tout de
    // suite après l'avoir récoltée, sans reculer.
    const holder = await inspectForward();
    if (holder.state === "live") {
      // Attendre ne rendra pas le port : un autre poste le sert. Boucler ici
      // affichait « relance dans 1 s » sans fin, sur un lien qui n'était plus le nôtre.
      die(`Le tunnel s'est fermé (code ${code}). ${heldByAnotherWorkstation(holder.peer)}`);
    }
    if (holder.state === "cleared") {
      warn(`Le tunnel s'est fermé (code ${code}) ; le port VPS:${plan.remotePort} restait tenu par une session SSH morte, libérée, relance immédiate.`);
    } else {
      warn(`Le tunnel s'est fermé (code ${code}) ; relance dans ${Math.round(backoffMs / 1_000)} s.`);
      await sleep(backoffMs);
    }
    if (stopping) process.exit(0);
    tunnel = spawnTunnel();
    if (await reachesThroughTunnel(15)) {
      backoffMs = 1_000;
      // Une coupure peut être un redémarrage du VPS, et un redémarrage un retour
      // à un snapshot qui a effacé l'instance : sans ce contrôle, le tunnel
      // rouvre vers un connecteur qui n'existe plus et tout paraît vivant.
      // Le réenrôlement crée un nouveau runtime : il reste un geste explicite.
      const after = await remoteState(options.ssh, options.host, plan).catch(() => "unknown" as const);
      if (after === "absent" || after === "elsewhere") {
        stop();
        die(`Tunnel rétabli, mais l'instance ${plan.instance} n'est plus liée à ${plan.remoteOrigin} sur le VPS (${after}) : relancer make link-dev-up pour la réenrôler.`);
      }
      if (after !== "linked") {
        say("Tunnel rétabli ; état de l'instance illisible sur le VPS, le connecteur devrait se reconnecter seul.");
        continue;
      }
      // Après une minute de dials refusés, le connecteur sort en 75 et systemd
      // ne le relance pas (mesuré : coupure de 1 h 40, Mac en veille) ; dans le
      // cas court, il attend encore son backoff. Le redémarrer couvre les deux.
      const restart = remoteConnectorRestartCommand(plan);
      const restarted = await remote(options.ssh, options.host, restart);
      if (restarted.code === 0) say("Tunnel rétabli ; connecteur du VPS redémarré.");
      else warn(`Tunnel rétabli, mais le redémarrage du connecteur a échoué (${restarted.stderr.trim() || `code ${restarted.code}`}) : ssh ${options.host} '${restart.join(" ")}'.`);
    } else {
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  }
}

await main();
