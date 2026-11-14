export type DiagnosticKind = "runtime" | "models" | "permissions" | "unknown";
export function conversationDiagnostic(
  code: string | null | undefined,
): DiagnosticKind {
  if (
    [
      "RUNTIME_MISSING",
      "RUNTIME_LINK_UNAVAILABLE",
      "RUNTIME_UNAVAILABLE",
      "HERMES_UNREACHABLE",
    ].includes(code ?? "")
  )
    return "runtime";
  if (
    [
      "MODEL_UNAVAILABLE",
      "PROVIDER_AUTH_REQUIRED",
      "PROVIDER_UNAVAILABLE",
      "NO_USABLE_PROVIDER",
      "PROVIDER_QUOTA_REACHED",
    ].includes(code ?? "")
  )
    return "models";
  if (
    [
      "BOT_PERMISSIONS_PENDING",
      "PERMISSION_POLICY_NOT_EFFECTIVE",
      "PERMISSION_POLICY_REQUIRES_PIPELINE",
      "PERMISSIONS_NOT_ENFORCED",
      "PERMISSION_RULES_REQUIRE_V2",
    ].includes(code ?? "")
  )
    return "permissions";
  return "unknown";
}
