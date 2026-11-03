import { Reply, X } from "lucide-react";
import { keepSoftKeyboard } from "../lib/composer/composer-keyboard";
import { useT } from "../lib/i18n";

/**
 * La réponse en cours, en onglet posé derrière la carte du composer (comme
 * l'avis du runtime) : il dépasse par le haut, la carte peint sur son bas.
 * « Réponse à Nom » au-dessus, la citation dessous, la croix à droite.
 * Voir `DESIGN.md` › Bureau › Composer : réponse.
 */
export function ComposerReplyTab({ preview, onCancel }: { preview: { author: string; text: string }; onCancel?: () => void }) {
  const { t } = useT();
  return (
    <div
      data-composer-reply=""
      className="ohb-fade-up mx-4 -mb-3 flex min-w-0 items-start gap-2 rounded-t-2xl border border-b-0 border-s-2 border-composer-edge border-s-[color:var(--bot-tint,var(--color-composer-edge-hover))] bg-background-secondary-default px-3 pt-2 pb-5 text-xs leading-5 text-text-secondary shadow-xs dark:bg-background-tertiary-default"
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
