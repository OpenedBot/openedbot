import type { TransactionDb } from "@openedbot/platform-db";

export type PlaybookInsert = {
  key: string;
  name: string;
  summary: string;
  triggers: readonly string[];
  instructions: string;
};

/**
 * Un playbook de même clé dans l'organisation est réutilisé, jamais écrasé
 * (`on conflict do nothing`). Appelée par marketplace dans la transaction de
 * l'installation d'un modèle.
 */
export async function insertPlaybookIfAbsent(
  tx: TransactionDb,
  organizationId: string,
  playbook: PlaybookInsert,
): Promise<void> {
  await tx`
    insert into playbooks (id, organization_id, key, name, summary, triggers, instructions)
    values (
      ${crypto.randomUUID()}, ${organizationId}, ${playbook.key}, ${playbook.name},
      ${playbook.summary},
      array(select jsonb_array_elements_text(${JSON.stringify(playbook.triggers)}::text::jsonb)),
      ${playbook.instructions}
    )
    on conflict (organization_id, key) do nothing
  `;
}

/** Rattache un playbook à un bot ; le lien existant est laissé tel quel. */
export async function linkBotPlaybook(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
  playbookId: string,
): Promise<void> {
  await tx`
    insert into bot_playbooks (organization_id, bot_id, playbook_id)
    values (${organizationId}, ${botId}, ${playbookId})
    on conflict do nothing
  `;
}
