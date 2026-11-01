import { afterEach, describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import {
  PROVIDER_RECONNECT_TTL_MS,
  clearProviderReconnect,
  freshProviderReconnect,
  holdProviderReconnect,
  releaseProviderReconnect,
  requestProviderReconnect,
  useProviderReconnectRequest,
} from "../../src/lib/provider-auth";

afterEach(clearProviderReconnect);

const current = () => renderHook(() => useProviderReconnectRequest()).result.current;

describe("provider reconnect request", () => {
  test("a request whose dialog never opened goes stale after the TTL", () => {
    requestProviderReconnect("xai-oauth", 1_000);
    expect(freshProviderReconnect(current(), 1_000 + PROVIDER_RECONNECT_TTL_MS)).toBe("xai-oauth");
    expect(freshProviderReconnect(current(), 1_001 + PROVIDER_RECONNECT_TTL_MS)).toBeNull();
  });

  // A device-code login can take longer than the TTL: an open dialog must not unmount.
  test("an opened dialog outlives the TTL until it is closed", () => {
    requestProviderReconnect("xai-oauth", 1_000);
    holdProviderReconnect();
    expect(freshProviderReconnect(current(), 1_000 + 10 * PROVIDER_RECONNECT_TTL_MS)).toBe("xai-oauth");
    clearProviderReconnect();
    expect(freshProviderReconnect(current(), 1_000)).toBeNull();
  });

  test("a released dialog goes back under the TTL of the original click", () => {
    requestProviderReconnect("xai-oauth", 1_000);
    holdProviderReconnect();
    releaseProviderReconnect();
    expect(freshProviderReconnect(current(), 1_000 + PROVIDER_RECONNECT_TTL_MS)).toBe("xai-oauth");
    expect(freshProviderReconnect(current(), 1_001 + PROVIDER_RECONNECT_TTL_MS)).toBeNull();
    holdProviderReconnect();
    expect(freshProviderReconnect(current(), 1_000 + 10 * PROVIDER_RECONNECT_TTL_MS)).toBe("xai-oauth");
  });
});
