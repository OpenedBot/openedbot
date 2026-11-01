import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { cn, useIsMobile } from "@openedbot/browser-ui-kit";
import { ObInput } from "@openedbot/browser-ui-kit/components/onboarding";
import type { OrganizationKind } from "@openedbot/contracts-api";
import { api, errorMessage } from "../../lib/api";
import { readCloudSession, saveCloudSession } from "../../lib/cloud-session";
import { isOwnFleet, ownWorkspaces } from "../../lib/organization-gate";
import { fleetHomeHref } from "../../lib/workspace-location";
import { useAccountWorkspaces } from "../../components/workspace/workspace-navigation";
import { useT } from "../../lib/i18n";
import { BUTTON } from "../../components/settings/primitives";
import { MobileActionFooter } from "../../components/mobile/inset-grouped";
import { OnboardingLogoutButton } from "./components/onboarding-logout-button";
import { RadioMark } from "./components/option-card";
import { StepHeading } from "./components/step-shell";
import { Wordmark } from "./components/wordmark";

/**
 * Créer l'autre type d'organisation (`?create=1`) : Personnel ou Agence sont
 * deux organisations distinctes (0086). Un premier compte sans organisation
 * propre passe par l'étape « Espace de travail » du parcours `/onboarding` ; cette
 * page ne reste que pour un compte qui en a déjà une et veut l'autre type.
 */
export function OrganizationSetupScreen() {
  const { t } = useT();
  const isMobile = useIsMobile();
  const search = useSearch({ strict: false }) as { create?: number; kind?: string };
  const account = useAccountWorkspaces();
  const hasPersonal = ownWorkspaces(account.data?.workspaces ?? []).some((w) => w.kind === "personal");
  const existingFleet = account.data?.workspaces.find(isOwnFleet);
  const agencyAvailable = account.data?.agencyAvailable === true;
  const [chosen, setChosen] = useState<OrganizationKind | null>(search.kind === "agency" ? "agency" : null);
  const kind: OrganizationKind = chosen ?? (hasPersonal && agencyAvailable ? "agency" : "personal");
  const [name, setName] = useState("");
  useEffect(() => {
    if (search.create || !agencyAvailable || !existingFleet) return;
    const session = readCloudSession();
    if (session) saveCloudSession({ ...session, organizationId: existingFleet.id });
    window.location.replace(fleetHomeHref(existingFleet.id));
  }, [agencyAvailable, existingFleet?.id, search.create]);
  const create = useMutation({
    mutationFn: () => api.createOrganization({ kind, name: name.trim() }),
    onSuccess: (created) => {
      const session = readCloudSession();
      if (session) saveCloudSession({ ...session, organizationId: created.organizationId });
      // Rechargement complet : chaque cache relit l'espace qui vient de naître.
      window.location.replace(created.kind === "agency" ? fleetHomeHref(created.organizationId) : "/onboarding");
    },
  });
  const personalDisabled = hasPersonal;
  const ready = name.trim().length > 0 && !create.isPending && account.isSuccess
    && !(kind === "personal" && personalDisabled) && !(kind === "agency" && !agencyAvailable);

  const choice = (value: OrganizationKind, label: string, help: string, disabled: boolean) => (
    <button type="button" role="radio" aria-checked={kind === value} disabled={disabled} onClick={() => setChosen(value)}
      className={cn(
        "group flex w-full items-start gap-3.5 rounded-lg border bg-card px-4 py-3 text-left transition-all disabled:cursor-not-allowed disabled:opacity-50",
        kind === value ? "border-foreground shadow-[inset_0_0_0_1px_var(--color-foreground)]" : "hover:border-foreground/20 hover:bg-accent/30",
      )}>
      <RadioMark selected={kind === value} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-body leading-tight text-foreground">{label}</span>
        <span className="text-caption text-muted-foreground">{help}</span>
      </span>
    </button>
  );

  const submit = (
    <button type="submit" form="organization-setup" className={cn(BUTTON.primary, "w-full justify-center")} disabled={!ready}>
      {t("fleet.orgSetupSubmit")}
    </button>
  );

  return (
    <div className="flex h-svh min-h-0 w-full flex-1 flex-col overflow-hidden bg-background">
      <div className="scrollbar-subtle flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pt-[max(2.5rem,var(--ohb-safe-top))] pb-10">
        <form id="organization-setup" className="flex w-full max-w-[28rem] flex-col gap-6"
          onSubmit={(e) => { e.preventDefault(); if (ready) create.mutate(); }}>
          <div className="flex items-center justify-between gap-3">
            <Wordmark className="size-8" />
            <OnboardingLogoutButton inline />
          </div>
          <StepHeading title={t("fleet.orgSetupTitle")} description={t("fleet.orgSetupDescription")} />
          {account.error && <p role="alert" className="text-caption text-destructive-text">{errorMessage(account.error, t("fleet.error"))}</p>}
          <div role="radiogroup" aria-label={t("fleet.orgSetupTitle")} className="flex flex-col gap-2">
            {choice("personal", t("fleet.orgSetupPersonal"), personalDisabled ? t("fleet.orgSetupPersonalExists") : t("fleet.orgSetupPersonalHelp"), personalDisabled)}
            {agencyAvailable && choice("agency", t("fleet.orgSetupAgency"), t("fleet.orgSetupAgencyHelp"), false)}
          </div>
          <label className="flex flex-col gap-1.5 text-body">
            {t("fleet.orgSetupName")}
            <ObInput value={name} maxLength={80} autoComplete="organization" onChange={(e) => setName(e.target.value)} />
          </label>
          {create.error && <p role="alert" className="text-caption text-destructive-text">{errorMessage(create.error, t("fleet.orgSetupError"))}</p>}
          {!isMobile && submit}
        </form>
      </div>
      {isMobile && <MobileActionFooter>{submit}</MobileActionFooter>}
    </div>
  );
}
