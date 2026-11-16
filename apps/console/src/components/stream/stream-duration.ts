/** the reference app's duration: « 23s », « 1m 12s » past a minute. */
export const streamDuration = (seconds: number) => (seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`);
