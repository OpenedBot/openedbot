export const mvp = {
  emailTitle: "Email alerts",
  emailHint:
    "Disabled by default. These choices apply to your account in this workspace. Sign-in and security emails are independent.",
  approval: "Approval needed",
  completed: "Task completed",
  failed: "Task failed or needs review",
  saveError: "Could not save preferences. Try again.",
  loadError: "Could not load this information.",
  modelsAction: "Check provider and model",
  runtimeAction: "Check machine",
  permissionsAction: "Check permissions",
  reference: "Reference",
  noMachine: "Link a machine so this bot can reply.",
  providerProblem:
    "The provider or model prevented this response. Check its configuration before sending your request again.",
  permissionsProblem: "This bot’s permissions are not active on the machine.",
  recovery: "Data recovery",
  recoveryHint:
    "Exports do not replace a full backup. Read the backup and recovery guide.",
  openGuide: "Recovery guide",
} as const;
