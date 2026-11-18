import type { WorkflowEmailPreferences } from "@openedbot/contracts-api";
import { request } from "./http";

export const mvpApi = {
  workspacePreferences: () =>
    request<WorkflowEmailPreferences>("/api/workspace-preferences"),
  saveWorkspacePreferences: (patch: Partial<WorkflowEmailPreferences>) =>
    request<WorkflowEmailPreferences>("/api/workspace-preferences", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
};
