import { RELAY_STAGE_HEADER } from "./relay-frames";

/** Its former name, read for one release (an instance not yet redeployed sets it). */
export const LEGACY_RELAY_STAGE_HEADER = "X-OHB-Relay-Stage";
/** The relay stage a response carries, under its current or its former name. */
export const relayStageOf = (headers: Headers): string | null => headers.get(RELAY_STAGE_HEADER) ?? headers.get(LEGACY_RELAY_STAGE_HEADER);
