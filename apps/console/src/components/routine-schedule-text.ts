import { scheduleText } from "@openedbot/execution/domain/routine-schedule-text";
import { useT } from "../lib/i18n";

/**
 * Hours, minutes and weekdays in the reader's language. The wording lives in
 * `routine-schedule-text.ts` (execution domain), shared with the API's
 * description of a `routine_manage` approval.
 */
export function useScheduleText() {
  return scheduleText(useT());
}
