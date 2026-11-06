/** Thread rows other packages write (ADR 0001 S4): a bot's and a room's thread (roster, imports), a run's session generation and activity (execution). */
export {
  advanceThreadSessionGeneration,
  insertBotDefaultThread,
  insertGroupThread,
  insertPersonaDraftThreadIfAbsent,
  markThreadSessionOpened,
  readThreadSessionGeneration,
  touchThread,
} from "../sql/threads";
