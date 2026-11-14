import { useIsMobile } from "@openedbot/browser-ui-kit";
import { useAccountLayout } from "../lib/shell/account-layout";
import { useT } from "../lib/i18n";
import { conversationDiagnostic } from "../lib/run/conversation-diagnostic";
import { useOpenSettings } from "../lib/shell/settings-overlay";
import { BUTTON } from "./settings/primitives";

export function ConversationDiagnostic({
  code,
  reference,
  onRetry,
  onPermissions,
  retrying = false,
  floating = false,
}: {
  code?: string | null;
  reference?: string;
  onRetry: () => void;
  onPermissions?: () => void;
  retrying?: boolean;
  floating?: boolean;
}) {
  const { t } = useT();
  const layout = useAccountLayout();
  const mobile = useIsMobile();
  const settings = useOpenSettings();
  const kind = conversationDiagnostic(code);
  return (
    <section
      role="status"
      aria-label={t("mvp.diagnostic")}
      className={`mx-4 mb-2 shrink-0 rounded-xl border border-border bg-background px-3 py-2 text-sm ${floating && layout === "c" && !mobile ? "mt-[72px]" : "mt-2"}`}
    >
      <p>
        {t(
          kind === "runtime"
            ? "mvp.noMachine"
            : kind === "models"
              ? "mvp.providerProblem"
              : kind === "permissions"
                ? "mvp.permissionsProblem"
                : "mvp.unknownError",
        )}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {kind !== "unknown" ? (
          <button
            className={BUTTON.small}
            type="button"
            onClick={() =>
              kind === "permissions" && onPermissions
                ? onPermissions()
                : settings(
                    kind === "models"
                      ? "/settings/models"
                      : kind === "permissions"
                        ? "/settings/policies"
                        : "/settings/runtime",
                  )
            }
          >
            {t(
              kind === "runtime"
                ? "mvp.runtimeAction"
                : kind === "models"
                  ? "mvp.modelsAction"
                  : "mvp.permissionsAction",
            )}
          </button>
        ) : null}
        <button
          className={BUTTON.small}
          type="button"
          disabled={retrying}
          onClick={onRetry}
        >
          {t("mvp.retry")}
        </button>
      </div>
      {reference ? (
        <p className="mt-1 break-all text-xs text-muted-foreground">
          {t("mvp.reference")}: {reference}
          {code ? ` / ${code}` : ""}
        </p>
      ) : null}
    </section>
  );
}
