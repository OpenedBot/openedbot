import { useEffect, useRef, type ComponentType, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RiGitMergeLine, RiRouteLine, RiShieldCheckLine, RiSpeedUpFill } from "@remixicon/react";
import {
  effectiveBotPermission,
  permissionModeRaiseRefused,
  type BotDto,
  type BotPermissionMode,
  type PermissionContextDto,
  type RosterDto,
} from "@openedbot/contracts-api";
import { cn, toast } from "@openedbot/browser-ui-kit";
import { ApiError, api, permissionContextQueryOptions, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { YoloBadge } from "../yolo/yolo-badge";
import { useThreadYoloLease, yoloIgnoredReason } from "../yolo/yolo-shared";

type IconType = ComponentType<{ className?: string }>;

/** The menu order, and the keys 1 to 4. */
export const PERMISSION_MODE_ORDER: readonly BotPermissionMode[] = ["manual", "auto", "plan", "bypass"];

const MODE_ICONS: Record<BotPermissionMode, { icon: IconType; flip?: boolean }> = {
  manual: { icon: RiGitMergeLine, flip: true },
  auto: { icon: RiSpeedUpFill },
  plan: { icon: RiRouteLine, flip: true },
  bypass: { icon: RiShieldCheckLine },
};

/** Écrit le mode de permission d'un bot, le roster en cache suit sans attendre. */
export function useSetPermissionMode(botId: string | undefined) {
  const { t } = useT();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (permissionMode: BotPermissionMode) => {
      if (!botId) throw new Error("bot missing");
      return api.updateBot(botId, { permissionMode });
    },
    onMutate: (permissionMode) => {
      queryClient.setQueryData<RosterDto>(queryKeys.roster, (roster) => roster
        ? { ...roster, bots: roster.bots.map((candidate) => candidate.id === botId ? { ...candidate, permissionMode } : candidate) }
        : roster);
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : t("boardui.saveFailed")),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.roster }),
  });
}

/** The organization's pipeline, ceiling and review proof; `null` until read (or on an older server). */
export function usePermissionContext(): PermissionContextDto | null {
  return useQuery(permissionContextQueryOptions()).data ?? null;
}

/**
 * The four modes as a radio group (PERM2-3): one line of truth per mode, a
 * mode above the organization ceiling visible but disabled, and the keyboard
 * of a menu (arrows move, 1 to 4 and Enter choose). `current` is the stored
 * mode of a bot, `null` on a creation.
 */
export function PermissionModeList({
  value,
  current = value,
  context,
  disabled = false,
  autoFocus = false,
  onSelect,
  ariaLabel,
  className,
  touch = false,
}: {
  value: BotPermissionMode;
  /** The stored mode the ceiling compares against (a bot already above it may stay). */
  current?: BotPermissionMode | null;
  context: PermissionContextDto | null;
  disabled?: boolean;
  autoFocus?: boolean;
  onSelect: (mode: BotPermissionMode) => void;
  ariaLabel: string;
  className?: string;
  /** 44 pt rows, for the bottom sheet. */
  touch?: boolean;
}) {
  const { t } = useT();
  const refs = useRef(new Map<BotPermissionMode, HTMLButtonElement>());
  const refused = (mode: BotPermissionMode) => permissionModeRaiseRefused(mode, current, context?.maxMode ?? null);
  const enabled = PERMISSION_MODE_ORDER.filter((mode) => !refused(mode));
  const tabStop = enabled.includes(value) ? value : enabled[0];

  useEffect(() => {
    if (autoFocus) refs.current.get(tabStop ?? value)?.focus();
    // Focus once, when the list opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choose = (mode: BotPermissionMode) => {
    if (disabled || refused(mode)) return;
    onSelect(mode);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const digit = Number(event.key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= PERMISSION_MODE_ORDER.length) {
      event.preventDefault();
      choose(PERMISSION_MODE_ORDER[digit - 1]!);
      return;
    }
    const focused = PERMISSION_MODE_ORDER.find((mode) => refs.current.get(mode) === document.activeElement);
    const at = focused ? enabled.indexOf(focused) : -1;
    let next: BotPermissionMode | undefined;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = enabled[(at + 1) % enabled.length];
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = enabled[(at <= 0 ? enabled.length : at) - 1];
    else if (event.key === "Home") next = enabled[0];
    else if (event.key === "End") next = enabled[enabled.length - 1];
    if (!next) return;
    event.preventDefault();
    refs.current.get(next)?.focus();
  };

  return (
    // The arrows and digits are the radio group's own keyboard (WAI-ARIA); the
    // rows are the focusable elements.
    <div role="radiogroup" aria-label={ariaLabel} onKeyDown={onKeyDown} className={cn("flex flex-col gap-1", className)}>
      {PERMISSION_MODE_ORDER.map((mode, index) => {
        const { icon: ModeIcon, flip } = MODE_ICONS[mode];
        const checked = mode === value;
        const limited = refused(mode);
        const hintKey = mode === "auto" && context?.pipeline !== "v2" ? "autoLegacy" : mode;
        return (
          <button
            key={mode}
            ref={(node) => { if (node) refs.current.set(mode, node); else refs.current.delete(mode); }}
            type="button"
            role="radio"
            data-permission-mode={mode}
            aria-checked={checked}
            aria-disabled={limited || disabled ? true : undefined}
            aria-keyshortcuts={String(index + 1)}
            tabIndex={mode === tabStop ? 0 : -1}
            onClick={() => choose(mode)}
            className={cn(
              "flex w-full items-center gap-2 rounded-[14px] p-2 text-start outline-none transition-colors focus-visible:ring-2 focus-visible:ring-border-focus-ring",
              touch && "min-h-11",
              limited || disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-background-primary-hover focus-visible:bg-background-primary-hover",
              checked && "bg-background-primary-hover",
            )}
          >
            <ModeIcon className={cn("size-5 shrink-0 text-foreground-icon-secondary", flip && "-scale-y-100")} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="inline-flex flex-wrap items-center text-body-medium text-text-secondary">
                {t(`boardui.permission.${mode}`)}
                {mode === "auto" && context?.pipeline === "v2" ? (
                  <span data-permission-experimental="" className="ms-1.5 rounded-full border border-border px-1.5 text-[11px] text-text-tertiary">
                    {t("boardui.permissionExperimental")}
                  </span>
                ) : null}
              </span>
              <span className="text-body-2-medium text-text-tertiary">{t(`boardui.permissionHint.${hintKey}`)}</span>
              {limited ? <span className="text-body-2-medium text-text-secondary">{t("boardui.permissionCeilingLimited")}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The modes worth showing in a conversation header: the others are the everyday ones. */
const NOTABLE_MODES: ReadonlySet<BotPermissionMode> = new Set(["plan", "bypass"]);

/**
 * The bot's mode in the conversation header, read only, and only when it is
 * out of the ordinary (Mode plan, Accès complet): the mode is a posture of
 * the bot, routines included, chosen in its page, not an option of the
 * message (iso Grok Bot, whose composer carries no permission control). The
 * click opens that page on Approvals.
 *
 * When the organization or an unproven reviewer makes the bot act otherwise,
 * the badge names the EFFECTIVE mode and says why.
 *
 * A YOLO lease that covers the bot wins over every mode: the badge becomes
 * « YOLO » and its countdown. The lease of `threadId` first (the gate's own
 * order: thread, bot, runtime), then the one the roster says covers the bot.
 */
export function PermissionModeBadge({
  bot,
  threadId,
  onOpen,
  compact = false,
}: {
  bot: BotDto;
  /** The conversation shown, whose own YOLO lease the badge looks for. */
  threadId?: string | null;
  onOpen: () => void;
  /** The phone header's subtitle line: text size of that line, no padding. */
  compact?: boolean;
}) {
  const { t } = useT();
  const context = usePermissionContext();
  const threadLease = useThreadYoloLease(threadId);
  const current = bot.permissionMode ?? "manual";
  const yolo = threadLease && yoloIgnoredReason(current, context) === null
    ? { leaseId: threadLease.id, scope: threadLease.scope, expiresAt: threadLease.expiresAt }
    : bot.effectivePermission?.yolo ?? null;
  if (yolo) return <YoloBadge key={yolo.leaseId} leaseId={yolo.leaseId} expiresAt={yolo.expiresAt} scope={yolo.scope} onOpen={onOpen} compact={compact} />;
  if (!NOTABLE_MODES.has(current)) return null;
  const { icon: Icon, flip } = MODE_ICONS[current];
  const label = t(`boardui.permission.${current}`);
  const effective = effectiveBotPermission(current, context);
  const effectiveLabel = t(`boardui.permission.${effective.mode}`);
  const reason = effective.reason ? t(`boardui.permissionEffectiveReason.${effective.reason}`, { mode: effectiveLabel }) : null;
  const hint = reason ?? t("boardui.permissionBadgeHint", { mode: label });
  return (
    <button
      type="button"
      data-permission-badge={current}
      data-effective-mode={effective.reason ? effective.mode : undefined}
      onClick={onOpen}
      aria-label={reason
        ? t("boardui.permissionEffectiveAria", { mode: label, effective: effectiveLabel, reason })
        : `${t("boardui.permissionLabel", { mode: label })}. ${hint}`}
      title={hint}
      className={cn(
        "flex shrink-0 cursor-pointer items-center gap-1 rounded-full outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-border-focus-ring",
        compact
          ? "min-w-0 text-[13px] leading-4 text-muted-foreground"
          : "h-7 bg-background-tertiary-default ps-2 pe-2.5 text-body-2-medium text-text-secondary hover:text-text-primary",
      )}
    >
      {compact ? <span aria-hidden>·</span> : null}
      <Icon className={cn("shrink-0 text-foreground-icon-secondary", compact ? "size-3.5" : "size-4", flip && "-scale-y-100")} />
      <span className="whitespace-nowrap">{label}</span>
      {effective.reason ? (
        <span data-permission-effective="" className="whitespace-nowrap text-text-primary">
          {t("boardui.permissionEffectiveShort", { mode: effectiveLabel })}
        </span>
      ) : null}
    </button>
  );
}
