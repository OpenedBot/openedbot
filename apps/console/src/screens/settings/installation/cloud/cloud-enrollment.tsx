import { EnrollmentStep } from "../../../../components/runtime-command";
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconRefresh } from "@tabler/icons-react";
import { cn, Dialog, toast } from "@openedbot/browser-ui-kit";
import { api, queryKeys } from "../../../../lib/api";
import { formatCountdown, useCountdown } from "../../../../lib/countdown";
import { useT } from "../../../../lib/i18n";
import type { RuntimeEnrollmentTicketDto } from "@openedbot/contracts-api";
import { BUTTON } from "../../../../components/settings/primitives";

/**
 * L'API ne pose `--insecure-ohb` que sur une origine `http://` de loopback,
 * c'est-à-dire un poste de développement joint par `make link-dev-up` : la
 * commande elle-même dit si le tunnel est un prérequis.
 */
function isDevelopmentLinkCommand(command: string): boolean {
  return command.includes("--insecure-ohb");
}

/**
 * Les runtimes declares par l organisation : ajout, bascule, retrait.
 *
 * La liste s affiche des le premier runtime, et le bouton d ajout est toujours
 * la. Le masquer sous deux runtimes fermait la porte : sans bouton, aucun
 * second runtime ne pouvait naitre depuis l application, donc la liste ne
 * s affichait jamais.
 */
/**
 * L'appairage sortant : une commande à jouer sur l'hôte, et rien à recopier.
 *
 * Le bearer du gateway ne traverse ni le presse-papiers, ni le scrollback, ni
 * cet écran : le script le lit sur place et le pousse. C'est ce qui rend la
 * connexion tenable pour un client quelconque : l'application ne se connecte
 * jamais à sa machine, c'est sa machine qui vient à elle, en sortant.
 */
/*
 * Le compte à rebours du ticket (`lib/countdown.ts`) : la seule chose qui
 * bouge toute seule ici. Un horodatage de fin (« jusqu'à 11:39:27 »)
 * demandait à l'opérateur de faire la soustraction pendant qu'il court après
 * un shell. On affiche donc ce qui lui sert (le temps qui reste), et on le
 * fait battre à la seconde.
 */

/**
 * Une étape de l'appairage : son rang, son titre, sa charge utile copiable.
 *
 * `prefix` marque du regard ce qui se tape dans un shell ; le ticket, lui, n'en
 * a pas : il se colle à une invite, il ne se lance pas. Le `<code>` ne porte
 * que la valeur, pour qu'un « Copier » et un glisser-sélectionner rendent
 * exactement la même chaîne.
 */


/**
 * La voie « lien openedbot » garde UNE largeur du nom jusqu'au ticket : la fenêtre
 * ne doit pas se rétrécir entre deux étapes du même geste. Le large
 * `DIRECT_DIALOG_WIDTH` reste réservé à l'assistant d'accès direct, qui a
 * réellement de quoi le remplir. 3xl parce que le ticket tient alors sur une
 * ligne, sans lettre orpheline au retour.
 */
export const ENROLLMENT_DIALOG_WIDTH = "sm:max-w-3xl";

/**
 * Ce qui se joue sur la machine AVANT l'appairage : poser `edge-setup`, puis
 * `up`, qui installe le runtime sous le compte `hermes`, garde le gateway sur
 * loopback et installe le connector sortant (edge-setup/README.md).
 * Sans ces gestes, la commande `link` du ticket n'a rien à lancer.
 *
 * Le binaire est posé par le bootstrap `docs.openedbot.app/install` : il
 * installe la release qu'il épingle depuis `releases.openedbot.app`, après
 * avoir vérifié la signature Sigstore de son `SHA256SUMS` (workflow de release
 * du tag) puis l'empreinte du binaire. Toute vérification ratée n'installe rien.
 */
export const EDGE_SETUP_BOOTSTRAP_URL = "https://docs.openedbot.app/install";

export const EDGE_SETUP_INSTALL_STEPS: { title: string; value: string; hint: string }[] = [
  {
    title: "Installer edge-setup, signature vérifiée",
    value: `curl --proto '=https' --tlsv1.2 -fsSL ${EDGE_SETUP_BOOTSTRAP_URL} | sh`,
    hint: "Vérifie la signature de la release puis l’empreinte du binaire, et l’installe dans /usr/local/sbin. Ajoutez « -s -- --dry-run » après sh pour tout voir sans rien changer.",
  },
  {
    title: "Sécuriser le gateway et installer le connector",
    value: "sudo edge-setup up --yes",
    hint: "Installe Hermes sous un compte non privilégié, garde le gateway sur la loopback (aucun port entrant) et pose le connector qui chiffre le transfert vers openedbot.",
  },
];

/**
 * L'appairage, en boîte modale : la même fenêtre que « Ajouter un runtime »,
 * dont le contenu bascule une fois le ticket ouvert.
 *
 * Rendu à plat dans la carte, il poussait le registre vers le haut et laissait
 * l'écran raconter deux choses à la fois : un parc vide, et un appairage en
 * cours juste dessous. Le geste est modal parce qu'il est bloquant : tant que
 * la machine ne s'est pas présentée, il n'y a rien d'autre à faire ici.
 *
 * Le compte à rebours est la seule chose qui bouge, donc la seule qui a droit
 * à du poids : chiffres tabulaires, et la jauge sert de filet entre le délai
 * et les deux étapes. Tout le reste reste en retrait.
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
  // Tant que la boîte est ouverte, on sonde l'état de l'enrôlement LUI-MÊME :
  // comparer des URL ne prouvait qu'une coïncidence, et un runtime connector
  // n'en a pas du tout.
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
      // La croix et le bouton du pied font la même chose : deux noms
      // accessibles identiques laisseraient un lecteur d'écran annoncer
      // « Fermer » deux fois sans dire lequel est lequel.
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
        La jauge est le filet entre le délai et les étapes : elle se vide à vue,
        donc le temps restant se lit sans lire le chiffre. `transition`
        seulement quand le mouvement est accepté ; sinon elle saute d'une
        seconde à l'autre.
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
