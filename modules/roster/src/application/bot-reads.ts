/** Reads of a bot and of its organization's permission defaults that other packages make (ADR 0001 S4). `./bots` holds the bot use cases. */
export {
  defaultPermissionMode,
  readBotCapabilityTarget,
  readPermissionPipeline,
} from "../sql/bots";
