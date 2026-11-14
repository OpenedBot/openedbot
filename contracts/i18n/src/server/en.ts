/**
 * What the API says of a `routine_manage` approval gate
 * (`modules/execution/src/domain/routine-gate-text.ts`): server-side
 * strings, kept out of the console's dictionaries (its first-load chunk),
 * which shows the sentence the API wrote.
 */
import type { routineGate as fr } from "./fr";

export const routineGate: Record<keyof typeof fr, string> = {
  named: "“{name}”",
  unknown: "it does not own (the tool will refuse)",
  list: "Read the list of its routines. Nothing changes.",
  create: "Create the routine {name}: {schedule}.",
  createOnce: "Create the one-shot reminder {name}: {schedule}.",
  update: "Change the routine {routine}: {changes}.",
  pause: "Pause the routine {routine}.",
  resume: "Switch the routine {routine} back on.",
  remove: "Delete the routine {routine} and its history.",
  changeName: "new name {name}",
  changeSchedule: "schedule {schedule}",
  changeTimezone: "time zone {timezone}",
  changeNothing: "nothing changes",
  changeMessageOnly: "new message",
  changeSeparator: "; ",
  delay: "once, in {delay} from your approval",
  scheduleUnreadable: "unreadable schedule “{text}” (the tool will refuse)",
  issueTimezoneMissing: "No time zone is given: the tool will refuse.",
  issueTimezoneInvalid: "The time zone given does not exist: the tool will refuse.",
  issueTooFrequent: "More than one run every {minutes} minutes: the tool will refuse.",
  issuePastInstant: "This instant has already passed: the tool will refuse.",
  issueNameTooLong: "The name is longer than {nameMax} characters: the tool will refuse.",
  issueScheduleTooLong: "The schedule is longer than 100 characters: the tool will refuse.",
  issuePromptTooLong: "The message is longer than {messageMax} characters: the tool will refuse.",
  message: "Message sent to the bot at each run: “{message}” ({chars} characters).",
  messageUnseen: "Message not sent by the server ({chars} characters): approving accepts a message nobody could read here.",
  unattendedCreated: "Active as soon as it is created, set to “Never wait”: it runs without asking for approval.",
  unattended: "Set to “Never wait”: it runs without asking for approval.",
  undescribed: "Act on its routines. The request's details could not be read: deny if you are unsure.",
};
