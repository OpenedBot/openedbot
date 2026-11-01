import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconActivity,
  IconArchive,
  IconArrowLeft,
  IconBrain,
  IconChevronRight,
  IconClock,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconHierarchy3,
  IconKey,
  IconNotebook,
  IconPencil,
  IconPin,
  IconPlugConnected,
  IconServerBolt,
  IconShieldCheck,
  IconSparkles,
  IconTools,
  IconTrash,
  IconWebhook,
  IconX,
} from "@tabler/icons-react";
import type { BotDto } from "@openedbot/contracts-api";
import { normalizeAutonomyPolicy } from "@openedbot/roster/domain/autonomous-workflow";
import { Dialog, cn, toast, useIsMobile } from "@openedbot/browser-ui-kit";
import { ApiError, api, queryKeys, runtimesQueryOptions } from "../../lib/api";
import { useT, type MessageKey } from "../../lib/i18n";
import { haptics } from "../../lib/haptics";
import { useAgentEditor } from "../../lib/agent-editor";
import { useBotDialogs, type BotManagePage } from "../../lib/bot-dialogs";
import { BotFace } from "../bot-face";
import { BotProfileRepair, useBotProfileStatus } from "../bot-profile-repair";
import { BotCapabilitiesPanel, botCapabilitiesQueryOptions } from "../bot-capabilities-panel";
import { BotCredentialSection } from "../bot-settings/bot-credential-section";
import { BotRoutinesPanel } from "../bot-routines-dialog";
import { BotMemoryPanel } from "../bot-runtime-memory-panel";
import { BotWebhooksPanel } from "../bot-webhooks-panel";
import { InsetBackButton, InsetCloseButton, InsetGroupedRow, InsetGroupedSection, MobileActionFooter } from "../mobile/inset-grouped";
import { MobileSheetStack } from "../mobile/sheet-stack";
import { BUTTON } from "../settings/primitives";
import { BotDeleteDialog, useBotActions } from "./bot-actions";
import { ActivityPage, ApprovalsPage, ModelPage, RuntimePane, useCoordinationPage, usePersonaPage } from "./bot-manage-pages";

type Icon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

type PageEntry = { id: BotManagePage; icon: Icon; labelKey: MessageKey; disabled?: boolean };

const PAGES: Record<BotManagePage, PageEntry> = {
  persona: { id: "persona", icon: IconSparkles, labelKey: "botManage.page.persona" },
  model: { id: "model", icon: IconBrain, labelKey: "botManage.page.model" },
  approvals: { id: "approvals", icon: IconShieldCheck, labelKey: "botManage.page.approvals" },
  skills: { id: "skills", icon: IconTools, labelKey: "botManage.page.skills" },
  mcp: { id: "mcp", icon: IconPlugConnected, labelKey: "botManage.page.mcp" },
  credentials: { id: "credentials", icon: IconKey, labelKey: "botManage.page.credentials" },
  memory: { id: "memory", icon: IconNotebook, labelKey: "botManage.page.memory" },
  routines: { id: "routines", icon: IconClock, labelKey: "botManage.page.routines" },
  coordination: { id: "coordination", icon: IconHierarchy3, labelKey: "botManage.page.coordination" },
  activity: { id: "activity", icon: IconActivity, labelKey: "botManage.page.activity" },
  runtime: { id: "runtime", icon: IconServerBolt, labelKey: "botManage.page.runtime" },
  // Parqué : le panneau et l'API restent, réactiver = retirer `disabled`.
  webhooks: { id: "webhooks", icon: IconWebhook, labelKey: "botManage.page.webhooks", disabled: true },
};

/** The rows of the bot page, grouped as OpenBot's `settings-rows` (each row says its current answer). */
export const BOT_MANAGE_GROUPS: ReadonlyArray<{ labelKey: MessageKey; pages: BotManagePage[] }> = [
  { labelKey: "botManage.group.who", pages: ["persona", "model"] },
  { labelKey: "botManage.group.how", pages: ["approvals", "skills", "mcp", "credentials", "coordination"] },
  { labelKey: "botManage.group.memory", pages: ["memory", "routines", "activity"] },
  { labelKey: "botManage.group.where", pages: ["runtime", "webhooks"] },
];

/** Parked: visible, not actionable (webhooks keep their panel and API). Also read by the group menu. */
export function isBotManagePageParked(page: BotManagePage): boolean {
  return PAGES[page].disabled === true;
}

/** A parked page never opens: the index stays. */
export function usableBotManagePage(page: BotManagePage | null | undefined): BotManagePage | null {
  if (!page) return null;
  return PAGES[page].disabled ? null : page;
}

/** The first line of the persona, without its markdown heading marks. */
function personaSummary(instructions: string): string | null {
  const line = instructions.split("\n").map((entry) => entry.replace(/^#+\s*/, "").trim()).find(Boolean);
  return line ?? null;
}

/**
 * La page d'un bot, à l'iso d'OpenBot (`bot-profile/profile.tsx` +
 * `settings-rows.tsx` + `manage.tsx`) : une liste de rangées qui disent
 * chacune leur réponse actuelle et ouvrent leur page, puis ce qu'on peut faire
 * au bot (épingler, masquer, dupliquer, archiver, supprimer).
 *
 * L'identité (visage, nom, rôle, description, langue, voix) se règle dans
 * l'éditeur d'agent BoardUI, à droite du fil, comme le panneau de bot de Grok
 * Bot : « Modifier le profil » y mène. Cette page porte tout le reste.
 *
 * Plus de brouillon global ni de « Enregistrer » commun : un choix s'écrit au
 * clic (approbations, capacités, modèle) ; un texte (persona, coordination)
 * a son propre bouton dans le pied de SA page.
 */
export function BotManageDialog({
  bot,
  open,
  onClose,
  initialPage = null,
  threadId = null,
}: {
  bot: BotDto;
  open: boolean;
  onClose: () => void;
  initialPage?: BotManagePage | null;
  /** The thread shown behind the page (a message branch), for the Activity page. */
  threadId?: string | null;
}) {
  const { t } = useT();
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const showEditor = useAgentEditor((state) => state.show);
  const openCreate = useBotDialogs((state) => state.openCreate);
  const [page, setPage] = useState<BotManagePage | null>(() => usableBotManagePage(initialPage));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const actions = useBotActions(bot);

  useEffect(() => {
    if (open) setPage(usableBotManagePage(initialPage));
  }, [open, initialPage, bot.id]);

  // Started on open, not on the "Skills et outils" row: a cold host needs
  // seconds for this inventory, which the time spent in the menu absorbs.
  useEffect(() => {
    if (open) void queryClient.prefetchQuery(botCapabilitiesQueryOptions(bot.id));
  }, [open, bot.id, queryClient]);

  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe, enabled: open });
  const canWrite = me.data?.kind === "session" && me.data.session.canWrite === true;
  const runtimes = useQuery({ ...runtimesQueryOptions(), enabled: open });
  const runtime = runtimes.data?.runtimes[0] ?? null;
  const profileCredentialsAvailable = Boolean(bot.hermesProfile && runtime?.linkFeatures?.includes("profile_credentials") === true);
  const shown = (id: BotManagePage) =>
    (id !== "routines" || canWrite) && (id !== "credentials" || profileCredentialsAvailable);

  const profileStatus = useBotProfileStatus(bot, open);
  const profileMissing = profileStatus.data?.state === "missing";
  const createProfile = useMutation({
    mutationFn: () => api.createBotProfile(bot.id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.roster }),
        queryClient.invalidateQueries({ queryKey: queryKeys.botCapabilities(bot.id) }),
      ]);
      toast.success(t("botCapabilities.profileCreate"));
    },
  });
  const profileManagementAvailable = !bot.hermesProfile
    && !createProfile.isSuccess
    && runtime?.linkFeatures?.includes("profile_management") === true;

  const personaPage = usePersonaPage(bot, open && page === "persona");
  const coordinationPage = useCoordinationPage(bot, open && page === "coordination");

  // Runtime replaced: the credentials page would read a profile the host lacks.
  useEffect(() => {
    if (page === "credentials" && runtimes.isFetched && !profileCredentialsAvailable) setPage(null);
  }, [page, runtimes.isFetched, profileCredentialsAvailable]);

  const value = (id: BotManagePage): string | undefined => {
    switch (id) {
      case "persona": return personaSummary(bot.instructions) ?? t("botManage.value.personaEmpty");
      case "model": return bot.model ?? t("botManage.value.modelRuntime");
      case "approvals": return t(`boardui.permission.${bot.permissionMode ?? "manual"}`);
      case "coordination": return t(normalizeAutonomyPolicy(bot.autonomy).enabled ? "botManage.value.on" : "botManage.value.off");
      case "runtime": return runtime?.name ?? undefined;
      case "webhooks": return t("botManage.value.parked");
      default: return undefined;
    }
  };
  /** The runtime row also names the bot's Hermes profile and who owns it (read-only). */
  const description = (id: BotManagePage): string | undefined => {
    if (id !== "runtime") return undefined;
    if (!bot.hermesProfile) return t("botManage.profile.unassigned");
    return t(bot.hermesProfileManaged ? "botManage.profile.managedByOhb" : "botManage.profile.imported", { profile: bot.hermesProfile });
  };

  const go = (id: BotManagePage) => {
    if (PAGES[id].disabled) return;
    haptics.light();
    setPage(id);
  };
  const back = () => {
    haptics.light();
    setPage(null);
  };
  const editProfile = () => {
    onClose();
    showEditor(bot.id);
  };
  const duplicate = () => {
    onClose();
    openCreate(bot);
  };

  type ActionRow = { id: string; icon: Icon; label: string; onSelect: () => void; destructive?: boolean; pending?: boolean };
  const manageRows: ActionRow[] = [
    { id: "pin", icon: IconPin, label: t(bot.pinned ? "boardui.unpinChat" : "boardui.pinChat"), onSelect: () => actions.togglePin.mutate(), pending: actions.togglePin.isPending },
    { id: "hide", icon: bot.hidden ? IconEye : IconEyeOff, label: t(bot.hidden ? "botContextMenu.show" : "botContextMenu.hide"), onSelect: () => actions.toggleHidden.mutate(), pending: actions.toggleHidden.isPending },
    { id: "duplicate", icon: IconCopy, label: t("botManage.duplicate"), onSelect: duplicate },
    { id: "archive", icon: IconArchive, label: t(actions.archived ? "botContextMenu.unarchive" : "botContextMenu.archive"), onSelect: () => actions.toggleArchive.mutate(undefined, { onSuccess: () => { if (!actions.archived) onClose(); } }), pending: actions.toggleArchive.isPending },
    { id: "delete", icon: IconTrash, label: t("botContextMenu.delete"), onSelect: () => setConfirmingDelete(true), destructive: true },
  ];

  const header = (
    <div className={cn("flex items-center gap-3", isMobile ? "flex-col px-4 pt-1 pb-2 text-center" : "px-1 pb-2")}>
      <BotFace name={bot.name} seed={bot.id} face={bot.face} animated className={isMobile ? "size-[88px]" : "size-14 shrink-0"} />
      <div className={cn("min-w-0", !isMobile && "flex-1")}>
        <h2 className={cn("truncate font-semibold text-text-primary", isMobile ? "text-[22px] leading-7" : "text-lg leading-6")}>{bot.name}</h2>
        <p className="truncate text-sm text-text-tertiary">{bot.label?.trim() || bot.description?.trim() || `@${bot.slug}`}</p>
      </div>
      <button type="button" className={cn(BUTTON.secondary, "gap-1.5")} onClick={editProfile}>
        <IconPencil className="size-3.5" aria-hidden />
        {t("botManage.editProfile")}
      </button>
      {!isMobile ? (
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={onClose}
          className="inline-flex size-8 shrink-0 items-center justify-center self-start rounded-full text-foreground-icon-secondary outline-none transition-colors hover:bg-background-tertiary-default focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          <IconX className="size-4" aria-hidden />
        </button>
      ) : null}
    </div>
  );

  const indexDesktop = (
    <div className="space-y-5">
      {header}
      {BOT_MANAGE_GROUPS.map((group) => (
        <section key={group.labelKey} aria-label={t(group.labelKey)}>
          <h3 className="px-3 pb-1 text-xs font-medium text-text-tertiary">{t(group.labelKey)}</h3>
          <ul className="rounded-2xl bg-background-secondary-default p-1">
            {group.pages.filter(shown).map((id) => {
              const entry = PAGES[id];
              const RowIcon = entry.icon;
              return (
                <li key={id}>
                  <button
                    type="button"
                    data-bot-manage-row={id}
                    onClick={() => go(id)}
                    disabled={entry.disabled}
                    aria-disabled={entry.disabled || undefined}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left outline-none ohb-row hover:bg-background-tertiary-default focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                  >
                    <RowIcon aria-hidden className="size-4 shrink-0 text-foreground-icon-secondary" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-text-primary">{t(entry.labelKey)}</span>
                      {description(id) ? <span className="block truncate text-xs text-text-tertiary">{description(id)}</span> : null}
                    </span>
                    {value(id) ? <span className="max-w-[45%] truncate text-sm text-text-tertiary">{value(id)}</span> : null}
                    <IconChevronRight aria-hidden className="size-4 shrink-0 text-foreground-icon-tertiary" />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <section aria-label={t("botManage.group.manage")}>
        <h3 className="px-3 pb-1 text-xs font-medium text-text-tertiary">{t("botManage.group.manage")}</h3>
        <ul className="rounded-2xl bg-background-secondary-default p-1">
          {manageRows.map((row) => {
            const RowIcon = row.icon;
            return (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={row.onSelect}
                  disabled={row.pending}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm outline-none ohb-row hover:bg-background-tertiary-default focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:opacity-50",
                    row.destructive ? "text-destructive-text" : "text-text-primary",
                  )}
                >
                  <RowIcon aria-hidden className={cn("size-4 shrink-0", row.destructive ? "text-destructive-text" : "text-foreground-icon-secondary")} />
                  <span className="min-w-0 flex-1 truncate">{row.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );

  const indexMobile = (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--ohb-grouped-canvas)]">
      <header className="flex min-h-11 shrink-0 items-center justify-end px-4 pt-2">
        <InsetCloseButton label={t("common.close")} onClick={onClose} />
      </header>
      <nav aria-label={t("botManage.navLabel")} className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto pb-[max(1.5rem,var(--ohb-safe-bottom))]">
        {header}
        {BOT_MANAGE_GROUPS.map((group) => (
          <InsetGroupedSection key={group.labelKey} caption={t(group.labelKey)}>
            {group.pages.filter(shown).map((id) => (
              <InsetGroupedRow
                key={id}
                icon={PAGES[id].icon}
                label={t(PAGES[id].labelKey)}
                value={value(id)}
                subtitle={description(id)}
                disabled={PAGES[id].disabled}
                onClick={() => go(id)}
              />
            ))}
          </InsetGroupedSection>
        ))}
        <InsetGroupedSection caption={t("botManage.group.manage")}>
          {manageRows.map((row) => (
            <InsetGroupedRow
              key={row.id}
              icon={row.icon}
              label={row.label}
              chevron={false}
              disabled={row.pending}
              onClick={row.onSelect}
              className={row.destructive ? "[&_span]:text-destructive-text [&_svg]:text-destructive-text" : undefined}
            />
          ))}
        </InsetGroupedSection>
      </nav>
    </div>
  );

  const capabilitiesPane = page === "skills" || page === "mcp";
  const needsProfile = page === "memory" || capabilitiesPane;
  let body: ReactNode = null;
  let footer: ReactNode = null;
  if (page && needsProfile && profileMissing && profileStatus.data) {
    body = <BotProfileRepair bot={bot} status={profileStatus.data} variant="inline" />;
  } else if (page === "persona") {
    body = personaPage.body;
    footer = personaPage.footer;
  } else if (page === "model") {
    body = <ModelPage bot={bot} />;
  } else if (page === "approvals") {
    body = <ApprovalsPage bot={bot} />;
  } else if (capabilitiesPane) {
    body = (
      <BotCapabilitiesPanel
        bot={bot}
        open={open}
        pane={page === "mcp" ? "mcp" : "skills"}
        createProfileAvailable={profileManagementAvailable}
        onCreateProfile={() => createProfile.mutate()}
        createProfilePending={createProfile.isPending}
        createProfileError={createProfile.error instanceof ApiError ? createProfile.error.message : createProfile.isError ? t("botCapabilities.profileCreateFailed") : null}
      />
    );
    if (profileManagementAvailable) {
      footer = (
        <button type="button" className={BUTTON.secondary} onClick={() => createProfile.mutate()} disabled={createProfile.isPending}>
          {createProfile.isPending ? t("botCapabilities.profileCreating") : t("botCapabilities.profileCreate")}
        </button>
      );
    }
  } else if (page === "credentials" && profileCredentialsAvailable && runtime) {
    body = <BotCredentialSection bot={bot} runtime={runtime} open={open} />;
  } else if (page === "memory") {
    body = <BotMemoryPanel bot={bot} open={open} />;
  } else if (page === "routines" && canWrite) {
    body = <BotRoutinesPanel bot={bot} open={open} embedded />;
  } else if (page === "coordination") {
    body = coordinationPage.body;
    footer = coordinationPage.footer;
  } else if (page === "activity") {
    body = <ActivityPage bot={bot} threadId={threadId} open={open} />;
  } else if (page === "webhooks" && !PAGES.webhooks.disabled) {
    body = <BotWebhooksPanel bot={bot} open={open} />;
  }
  /** The runtime page is the `/settings/runtime` screen: its own scroller and footer. */
  const runtimePane = page === "runtime";

  const detail = page ? (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <header className={cn("flex items-center gap-1", isMobile ? "bg-[var(--ohb-grouped-canvas)] px-2 py-1" : "gap-2 border-b border-border px-4 py-3")}>
        {isMobile ? (
          <InsetBackButton label={t("botManage.back")} onClick={back} />
        ) : (
          <button
            type="button"
            aria-label={t("botManage.back")}
            onClick={back}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-foreground-icon-secondary outline-none transition-colors hover:bg-background-tertiary-default focus-visible:ring-2 focus-visible:ring-border-focus-ring"
          >
            <IconArrowLeft className="size-4" aria-hidden />
          </button>
        )}
        <h2 className={cn("min-w-0 flex-1 truncate font-semibold", isMobile ? "px-2 text-center text-[17px] leading-[22px] text-[var(--ohb-grouped-label)]" : "text-base text-text-primary")}>
          {t(PAGES[page].labelKey)}
        </h2>
        {isMobile ? (
          <div className="flex size-11 items-center justify-center">
            <InsetCloseButton label={t("common.close")} onClick={onClose} />
          </div>
        ) : (
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={onClose}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-foreground-icon-secondary outline-none transition-colors hover:bg-background-tertiary-default focus-visible:ring-2 focus-visible:ring-border-focus-ring"
          >
            <IconX className="size-4" aria-hidden />
          </button>
        )}
      </header>
      {runtimePane ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden"><RuntimePane /></div>
      ) : (
        <div
          // Focusable: a page with text only must still scroll from the keyboard
          // (axe `scrollable-region-focusable`).
          tabIndex={0}
          data-bot-manage-scroll=""
          className={cn(
            "scrollbar-subtle min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring",
            isMobile ? "bg-[var(--ohb-grouped-canvas)] px-4 py-4" : "px-5 py-4",
          )}
        >
          <div className={cn(isMobile && "rounded-[20px] bg-[var(--ohb-grouped-card)] px-4 py-4")}>{body}</div>
        </div>
      )}
      {footer ? (
        isMobile ? (
          <MobileActionFooter>{footer}</MobileActionFooter>
        ) : (
          <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</footer>
        )
      ) : isMobile && !runtimePane ? (
        <div className="shrink-0 bg-[var(--ohb-grouped-canvas)] pb-[max(0.75rem,var(--ohb-safe-bottom))]" />
      ) : null}
    </div>
  ) : null;

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        ariaLabel={t("botManage.title", { name: bot.name })}
        closeLabel={t("common.close")}
        showHandle={!isMobile}
        className={cn(
          !isMobile && "h-[min(48rem,calc(100dvh-6rem))] max-h-[min(48rem,calc(100dvh-6rem))] max-w-[min(48rem,calc(100vw-2rem))]",
          !isMobile && runtimePane && "max-w-[min(80rem,calc(100vw-2rem))]",
          isMobile &&
            "ohb-inset-sheet h-[calc(100dvh-var(--ohb-safe-top)-0.75rem)] max-h-[calc(100dvh-var(--ohb-safe-top)-0.75rem)] max-sm:max-h-[calc(100dvh-var(--ohb-safe-top)-0.75rem)]",
        )}
        bodyClassName="flex min-h-0 flex-1 flex-col overflow-y-hidden p-0"
      >
        <MobileSheetStack
          pushed={page !== null}
          onPop={back}
          index={isMobile ? indexMobile : (
            <div data-bot-manage-index="" className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-5 pt-5 pb-6">{indexDesktop}</div>
          )}
        >
          {detail}
        </MobileSheetStack>
      </Dialog>
      <BotDeleteDialog
        bot={bot}
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        remove={actions.remove}
        onDeleted={onClose}
      />
    </>
  );
}
