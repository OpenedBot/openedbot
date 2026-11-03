import { useEffect, useRef } from "react";
import type { AskUserPrompt } from "@openedbot/roster/domain/ask-user";
import { useT } from "../lib/i18n";
import { BuiCloseGlyph } from "./boardui/menu";

/** A, B, C… : la lettre affichée EST le raccourci clavier. */
const optionLetter = (index: number) => String.fromCharCode(65 + index);

/**
 * La question ask_user servie DANS le fil, sous la réponse qui la pose, comme
 * Grok Bot : la question, puis une rangée par réponse, chacune marquée de sa
 * lettre. Un clic (ou la lettre au clavier) envoie la réponse comme message de
 * l'opérateur ; le composer, juste en dessous, reste la réponse libre.
 *
 * Seule la question encore ouverte (le dernier tour achevé) prend cette
 * carte : une question passée se replie en une ligne dans l'historique.
 * Le « x » en haut à droite ignore la question sans répondre (Grok Bot :
 * « Dismiss without answering ») : la carte se replie aussitôt.
 */
export function AskUserCard({
  prompt,
  onPick,
  onDismiss,
  disabled = false,
}: {
  prompt: AskUserPrompt;
  onPick: (text: string) => void;
  onDismiss?: () => void;
  disabled?: boolean;
}) {
  const { t } = useT();
  const rows = useRef<Array<HTMLButtonElement | null>>([]);

  // La lettre répond depuis n'importe où, sauf quand on écrit déjà : un « a »
  // tapé dans le composer est du texte, jamais un choix.
  useEffect(() => {
    if (disabled || prompt.options.length === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      const index = event.key.toUpperCase().charCodeAt(0) - 65;
      if (index < 0 || index >= prompt.options.length) return;
      event.preventDefault();
      onPick(prompt.options[index]!);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [prompt.options, onPick, disabled]);

  const moveFocus = (from: number, delta: number) => rows.current[from + delta]?.focus();

  return (
    <div
      data-ask-user-card=""
      className="animate-agent-card-in mt-2 w-full max-w-[520px] self-start rounded-2xl border border-border-button-default bg-background-primary-default p-2"
    >
      <div className="flex items-start gap-3 ps-2.5 pe-1 pt-1.5 pb-2">
        <p className="min-w-0 flex-1 text-body-2-medium text-text-secondary">{prompt.question}</p>
        {onDismiss ? (
          <button
            type="button"
            data-ask-user-dismiss=""
            aria-label={t("threadTimeline.askUserDismiss")}
            title={t("threadTimeline.askUserDismissHint")}
            disabled={disabled}
            onClick={onDismiss}
            className="relative inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full bg-background-tertiary-default text-foreground-icon-tertiary outline-none transition-colors duration-150 select-none before:absolute before:-inset-3 before:content-[''] hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
          >
            <BuiCloseGlyph />
          </button>
        ) : null}
      </div>
      {prompt.options.length > 0 ? (
        <div role="group" aria-label={prompt.question} className="flex flex-col gap-0.5">
          {prompt.options.map((option, index) => (
            <button
              key={`${index}-${option}`}
              ref={(node) => { rows.current[index] = node; }}
              type="button"
              disabled={disabled}
              aria-keyshortcuts={optionLetter(index)}
              onClick={() => onPick(option)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") { event.preventDefault(); moveFocus(index, 1); }
                if (event.key === "ArrowUp") { event.preventDefault(); moveFocus(index, -1); }
              }}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-start text-body-regular text-text-primary outline-none ohb-row hover:bg-background-secondary-default focus-visible:bg-background-secondary-default focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              <kbd
                aria-hidden
                className="grid size-6 shrink-0 place-items-center rounded-md border border-border-button-default bg-background-secondary-default font-sans text-xs font-medium text-text-secondary"
              >
                {optionLetter(index)}
              </kbd>
              <span className="min-w-0 flex-1">{option}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
