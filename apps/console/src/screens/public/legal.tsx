import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { LegalSlug } from "@openedbot/contracts-api";
import { ApiError, api, queryKeys } from "../../lib/api";
import { appUrl } from "../../lib/platform";
import { useT } from "../../lib/i18n";

const LEGAL_LABELS: Record<LegalSlug, "legal.mentions" | "legal.privacy" | "legal.terms"> = {
  mentions: "legal.mentions",
  privacy: "legal.privacy",
  terms: "legal.terms",
};

const LEGAL_SLUGS: readonly LegalSlug[] = ["mentions", "privacy", "terms"];

/** Public deployment-owned Markdown. Raw HTML is intentionally discarded. */
export function LegalScreen() {
  const { slug: rawSlug } = useParams({ from: "/legal/$slug" });
  const { t } = useT();
  const slug = isLegalSlug(rawSlug) ? rawSlug : null;
  const catalog = useQuery({ queryKey: queryKeys.legalCatalog, queryFn: api.legalCatalog });
  const document = useQuery({
    queryKey: queryKeys.legalDocument(slug ?? "mentions"),
    queryFn: () => api.legalDocument(slug!),
    enabled: slug !== null,
    retry: false,
  });

  if (!slug) return <LegalUnavailable title={t("legal.notFound")} message={t("legal.notFoundDescription")} />;

  const title = t(LEGAL_LABELS[slug]);
  return (
    <main className="scrollbar-subtle flex min-h-0 min-w-0 flex-1 overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-10 sm:px-10">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-6">
          <div>
            <Link to="/" className="text-xs font-medium text-muted-foreground hover:text-foreground">
              {t("legal.backToApp")}
            </Link>
            <h1 className="mt-4 text-2xl font-semibold tracking-tight">{title}</h1>
            <p className="mt-2 max-w-[70ch] text-sm text-muted-foreground">{t("legal.description")}</p>
          </div>
          <nav aria-label={t("legal.navigationLabel")} className="flex flex-wrap gap-2 text-xs">
            {LEGAL_SLUGS.map((candidate) => {
              const available = catalog.data?.documents.find((entry) => entry.slug === candidate)?.available;
              return (
                <Link
                  key={candidate}
                  to="/legal/$slug"
                  params={{ slug: candidate }}
                  aria-current={candidate === slug ? "page" : undefined}
                  className="rounded-md border border-border px-2.5 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground aria-[current=page]:bg-accent aria-[current=page]:text-foreground"
                >
                  {t(LEGAL_LABELS[candidate])}
                  {available === false ? ` · ${t("legal.unavailableShort")}` : ""}
                </Link>
              );
            })}
          </nav>
        </header>

        {document.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">{t("legal.loading")}</p>
        ) : document.error ? (
          <LegalUnavailable
            title={t("legal.unavailable")}
            message={document.error instanceof ApiError && document.error.status === 404
              ? t("legal.notFoundDescription")
              : t("legal.unavailableDescription")}
          />
        ) : (
          <article className="legal-markdown max-w-[78ch] text-sm leading-7 text-foreground">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              skipHtml
              urlTransform={safeMarkdownUrl}
              components={{
                a: ({ href, children }) => {
                  if (!href || !safeMarkdownUrl(href)) return <span>{children}</span>;
                  const external = /^https?:/i.test(href);
                  return (
                    <a href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
                      {children}
                    </a>
                  );
                },
              }}
            >
              {document.data?.content ?? ""}
            </ReactMarkdown>
          </article>
        )}
      </div>
    </main>
  );
}

function LegalUnavailable({ title, message }: { title: string; message: string }) {
  const { t } = useT();
  return (
    <main className="scrollbar-subtle flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-background px-6 py-10">
      <section className="w-full max-w-xl rounded-xl border border-border bg-card p-6">
        <Link to="/" className="text-xs font-medium text-muted-foreground hover:text-foreground">
          {t("legal.backToApp")}
        </Link>
        <h1 className="mt-5 text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{message}</p>
      </section>
    </main>
  );
}

function isLegalSlug(value: string): value is LegalSlug {
  return LEGAL_SLUGS.includes(value as LegalSlug);
}

function safeMarkdownUrl(value: string): string {
  const url = value.trim();
  if (!url || url.startsWith("#")) return url;
  try {
    const parsed = appUrl(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? url : "";
  } catch {
    return "";
  }
}
