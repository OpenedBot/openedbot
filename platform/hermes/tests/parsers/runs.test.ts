import { describe, expect, test } from "bun:test";
import { normalizeHermesRunDetails, pendingSteerText } from "../../src/parsers/runs";

describe("normalizeHermesRunDetails", () => {
  test("accepts queued and interrupted statuses from mixed Hermes versions", () => {
    expect(normalizeHermesRunDetails({ status: "queued" }, "run-queued").status).toBe("queued");
    expect(normalizeHermesRunDetails({ status: "interrupted" }, "run-interrupted").status).toBe("interrupted");
  });

  test("rend le steer non lu que l'amont renvoie sur le statut", () => {
    const details = normalizeHermesRunDetails(
      { run_id: "run-1", status: "completed", output: "ok", pending_steer: " message 9 " },
      "run-1",
    );
    expect(details.pendingSteer).toBe("message 9");
  });

  test("un pending_steer absent, nul, vide ou non textuel ne rejoue rien", () => {
    for (const value of [undefined, null, "", "   ", 3, { text: "x" }]) {
      const details = normalizeHermesRunDetails({ status: "completed", output: "ok", pending_steer: value }, "run-1");
      expect(details.pendingSteer).toBeNull();
    }
    expect(pendingSteerText("a\nb")).toBe("a\nb");
  });
});
