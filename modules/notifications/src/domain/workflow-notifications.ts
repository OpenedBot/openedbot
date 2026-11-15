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
 * Cette règle est partagée par les notifications navigateur de la SPA
 * et les courriels d’exécution.
 */
export function workflowNotificationEligible(
  workflow: WorkflowNotificationEligibility,
): boolean {
  return workflow.autonomyEnabled
    || workflow.kind === "group"
    || workflow.kind === "routine";
}
