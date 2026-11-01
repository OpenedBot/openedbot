import { useQuery } from "@tanstack/react-query";
import type { RosterDto } from "@openedbot/contracts-api";
import { api, queryKeys } from "../api";
import { useT } from "../i18n";

type AuthMe = Awaited<ReturnType<typeof api.authMe>>;

const selectOperator = (roster: RosterDto) => roster.operator ?? null;

export type OperatorIdentity = {
  /** The handle the bots address, or the generic "Operator" without a profile. */
  name: string;
  /** The session address, or the generic "Operator" without a session. */
  email: string;
  /** A signed-in session exists (something to sign out of). */
  signedIn: boolean;
  impersonating: boolean;
  /** A personal organization: the account card is the identity, not an organization name. */
  personal: boolean;
  /** The organization name of the session, empty without one. */
  organizationName: string;
};

/**
 * Who is signed in, as the account card (`data-nav-user`) says it. In a
 * personal account this is the single source of truth: the top bar and the
 * settings modal read it instead of re-deriving a name from the organization.
 */
export function useOperatorIdentity(): OperatorIdentity {
  const { t } = useT();
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe }).data;
  const operator = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster, select: selectOperator }).data ?? null;
  return deriveOperatorIdentity(me, operator, {
    handle: (username) => t("navUser.handle", { username }),
    fallback: t("navUser.operator"),
  });
}

export function deriveOperatorIdentity(
  me: AuthMe | undefined,
  operator: { username: string } | null,
  labels: { handle: (username: string) => string; fallback: string },
): OperatorIdentity {
  const session = me?.kind === "session" ? me : null;
  return {
    name: operator ? labels.handle(operator.username) : labels.fallback,
    email: session?.user.email ?? labels.fallback,
    signedIn: session !== null,
    impersonating: session !== null && session.session.impersonation !== null,
    personal: session?.organization.kind === "personal",
    organizationName: session?.organization.name ?? "",
  };
}
