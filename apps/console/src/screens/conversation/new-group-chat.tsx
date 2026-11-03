import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconUsersGroup, IconX } from "@tabler/icons-react";
import type { BotDto, GroupDto } from "@openedbot/contracts-api";
import { GROUP_MEMBERS_MAX } from "@openedbot/contracts-api";
import { cn, toast } from "@openedbot/browser-ui-kit";
import { visibleRosterItems } from "@/lib/thread/thread-visibility";
import { ApiError, api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { BotFace } from "../../components/bot-face";
import { Composer } from "../../components/composer";

/** Le nom d'un groupe créé ici : ses membres, « Designer, Dev et Recherche » (100 caractères au plus, la limite de l'API). */
export function groupNameFor(names: ReadonlyArray<string>, locale: string): string {
  const joined = new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names);
  return joined.length <= 100 ? joined : `${joined.slice(0, 99)}…`;
}

type Option = { kind: "create" } | { kind: "bot"; bot: BotDto };

/** Les choix du menu « À : » : créer le groupe dès deux destinataires, puis les bots restants qui correspondent. */
export function recipientOptions(bots: ReadonlyArray<BotDto>, chosen: ReadonlyArray<string>, query: string): Option[] {
  const needle = query.trim().toLocaleLowerCase();
  const matches = bots.filter((bot) => !chosen.includes(bot.id)
    && (!needle || bot.name.toLocaleLowerCase().includes(needle) || bot.slug.toLocaleLowerCase().includes(needle)));
  const options: Option[] = matches.map((bot) => ({ kind: "bot", bot }));
  return chosen.length >= 2 && !needle ? [{ kind: "create" }, ...options] : options;
}

/**
 * Une nouvelle conversation, le `NewChatBar` de Grok Bot : en haut, « À : »
 * et les bots choisis en pastilles ; en bas, le composer. Un seul bot :
 * le message part dans son fil. Deux à six : le groupe naît au premier
 * message (ou par « Créer la conversation de groupe »), nommé d'après ses
 * membres ; ni formulaire ni nom à inventer.
 *
 * Un nouvel essai après un envoi raté réutilise le groupe déjà créé et la
 * même clé d'idempotence : pas de doublon.
 */
export function NewGroupChatScreen({ initialIds = [] }: { initialIds?: string[] }) {
  const { t, locale } = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster });
  const bots = useMemo(
    () => visibleRosterItems(roster.data?.bots ?? []).filter((bot) => !bot.archivedAt),
    [roster.data?.bots],
  );
  const [ids, setIds] = useState<string[]>(initialIds);
  const [query, setQuery] = useState("");
  const [listOpen, setListOpen] = useState(true);
  const [active, setActive] = useState(0);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Le groupe créé et la clé du message, gardés tant que les destinataires ne changent pas.
  const attempt = useRef<{ members: string; group: GroupDto | null; key: string } | null>(null);

  const chosen = ids.map((id) => bots.find((bot) => bot.id === id)).filter((bot): bot is BotDto => bot !== undefined);
  const options = recipientOptions(bots, ids, query);
  const activeIndex = Math.min(active, Math.max(options.length - 1, 0));
  const tooMany = chosen.length > GROUP_MEMBERS_MAX;

  const add = (botId: string) => {
    setIds((current) => (current.includes(botId) ? current : [...current, botId]));
    setQuery("");
    setActive(0);
    input.current?.focus();
  };
  const remove = (botId: string) => {
    setIds((current) => current.filter((id) => id !== botId));
    input.current?.focus();
  };
  const close = () => {
    if (window.history.length > 1) window.history.back();
    else void navigate({ to: "/" });
  };

  const attemptFor = (members: string) => {
    if (attempt.current?.members !== members) attempt.current = { members, group: null, key: crypto.randomUUID() };
    return attempt.current;
  };

  /** Crée le groupe (une seule fois) puis, s'il y a un texte, l'y envoie ; sinon ouvre le groupe. */
  const start = async (text: string) => {
    if (pending || chosen.length === 0 || tooMany) return;
    setPending(true);
    try {
      if (chosen.length === 1) {
        const bot = chosen[0]!;
        if (text) await api.sendMessage(bot.threadId, text, [], attemptFor(bot.id).key);
        await queryClient.invalidateQueries({ queryKey: queryKeys.thread(bot.threadId) });
        void navigate({ to: "/bot/$botId", params: { botId: bot.id } });
        return;
      }
      const current = attemptFor(chosen.map((bot) => bot.id).join(","));
      if (!current.group) {
        try {
          current.group = await api.createGroup({
            name: groupNameFor(chosen.map((bot) => bot.name), locale),
            memberIds: chosen.map((bot) => bot.id),
          });
        } catch (error) {
          toast.error(error instanceof ApiError ? error.message : t("groups.newChat.createFailed"));
          return;
        }
        await queryClient.invalidateQueries({ queryKey: queryKeys.roster });
      }
      if (text) await api.sendMessage(current.group.threadId, text, [], current.key);
      void navigate({ to: "/g/$groupId", params: { groupId: current.group.id } });
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : t("groups.newChat.sendFailed"));
    } finally {
      setPending(false);
    }
  };

  const pick = (option: Option | undefined) => {
    if (!option) return;
    if (option.kind === "create") void start("");
    else add(option.bot.id);
  };

  const onKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setListOpen(true);
      if (options.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + step + options.length) % options.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (listOpen) pick(options[activeIndex]);
    } else if (event.key === "Escape") {
      if (listOpen) {
        event.preventDefault();
        event.stopPropagation();
        setListOpen(false);
      }
    } else if (event.key === "Backspace" && query === "" && ids.length > 0) {
      setIds((current) => current.slice(0, -1));
    }
  };

  const names = chosen.map((bot) => bot.name);
  const disabledReason = chosen.length === 0 ? t("groups.newChat.pickOne") : tooMany ? t("groups.newChat.tooMany") : undefined;
  const listId = "new-chat-recipients";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <h1 className="sr-only">{t("groups.newChat.title")}</h1>
      <div className="relative flex min-h-12 shrink-0 items-center gap-2 border-b border-foreground/8 px-4 py-2">
        <span className="shrink-0 text-[13px] text-muted-foreground">{t("groups.newChat.to")}</span>
        <ul aria-label={t("groups.newChat.recipients")} className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {chosen.map((bot) => (
            <li key={bot.id} className="flex h-6 items-center gap-1 rounded-full bg-[var(--btn-veil-hover)] ps-1 pe-0.5 text-[13px] text-foreground">
              <BotFace name={bot.name} seed={bot.id} face={bot.face} animated={false} className="size-4" />
              <span className="max-w-40 truncate">{bot.name}</span>
              <button
                type="button"
                aria-label={t("groups.newChat.remove", { name: bot.name })}
                onClick={() => remove(bot.id)}
                className="inline-flex size-5 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <IconX aria-hidden className="size-3" />
              </button>
            </li>
          ))}
          <li className="min-w-40 flex-1">
            <input
              ref={input}
              autoFocus
              role="combobox"
              aria-expanded={listOpen}
              aria-controls={listId}
              aria-activedescendant={listOpen && options.length ? `${listId}-${activeIndex}` : undefined}
              aria-label={t("groups.newChat.placeholder")}
              placeholder={chosen.length ? "" : t("groups.newChat.placeholder")}
              value={query}
              onChange={(event) => { setQuery(event.target.value); setActive(0); setListOpen(true); }}
              onFocus={() => setListOpen(true)}
              onBlur={() => setListOpen(false)}
              onKeyDown={onKey}
              className="h-7 w-full border-0 bg-transparent p-0 text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </li>
        </ul>
        <button
          type="button"
          aria-label={t("groups.newChat.close")}
          onClick={close}
          className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-[var(--btn-veil-hover)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <IconX aria-hidden className="size-3.5" />
        </button>

        {listOpen ? (
          <ul
            id={listId}
            role="listbox"
            aria-label={t("groups.newChat.recipients")}
            className="absolute top-full left-4 z-30 mt-1 max-h-[min(28rem,60dvh)] w-[min(40rem,calc(100%-2rem))] overflow-y-auto rounded-xl border border-foreground/12 bg-popover p-1.5 shadow-[var(--shadow-elevated)]"
          >
            {options.length === 0 ? (
              <li className="px-2 py-2 text-[13px] text-muted-foreground">{t("groups.newChat.noMatch")}</li>
            ) : options.map((option, index) => (
              <li
                key={option.kind === "create" ? "create" : option.bot.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                // `mousedown` : le clic ne doit pas d'abord retirer le focus du champ (et fermer la liste).
                onMouseDown={(event) => { event.preventDefault(); pick(option); }}
                onMouseMove={() => setActive(index)}
                className={cn(
                  "flex h-10 cursor-pointer items-center gap-2 rounded-[10px] px-2 text-[13px] text-foreground",
                  index === activeIndex && "bg-[var(--btn-veil-hover)]",
                )}
              >
                {option.kind === "create" ? (
                  <>
                    <IconUsersGroup aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-medium">{t("groups.newChat.create")}</span>
                  </>
                ) : (
                  <>
                    <BotFace name={option.bot.name} seed={option.bot.id} face={option.bot.face} animated={false} className="size-5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{option.bot.name}</span>
                    {index === activeIndex ? (
                      <span className="shrink-0 text-xs text-muted-foreground">{t("groups.newChat.add")}</span>
                    ) : null}
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="min-h-0 flex-1" />

      <div data-thread-column="" className="flex shrink-0 flex-col">
        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={() => void start(draft.trim()).then(() => undefined)}
          onCancel={() => undefined}
          botName={names.length ? new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names) : t("groups.newChat.title")}
          disabled={chosen.length === 0 || tooMany}
          disabledReason={disabledReason}
          running={false}
          sending={pending}
          showPlugins={false}
        />
      </div>
    </div>
  );
}

/** La route `/g/new?with=<botId>,<botId>` : les bots déjà choisis (depuis le menu d'un bot, l'en-tête d'un fil). */
export function NewGroupChatRoute() {
  const search = useSearch({ strict: false }) as { with?: string };
  const ids = search.with?.split(",").filter(Boolean) ?? [];
  return <NewGroupChatScreen key={search.with ?? ""} initialIds={ids} />;
}
