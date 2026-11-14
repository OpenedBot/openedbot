/** Attachment rows other packages write: a run's output media (execution) and an imported bot's avatar (portability). */
export { insertImportedAvatarAttachment, insertMessageAttachment } from "../sql/attachments";

/** Scoped conversation data used when a group turn explicitly replies to an older message. */
export { readThreadReplyTargets, readThreadAttachmentRows } from "../sql/room-attachments";
