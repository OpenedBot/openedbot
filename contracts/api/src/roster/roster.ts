import type { OperatorProfileDto } from "../identity/onboarding";
import type { BotDto } from "./bots";
import type { GroupDto, SectionDto } from "./groups";

export type RosterDto = {
  sections: SectionDto[];
  bots: BotDto[];
  groups?: GroupDto[];
  operator?: OperatorProfileDto | null;
  /**
   * `max(cursor)` de l'organisation, lu en premier dans la transaction qui a
   * construit ce roster : tout événement de curseur ≤ est déjà projeté ici.
   * Le client avance cette valeur quand il patche le roster depuis le flux.
   * Absent sur une API antérieure.
   */
  cursor?: number;
};
