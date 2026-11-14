import { lazyRouteComponent, useSearch } from "@tanstack/react-router";
import { DevReplayEntrance } from "../../components/dev/dev-replay-entrance";
import { devRestoreLoginBoot } from "./login-boot";

const LoginScreen = lazyRouteComponent(() => import("./login"), "LoginScreen");

/**
 * Component of the `/login` route. Kept out of `route-tree.tsx`, which is at
 * its size ceiling; the sign-in screen itself stays a lazy chunk.
 */
export function LoginRoute() {
  const { reason, email } = useSearch({ from: "/login" });
  return (
    <DevReplayEntrance onReplay={devRestoreLoginBoot} holdMs={700}>
      <LoginScreen reason={reason} email={email} />
    </DevReplayEntrance>
  );
}
