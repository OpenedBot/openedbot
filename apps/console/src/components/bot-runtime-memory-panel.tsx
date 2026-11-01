import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BotDto, BotRuntimeMemoryDto, RuntimeMemoryTarget } from "@openedbot/contracts-api";
import { SECTION_CONTEXT_MAX_CHARS } from "@openedbot/roster/domain/playbooks";
import { Button, Input, Label, Skeleton, Switch, cn } from "@openedbot/browser-ui-kit";
import { ApiError, api, queryKeys } from "../lib/api";
import { useT } from "../lib/i18n";
import { BUTTON } from "./settings/primitives";

type RuntimeMemory = Extract<BotRuntimeMemoryDto, { available: true }>;

/**
 * La rubrique Mémoire d'un bot : la mémoire de son runtime, et elle seule.
 * Relue à chaque ouverture ; sans profil géré ou sans hôte capable, l'écran
 * dit pourquoi il n'y a rien à montrer.
 */
export function BotMemoryPanel({ bot, open }: { bot: BotDto; open: boolean }) {
  const { t } = useT();
  const auth = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe, enabled: open });
  const runtime = useQuery({
    queryKey: queryKeys.botRuntimeMemory(bot.id),
    queryFn: () => api.botRuntimeMemory(bot.id),
    enabled: open,
    refetchInterval: open ? 10_000 : false,
  });
  if (runtime.isPending) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label={t("botMemory.loading")}>
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (runtime.isError) {
    return (
      <p className="text-sm text-destructive-text" role="alert">
        {runtime.error instanceof ApiError ? runtime.error.message : t("botMemory.failed")}
      </p>
    );
  }
  if (runtime.data.available) {
    return <BotRuntimeMemoryPanel bot={bot} memory={runtime.data} canManage={auth.data?.session.canWrite === true} />;
  }
  const reasonKey = runtime.data.reason === "no_profile"
    ? "botMemory.runtimeNoProfile"
    : runtime.data.reason === "runtime_missing"
      ? "botMemory.runtimeMissing"
      : "botMemory.runtimeFeatureMissing";
  return <p className="text-sm text-muted-foreground" role="status">{t(reasonKey)}</p>;
}

/**
 * La mémoire d'un bot à PROFIL GÉRÉ : celle du runtime, et elle seule.
 *
 * Ce que l'écran montre est `MEMORY.md` / `USER.md` du profil, lus par le
 * magasin Hermes sur l'hôte : les entrées, les caractères consommés contre
 * les plafonds du profil (2 200 / 1 375 par défaut). Ajouter, corriger et
 * oublier passent par ce même magasin (add / replace / remove), donc par les
 * mêmes règles que l'outil `memory` du bot : pas d'approbation, pas de file
 * d'attente ; quand un tiroir est plein, on raccourcit ou on oublie.
 *
 * L'interrupteur est le toolset `memory` du profil : coupé, le bot n'a aucune
 * mémoire et le sait (bloc runtime du worker).
 */
function BotRuntimeMemoryPanel({
  bot,
  memory,
  canManage,
}: {
  bot: BotDto;
  memory: RuntimeMemory;
  canManage: boolean;
}) {
  const { t, formatNumber } = useT();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [target, setTarget] = useState<RuntimeMemoryTarget>("memory");
  const [editing, setEditing] = useState<{ target: RuntimeMemoryTarget; entry: string; value: string } | null>(null);
  const [brief, setBrief] = useState("");
  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.botRuntimeMemory(bot.id) });

  const write = useMutation({
    mutationFn: (input: Parameters<typeof api.writeBotRuntimeMemory>[1]) => api.writeBotRuntimeMemory(bot.id, input),
    onSuccess: async (next) => {
      queryClient.setQueryData(queryKeys.botRuntimeMemory(bot.id), next);
      setDraft("");
      setEditing(null);
      await invalidate();
    },
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.setBotToolset(bot.id, "memory", enabled),
    onSuccess: async () => {
      await invalidate();
      await queryClient.invalidateQueries({ queryKey: queryKeys.botCapabilities(bot.id) });
    },
  });
  const saveBrief = useMutation({
    mutationFn: (context: string) => api.updateSection(bot.sectionId, { context }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.roster });
    },
  });

  const trimmed = draft.trim();
  const error = write.error ?? toggle.error;
  const drawers: Array<{ target: RuntimeMemoryTarget; title: string; help: string }> = [
    { target: "memory", title: t("botMemory.drawerProject"), help: t("botMemory.drawerProjectHelp") },
    { target: "user", title: t("botMemory.drawerUser"), help: t("botMemory.drawerUserHelp") },
  ];
  const section = roster.data?.sections.find((candidate) => candidate.id === bot.sectionId);
  const total = memory.entries.memory.length + memory.entries.user.length;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("botMemory.runtimeIntro")}</p>

      <section className="space-y-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5" aria-live="polite" aria-atomic="true">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">{t("botMemory.runtimeSwitchTitle")}</h3>
            <p className="text-xs text-muted-foreground">
              {memory.enabled ? t("botMemory.runtimeSwitchOn", { count: total }) : t("botMemory.runtimeSwitchOff")}
            </p>
          </div>
          <Switch
            checked={memory.enabled}
            disabled={!canManage || toggle.isPending}
            aria-label={t("botMemory.runtimeSwitchTitle")}
            onCheckedChange={(enabled) => toggle.mutate(enabled)}
          />
        </div>
        {drawers.map(({ target: drawer, title, help }) => {
          const used = memory.usedChars[drawer];
          const max = memory.limits[drawer];
          const label = t("botMemory.runtimeDrawerUsage", {
            count: memory.entries[drawer].length,
            used: formatNumber(used),
            max: formatNumber(max),
          });
          const percent = max === 0 ? 0 : Math.min(100, (used / max) * 100);
          return (
            <div key={drawer} className="space-y-1">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-xs font-medium">{title}</p>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{label}</span>
              </div>
              <div
                role="progressbar"
                aria-label={title}
                aria-valuemin={0}
                aria-valuemax={max}
                aria-valuenow={used}
                aria-valuetext={label}
                className="h-1.5 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className={cn("h-full rounded-full transition-[width] motion-reduce:transition-none", percent >= 90 ? "bg-warn-700" : "bg-primary")}
                  style={{ width: `${percent}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">{help}</p>
            </div>
          );
        })}
        <p className="text-xs text-muted-foreground">{t("botMemory.runtimeNextRunHelp")}</p>
      </section>

      {canManage ? (
        <section className="space-y-2 rounded-lg border border-border px-3 py-2.5">
          <Label htmlFor="bot-runtime-memory-draft" className="text-sm font-medium">{t("botMemory.addTitle")}</Label>
          <div className="flex gap-2">
            <Input
              id="bot-runtime-memory-draft"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t("botMemory.addPlaceholder")}
              disabled={!memory.enabled}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !trimmed || write.isPending || !memory.enabled) return;
                event.preventDefault();
                write.mutate({ target, action: "add", content: trimmed });
              }}
            />
            <button
              type="button"
              onClick={() => write.mutate({ target, action: "add", content: trimmed })}
              disabled={!trimmed || write.isPending || !memory.enabled}
              className={BUTTON.primary}
            >
              {t("botMemory.add")}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">{t("botMemory.addScope")}</span>
            <Button size="sm" variant={target === "memory" ? "secondary" : "ghost"} onClick={() => setTarget("memory")}>
              {t("botMemory.drawerProject")}
            </Button>
            <Button size="sm" variant={target === "user" ? "secondary" : "ghost"} onClick={() => setTarget("user")}>
              {t("botMemory.drawerUser")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("botMemory.runtimeHowItWorks")}</p>
        </section>
      ) : (
        <p className="text-xs text-muted-foreground">{t("botMemory.readOnly")}</p>
      )}
      {error ? (
        <p className="text-xs text-destructive-text" role="alert">
          {error instanceof ApiError ? error.message : t("botMemory.failed")}
        </p>
      ) : null}
      {write.data?.available && write.data.message && !error ? (
        <p className="text-xs text-muted-foreground" aria-live="polite">{write.data.message}</p>
      ) : null}

      {drawers.map(({ target: drawer, title }) => {
        const entries = memory.entries[drawer];
        return (
          <section key={drawer} className="space-y-2">
            <h3 className="text-sm font-medium">
              {title}
              <span className="ml-2 text-xs font-normal tabular-nums text-muted-foreground">{entries.length}</span>
            </h3>
            {entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("botMemory.runtimeDrawerEmpty")}</p>
            ) : (
              <ul className="space-y-1.5" aria-label={title}>
                {entries.map((entry) => {
                  const isEditing = editing?.target === drawer && editing.entry === entry;
                  return (
                    <li key={entry} className="rounded-lg border border-border px-3 py-2">
                      {isEditing ? (
                        <div className="space-y-2">
                          <Label htmlFor={`bot-runtime-memory-edit-${drawer}`} className="sr-only">{t("botMemory.editLabel")}</Label>
                          <Input
                            id={`bot-runtime-memory-edit-${drawer}`}
                            value={editing.value}
                            autoFocus
                            onChange={(event) => setEditing({ ...editing, value: event.target.value })}
                          />
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={!editing.value.trim() || editing.value.trim() === entry || write.isPending}
                              onClick={() => write.mutate({ target: drawer, action: "replace", oldText: entry, content: editing.value.trim() })}
                              className={BUTTON.primary}
                            >
                              {t("botMemory.save")}
                            </button>
                            <button type="button" onClick={() => setEditing(null)} className={BUTTON.small}>{t("botMemory.cancelEdit")}</button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start justify-between gap-3">
                          <p className="text-sm">{entry}</p>
                          {canManage ? (
                            <div className="flex shrink-0 gap-1">
                              <button
                                type="button"
                                disabled={write.isPending}
                                onClick={() => setEditing({ target: drawer, entry, value: entry })}
                                className={BUTTON.small}
                              >
                                {t("botMemory.edit")}
                              </button>
                              <button
                                type="button"
                                disabled={write.isPending}
                                onClick={() => write.mutate({ target: drawer, action: "remove", oldText: entry })}
                                className={BUTTON.small}
                              >
                                {t("botMemory.delete")}
                              </button>
                            </div>
                          ) : null}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}

      <details className="rounded-lg border border-border/60 bg-surface-sunken/40 px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t("botMemory.runtimeWhereTitle")}
        </summary>
        <p className="mt-2 text-xs text-muted-foreground">{t("botMemory.runtimeWhereBody", { profile: memory.profile })}</p>
        {canManage && section ? (
          <div className="mt-3 space-y-1.5">
            <Label htmlFor="bot-runtime-memory-team-brief">{t("botMemory.teamBriefTitle")}</Label>
            <textarea
              id="bot-runtime-memory-team-brief"
              value={brief || section.context || ""}
              maxLength={SECTION_CONTEXT_MAX_CHARS}
              onChange={(event) => setBrief(event.target.value)}
              onBlur={() => {
                const next = brief || section.context || "";
                if (next !== (section.context ?? "")) saveBrief.mutate(next);
              }}
              placeholder={t("botMemory.teamBriefPlaceholder")}
              className="scrollbar-subtle min-h-20 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <p className="text-xs text-muted-foreground">{t("botMemory.teamBriefHelp")}</p>
          </div>
        ) : null}
      </details>
    </div>
  );
}
