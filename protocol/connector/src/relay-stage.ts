import { RELAY_STAGE_HEADER } from "./relay-frames";

/** The relay stage a response carries, or null when it carries none. */
export const relayStageOf = (headers: Headers): string | null => headers.get(RELAY_STAGE_HEADER);
