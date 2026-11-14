import { expect, test } from "bun:test";
import { readUserTimeZone } from "../src/routes/conversation/conversation-input";

test("the message's time zone is an IANA name the server knows; anything else reads as absent (0187)", () => {
  expect(readUserTimeZone("Europe/Paris")).toBe("Europe/Paris");
  expect(readUserTimeZone(" America/New_York ")).toBe("America/New_York");
  expect(readUserTimeZone("Etc/GMT+3")).toBe("Etc/GMT+3");
  // Absent, malformed or unknown: the message goes through and the bot asks for the zone.
  for (const value of [undefined, null, 42, "", "Mars/Olympus", "Europe/Paris; drop table", "x".repeat(80)]) {
    expect(readUserTimeZone(value)).toBeNull();
  }
});
