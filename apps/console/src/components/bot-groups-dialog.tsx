import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconPlus } from "@tabler/icons-react";
import type { BotDto, GroupDto } from "@openedbot/contracts-api";
import { GROUP_MEMBERS_MAX, GROUP_MEMBERS_MIN } from "@openedbot/contracts-api";
import { visibleRosterItems } from "@/lib/thread-visibility";
import { Checkbox, Dialog, Input, Label } from "@openedbot/browser-ui-kit";
import { ApiError, api, queryKeys } from "../lib/api";
import { GroupFaceStack } from "./group-face-stack";
import { GroupMembersFields } from "./group-members-fields";
import { useT } from "../lib/i18n";
import { BUTTON } from "./settings/primitives";

/**
 * Les groupes d'UN bot, depuis son menu contextuel.
 *
 * Différent de `GroupDialog` (qui édite un groupe à la fois) : ici c'est le
 * bot qui est fixe et les groupes qui défilent, une case à cocher par ligne,
 * l'idiome « appartenances » plutôt que « détail d'un groupe ». La création
 * d'un nouveau groupe reste possible sans quitter ce dialogue, ce bot
 * présélectionné.
 */
export function BotGroupsDialog({
  bot,
  open,
  onClose,
}: {
  bot: BotDto;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster, enabled: open });
  const groups = visibleRosterItems(roster.data?.groups ?? []);
  const bots = visibleRosterItems(roster.data?.bots ?? []).filter((candidate) => !candidate.archivedAt);

  const [rowError, setRowError] = useState<{ groupId: string; message: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([bot.id]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.roster });

  const toggleMembership = useMutation({
    mutationFn: (input: { group: GroupDto; nextMemberIds: string[] }) =>
      api.updateGroup(input.group.id, { memberIds: input.nextMemberIds }),
    onSuccess: invalidate,
  });

  const createGroup = useMutation({
    mutationFn: () => api.createGroup({ name: name.trim(), memberIds }),
    onSuccess: async () => {
      await invalidate();
      setCreating(false);
      setName("");
      setMemberIds([bot.id]);
    },
  });

  const closeAll = () => {
    onClose();
    setCreating(false);
    setName("");
    setMemberIds([bot.id]);
    setRowError(null);
  };

  const toggle = (group: GroupDto, isMember: boolean) => {
    setRowError(null);
    if (isMember && group.defaultResponder.kind === "member" && group.defaultResponder.botId === bot.id) {
      setRowError({ groupId: group.id, message: t("groups.errors.responderNotMember") });
      return;
    }
    if (isMember && group.members.length <= GROUP_MEMBERS_MIN) {
      setRowError({ groupId: group.id, message: t("groups.errors.tooFewMembers") });
      return;
    }
    const nextMemberIds = isMember
      ? group.members.filter((member) => member.id !== bot.id).map((member) => member.id)
      : [...group.members.map((member) => member.id), bot.id];
    toggleMembership.mutate({ group, nextMemberIds });
  };

  // Un salon réunit 2 à 6 bots : avec un seul bot dans l'organisation, la
  // création est une impasse : on le dit plutôt que de laisser un bouton gris.
  const enoughBots = bots.length >= GROUP_MEMBERS_MIN;
  const outOfRange = memberIds.length < GROUP_MEMBERS_MIN || memberIds.length > GROUP_MEMBERS_MAX;

  const toggleNewMember = (botId: string) =>
    setMemberIds((prev) => (prev.includes(botId) ? prev.filter((id) => id !== botId) : [...prev, botId]));

  return (
    <Dialog
      open={open}
      onClose={closeAll}
      title={t("groups.manageForBotTitle", { name: bot.name })}
      closeLabel={t("common.close")}
      className="max-w-md"
      footer={
        <button type="button" onClick={closeAll} className={BUTTON.secondary}>
          {t("common.close")}
        </button>
      }
    >
      <div className="space-y-4">
        {groups.length > 0 ? (
          <div className="space-y-0.5">
            {groups.map((group) => {
              const isMember = group.members.some((member) => member.id === bot.id);
              const pending = toggleMembership.isPending && toggleMembership.variables?.group.id === group.id;
              return (
                <div key={group.id} className="space-y-1">
                  <label className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1.5 text-sm hover:bg-muted">
                    <span className="flex min-w-0 items-center gap-2">
                      <GroupFaceStack members={group.members} size="size-5" />
                      <span className="truncate">{group.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t("groups.memberCount", { count: group.members.length })}
                      </span>
                    </span>
                    <Checkbox
                      checked={isMember}
                      disabled={pending}
                      onCheckedChange={() => toggle(group, isMember)}
                    />
                  </label>
                  {rowError?.groupId === group.id ? (
                    <p className="px-1.5 text-xs text-destructive-text">{rowError.message}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("groups.noGroupsYet")}</p>
        )}

        <div className="border-t border-border pt-3">
          {creating ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="bot-groups-new-name" className="text-xs text-muted-foreground">
                  {t("groups.name")}
                </Label>
                <Input
                  id="bot-groups-new-name"
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t("groups.members")}</Label>
                <GroupMembersFields bots={bots} memberIds={memberIds} onToggle={toggleNewMember} />
                <p className="text-xs text-muted-foreground">{t("groups.membersHint")}</p>
              </div>
              {outOfRange ? (
                <p className="text-xs text-destructive-text">{t("groups.errors.memberRange")}</p>
              ) : null}
              {createGroup.isError ? (
                <p className="text-xs text-destructive-text">
                  {createGroup.error instanceof ApiError ? createGroup.error.message : t("groups.errors.saveFailed")}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setCreating(false)} className={BUTTON.secondary}>
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => createGroup.mutate()}
                  disabled={createGroup.isPending || !name.trim() || outOfRange}
                  className={BUTTON.primary}
                >
                  {createGroup.isPending ? t("groups.creating") : t("groups.create")}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={!enoughBots}
              onClick={() => setCreating(true)}
              className={BUTTON.small}
            >
              <IconPlus className="size-3.5" aria-hidden />
              {t("groups.newGroup")}
            </button>
          )}
          {!enoughBots ? (
            <p className="mt-2 text-xs text-muted-foreground">{t("groups.errors.needMoreBots")}</p>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
