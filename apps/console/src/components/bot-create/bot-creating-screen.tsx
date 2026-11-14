import { useNavigate } from "@tanstack/react-router";
import { SiteHeader } from "../dashboard/site-header";
import { BotFace } from "../bot-face";
import { BotArrivalStage } from "../bot-arrival-stage";
import { BUTTON } from "../settings/primitives";
import { useT } from "../../lib/i18n";
import { usePendingBotCreation } from "../../lib/bots/pending-bot-creations";

/**
 * The screen of a bot being created, shown as soon as « Créer » is clicked.
 * Its face, its name and the stages of its preparation (`BotArrivalStage`)
 * are already there; the thread waits until the server has finished.
 * On failure, the pattern stays readable, « Réessayer » replays the same request
 * (never a second bot) and the return home is offered.
 */
export function BotCreatingScreen({ botId }: { botId: string }) {
  const { t } = useT();
  const navigate = useNavigate();
  const pending = usePendingBotCreation(botId);
  const name = pending?.name ?? t("newBotDialog.defaultName");
  const face = pending?.face ?? null;
  const failed = Boolean(pending?.error);
  // A provisional address reloaded or shared no longer has a creation behind it.
  const lost = !pending;

  return (
    <>
      <SiteHeader
        align="start"
        avatar={<BotFace name={name} seed="preview" face={face} animated={false} className="size-6" />}
        title={<span className="truncate">{name}</span>}
      />
      {/* In progress: the screen the conversation picks up as is, with no jump. */}
      {!failed && !lost ? (
        <BotArrivalStage bot={{ id: null, name, face }} progress={null} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center" aria-live="polite">
          <BotFace name={name} seed="preview" face={face} animated={false} className="size-24" />
          {lost ? (
            <p className="text-sm text-text-secondary">{t("newBotDialog.creatingLost")}</p>
          ) : (
            <div className="flex max-w-sm flex-col items-center gap-2">
              <p className="text-base font-semibold text-text-primary">{t("newBotDialog.createFailed")}</p>
              <p role="alert" className="text-sm text-text-secondary">{pending?.error}</p>
              {pending?.retry ? <p className="text-xs text-text-tertiary">{t("newBotDialog.retryHint")}</p> : null}
            </div>
          )}
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
        </div>
      )}
    </>
  );
}
