import { expect, test } from "bun:test";
import { conversationDiagnostic } from "../src/lib/run/conversation-diagnostic";

test("maps stable error codes without interpreting provider text", () => {
  expect(conversationDiagnostic("MODEL_UNAVAILABLE")).toBe("models");
  expect(conversationDiagnostic("PROVIDER_AUTH_REQUIRED")).toBe("models");
  expect(conversationDiagnostic("RUNTIME_LINK_UNAVAILABLE")).toBe("runtime");
  expect(conversationDiagnostic("PERMISSION_POLICY_NOT_EFFECTIVE")).toBe(
    "permissions",
  );
  expect(conversationDiagnostic("upstream said auth failed")).toBe("unknown");
  expect(conversationDiagnostic(null)).toBe("unknown");
});
