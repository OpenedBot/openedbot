import { afterEach, expect, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { queryKeys } from "../../../src/lib/api";
import { useRuntimeVerdictExpiry } from "../../../src/lib/runtime/use-runtime-health";

afterEach(() => cleanup());

/** Rework-flux-api step 5d: observers whose read expires together share one reread. */
test("three observers reaching validUntil together start a single read", async () => {
  let reads = 0;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const queryFn = async () => {
    reads += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { runtime: null };
  };
  client.setQueryData(queryKeys.runtimeConfiguration, { runtime: null });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const validUntil = new Date(Date.now() + 20).toISOString();
  for (let i = 0; i < 3; i += 1) {
    renderHook(() => {
      useQuery({ queryKey: queryKeys.runtimeConfiguration, queryFn });
      useRuntimeVerdictExpiry(validUntil);
    }, { wrapper });
  }
  await waitFor(() => expect(reads).toBe(1));
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(reads).toBe(1);
});
