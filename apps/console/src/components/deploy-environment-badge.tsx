import { DEPLOY_ENVIRONMENT_BADGE, useDeployEnvironment } from "../lib/deploy-environment";
import { ToneBadge } from "./settings/primitives";

/**
 * The tier of this openedbot as a badge. `hideProd` is for the chrome every screen
 * carries (the top bar): production stays clean there, while dev and preprod
 * are always in sight. The Edge card shows every tier, production included.
 */
export function DeployEnvironmentBadge({ hideProd = false, className }: { hideProd?: boolean; className?: string }) {
  const environment = useDeployEnvironment();
  if (!environment || (hideProd && environment === "prod")) return null;
  const badge = DEPLOY_ENVIRONMENT_BADGE[environment];
  return (
    <ToneBadge tone={badge.tone} className={className}>
      {badge.label}
    </ToneBadge>
  );
}
