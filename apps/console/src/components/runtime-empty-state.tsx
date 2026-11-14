import { Link } from "@tanstack/react-router";
import { IconServerBolt } from "@tabler/icons-react";
import { BUTTON, EmptyState } from "./settings/primitives";
import { useT } from "../lib/i18n";

/**
 * The welcome when no Hermes runtime is connected yet:
 * one voice, one gesture: configure Hermes.
 */
export function RuntimeEmptyState() {
  const { t } = useT();
  return (
    <EmptyState
      icon={<IconServerBolt />}
      title={t("onboarding.completion.runtime_missing_title")}
      description={t("onboarding.completion.runtime_missing_description")}
      actions={
        <Link to="/settings/runtime" className={BUTTON.primary}>
          {t("onboarding.completion.configure_runtime")}
        </Link>
      }
    />
  );
}
