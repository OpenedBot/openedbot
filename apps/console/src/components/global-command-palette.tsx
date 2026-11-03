import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  IconBrain,
  IconInbox,
  IconLayoutDashboard,
  IconMessageSearch,
  IconPlugConnected,
  IconRobot,
  IconServer,
  IconSettings,
  IconShieldCheck,
  IconUsersGroup,
} from "@tabler/icons-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  Dialog,
} from "@openedbot/browser-ui-kit";
import { visibleRosterItems } from "@/lib/thread/thread-visibility";
import { api, queryKeys } from "../lib/api";
import { useT } from "../lib/i18n";
import { searchHitMeta } from "../lib/thread/search-hit-meta";
import { useOpenSettings } from "../lib/shell/settings-overlay";

type CommandIcon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

/**
 * Palette globale des routes authentifiées.
 *
 * Les créations restent volontairement dans `BoardSidebar`: leurs états de
 * dialogue y sont privés. Les déclencher ici imposerait soit deux instances de
 * chaque formulaire, soit un clic DOM simulé sur un bouton éventuellement
 * replié. La palette ne fabrique aucun de ces deux couplages : elle navigue vers
 * les conversations et les pages sûres, jusqu'à ce que l'état des dialogues
 * soit remonté dans un contrôleur partagé.
 */
export function GlobalCommandPalette() {
  const { t, locale } = useT();
  const navigate = useNavigate();
  const openSettings = useOpenSettings();
  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const openRef = useRef(open);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebouncedQuery("");
      return;
    }
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 150);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  const globalSearch = useQuery({
    queryKey: ["global-search", debouncedQuery],
    queryFn: () => api.globalSearch(debouncedQuery, 12),
    enabled: open && debouncedQuery.length > 0,
    staleTime: 30_000,
  });

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        event.repeat ||
        event.key.toLocaleLowerCase() !== "k" ||
        (!event.metaKey && !event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }

      // Capture + stopImmediatePropagation neutralisent l'ancien raccourci du
      // filtre de roster sans toucher la sidebar. Dans un autre dialogue, le
      // raccourci est consommé mais n'empile jamais une seconde modale.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!openRef.current && document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      setOpen((current) => !current);
    };

    window.addEventListener("keydown", toggle, { capture: true });
    return () => window.removeEventListener("keydown", toggle, { capture: true });
  }, []);

  // ⌘⇧N / Ctrl+Shift+N : une nouvelle conversation de groupe, le raccourci de Grok Bot.
  useEffect(() => {
    const newGroupChat = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat || event.altKey || !event.shiftKey || (!event.metaKey && !event.ctrlKey)) return;
      if (event.key.toLocaleLowerCase() !== "n") return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      event.preventDefault();
      void navigate({ to: "/g/new" });
    };
    window.addEventListener("keydown", newGroupChat);
    return () => window.removeEventListener("keydown", newGroupChat);
  }, [navigate]);

  const bots = useMemo(
    () => visibleRosterItems(roster.data?.bots ?? []).filter((bot) => !bot.archivedAt),
    [roster.data?.bots],
  );
  const groups = useMemo(
    () => visibleRosterItems(roster.data?.groups ?? []),
    [roster.data?.groups],
  );

  const go = (navigateTo: () => void) => {
    setOpen(false);
    navigateTo();
  };

  const goToSearchHit = (hit: NonNullable<typeof globalSearch.data>["hits"][number]) => {
    if (hit.botSlug) {
      const owner = roster.data?.bots.find((candidate) => candidate.slug === hit.botSlug);
      if (!owner) return;
      const main = hit.threadId === owner.threadId;
      go(() => void navigate({
        to: main ? "/bot/$botId" : "/cs/$botId",
        params: { botId: owner.id },
        search: main
          ? { focus: hit.targetId ?? undefined }
          : { task: hit.threadId, focus: hit.targetId ?? undefined },
      }));
    } else if (hit.groupId) {
      go(() => void navigate({
        to: "/g/$groupId",
        params: { groupId: hit.groupId! },
        search: { focus: hit.targetId ?? undefined },
      }));
    }
  };

  const navigation: Array<{ value: string; label: string; icon: CommandIcon; run: () => void }> = [
    {
      value: "new group chat room bots nouvelle conversation groupe",
      label: t("groups.newChat.title"),
      icon: IconUsersGroup,
      run: () => void navigate({ to: "/g/new" }),
    },
    {
      value: "overview dashboard",
      label: t("commandPalette.overview"),
      icon: IconLayoutDashboard,
      run: () => void navigate({ to: "/" }),
    },
    {
      value: "decisions approvals",
      label: t("commandPalette.decisions"),
      icon: IconShieldCheck,
      run: () => openSettings("/settings/decisions"),
    },
    {
      value: "inbox à traiter approbations à vérifier",
      label: t("commandPalette.inbox"),
      icon: IconInbox,
      run: () => void navigate({ to: "/inbox" }),
    },
    {
      value: "settings preferences",
      label: t("commandPalette.settings"),
      icon: IconSettings,
      run: () => openSettings("/settings"),
    },
    {
      value: "edge runtime hermes",
      label: t("commandPalette.runtime"),
      icon: IconServer,
      run: () => openSettings("/settings/runtime"),
    },
    {
      value: "agents import hermes profiles archive",
      label: t("commandPalette.agents"),
      icon: IconRobot,
      run: () => openSettings("/settings/agents"),
    },
    {
      value: "models providers",
      label: t("commandPalette.models"),
      icon: IconBrain,
      run: () => openSettings("/settings/models"),
    },
    {
      value: "connectors integrations mcp tools",
      label: t("commandPalette.connectors"),
      icon: IconPlugConnected,
      run: () => openSettings("/settings/connectors"),
    },
  ];

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title={t("commandPalette.title")}
      description={t("commandPalette.description")}
      closeLabel={t("common.close")}
      className="max-w-2xl"
      bodyClassName="p-0"
    >
      <Command aria-busy={roster.isPending || globalSearch.isFetching} label={t("commandPalette.placeholder")}>
        <CommandInput
          aria-label={t("commandPalette.placeholder")}
          aria-keyshortcuts="Meta+K Control+K"
          data-dialog-autofocus
          value={query}
          onValueChange={setQuery}
          placeholder={t("commandPalette.placeholder")}
        />
        <CommandList scrollbar="subtle" className="max-h-[min(28rem,60dvh)] py-1">
          <CommandEmpty>{t("commandPalette.empty")}</CommandEmpty>

          {bots.length ? (
            <CommandGroup heading={t("commandPalette.bots")}>
              {bots.map((bot) => (
                <CommandItem
                  key={bot.id}
                  value={`bot ${bot.name} ${bot.slug}`}
                  keywords={[bot.name, bot.slug, bot.description ?? ""]}
                  onSelect={() => go(() => void navigate({ to: "/bot/$botId", params: { botId: bot.id } }))}
                >
                  <IconRobot aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{bot.name}</span>
                  <span className="truncate text-xs text-muted-foreground">@{bot.slug}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}

          {groups.length ? (
            <CommandGroup heading={t("commandPalette.groups")}>
              {groups.map((group) => (
                <CommandItem
                  key={group.id}
                  value={`group ${group.name}`}
                  keywords={[group.name, ...group.members.map((member) => member.name)]}
                  onSelect={() => go(() => void navigate({ to: "/g/$groupId", params: { groupId: group.id } }))}
                >
                  <IconUsersGroup aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{group.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {group.members.map((member) => member.name).join(", ")}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}

          {globalSearch.data?.hits.length ? (
            <CommandGroup heading={t("commandPalette.messages")}>
              {globalSearch.data.hits.map((hit) => {
                const before = hit.snippet.slice(0, hit.matchStart);
                const match = hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength);
                const after = hit.snippet.slice(hit.matchStart + hit.matchLength);
                return (
                  <CommandItem
                    key={`${hit.kind}:${hit.threadId}:${hit.targetId ?? "title"}`}
                    value={`search ${hit.conversationName} ${hit.snippet}`}
                    keywords={[hit.conversationName, hit.authorName ?? "", hit.snippet]}
                    onSelect={() => goToSearchHit(hit)}
                    className="items-start py-2"
                  >
                    <IconMessageSearch aria-hidden className="mt-0.5" />
                    {/* Comme Grok Bot : l'extrait d'abord, le terme en gras,
                        puis qui a écrit à qui et quand. */}
                    <span className="min-w-0 flex-1">
                      <span className="block line-clamp-2 text-sm">
                        {before}
                        {match ? <mark className="bg-transparent font-semibold text-foreground">{match}</mark> : null}
                        {after}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {searchHitMeta(hit, t, locale)}
                      </span>
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ) : null}

          {(bots.length || groups.length || globalSearch.data?.hits.length) ? <CommandSeparator /> : null}
          <CommandGroup heading={t("commandPalette.navigation")}>
            {navigation.map((item) => {
              const Icon = item.icon;
              return (
                <CommandItem key={item.value} value={`${item.value} ${item.label}`} onSelect={() => go(item.run)}>
                  <Icon aria-hidden />
                  <span>{item.label}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </Command>
    </Dialog>
  );
}
