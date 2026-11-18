import { useQuery } from "@tanstack/react-query";
import { api, queryKeys, runtimesQueryOptions } from "../api";

export function useBotRuntime(runtimeId?: string | null) {
  const active = useQuery({ ...runtimesQueryOptions(), enabled: !runtimeId, refetchOnWindowFocus: true });
  const registry = useQuery({
    queryKey: queryKeys.runtimeList,
    queryFn: api.runtimeList,
    enabled: Boolean(runtimeId),
    refetchOnWindowFocus: true,
  });
  const query = runtimeId ? registry : active;
  const runtime = runtimeId ? registry.data?.find((host) => host.id === runtimeId) : active.data?.runtimes[0];
  return { runtime, isPending: query.isPending, isSuccess: query.isSuccess, error: query.error, refetch: query.refetch };
}
