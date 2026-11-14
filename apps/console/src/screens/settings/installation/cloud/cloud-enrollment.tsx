import { EnrollmentStep } from "../../../../components/runtime-command";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconRefresh } from "@tabler/icons-react";
import { cn, Dialog, toast } from "@openedbot/browser-ui-kit";
import { api, queryKeys } from "../../../../lib/api";
import { useT } from "../../../../lib/i18n";
import type { RuntimeEnrollmentTicketDto } from "@openedbot/contracts-api";
import { BUTTON } from "../../../../components/settings/primitives";

/**
 * The API sets `--insecure-openedbot` only on a loopback `http://` origin,
 * that is a development workstation joined by `make link-dev-up`: the
 * command itself says whether the tunnel is a prerequisite.
 */
function isDevelopmentLinkCommand(command: string): boolean {
  return command.includes("--insecure-openedbot");
}

/**
 * The runtimes declared by the organization: add, switch, remove.
 *
 * The list shows from the first runtime, and the add button is always
 * there. Hiding it below two runtimes closed the door: without a button, no
 * second runtime could be born from the application, so the list
 * never showed.
 */
/**
 * Outgoing pairing: a command to run on the host, and nothing to copy.
 *
 * The gateway's bearer crosses neither the clipboard, nor the scrollback, nor
 * this screen: the script reads it in place and pushes it. That is what makes the
 * connection tenable for any client: the application never connects
 * to their machine, it is their machine that comes to it, outgoing.
 */
/**
 * The ticket's countdown: the only thing that moves on its own here.
 *
 * An end timestamp (« jusqu'à 11:39:27 ») asked the operator to do
 * the subtraction while chasing a shell. What serves them is therefore shown (the time left), and it is made to tick each second.
 */
function useCountdown(expiresAt: string): { remainingMs: number; ratio: number } {
  const endsAt = new Date(expiresAt).getTime();
  const [now, setNow] = useState(() => Date.now());
  // The total duration is measured on mount: the ticket has just been created, so
  // the gauge starts full without the API having to publish its TTL.
  const [startedAt] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  const remainingMs = Math.max(0, endsAt - now);
  const totalMs = Math.max(1, endsAt - startedAt);
  return { remainingMs, ratio: Math.min(1, remainingMs / totalMs) };
}

function formatCountdown(remainingMs: number): string {
  const seconds = Math.ceil(remainingMs / 1_000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * A pairing step: its rank, its title, its copyable payload.
 *
 * `prefix` marks by eye what is typed in a shell; the ticket itself has
 * none: it is pasted at a prompt, it is not launched. The `<code>` carries
 * only the value, so a « Copier » and a drag-select render
 * exactly the same string.
 */


/**
 * The « lien openedbot » path keeps ONE width from the name to the ticket: the window
 * must not shrink between two steps of the same gesture. The wide
 * `DIRECT_DIALOG_WIDTH` stays reserved for the direct-access assistant, which
 * really has something to fill it with. 3xl because the ticket then fits on one
 * line, with no orphaned letter on the wrap.
 */
export const ENROLLMENT_DIALOG_WIDTH = "sm:max-w-3xl";

/**
 * What is played on the machine BEFORE pairing: set `edge-setup`, then
 * `up`, which installs the runtime under the `hermes` account, keeps the gateway on
 * loopback and installs the outgoing connector (edge-setup/README.md).
 * Without these gestures, the ticket's `link` command has nothing to launch.
 *
 * The binary is set by the `docs.openedbot.app/install` bootstrap: it
 * installs the release it pins from `releases.openedbot.app`, after
 * checking the Sigstore signature of its `SHA256SUMS` (the tag's release
 * workflow) then the binary's hash. Any failed check installs nothing.
 */
export const EDGE_SETUP_BOOTSTRAP_URL = "https://docs.openedbot.app/install";

export const EDGE_SETUP_INSTALL_STEPS: { title: string; value: string; hint: string }[] = [
  {
    title: "Télécharger et installer edge-setup sur le serveur Linux",
    value: `curl --proto '=https' --tlsv1.2 -fsSL ${EDGE_SETUP_BOOTSTRAP_URL} | sh`,
    hint: "À exécuter dans le terminal de votre serveur, après connexion SSH, pas sur votre ordinateur. Le script télécharge le binaire adapté depuis releases.openedbot.app, vérifie sa signature et son empreinte, puis l’installe. Pour tout vérifier sans installer : remplacez « | sh » par « | sh -s -- --dry-run ».",
  },
  {
    title: "Installer Hermes et le connecteur",
    value: "sudo edge-setup up --yes",
    hint: "Sur le même serveur, installe Hermes sous un compte non privilégié, garde le gateway sur la loopback (aucun port entrant) et installe le connecteur. Le durcissement du serveur (SSH, pare-feu, sandbox) reste optionnel et n’est pas activé par cette commande.",
  },
];

/**
 * Pairing, in a modal box: the same window as « Ajouter un runtime »,
 * whose content switches once the ticket is open.
 *
 * Rendered flat in the card, it pushed the register upward and left
 * the screen telling two things at once: an empty registry, and a pairing in
 * progress right underneath. The gesture is modal because it is blocking: while
 * the machine has not presented itself, there is nothing else to do here.
 *
 * The countdown is the only thing that moves, so the only one entitled
 * to weight: tabular figures, and the gauge serves as the hairline between the delay
 * and the two steps. Everything else stays set back.
 */
export function RuntimeEnrollmentDialog({
  ticket,
  onDone,
  onCancel,
}: {
  ticket: RuntimeEnrollmentTicketDto;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const { remainingMs, ratio } = useCountdown(ticket.expiresAt);
  const expired = remainingMs <= 0;
  const urgent = !expired && remainingMs <= 60_000;
  // While the box is open, the enrollment's OWN state is probed:
  // comparing URLs proved only a coincidence, and a connector runtime
  // has none at all.
  const status = useQuery({
    queryKey: queryKeys.runtimeEnrollmentStatus(ticket.enrollmentId),
    queryFn: () => api.runtimeEnrollmentStatus(ticket.enrollmentId),
    refetchInterval: expired ? false : 3_000,
  });
  const completed = status.data?.state === "completed";
  // Claimed records the operator's organization, not a connection from the host.
  const enrollmentProgress = completed ? 100 : 25;
  const enrollmentStatus = completed
    ? "Appairage terminé"
    : "En attente de la connexion de l’hôte…";
  useEffect(() => {
    if (!completed) return;
    toast.success(`${ticket.runtimeName} est connecté.`);
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfiguration });
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtime });
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeList });
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimes });
    onDone();
  }, [completed, onDone, queryClient, ticket.runtimeName]);

  return (
    <Dialog
      open
      onClose={onCancel}
      title={`Appairer ${ticket.runtimeName}`}
      description="La machine ouvre elle-même la connexion vers openedbot : le token du gateway est lu sur place et prouvé par le lien. Ni cette fenêtre ni votre presse-papiers ne le voient."
      className={ENROLLMENT_DIALOG_WIDTH}
      bodyClassName="p-0"
      // The cross and the foot's button do the same thing: two identical
      // accessible names would leave a screen reader announcing
      // « Fermer » twice without saying which is which.
      closeLabel="Fermer la fenêtre"
      footerClassName="sm:justify-between"
      footer={expired ? (
        <>
          <p role="alert" className="min-w-0 text-xs leading-5 text-destructive-text">
            Ticket expiré. Fermez, puis relancez « Appairer depuis le serveur » pour en obtenir un autre.
          </p>
          <button type="button" className={BUTTON.primary} onClick={onCancel}>
            Fermer
          </button>
        </>
      ) : (
        <>
          <p role="status" className="flex min-w-0 items-center gap-2 text-xs leading-5 text-muted-foreground">
            <IconRefresh aria-hidden className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
            {enrollmentStatus}
          </p>
          <button type="button" className={BUTTON.secondary} onClick={onCancel}>
            Fermer
          </button>
        </>
      )}
    >
      <div className="flex items-baseline justify-between gap-4 px-5 pt-4 pb-3">
        <p className="min-w-0 text-xs leading-5 text-muted-foreground">
          {expired ? "Le ticket ne vaut plus rien" : "Ticket valable encore"}
        </p>
        <p
          role="timer"
          aria-label={expired ? "Ticket expiré" : `Ticket valable encore ${formatCountdown(remainingMs)}`}
          className={cn(
            "shrink-0 font-mono text-3xl leading-none tabular-nums",
            expired ? "text-destructive-text" : urgent ? "text-warn-700" : "text-foreground",
          )}
        >
          {expired ? "expiré" : formatCountdown(remainingMs)}
        </p>
      </div>
      {/*
        The gauge is the hairline between the delay and the steps: it empties in view,
        so the time left is read without reading the figure. `transition`
        only when motion is accepted; otherwise it jumps from one
        second to the next.
      */}
      <div aria-hidden className="h-0.5 w-full bg-border">
        <div
          className={cn(
            "h-full transition-[width] duration-1000 ease-linear motion-reduce:transition-none",
            expired ? "bg-destructive" : urgent ? "bg-warn-700" : "bg-foreground/60",
          )}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      <div
        role="progressbar"
        aria-label="Progression de l’appairage"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={enrollmentProgress}
        className="h-1 w-full overflow-hidden bg-surface-sunken"
      >
        <div
          className="h-full bg-info-700 transition-[width] duration-500 motion-reduce:transition-none"
          style={{ width: `${enrollmentProgress}%` }}
        />
      </div>
      <ol className={cn("space-y-5 px-5 py-4", expired && "opacity-50")}>
        <EnrollmentStep
          index={1}
          title={`Lancer la commande sur ${ticket.runtimeName}`}
          value={ticket.command}
          copyLabel="La commande"
          prefix="$"
        >
          <p>
            Suppose <code>edge-setup</code> installé et <code>sudo edge-setup up --yes</code> déjà joué sur{" "}
            {ticket.runtimeName}. Sinon, fermez : la fenêtre précédente donne ces commandes.
          </p>
          {isDevelopmentLinkCommand(ticket.command) ? (
            <p role="note" className="text-warn-700">
              Mode développement : {ticket.runtimeName} joint cette API par un tunnel SSH inverse. Lancez{" "}
              <code>make link-dev-up HOST=hermes-admin@&lt;vps&gt;</code> dans un terminal du poste : cette cible
              ouvre le tunnel puis relie elle-même une instance nommée du VPS (<code>mac</code> par défaut), avec
              son propre ticket, donc la commande ci-dessus ne sert que si vous ouvrez le tunnel à la main. Elle démarre
              automatiquement la passerelle locale si votre environnement utilise le mode <code>separate</code>,
              et garde le tunnel ouvert en arrière-plan jusqu’à <code>make link-dev-down</code>.
            </p>
          ) : null}
        </EnrollmentStep>
        <EnrollmentStep
          index={2}
          title={t("cloudRuntimeSettings.enrollmentTicketStepTitle")}
          value={ticket.ticket}
          copyLabel="Le ticket"
          wrap
        >
          <code>edge-setup</code> le demande sans l’afficher. Il ne figurera ni dans argv ni dans
          l’historique du shell, et ne sert qu’une fois.
        </EnrollmentStep>
      </ol>
    </Dialog>
  );
}
