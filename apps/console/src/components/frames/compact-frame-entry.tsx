import { getRouteApi } from "@tanstack/react-router";
import { CompactFrame } from "../compact/compact-frame";
import { COMPACT_PATH } from "../../lib/shell/compact-shell";

const compactFrameApi = getRouteApi(COMPACT_PATH);

export function CompactFrameEntry() {
  const { signedOut } = compactFrameApi.useRouteContext();
  return <CompactFrame signedOut={signedOut} />;
}
