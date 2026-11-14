export type WorkflowNotificationEligibility = {
  kind: "dm" | "group" | "routine";
  autonomyEnabled: boolean;
};

/**
 * Les DM ordinaires restent silencieux. Un salon et une routine sont en
 * revanche des workflows longs par nature, même quand l'option de délégation
 * autonome du bot est coupée : leur progression doit donc rester visible sur
 * les surfaces système.
 *
 * Le plan APNs / Live Activity de 0009 qui accompagnait cette éligibilité a
 * été retiré le 2026-08-28 avec le client Expo. La même règle alimente
 * l'outbox `push_outbox` (trigger 0039), consommée par Web Push et,
 * depuis DEV-308, par APNs pour l'app native iOS (0108, sans Live Activity),
 * plus les notifications de page tant que la SPA reste chargée.
 */
export function workflowNotificationEligible(
  workflow: WorkflowNotificationEligibility,
): boolean {
  return workflow.autonomyEnabled
    || workflow.kind === "group"
    || workflow.kind === "routine";
}
