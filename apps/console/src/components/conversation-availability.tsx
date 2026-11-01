import { useEffect, useState, type ReactNode } from "react";
import { Dialog } from "@openedbot/browser-ui-kit";
import { useT } from "../lib/i18n";
import { BUTTON } from "./settings/primitives";

export function ConversationAvailability({
  blocked, message, retrying, onRetry, children, modal = false, onDismiss, locked = false,
}: {
  blocked: boolean;
  message: string;
  retrying: boolean;
  onRetry: () => void;
  children: ReactNode;
  modal?: boolean;
  onDismiss?: () => void;
  /** Une autre alerte tient la conversation (réparation du profil) : fil inerte et flouté, sans la boîte d'ici. */
  locked?: boolean;
}) {
  const { t } = useT();
  const [alertOpen, setAlertOpen] = useState(blocked);
  useEffect(() => {
    setAlertOpen(blocked);
  }, [blocked, message]);
  const obscureConversation = locked || (blocked && (!modal || alertOpen));
  const dismissAlert = () => {
    setAlertOpen(false);
    onDismiss?.();
  };
  return (
    <>
      {modal ? (
        <Dialog
          open={blocked && alertOpen}
          onClose={dismissAlert}
          role="alertdialog"
          title={t("conversation.unavailable")}
          description={message}
          showClose={false}
          swipeToDismiss={false}
          footer={
            <button type="button" className={BUTTON.primary} onClick={dismissAlert}>
              {t("common.close")}
            </button>
          }
        />
      ) : null}
      <div
        inert={obscureConversation}
        aria-hidden={obscureConversation || undefined}
        className={`flex min-h-0 min-w-0 flex-1 flex-col ${obscureConversation ? "pointer-events-none select-none blur-sm" : ""}`}
      >
        {children}
      </div>
      {blocked && !modal ? (
        <div className="scrollbar-subtle absolute inset-0 z-30 flex items-center justify-center overflow-y-auto bg-background/60 p-4">
          <div role="alert" className="my-auto w-full max-w-md rounded-2xl border border-border bg-background p-6 text-center shadow-lg">
            <h2 className="text-base font-semibold">{t("conversation.unavailable")}</h2>
            <p className="mt-2 break-words text-sm text-muted-foreground">{message}</p>
            <button type="button" className={`${BUTTON.primary} mt-4`} disabled={retrying} onClick={onRetry}>
              {t("errorState.retry")}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
