import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, queryKeys } from "../../lib/api";

/**
 * The thread's message versions, keyed by the message each family currently
 * shows: the edit, regenerate and version-switch gestures read their count.
 */
export function useMessageVersionFamilies(activeThreadId: string | null | undefined) {
  const versions = useQuery({
    queryKey: queryKeys.messageVersions(activeThreadId ?? "none"),
    queryFn: () => api.messageVersions(activeThreadId!),
    enabled: Boolean(activeThreadId),
  });
  return useMemo(
    () => new Map((versions.data?.families ?? []).map((family) => [family.currentMessageId, family] as const)),
    [versions.data?.families],
  );
}
