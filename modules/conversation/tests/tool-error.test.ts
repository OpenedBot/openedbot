import { describe, expect, test } from "bun:test";
import { toolErrorCode } from "../src/domain/tool-error";

describe("toolErrorCode", () => {
  test("recognizes a missing Python module in text and truncated terminal JSON", () => {
    expect(toolErrorCode("ModuleNotFoundError: No module named 'PIL'")).toBe("PYTHON_DEPENDENCY_MISSING");
    expect(toolErrorCode('{"output":"Traceback: ModuleNotFoundError: No module named \'PIL\'", "approval":"Command required approval (script execution via -…')).toBe("PYTHON_DEPENDENCY_MISSING");
  });

  test("recognizes explicit approval failures", () => {
    expect(toolErrorCode("Command required approval (script execution)")).toBe("APPROVAL_REQUIRED");
    expect(toolErrorCode('{"error":"approval_required"}')).toBe("APPROVAL_REQUIRED");
  });

  test("does not invent a cause from missing, malformed, or arbitrary output", () => {
    for (const value of [null, undefined, {}, "", "PIL", "exit 2", "{broken JSON", "No module named in this document"]) {
      expect(toolErrorCode(value)).toBe("TOOL_EXECUTION_FAILED");
    }
  });
});
