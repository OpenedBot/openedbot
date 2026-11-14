import type {
  ConversationFilesDto,
  WorkflowEmailPreferences,
} from "@openedbot/contracts-api";
import { nativeBridge } from "../platform";
import {
  API_ORIGIN,
  rawApiFetch,
  cloudHeaders,
  authHeadersFor,
  ApiError,
  request,
  errorFrom,
} from "./http";

export const mvpApi = {
  workspacePreferences: () =>
    request<WorkflowEmailPreferences>("/api/workspace-preferences"),
  saveWorkspacePreferences: (patch: Partial<WorkflowEmailPreferences>) =>
    request<WorkflowEmailPreferences>("/api/workspace-preferences", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  conversationFiles: (
    threadId: string,
    search: string,
    cursor: string | null,
  ) => {
    const query = new URLSearchParams({ q: search });
    if (cursor) query.set("cursor", cursor);
    return request<ConversationFilesDto>(
      `/api/threads/${threadId}/files?${query}`,
    );
  },
  exportProduct: async (
    kind: "threads" | "bots",
    id: string,
  ): Promise<Blob> => {
    const bridge = nativeBridge();
    const bearer = bridge ? ((await bridge.readAccessToken()) ?? "") : "";
    const response = await rawApiFetch(
      `${API_ORIGIN}/api/exports/${kind}/${id}`,
      {
        credentials: bridge ? "omit" : "include",
        signal: AbortSignal.timeout(75_000),
        headers: {
          ...cloudHeaders("GET", true, bridge !== null),
          ...authHeadersFor(bearer),
        },
      },
    );
    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ApiError(response.status, "Export failed.", "EXPORT_FAILED");
      }
      throw errorFrom(response, body);
    }
    return response.blob();
  },
};
export function saveProductBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // Let the WebView consume the URL before releasing it.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
