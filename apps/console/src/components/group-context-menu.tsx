import { Suspense, useState, type ReactNode } from "react";
import { lazyRouteComponent, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ContextMenu } from "radix-ui";
import { Clock, Eye, EyeOff, FolderInput, Mail, Pin, PinOff, Trash2, Users, Webhook } from "lucide-react";
import { Button, cn, Dialog, toast } from "@openedbot/browser-ui-kit";
import { BUI_MENU_ITEM, BUI_POPOVER } from "./boardui/menu";
import type { GroupDto } from "@openedbot/contracts-api";
import { ApiError, api, queryKeys } from "../lib/api";
import { isBotManagePageParked } from "../lib/bots/bot-dialogs";
import { useT } from "../lib/i18n";
import { useOpenedOnce } from "../lib/hooks/use-opened-once";

// Fetched on first opening: the sidebar draws every group row with this menu,
// and none of its dialogs is needed to draw a row (ADR 0001, D1b).
const GroupDialog = lazyRouteComponent(() => import("./group-dialog"), "GroupDialog");
const MoveToSectionDialog = lazyRouteComponent(() => import("./move-to-section-dialog"), "MoveToSectionDialog");
const BotRoutinesDialog = lazyRouteComponent(() => import("./bot-routines-dialog"), "BotRoutinesDialog");
const ThreadWebhooksPanel = lazyRouteComponent(() => import("./bot-webhooks-panel"), "ThreadWebhooksPanel");

/**
 * Menu contextuel d'un groupe, au clic droit, le pendant de `BotContextMenu`
 * pour une ligne de salon. Deux issues seulement : gérer (nom, membres) ou
 * supprimer, avec la même confirmation par `Dialog` (jamais `window.confirm`,
 * cf. `bot-context-menu.tsx`).
 */
export function GroupContextMenu({ group, children }: { group: GroupDto; children: ReactNode }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const canManageRoutines = me.data?.kind === "session" && me.data.session.canWrite === true;
  const navigate = useNavigate();
  const { groupId } = useParams({ strict: false });
  const [managing, setManaging] = useState(false);
  const [managingRoutines, setManagingRoutines] = useState(false);
  const [managingWebhooks, setManagingWebhooks] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [movingToSection, setMovingToSection] = useState(false);
  // Each sidebar row carries this menu: its dialogs mount on first open only.
  const groupMounted = useOpenedOnce(managing);
  const sectionMounted = useOpenedOnce(movingToSection);
  const routinesMounted = useOpenedOnce(managingRoutines);

  const remove = useMutation({
    mutationFn: () => api.deleteGroup(group.id),
    onSuccess: async () => {
      setConfirming(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.roster });
      if (groupId === group.id) void navigate({ to: "/" });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : t("botContextMenu.actionFailed")),
  });
  const markUnread = useMutation({
    mutationFn: () => api.markThreadUnread(group.threadId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.roster }),
  });
  const togglePin = useMutation({
    mutationFn: () => api.updateGroup(group.id, { pinned: !group.pinned }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.roster }),
  });
  const toggleHidden = useMutation({
    mutationFn: () => group.hidden ? api.showThread(group.threadId) : api.hideThread(group.threadId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.roster });
      if (!group.hidden && groupId === group.id) void navigate({ to: "/" });
    },
  });

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={cn(BUI_POPOVER, "min-w-[198px] gap-1")}>
            <ContextMenu.Item
              onSelect={() => setManaging(true)}
              className={BUI_MENU_ITEM}
            >
              <Users className="size-5 shrink-0 text-foreground-icon-secondary" />
              {t("groups.manage")}
            </ContextMenu.Item>
            {canManageRoutines ? (
            <ContextMenu.Item
              onSelect={() => setMovingToSection(true)}
              className={BUI_MENU_ITEM}
            >
              <FolderInput className="size-5 shrink-0 text-foreground-icon-secondary" />
              {t("appSidebar.moveToSection")}
            </ContextMenu.Item>
            ) : null}
            {canManageRoutines ? (
            <ContextMenu.Item
              onSelect={() => setManagingRoutines(true)}
              className={BUI_MENU_ITEM}
            >
              <Clock className="size-5 shrink-0 text-foreground-icon-secondary" />
              {t("botContextMenu.routines")}
            </ContextMenu.Item>
            ) : null}
            <ContextMenu.Item
              onSelect={() => markUnread.mutate()}
              className={BUI_MENU_ITEM}
            >
              <Mail className="size-5 shrink-0 text-foreground-icon-secondary" />
              {t("groups.markUnread")}
            </ContextMenu.Item>
            <ContextMenu.Item
              disabled={isBotManagePageParked("webhooks")}
              onSelect={() => setManagingWebhooks(true)}
              className={BUI_MENU_ITEM}
            >
              <Webhook className="size-5 shrink-0 text-foreground-icon-secondary" />
              {t("botSettingsDialog.navWebhooks")}
            </ContextMenu.Item>
            <ContextMenu.Item
              onSelect={() => togglePin.mutate()}
              className={BUI_MENU_ITEM}
            >
              {group.pinned ? <PinOff className="size-5 shrink-0 text-foreground-icon-secondary" /> : <Pin className="size-5 shrink-0 text-foreground-icon-secondary" />}
              {group.pinned ? t("groups.unpin") : t("groups.pin")}
            </ContextMenu.Item>
            <ContextMenu.Item
              onSelect={() => toggleHidden.mutate()}
              className={BUI_MENU_ITEM}
            >
              {group.hidden ? <Eye className="size-5 shrink-0 text-foreground-icon-secondary" /> : <EyeOff className="size-5 shrink-0 text-foreground-icon-secondary" />}
              {group.hidden ? t("groups.show") : t("groups.hide")}
            </ContextMenu.Item>
            <ContextMenu.Separator className="-mx-1.5 my-1 h-px bg-border-button-default" />
            <ContextMenu.Item
              onSelect={() => setConfirming(true)}
              className={cn(BUI_MENU_ITEM, "text-text-destructive")}
            >
              <Trash2 className="size-5 shrink-0" />
              {t("groups.delete")}
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      {groupMounted ? <Suspense fallback={null}><GroupDialog open={managing} onClose={() => setManaging(false)} group={group} /></Suspense> : null}
      {sectionMounted ? <Suspense fallback={null}><MoveToSectionDialog row={{ kind: "group", group }} open={movingToSection} onClose={() => setMovingToSection(false)} /></Suspense> : null}
      {routinesMounted ? <Suspense fallback={null}><BotRoutinesDialog group={group} open={managingRoutines} onClose={() => setManagingRoutines(false)} /></Suspense> : null}

      <Dialog
        open={managingWebhooks}
        onClose={() => setManagingWebhooks(false)}
        title={`${t("botSettingsDialog.navWebhooks")} · ${group.name}`}
        closeLabel={t("common.close")}
        className="max-w-2xl"
      >
        <Suspense fallback={null}><ThreadWebhooksPanel threadId={group.threadId} open={managingWebhooks} /></Suspense>
      </Dialog>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        role="alertdialog"
        title={t("groups.deleteTitle", { name: group.name })}
        description={t("groups.deleteDescription")}
        closeLabel={t("common.close")}
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConfirming(false)}
              disabled={remove.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              {remove.isPending ? t("groups.deleting") : t("groups.delete")}
            </Button>
          </>
        }
      >
        {remove.isError ? (
          <p className="text-destructive-text">
            {t("groups.deleteError", { message: remove.error.message })}
          </p>
        ) : null}
      </Dialog>
    </>
  );
}
