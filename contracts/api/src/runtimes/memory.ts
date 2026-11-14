/** The two targets of runtime memory: `MEMORY.md` (project) and `USER.md` (operator). */
export type RuntimeMemoryTarget = "memory" | "user";

/**
 * The memory of a managed-profile bot, as the RUNTIME holds it: the
 * entries of the profile's `MEMORY.md` and `USER.md`, read and written by the
 * Hermes store itself (same ceilings, same format as the bot's `memory`
 * tool). It is the only memory of such a bot: openedbot no longer injects anything.
 *
 * `available: false` says why the screen must fall back to openedbot memory
 * (bot without a profile) or show a state: host without the feature, runtime absent.
 */
export type BotRuntimeMemoryDto =
  | { available: false; reason: "no_profile" | "runtime_missing" | "feature_missing" }
  | {
      available: true;
      profile: string;
      /** The profile's `memory` toolset, hence its two flags, are active. */
      enabled: boolean;
      limits: Record<RuntimeMemoryTarget, number>;
      entries: Record<RuntimeMemoryTarget, string[]>;
      usedChars: Record<RuntimeMemoryTarget, number>;
      /** Store message after a write, otherwise `null`. */
      message: string | null;
    };

export type BotRuntimeMemoryWriteInput = {
  target: RuntimeMemoryTarget;
  action: "add" | "replace" | "remove";
  content?: string;
  /** Unique substring of the targeted entry (`replace`, `remove`). */
  oldText?: string;
};
