/**
 * Is the text a live run is writing the ANSWER yet, or still a sentence a
 * tool call may follow?
 *
 * The runtime streams the narration before a tool exactly like an answer
 * (`agent.message`), and nothing says which one it is until the next event.
 * Shown as the answer straight away, a narration then had to leave the answer
 * for the work block when its tool call arrived: the operator saw the reply
 * start, then the turn "switch to tools". So a live text only takes the
 * answer slot once it is clearly more than a narration line: longer than
 * `LIVE_NARRATION_MAX`, or already shaped like a document (a second
 * paragraph, a heading, a list, a fence, a quote). Once the run ends, every
 * trailing text is the answer: callers check that themselves.
 */

/** Beyond this, a sentence written after the last tool reads as the answer. */
export const LIVE_NARRATION_MAX = 280;

const ANSWER_SHAPE = /\n\s*\n|^\s*(?:#{1,6}\s|[-*+]\s|\d+\.\s|```|~~~|>)/m;

export function isConfirmedLiveAnswer(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > LIVE_NARRATION_MAX || ANSWER_SHAPE.test(trimmed);
}
