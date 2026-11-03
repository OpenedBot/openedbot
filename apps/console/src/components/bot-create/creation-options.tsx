import type { BotPermissionMode, RuntimePublicDto } from "@openedbot/contracts-api";
import { useT } from "../../lib/i18n";

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

/**
 * What a creation decides without asking. There is no « Options avancées »
 * fold any more (2026-11-02): a bot is created with a name, and the safe
 * defaults below; its approval rules, persona, model and end-of-turn notice
 * change afterwards on its own page. The notice is on, like the column's
 * default (0099) and an API creation that leaves it out: a bot muted by
 * default, with no switch at creation, would stay silent unnoticed. The organization's default permission
 * mode replaces `permissionMode` unless a duplicate pins it.
 *
 * `profile` is only filled by a duplicate on a host without
 * `profile_management`: it must name its own Hermes profile.
 */
export type CreationOptionsValue = {
  profile: string;
  permissionMode: BotPermissionMode;
  notifyOnFinish: boolean;
  greet: boolean;
};

export const DEFAULT_CREATION_OPTIONS: CreationOptionsValue = {
  profile: "",
  permissionMode: "manual",
  notifyOnFinish: true,
  greet: true,
};
