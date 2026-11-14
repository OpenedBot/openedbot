import { lazy, Suspense, useState, type CSSProperties } from "react";
import { LogOut } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@openedbot/browser-ui-kit";
import { ObButton } from "@openedbot/browser-ui-kit/components/onboarding";
import { api, queryKeys } from "../../../lib/api";
import { useSignOut } from "../../../lib/session/sign-out";
import { useT } from "../../../lib/i18n";

const OnboardingAccountDialog = lazy(() => import("./onboarding-account-dialog"));

/**
 * The « changer de compte » exit, shared by every step.
 *
 * `fixed` only for the welcome, which has no rail to place it on. Every
 * other step passes `inline`: it then overlapped the rail's foot,
 * pinned to the window's corner, it fell out of the measure and read
 * as a second header row above Back.
 *
 * The rail confines `.dark` to its own panel: the muted/foreground tokens
 * already resolve there against a dark surface, no inverted utility is
 * necessary.
 *
 * Absent outside an SSO session: an owner token has no session to
 * revoke, and the button would return to `/login` with nothing to do there.
 */
export function OnboardingLogoutButton({
  inline = false,
}: {
  /** Rendered in the flow (at the rail's foot) rather than pinned. */
  inline?: boolean;
} = {}) {
  const { t } = useT();
  const [accountOpen, setAccountOpen] = useState(false);
  const leaving = useSignOut();
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe, retry: false });

  if (me.data?.kind !== "session") return null;

  return (
    <>
      <div
        className={cn("flex w-fit shrink-0 items-center gap-1",
          inline ? "-ml-2" : "fixed top-[max(2rem,env(safe-area-inset-top))] right-[max(2rem,env(safe-area-inset-right))] z-50",
        )}
        style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
      >
        <ObButton variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={() => setAccountOpen(true)}>
          {t("settingsAccount.title")}
        </ObButton>
        <ObButton
          variant="ghost"
          size="sm"
          disabled={leaving.isPending}
          className={cn("text-muted-foreground", inline ? "hover:text-foreground" : "hover:text-destructive-text")}
          onClick={() => leaving.mutate()}
        >
          <LogOut />
          {t("onboarding.common.log_out")}
        </ObButton>
      </div>
      {accountOpen ? <Suspense fallback={<span role="status">{t("common.loading")}</span>}>
        <OnboardingAccountDialog onClose={() => setAccountOpen(false)} />
      </Suspense> : null}
    </>
  );
}
