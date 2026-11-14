import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GroupAnswerMode, GroupDefaultResponder, GroupDto } from "@openedbot/contracts-api";
import { GROUP_MEMBERS_MAX, GROUP_MEMBERS_MIN } from "@openedbot/contracts-api";
import { visibleRosterItems } from "@/lib/thread/thread-visibility";
import {
  Dialog,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@openedbot/browser-ui-kit";
import { ApiError, api, queryKeys } from "../lib/api";
import { GroupMembersFields } from "./group-members-fields";
import { useT } from "../lib/i18n";
import { BUTTON } from "./settings/primitives";

/**
 * Create or edit a group, the same fields, two outcomes.
 *
 * `group` absent: creation (`POST`), then navigation to the new salon,
 * as `CreateBotSheet` does for a bot. `group` set: edit in place
 * (`PATCH`), no navigation, the operator stays where they are (the context
 * menu of a bar row, or the salon itself).
 */
export function GroupDialog({
  open,
  onClose,
  group,
  initialMemberIds,
}: {
  open: boolean;
  onClose: () => void;
  group?: GroupDto;
  /** Creation from a thread: that thread's bot is already in the salon. */
  initialMemberIds?: readonly string[];
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // The roster already carries `bots`: no dedicated request, just keeping it in
  // cache; `enabled: open` avoids keeping it alive behind a closed dialog.
  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster, enabled: open });
  const bots = visibleRosterItems(roster.data?.bots ?? []).filter((bot) => !bot.archivedAt);

  const [name, setName] = useState(group?.name ?? "");
  const [memberIds, setMemberIds] = useState<string[]>(group?.members.map((member) => member.id) ?? [...(initialMemberIds ?? [])]);
  const [instructions, setInstructions] = useState(group?.instructions ?? "");
  const [responder, setResponder] = useState(responderValue(group?.defaultResponder));
  const [answerMode, setAnswerMode] = useState<GroupAnswerMode>(group?.answerMode ?? "each");

  // A dialog reused for two successive groups (right click on one,
  // then on the other without ever unmounting the component) would otherwise keep the
  // previous one's name and members.
  useEffect(() => {
    if (!open) return;
    setName(group?.name ?? "");
    setMemberIds(group?.members.map((member) => member.id) ?? [...(initialMemberIds ?? [])]);
    setInstructions(group?.instructions ?? "");
    setResponder(responderValue(group?.defaultResponder));
    setAnswerMode(group?.answerMode ?? "each");
    // `initialMemberIds` is read only on opening: a literal array
    // recreated on every render must not reset the selection in progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, group]);

  const save = useMutation({
    mutationFn: () =>
      group
        ? api.updateGroup(group.id, {
            name: name.trim(),
            memberIds,
            instructions,
            defaultResponder: responderInput(responder),
            answerMode,
          })
        : api.createGroup({
            name: name.trim(),
            memberIds,
            instructions,
            defaultResponder: responderInput(responder),
            answerMode,
          }),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.roster });
      onClose();
      if (!group) void navigate({ to: "/g/$groupId", params: { groupId: saved.id } });
    },
  });

  const toggle = (botId: string) =>
    setMemberIds((prev) => (prev.includes(botId) ? prev.filter((id) => id !== botId) : [...prev, botId]));

  const outOfRange = memberIds.length < GROUP_MEMBERS_MIN || memberIds.length > GROUP_MEMBERS_MAX;
  const responderBotId = responder.startsWith("member:") ? responder.slice("member:".length) : null;
  const invalidResponder = responderBotId !== null && !memberIds.includes(responderBotId);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={group ? t("groups.manage") : t("groups.newGroup")}
      description={t("groups.membersHint")}
      closeLabel={t("common.close")}
      className="max-w-md"
      footer={
        <>
          <button type="button" onClick={onClose} className={BUTTON.secondary}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending || !name.trim() || outOfRange || invalidResponder}
            className={BUTTON.primary}
          >
            {save.isPending ? (group ? t("groups.saving") : t("groups.creating")) : group ? t("groups.save") : t("groups.create")}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="group-name">{t("groups.name")}</Label>
          <Input
            id="group-name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">{t("groups.members")}</Label>
          <GroupMembersFields bots={bots} memberIds={memberIds} onToggle={toggle} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="group-responder">{t("groups.defaultResponder")}</Label>
          <Select value={responder} onValueChange={setResponder}>
            <SelectTrigger id="group-responder">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="everyone">{t("groups.responders.everyone")}</SelectItem>
              <SelectItem value="mentions">{t("groups.responders.mentions")}</SelectItem>
              {bots.filter((bot) => memberIds.includes(bot.id)).map((bot) => (
                <SelectItem key={bot.id} value={`member:${bot.id}`}>
                  {t("groups.responders.member", { name: bot.name })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("groups.defaultResponderHint")}</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="group-answer-mode">{t("groups.answerMode")}</Label>
          <Select value={answerMode} onValueChange={(value) => setAnswerMode(value === "team" ? "team" : "each")}>
            <SelectTrigger id="group-answer-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="each">{t("groups.answerModes.each")}</SelectItem>
              <SelectItem value="team">{t("groups.answerModes.team")}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("groups.answerModeHint")}</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="group-instructions">{t("groups.instructions")}</Label>
          <Textarea
            id="group-instructions"
            value={instructions}
            maxLength={12_000}
            rows={4}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder={t("groups.instructionsPlaceholder")}
          />
        </div>

        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {t("groups.cwdUnavailable")}
        </p>

        {!group && bots.length < GROUP_MEMBERS_MIN ? (
          <p className="text-xs text-muted-foreground">{t("groups.errors.needMoreBots")}</p>
        ) : null}

        {outOfRange && memberIds.length > 0 ? (
          <p className="text-xs text-destructive-text">{t("groups.errors.memberRange")}</p>
        ) : null}

        {invalidResponder ? (
          <p className="text-xs text-destructive-text">{t("groups.errors.responderNotMember")}</p>
        ) : null}

        {save.isError ? (
          <p className="text-sm text-destructive-text">
            {save.error instanceof ApiError ? save.error.message : t("groups.errors.saveFailed")}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function responderValue(responder?: GroupDefaultResponder): string {
  return responder?.kind === "member" ? `member:${responder.botId}` : responder?.kind ?? "everyone";
}

function responderInput(value: string): GroupDefaultResponder {
  return value.startsWith("member:")
    ? { kind: "member", botId: value.slice("member:".length) }
    : value === "mentions"
      ? { kind: "mentions" }
      : { kind: "everyone" };
}
