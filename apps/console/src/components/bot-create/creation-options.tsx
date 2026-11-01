import { useState, type ReactNode } from "react";
import { IconChevronDown } from "@tabler/icons-react";
import type { BotPermissionMode, RuntimePublicDto } from "@openedbot/contracts-api";
import { Checkbox, cn } from "@openedbot/browser-ui-kit";
import { useT } from "../../lib/i18n";
import { PermissionModeList, usePermissionContext } from "../boardui/permission-picker";
import { HermesProfileField } from "../hermes-profile-field";

export function isRuntimeLinked(runtime: RuntimePublicDto | null | undefined): runtime is RuntimePublicDto {
  if (!runtime?.configured || runtime.lastHealthStatus !== "healthy") return false;
  return runtime.reachability === "direct" || runtime.link?.connected === true;
}

/**
 * Where and with what the bot will work: one sentence above the footer buttons.
 * `model` is the bot's own model when it brings one (a duplicate carries its
 * source's); otherwise the bot follows the runtime's.
 */
/**
 * `pendingModel` : the runtime's new model, still under proof. The bot would
 * run the current one until then, so the line says so instead of promising it.
 */
export function RuntimePromiseLine({ runtime, model = null, pendingModel = null, mode }: {
  runtime: RuntimePublicDto | null | undefined;
  model?: string | null;
  pendingModel?: string | null;
  mode: BotPermissionMode;
}) {
  const { t } = useT();
  if (!isRuntimeLinked(runtime)) {
    return <p className="ohb-new-bot-promise" role="status">{t("newBotDialog.promiseUnlinked")}</p>;
  }
  const current = model || runtime.selectedModel || t("newBotDialog.rulesModelRuntime");
  return (
    <p className="ohb-new-bot-promise" role="status">
      {t("newBotDialog.promiseLinked", {
        runtime: runtime.name || t("newBotDialog.rulesServerFallback"),
        model: current,
        rule: t(`newBotDialog.promiseRule.${mode}`),
      })}
      {pendingModel ? <> <strong>{t("newBotDialog.promiseModelPending", { pending: pendingModel, current })}</strong></> : null}
    </p>
  );
}

export type CreationOptionsValue = {
  profile: string;
  permissionMode: BotPermissionMode;
  notifyOnFinish: boolean;
  firstRoutine: boolean;
  greet: boolean;
};

/**
 * « Options avancées », folded by default (touri, OpenBot): the defaults are
 * the safe ones (ask before acting, introduce itself), so a bot is created
 * with a name and a persona; everything here can change later on its page.
 * The closed disclosure still names the current choices, so nothing is
 * hidden from the operator who does not open it.
 *
 * `profileRequired` (a duplicate on a host without `profile_management`)
 * takes the profile field out of the fold: creation waits on it, so it must
 * stay in sight with its `profileError`.
 */
export function CreationOptions({
  id,
  runtime,
  profileManagement,
  profileRequired = false,
  profileError = null,
  model = null,
  value,
  onChange,
  children,
}: {
  id: string;
  runtime: RuntimePublicDto | null | undefined;
  profileManagement: boolean;
  profileRequired?: boolean;
  profileError?: string | null;
  /** The bot's own model (a duplicate's), shown instead of the runtime's. */
  model?: string | null;
  value: CreationOptionsValue;
  onChange: (next: CreationOptionsValue) => void;
  /** Shown first in the fold (the job sheet); stays mounted while folded. */
  children?: ReactNode;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const permissionContext = usePermissionContext();
  const set = <K extends keyof CreationOptionsValue>(key: K, next: CreationOptionsValue[K]) => onChange({ ...value, [key]: next });
  const summary = [
    t(`boardui.permission.${value.permissionMode}`),
    value.greet ? t("newBotDialog.summaryGreet") : null,
    value.notifyOnFinish ? t("newBotDialog.summaryNotify") : null,
  ].filter((part): part is string => Boolean(part)).join(" · ");

  return (
    <section className="ohb-new-bot-sheet" aria-labelledby={`${id}-options-title`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-options`}
        onClick={() => setOpen((current) => !current)}
        className="ohb-new-bot-disclosure"
      >
        <span className="min-w-0 flex-1 text-left">
          <span id={`${id}-options-title`} className="block text-sm font-semibold text-text-primary">{t("newBotDialog.profileAdvanced")}</span>
          <span className="block truncate text-xs text-text-tertiary">{summary}</span>
        </span>
        <IconChevronDown aria-hidden className={cn("size-4 shrink-0 text-foreground-icon-secondary transition-transform motion-reduce:transition-none", open && "rotate-180")} />
      </button>
      {profileRequired ? (
        <HermesProfileField id={`${id}-profile`} value={value.profile} onChange={(profile) => set("profile", profile)} required error={profileError} />
      ) : null}
      {/* Replié = masqué, pas démonté : une fiche que le runtime est en train de
          proposer doit pouvoir finir et lever son verrou sur « Créer ». */}
      <div id={`${id}-options`} className="space-y-5" hidden={!open}>
          {children}
          <dl className="ohb-new-bot-runtime-facts">
            <div>
              <dt>{t("newBotDialog.rulesServer")}</dt>
              <dd>{runtime?.name || t("newBotDialog.rulesServerWaiting")}</dd>
            </div>
            <div>
              <dt>{t("newBotDialog.rulesModel")}</dt>
              <dd>
                {model || runtime?.selectedModel || t("newBotDialog.rulesModelRuntime")}
                <span className="ms-2 text-xs text-text-tertiary">{t("newBotDialog.rulesModelLater")}</span>
              </dd>
            </div>
            <div>
              <dt>{t("newBotDialog.profileLabel")}</dt>
              <dd>{profileManagement ? t("newBotDialog.profileManagedHint") : t("newBotDialog.profileManualHint")}</dd>
            </div>
          </dl>
          {!profileManagement && !profileRequired ? (
            <HermesProfileField id={`${id}-profile`} value={value.profile} onChange={(profile) => set("profile", profile)} />
          ) : null}
          {/* Les composants officiels du ui-kit (Radix) : la ligne entière reste
              cliquable par son `label`, le contrôle porte le focus et l'état. */}
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-semibold text-text-primary">{t("newBotDialog.rulesBeforeActing")}</legend>
            {/* The same four rows as the composer menu (PERM2-3); a creation has
                no stored mode, so the ceiling alone decides what is offered. */}
            <PermissionModeList
              value={value.permissionMode}
              current={null}
              context={permissionContext}
              onSelect={(next) => set("permissionMode", next)}
              ariaLabel={t("newBotDialog.rulesBeforeActing")}
            />
            {/* La promesse n'est imposée que par un hôte qui annonce
                `approval_policy` ; ailleurs, seul le modèle la tient. */}
            {value.permissionMode === "manual" && isRuntimeLinked(runtime) && !runtime.linkFeatures?.includes("approval_policy") ? (
              <p className="text-xs text-text-tertiary">{t("newBotDialog.rulesAskNotEnforced")}</p>
            ) : null}
          </fieldset>
          <div className="grid gap-2">
            <label htmlFor={`${id}-greet`} className="ohb-new-bot-choice">
              <Checkbox id={`${id}-greet`} checked={value.greet} onCheckedChange={(checked) => set("greet", checked === true)} />
              <span>{t("newBotDialog.rulesGreet")}</span>
            </label>
            <label htmlFor={`${id}-notify`} className="ohb-new-bot-choice">
              <Checkbox id={`${id}-notify`} checked={value.notifyOnFinish} onCheckedChange={(checked) => set("notifyOnFinish", checked === true)} />
              <span>{t("newBotDialog.rulesNotify")}</span>
            </label>
            <label htmlFor={`${id}-first-routine`} className="ohb-new-bot-choice">
              <Checkbox id={`${id}-first-routine`} checked={value.firstRoutine} onCheckedChange={(checked) => set("firstRoutine", checked === true)} />
              <span>{t("newBotDialog.rulesFirstRoutine")}</span>
            </label>
          </div>
      </div>
    </section>
  );
}
