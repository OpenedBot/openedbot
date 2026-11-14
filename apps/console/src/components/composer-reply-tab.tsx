import { Reply, X } from "lucide-react";
import { keepSoftKeyboard } from "../lib/composer/composer-keyboard";
import { useT } from "../lib/i18n";

/**
 * The reply in progress, as a tab set behind the composer's card (like
 * the runtime notice): it sticks out at the top, the card paints over its bottom.
 * « Réponse à Nom » above, the quote below, the cross on the right.
 * See `DESIGN.md` › Bureau › Composer : réponse.
 */
export function ComposerReplyTab({ preview, onCancel }: { preview: { author: string; text: string }; onCancel?: () => void }) {
  const { t } = useT();
  return (
    <div
      data-composer-reply=""
      className="openedbot-fade-up mx-4 -mb-3 flex min-w-0 items-start gap-2 rounded-t-2xl border border-b-0 border-s-2 border-composer-edge border-s-[color:var(--bot-tint,var(--color-composer-edge-hover))] bg-background-secondary-default px-3 pt-2 pb-5 text-xs leading-5 text-text-secondary shadow-xs dark:bg-background-tertiary-default"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-text-primary">{t("composer.replyingTo", { name: preview.author })}</p>
        <p className="flex min-w-0 items-center gap-1.5 text-text-secondary" title={preview.text}>
          <Reply className="size-3 shrink-0 text-foreground-icon-secondary" aria-hidden />
          <span className="min-w-0 truncate">{preview.text || "…"}</span>
        </p>
      </div>
      {onCancel ? (
        <button
          type="button"
          onPointerDown={keepSoftKeyboard}
          onClick={onCancel}
          aria-label={t("composer.cancelReply")}
          title={t("composer.cancelReply")}
          className="flex size-6 shrink-0 items-center justify-center rounded-full text-text-tertiary outline-none hover:bg-background-tertiary-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
