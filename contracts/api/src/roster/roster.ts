import type { OperatorProfileDto } from "../identity/onboarding";
import type { BotDto } from "./bots";
import type { GroupDto, SectionDto } from "./groups";

export type RosterDto = {
  sections: SectionDto[];
  bots: BotDto[];
  groups?: GroupDto[];
  operator?: OperatorProfileDto | null;
  /**
   * `max(cursor)` of the organization, read first in the transaction that
   * built this roster: every event with cursor ≤ is already projected here.
   * The client advances this value when it patches the roster from the stream.
   * Absent on an older API.
   */
  cursor?: number;
};
