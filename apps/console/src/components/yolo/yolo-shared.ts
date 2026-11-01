import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  YOLO_ACK_REQUIRED_CODE,
  YOLO_BLOCKED_BY_POLICY_CODE,
  YOLO_HOST_UNSUPPORTED_CODE,
  YOLO_HUMAN_REQUIRED_CODE,
  YOLO_SIGNING_UNAVAILABLE_CODE,
  yoloPolicyBlock,
  type BotPermissionMode,
  type PermissionContextDto,
  type YoloLeaseDto,
  type YoloPolicyBlockReason,
} from "@openedbot/contracts-api";
import { ApiError, api, queryKeys, userFacingError } from "../../lib/api";
import type { MessageKey } from "../../lib/i18n";
import { activeFleetId, activeOrganizationId } from "../../lib/session/cloud-session";

type T = (key: MessageKey, params?: Record<string, string | number>) => string;

/** Les durées proposées, en heures : 4 h par défaut, 24 h au plus (`YOLO_MAX_SECONDS`). */
export const YOLO_DURATION_HOURS = [1, 2, 4, 8, 12, 24] as const;
export const YOLO_DEFAULT_HOURS = 4;

/** Une lecture des baux tient 30 s : l'échéance, elle, se compte à la seconde contre `expiresAt`. */
const LEASES_REFRESH_MS = 30_000;

/**
 * `/api/organization*` n'existe que pour l'organisation elle-même : une
 * agence qui agit pour un client n'y a pas accès (D-5), et sans organisation
 * active il n'y a rien à lire.
 */
export function yoloReachable(): boolean {
  return Boolean(activeOrganizationId()) && !activeFleetId();
}

/** Owner ou admin : seuls à octroyer, couper et lire l'audit. Un membre voit les badges, en lecture. */
export function useCanManageYolo(): boolean {
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const role = me.data?.session.role;
  return (role === "owner" || role === "admin") && yoloReachable();
}

export function useYoloLeases(filters: { runtimeId?: string; botId?: string; threadId?: string }, enabled = true) {
  return useQuery({
    queryKey: queryKeys.yoloLeases(filters),
    // A body without its list (an older server, a proxy page) is a read
    // error the screens show, never a crash of the page that reads it.
    queryFn: async () => {
      const data = await api.yoloLeases(filters);
      if (!Array.isArray(data?.leases)) throw new Error("malformed YOLO leases response");
      return data;
    },
    enabled: enabled && yoloReachable(),
    retry: false,
    refetchInterval: LEASES_REFRESH_MS,
  });
}

/** Le bail de CETTE conversation, s'il y en a un : les baux de bot et de runtime se lisent sur la fiche (`effectivePermission.yolo`). */
export function useThreadYoloLease(threadId: string | null | undefined): YoloLeaseDto | null {
  const leases = useYoloLeases({ threadId: threadId ?? undefined }, Boolean(threadId));
  return leases.data?.leases.find((lease) => lease.scope === "thread" && lease.threadId === threadId) ?? null;
}

/** Après un octroi, une révocation ou un kill : les baux et l'état effectif des bots se relisent. */
export function invalidateYolo(queryClient: QueryClient): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.yoloLeasesRoot }),
    queryClient.invalidateQueries({ queryKey: queryKeys.roster }),
  ]);
}

export function useInvalidateYolo(): () => Promise<unknown> {
  const queryClient = useQueryClient();
  return () => invalidateYolo(queryClient);
}

/**
 * Pourquoi un bail qui court ne s'applique pas à ce bot : la porte l'ignore
 * en Mode plan, sous un plafond inférieur à Accès complet ou avec la revue
 * imposée. `null` : il s'applique. La raison se dit, jamais une
 * rétrogradation silencieuse.
 */
export function yoloIgnoredReason(
  mode: BotPermissionMode,
  context: PermissionContextDto | null,
): YoloPolicyBlockReason | "plan" | null {
  if (mode === "plan") return "plan";
  return context ? yoloPolicyBlock(context) : null;
}

function reasonOf(error: ApiError): string | null {
  const details = error.details;
  if (!details || typeof details !== "object" || !("reason" in details)) return null;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : null;
}

/** Le refus nommé par l'API (`YOLO_*` et sa `reason`), dit dans nos mots ; sinon le message de l'API. */
export function yoloErrorMessage(error: unknown, t: T, fallback: string): string {
  if (!(error instanceof ApiError)) return userFacingError(error, fallback);
  const reason = reasonOf(error);
  switch (error.code) {
    case YOLO_BLOCKED_BY_POLICY_CODE:
      if (reason === "ceiling" || reason === "enforce_review") return t(`yolo.blocked.${reason}`);
      break;
    case YOLO_HOST_UNSUPPORTED_CODE:
      if (reason === "yolo_lease" || reason === "yolo_thread_scope" || reason === "bot_profile_missing") {
        return t(`yolo.hostUnsupported.${reason}`);
      }
      break;
    case YOLO_HUMAN_REQUIRED_CODE: return t("yolo.error.humanRequired");
    case YOLO_SIGNING_UNAVAILABLE_CODE: return t("yolo.error.signingUnavailable");
    case "ROLE_REQUIRED": return t("yolo.managersOnly");
    case "YOLO_POLICY_CHANGED": return t("yolo.error.policyChanged");
    case "YOLO_TARGET_CHANGED": return t("yolo.error.targetChanged");
    case "YOLO_RUNTIME_NOT_FOUND":
    case "YOLO_TARGET_NOT_FOUND": return t("yolo.error.notFound");
    case "YOLO_LEASE_NOT_FOUND": return t("yolo.error.leaseNotFound");
    default: break;
  }
  return userFacingError(error, fallback);
}

export function isYoloAckRequired(error: unknown): boolean {
  return error instanceof ApiError && error.code === YOLO_ACK_REQUIRED_CODE;
}
