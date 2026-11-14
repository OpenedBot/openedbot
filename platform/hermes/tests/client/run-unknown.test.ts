import { describe, expect, test } from "bun:test";
import { HermesClient } from "../../src/client";
import { normalizeHermesRunDetails } from "../../src/parsers/runs";

function recordingClient() {
  const calls: Array<{ url: string; body: unknown }> = [];
  const client = new HermesClient({ transport: { kind: "direct", send: async (path: string, init: RequestInit) => {
    calls.push({ url: path, body: init.body ? JSON.parse(String(init.body)) : null });
    return Response.json({ admission_id: "adm_1", status: "terminal" });
  } } });
  return { client, calls };
}

describe("Hermes 0.23 unknown run", () => {
  test("the status parser accepts unknown with its admission pair", () => {
    expect(normalizeHermesRunDetails({ run_id: "run_1", status: "unknown", admission_id: "adm_1", execution_generation: 2 }, "run_1"))
      .toMatchObject({ status: "unknown", admissionId: "adm_1", executionGeneration: 2 });
  });

  test("a Hermes 0.22 status has no admission pair", () => {
    expect(normalizeHermesRunDetails({ run_id: "run_1", status: "running" }, "run_1"))
      .toMatchObject({ admissionId: null, executionGeneration: null });
    expect(normalizeHermesRunDetails({ status: "running", admission_id: "", execution_generation: -1 }, "run_1"))
      .toMatchObject({ admissionId: null, executionGeneration: null });
  });

  test("resolve-unknown sends exactly the admission and the generation", async () => {
    const { client, calls } = recordingClient();
    await client.resolveUnknownRun("run_1", "adm_1", 2);
    expect(calls).toEqual([{ url: "/v1/runs/run_1/resolve-unknown", body: { admission_id: "adm_1", execution_generation: 2 } }]);
  });

  test("resolve-unknown without its pair is refused before any send", async () => {
    const { client, calls } = recordingClient();
    await expect(client.resolveUnknownRun("run_1", "", 2)).rejects.toMatchObject({ code: "BODY_INVALID" });
    await expect(client.resolveUnknownRun("run_1", "adm_1", -1)).rejects.toMatchObject({ code: "BODY_INVALID" });
    expect(calls).toEqual([]);
  });
});
