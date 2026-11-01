import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { IconCheck, IconExternalLink, IconX } from "@tabler/icons-react";
import { Dialog, DotMatrix, cn } from "@openedbot/browser-ui-kit";
import type { RuntimeMcpOauthDto } from "@openedbot/contracts-api";
import { api, queryKeys } from "../../../../lib/api";
import { useT, type MessageKey } from "../../../../lib/i18n";
import { BUTTON, Note } from "../../../../components/settings/primitives";
import { useMcpLiveReload } from "../../../../lib/runtime/mcp-live-reload";

/**
 * L'autorisation OAuth d'un serveur, dans une boîte à part.
 *
 * Ouvrir la boîte DÉMARRE l'autorisation sur l'hôte : c'est lui qui découvre
 * le fournisseur, enregistre son client et génère l'URL ; ce navigateur ne
 * fait que l'ouvrir dans un onglet, puis attendre. Le retour du fournisseur
 * passe par l'API, jamais par ce composant, et la session ne devient
 * « connectée » que lorsque l'hôte a relu un jeton sur son disque et listé les
 * outils avec lui. Rien de secret n'arrive jamais ici.
 */
/**
 * Ce qui se relie à quoi, quand l'autorisation sert UN bot : le service et le
 * bot, chacun avec son visage. La boîte les montre côte à côte, reliés par un
 * trait qui porte l'état (en attente, relié, rompu).
 */
export type McpOauthPairing = {
  service: { name: string; logo: ReactNode };
  bot: { name: string; face: ReactNode };
};

export function McpOauthDialog({
  server,
  title,
  pairing,
  start: startSession,
  onClose,
  onConnected,
}: {
  server: string | null;
  /** Le nom affiché, quand il diffère du nom du serveur sur l'hôte. */
  title?: string;
  /** Présent pour une connexion à un bot : l'en-tête service ↔ bot remplace l'explication générale. */
  pairing?: McpOauthPairing;
  /**
   * Ce qui ouvre l'autorisation. Par défaut celle de la racine du runtime ;
   * le volet d'un bot passe la connexion du catalogue, pour son profil.
   */
  start?: (server: string) => Promise<RuntimeMcpOauthDto>;
  onClose: () => void;
  onConnected: () => void;
}) {
  const { t, formatNumber } = useT();
  const liveReload = useMcpLiveReload(server !== null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () => (startSession ?? api.startRuntimeMcpOauth)(server!),
    onSuccess: (session) => setSessionId(session.sessionId),
  });
  const notifiedRef = useRef<string | null>(null);
  /**
   * L'état vit AU-DESSUS de la boîte, pas dans son corps : les actions sont
   * des CTA, et un CTA vit dans le pied `.bottomBar`, hors du défilement,
   * comme une barre d'outils iOS. Un composant enfant ne pourrait pas les y
   * poser.
   *
   * D'où ce départ piloté par un effet plutôt que par un remontage (`key`) :
   * ouvrir la boîte démarre une session, en rouvrir une doit en démarrer une
   * neuve, et fermer ne doit RIEN remettre à zéro tant que la feuille glisse
   * encore, sinon le corps se vide sous les yeux pendant l'animation.
   */
  const startedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (server === null) {
      startedForRef.current = null;
      return;
    }
    if (startedForRef.current === server) return;
    startedForRef.current = server;
    notifiedRef.current = null;
    setSessionId(null);
    start.mutate();
  }, [server, start]);
  const session = useQuery({
    queryKey: queryKeys.runtimeMcpOauth(server ?? "none", sessionId ?? "none"),
    queryFn: () => api.runtimeMcpOauth(server!, sessionId!),
    // Boîte fermée : plus de sonde. Le cache garde le dernier état le temps
    // que la feuille finisse de sortir.
    enabled: server !== null && Boolean(sessionId),
    refetchInterval: (query) => {
      // Une session perdue (hôte redémarré, 404) ne se sonde plus.
      if (query.state.status === "error") return false;
      const state = query.state.data?.status;
      return state === "starting" || state === "pending" ? 1_500 : false;
    },
  });
  const current: RuntimeMcpOauthDto | undefined = session.data ?? start.data;
  const cancel = useMutation({ mutationFn: () => api.cancelRuntimeMcpOauth(server!, sessionId!) });
  useEffect(() => {
    if (current?.status !== "connected" || notifiedRef.current === current.sessionId) return;
    notifiedRef.current = current.sessionId;
    onConnected();
  }, [current, onConnected]);

  const waiting = current?.status === "starting" || current?.status === "pending";
  const retryable = current?.status === "failed" || current?.status === "cancelled";
  // Le nom survit à la fermeture le temps que la feuille glisse : un titre
  // vidé d'un coup se remarque plus que la feuille elle-même.
  const lastServerRef = useRef<string | null>(null);
  if (server !== null) lastServerRef.current = title ?? server;
  const shown = server !== null ? (title ?? server) : lastServerRef.current;
  return (
    <Dialog
      open={server !== null}
      onClose={onClose}
      title={shown ?? ""}
      closeLabel={t("common.close")}
      footer={
        <>
          {waiting && sessionId ? (
            <button type="button" className={BUTTON.secondary} disabled={cancel.isPending} onClick={() => cancel.mutate()}>
              {t("common.cancel")}
            </button>
          ) : (
            <button type="button" className={BUTTON.secondary} onClick={onClose}>{t("common.close")}</button>
          )}
          {retryable ? (
            <button type="button" className={BUTTON.primary} disabled={start.isPending} onClick={() => { setSessionId(null); start.mutate(); }}>
              {t("connectorsSettings.mcpOauthRetry")}
            </button>
          ) : current?.status === "pending" && current.authorizationUrl ? (
            /* Le CTA de la feuille : l'onglet du fournisseur. Un lien, parce
               que c'est une navigation, mais posé dans la barre du bas, pas
               dans le défilement. */
            <a className={BUTTON.primary} href={current.authorizationUrl} target="_blank" rel="noreferrer">
              {pairing ? t("connectorsPage.oauthOpen", { name: pairing.service.name }) : t("connectorsSettings.mcpOauthOpen")}
              <IconExternalLink aria-hidden className="size-4" />
            </a>
          ) : null}
        </>
      }
    >
      <div className="grid gap-3">
        {pairing ? (
          <>
            <PairingHeader
              pairing={pairing}
              state={start.error || session.error || current?.status === "failed"
                ? "broken"
                : current?.status === "connected"
                  ? "linked"
                  : current?.status === "cancelled"
                    ? "idle"
                    : "waiting"}
            />
            <p className="text-center text-sm leading-6 text-muted-foreground text-balance">
              {t("connectorsPage.oauthBody", { name: pairing.service.name, bot: pairing.bot.name })}
            </p>
          </>
        ) : (
          <>
            <p className="text-sm font-semibold tracking-tight">{t("connectorsSettings.mcpOauthTitle", { name: shown ?? "" })}</p>
            <p className="text-sm leading-6 text-muted-foreground">{t("connectorsSettings.mcpOauthDescription")}</p>
          </>
        )}
        {start.error ? (
          <Note tone="danger" role="alert">{start.error instanceof Error ? start.error.message : t("connectorsSettings.mcpOauthFailed")}</Note>
        ) : session.error ? (
          <Note tone="danger" role="alert">{t("connectorsSettings.mcpOauthSessionLost")}</Note>
        ) : !current || current.status === "starting" ? (
          <p role="status" className={cn("flex items-center gap-2 text-sm text-muted-foreground", pairing && "justify-center")}>
            {pairing ? null : <DotMatrix aria-hidden state="connecting" label={t("connectorsSettings.mcpOauthPreparing")} />}
            {t("connectorsSettings.mcpOauthPreparing")}
          </p>
        ) : current.status === "pending" ? (
          <p role="status" className={cn("flex items-center gap-2 text-sm text-muted-foreground", pairing && "justify-center")}>
            {pairing ? null : <DotMatrix aria-hidden state="waiting" label={t("connectorsSettings.mcpOauthWaiting")} />}
            {t("connectorsSettings.mcpOauthWaiting")}
          </p>
        ) : current.status === "connected" ? (
          <div className="grid gap-2">
            <Note tone="success" role="status">
              {current.discoveredTools.length > 0
                ? t("connectorsSettings.mcpOauthConnected", { count: formatNumber(current.discoveredTools.length) })
                : t("connectorsSettings.mcpOauthConnectedNoTools")}
            </Note>
            <Note tone="info">{t(liveReload ? "connectorsSettings.mcpOauthLiveHint" : "connectorsSettings.mcpOauthRestartHint")}</Note>
          </div>
        ) : current.status === "cancelled" ? (
          <Note tone="neutral">{t("connectorsSettings.mcpOauthCancelled")}</Note>
        ) : (
          <Note tone="danger" role="alert">{t(oauthErrorKey(current.errorCode))}</Note>
        )}
      </div>
    </Dialog>
  );
}

/**
 * Le message d'un échec, par son code : jamais le texte de l'hôte, qui est en
 * anglais et décrit l'implémentation plutôt que ce que la personne peut faire.
 */
function oauthErrorKey(code: string | null | undefined): MessageKey {
  switch (code) {
    case "OAUTH_TIMEOUT": return "connectorsSettings.mcpOauthErrorTimeout";
    case "OAUTH_CALLBACK_INVALID": return "connectorsSettings.mcpOauthErrorCallback";
    case "OAUTH_REGISTRATION_REFUSED": return "connectorsSettings.mcpOauthErrorRegistration";
    case "OAUTH_NO_TOKEN": return "connectorsSettings.mcpOauthErrorNoToken";
    case "PROFILE_NOT_FOUND": return "connectorsSettings.mcpOauthErrorProfile";
    default: return "connectorsSettings.mcpOauthFailed";
  }
}

type PairingState = "waiting" | "linked" | "broken" | "idle";

/**
 * Le service à gauche, le bot à droite, et entre eux le trait de la connexion :
 * pointillé et animé tant que l'autorisation attend, plein et coché une fois
 * le jeton prouvé, coupé d'une croix si elle échoue. C'est le seul élément
 * marquant de la boîte ; tout le reste se tait.
 */
function PairingHeader({ pairing, state }: { pairing: McpOauthPairing; state: PairingState }) {
  const line = state === "linked"
    ? "border-t-2 border-solid border-pos-700/70"
    : state === "broken"
      ? "border-t-2 border-dashed border-destructive/50"
      : "border-t-2 border-dashed border-border";
  return (
    <div data-oauth-pairing={state} className="flex items-center justify-center gap-3 pt-1 pb-2">
      <PairingSide label={pairing.service.name}>{pairing.service.logo}</PairingSide>
      <div aria-hidden className="relative flex w-24 items-center justify-center">
        <span className={cn("absolute inset-x-0 top-1/2", line)} />
        <span className="relative flex size-7 items-center justify-center rounded-full border border-border bg-card">
          {state === "linked" ? (
            <IconCheck className="size-4 text-pos-700" />
          ) : state === "broken" ? (
            <IconX className="size-4 text-destructive-text" />
          ) : state === "waiting" ? (
            <DotMatrix state="waiting" label="" />
          ) : null}
        </span>
      </div>
      <PairingSide label={pairing.bot.name}>{pairing.bot.face}</PairingSide>
    </div>
  );
}

function PairingSide({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="flex w-20 flex-col items-center gap-1.5">
      <span className="flex size-12 items-center justify-center [&>[data-connector-logo]]:size-12 [&>[data-connector-logo]]:rounded-xl [&>[data-connector-logo]>svg]:size-6">
        {children}
      </span>
      <span className="max-w-full truncate text-xs font-medium text-foreground">{label}</span>
    </span>
  );
}
