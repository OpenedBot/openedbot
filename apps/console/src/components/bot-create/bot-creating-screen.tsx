import { useNavigate } from "@tanstack/react-router";
import { AgentThinking } from "@openedbot/browser-ui-kit";
import { SiteHeader } from "../dashboard/site-header";
import { BotFace } from "../bot-face";
import { BUTTON } from "../settings/primitives";
import { useT } from "../../lib/i18n";
import { usePendingBotCreation } from "../../lib/bots/pending-bot-creations";

/**
 * L'écran d'un bot en cours de création, affiché dès le clic sur « Créer ».
 * Son visage et son nom sont déjà là ; le fil attend que le serveur ait fini.
 * En échec, le motif reste lisible, « Réessayer » rejoue la même demande
 * (jamais un second bot) et le retour à l'accueil est proposé.
 */
export function BotCreatingScreen({ botId }: { botId: string }) {
  const { t } = useT();
  const navigate = useNavigate();
  const pending = usePendingBotCreation(botId);
  const name = pending?.name ?? t("newBotDialog.defaultName");
  const face = pending?.face ?? null;
  const failed = Boolean(pending?.error);
  // Une adresse provisoire rechargée ou partagée n'a plus de création derrière elle.
  const lost = !pending;

  return (
    <>
      <SiteHeader
        align="start"
        avatar={<BotFace name={name} seed="preview" face={face} animated={false} className="size-6" />}
        title={<span className="truncate">{name}</span>}
      />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center" aria-live="polite">
        <BotFace name={name} seed="preview" face={face} animated={!failed && !lost} className="size-24" />
        {lost ? (
          <p className="text-sm text-text-secondary">{t("newBotDialog.creatingLost")}</p>
        ) : failed ? (
          <div className="flex max-w-sm flex-col items-center gap-2">
            <p className="text-base font-semibold text-text-primary">{t("newBotDialog.createFailed")}</p>
            <p role="alert" className="text-sm text-text-secondary">{pending?.error}</p>
            {pending?.retry ? <p className="text-xs text-text-tertiary">{t("newBotDialog.retryHint")}</p> : null}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <p className="text-base font-semibold text-text-primary">{t("newBotDialog.creatingTitle", { name })}</p>
            {/* Le même indicateur que la conversation qui prend le relais :
                la réflexion ne s'interrompt pas au changement d'écran. */}
            <AgentThinking label={t("botProfileProvision.preparing")} />
          </div>
        )}
        {failed || lost ? (
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button type="button" className={BUTTON.secondary} onClick={() => void navigate({ to: "/", replace: true })}>
              {t("notFound.home")}
            </button>
            {failed && pending?.retry ? (
              <button type="button" className={BUTTON.primary} onClick={pending.retry}>
                {t("newBotDialog.retry")}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
