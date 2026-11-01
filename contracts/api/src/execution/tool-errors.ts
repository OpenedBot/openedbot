/**
 * Un échec d'outil (table `tool_errors`, 0037) : ce que le runtime a dit, borné
 * et rédigé, ou `null` quand il n'a rien dit : mesuré sur `/v1/runs`,
 * `tool.completed` ne porte aucun texte. La ligne existe quand même.
 */
export type ToolErrorDto = {
  id: string;
  botId: string;
  threadId: string;
  runId: string;
  /** L'opérateur qui a envoyé le message d'origine ; `null` pour une routine, un webhook, un hand-off. */
  userId: string | null;
  tool: string;
  toolCallId: string;
  errorMessage: string | null;
  durationMs: number | null;
  occurredAt: string;
};

export type ToolErrorPageDto = {
  errors: ToolErrorDto[];
  /** `occurredAt|id` de la dernière ligne rendue ; `null` en fin de liste. */
  nextCursor: string | null;
};
