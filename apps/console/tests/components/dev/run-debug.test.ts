import { describe, expect, test } from "bun:test";
import { runDebugReport } from "../../../src/components/dev/run-debug";

describe("dev run debug report", () => {
  test("a failed command shows its exit code, full input and parsed raw result", () => {
    const result = JSON.stringify({ output: "ModuleNotFoundError: No module named 'matplotlib'", exit_code: 1, hint: "Python cannot import 'matplotlib'." });
    const [failed, live] = runDebugReport([
      { tool: "terminal", done: true, failed: true, errorMessage: "exit 1", attachment: { input: "python3 revenue.py", result, exitCode: 1 } },
      { tool: "terminal", done: false, preview: "pip install -q matplotlib" },
    ]);
    expect(failed).toMatchObject({
      tool: "terminal",
      status: "failed",
      exitCode: 1,
      errorMessage: "exit 1",
      input: "python3 revenue.py",
      result: { output: "ModuleNotFoundError: No module named 'matplotlib'", exit_code: 1, hint: "Python cannot import 'matplotlib'." },
      attached: true,
    });
    expect(live).toMatchObject({ status: "running", input: "pip install -q matplotlib", result: null, attached: false });
  });

  test("a result that is not JSON stays raw", () => {
    const [entry] = runDebugReport([{ tool: "terminal", done: true, resultExcerpt: "command not found: foo" }]);
    expect(entry!.result).toBe("command not found: foo");
  });
});
