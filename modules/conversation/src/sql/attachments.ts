import type { Db } from "@openedbot/platform-db";

/** Un artefact produit par un run, rattaché au message de sa réponse. */
export async function insertMessageAttachment(
  tx: Db,
  input: {
    id: string;
    organizationId: string;
    messageId: string;
    objectKey: string;
    driver: string;
    name: string;
    contentType: string;
    kind: string;
    bytes: number;
  },
): Promise<void> {
  await tx`
    insert into attachments (
      id, organization_id, message_id, object_key, driver, name, content_type, kind, bytes
    ) values (
      ${input.id}, ${input.organizationId}, ${input.messageId}, ${input.objectKey}, ${input.driver},
      ${input.name}, ${input.contentType}, ${input.kind}, ${input.bytes}
    )
  `;
}

/** L'avatar d'un profil importé : une image sans message, rangée sous la clé d'import. */
export async function insertImportedAvatarAttachment(
  tx: Db,
  input: {
    id: string;
    organizationId: string;
    objectKey: string;
    driver: string;
    name: string;
    contentType: string;
    bytes: number;
  },
): Promise<void> {
  await tx`
    insert into attachments (id, organization_id, message_id, object_key, driver, name, content_type, kind, bytes)
    values (${input.id}, ${input.organizationId}, null, ${input.objectKey}, ${input.driver}, ${input.name}, ${input.contentType}, 'image', ${input.bytes})
  `;
}
