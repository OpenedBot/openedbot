import { Hono } from "hono";
import {
  GLOBAL_SEARCH_LIMITS,
  finalizeGlobalSearchSnippet,
  globalSearchSnippet,
  globalSearchVisibleMessageText,
  type GlobalSearchHitDto,
  type GlobalSearchPageDto,
} from "@openedbot/conversation/domain/global-search";
import type { MentionableBot } from "@openedbot/roster/domain/mentions";
import type { MessageContent } from "@openedbot/contracts-api";
import type { AppVariables } from "../identity/auth";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { HttpError } from "../../interfaces/http/http-error";
import { readOperatorProfile } from "@openedbot/identity/sql/operator-profile";

type SearchCandidate = {
  kind: "conversation" | "message";
  threadId: string;
  messageId: string | null;
  role: "user" | "assistant" | null;
  content: MessageContent | null;
  botSlug: string | null;
  groupId: string | null;
  conversationName: string;
  authorName: string | null;
  searchText: string;
  occurredAt: Date | string;
};

export function readGlobalSearchQuery(value: string | undefined): string {
  const query = (value ?? "").trim();
  if (query.length > GLOBAL_SEARCH_LIMITS.maxQueryChars) {
    throw new HttpError(400, "SEARCH_QUERY_TOO_LONG", "La recherche est trop longue.");
  }
  return query;
}

export function readGlobalSearchLimit(value: string | undefined): number {
  if (value === undefined) return GLOBAL_SEARCH_LIMITS.defaultResults;
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new HttpError(400, "SEARCH_LIMIT_INVALID", "La limite de recherche est invalide.");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > GLOBAL_SEARCH_LIMITS.maxResults) {
    throw new HttpError(400, "SEARCH_LIMIT_INVALID", "La limite de recherche est invalide.");
  }
  return limit;
}

export function isGlobalSearchSchemaMissing(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const details = error as Error & { code?: unknown; errno?: unknown };
  const sqlState = details.errno ?? details.code;
  return sqlState === "42883" && (
    error.message.includes("ohb_visible_message_search_text") ||
    error.message.includes("ohb_global_search_normalize")
  );
}

export function searchRoutes(db: Db): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/search", async (context) => {
    const auth = context.get("auth");
    const query = readGlobalSearchQuery(context.req.query("q"));
    const limit = readGlobalSearchLimit(context.req.query("limit"));
    if (!query) return context.json<GlobalSearchPageDto>({ hits: [] });
    const candidateLimit = Math.min(200, Math.max(40, limit * 5));

    try {
      const hits = await withTenant(db, auth.organizationId, async (tx) => {
        const [mentionables, operatorProfile, candidates] = await Promise.all([
          tx<MentionableBot[]>`
            select id, name, slug, face from bots
             where organization_id = ${auth.organizationId}
             order by id
          `,
          readOperatorProfile(tx, auth.organizationId),
          tx<SearchCandidate[]>`
            with search_query as (
              select plainto_tsquery(
                'simple'::regconfig,
                public.ohb_global_search_normalize(${query})
              ) as value
            ), candidates as (
              select 'conversation'::text as kind,
                     thread.id as "threadId", null::uuid as "messageId", null::text as role,
                     null::jsonb as content, bot.slug as "botSlug", thread.group_id as "groupId",
                     thread.title as "conversationName",
                     null::text as "authorName", thread.title as "searchText",
                     thread.updated_at as "occurredAt"
                from threads thread
                left join bots bot on bot.organization_id = thread.organization_id and bot.id = thread.bot_id
                cross join search_query
               where thread.organization_id = ${auth.organizationId}
                 -- Fils de service (brouillon de persona) : titrés du nom du bot,
                 -- sans bulle. Une recherche par nom ne doit pas les ouvrir.
                 and coalesce(thread.hermes_session_id, '') not like '%:persona-draft:%'
                 and to_tsvector(
                   'simple'::regconfig,
                   public.ohb_global_search_normalize(coalesce(thread.title, ''))
                 ) @@ search_query.value
                 and not exists (
                   select 1 from thread_hides hidden
                    where hidden.organization_id = thread.organization_id
                      and hidden.thread_id = thread.id and hidden.user_id = ${auth.userId}
                 )
              union all
              select 'message'::text as kind,
                     thread.id as "threadId", message.id as "messageId", message.role,
                     message.content, bot.slug as "botSlug", thread.group_id as "groupId",
                     thread.title as "conversationName",
                     coalesce(message.original_author_name, author.name) as "authorName",
                     public.ohb_visible_message_search_text(message.content) as "searchText",
                     message.created_at as "occurredAt"
                from messages message
                join threads thread
                  on thread.organization_id = message.organization_id and thread.id = message.thread_id
                join thread_message_counters counter
                  on counter.organization_id = message.organization_id and counter.thread_id = message.thread_id
                left join bots bot on bot.organization_id = thread.organization_id and bot.id = thread.bot_id
                left join bots author
                  on author.organization_id = message.organization_id and author.id = message.author_bot_id
                cross join search_query
               where message.organization_id = ${auth.organizationId}
                 and message.sequence >= greatest(
                   0::bigint,
                   counter.next_sequence - ${GLOBAL_SEARCH_LIMITS.mountedMessagesPerThread}::bigint
                 )
                 and to_tsvector(
                   'simple'::regconfig,
                   public.ohb_visible_message_search_text(message.content)
                 ) @@ search_query.value
                 and not exists (
                   select 1 from thread_hides hidden
                    where hidden.organization_id = thread.organization_id
                      and hidden.thread_id = thread.id and hidden.user_id = ${auth.userId}
                 )
            )
            select * from candidates
             order by "occurredAt" desc, "threadId" asc, "messageId" asc nulls first
             limit ${candidateLimit}
          `,
        ]);

        const operatorUsername = operatorProfile?.username ?? null;
        const results: GlobalSearchHitDto[] = [];
        for (const candidate of candidates) {
          const text = candidate.kind === "message" && candidate.content && candidate.role
            ? globalSearchVisibleMessageText(candidate.content, candidate.role, {
                mentionables,
                operatorUsername,
              })
            : candidate.searchText;
          const excerpt = globalSearchSnippet(text, query);
          if (!excerpt) continue;
          const highlighted = finalizeGlobalSearchSnippet(excerpt, query);
          results.push({
            kind: candidate.kind,
            threadId: candidate.threadId,
            targetId: candidate.messageId ? `message:${candidate.messageId}` : null,
            botSlug: candidate.botSlug,
            groupId: candidate.groupId,
            conversationName: candidate.conversationName,
            role: candidate.role,
            authorName: candidate.authorName,
            ...highlighted,
            occurredAt: new Date(candidate.occurredAt).toISOString(),
          });
          if (results.length >= limit) break;
        }
        return results;
      });
      return context.json<GlobalSearchPageDto>({ hits });
    } catch (error) {
      if (isGlobalSearchSchemaMissing(error)) {
        throw new HttpError(
          503,
          "DATABASE_MIGRATION_REQUIRED",
          "La recherche globale exige la migration de base de données courante.",
        );
      }
      throw error;
    }
  });

  return routes;
}
