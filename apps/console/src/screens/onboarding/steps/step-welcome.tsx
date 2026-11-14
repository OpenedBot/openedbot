import { useState, type ReactNode } from "react";
import { ArrowRight, CircleCheck, CircleDashed, CircleDot, Loader2 } from "lucide-react";
import { cn } from "@openedbot/browser-ui-kit";
import { ObButton } from "@openedbot/browser-ui-kit/components/onboarding";
import type { BotFaceSpec } from "@openedbot/contracts-api";
import { BotFace } from "../../../components/bot-face";
import { useT, type MessageKey } from "../../../lib/i18n";
import { Wordmark } from "../components/wordmark";

/**
 * Step 0: the product intro, played on EVERY entry into the flow (the current
 * step is not persisted). Whoever has already finished the welcome never arrives
 * here: the route turns them away earlier, on `completed` (the person's flag).
 *
 * Layout: an editorial hero in two columns from `lg`, a single
 * column below. On the left = mark + serif title + standfirst + action; on the
 * right = a stack of activity cards that show what
 * work shared between a human and their bots looks like: the thing the user
 * is about to create. The right column is an ILLUSTRATION, not
 * content: hidden below `lg` so the title and the action stay the subject.
 *
 * `onSkip`, when provided, renders a ghost secondary action that marks
 * the welcome finished on the cloud API side and takes one straight into the workspace. The
 * flow passes it only if at least one bot already exists; without that, skipping
 * would land in the void.
 */
export function StepWelcome({
  onNext,
  onSkip,
}: {
  onNext: () => void | Promise<void>;
  onSkip?: () => void | Promise<void>;
}) {
  const { t } = useT();
  // Which button is in flight: one spinner per button, both disarmed meanwhile.
  const [pending, setPending] = useState<"next" | "skip" | null>(null);

  const handleNext = async () => {
    if (pending) return;
    setPending("next");
    try {
      await onNext();
    } finally {
      setPending(null);
    }
  };

  const handleSkip = async () => {
    if (pending || !onSkip) return;
    setPending("skip");
    try {
      await onSkip();
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="scrollbar-subtle animate-onboarding-enter flex h-full min-h-0 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      {/* Left: the prose and the action */}
      <div className="flex min-h-min flex-col lg:min-h-0 lg:flex-1">
        <div className="flex flex-1 flex-col justify-center px-6 py-8 sm:px-10 sm:py-12 md:px-20 lg:px-20 lg:pt-0 lg:pb-12 xl:px-24">
          <div className="flex w-full max-w-[540px] flex-col gap-8">
            <div className="flex items-center gap-2.5">
              <Wordmark className="size-5" />
              <span className="font-serif text-title-lg font-medium tracking-tight">
                {t("onboarding.welcome.wordmark")}
              </span>
            </div>

            <h1 className="text-balance font-serif text-5xl font-medium leading-[1.04] tracking-tight sm:text-6xl">
              {t("onboarding.welcome.headline_line1")}
              <br />
              {t("onboarding.welcome.headline_line2")}{" "}
              <em className="italic text-brand">{t("onboarding.welcome.headline_emphasis")}</em>
            </h1>

            <div className="flex flex-col gap-4">
              <p className="text-title leading-relaxed text-foreground">
                {t("onboarding.welcome.lede")}
              </p>
              <p className="text-body leading-relaxed text-muted-foreground">
                {t("onboarding.welcome.lede_desktop")}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <ObButton size="lg" onClick={handleNext} disabled={pending !== null}>
                {pending === "next" && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("onboarding.welcome.start_exploring")}
                <ArrowRight className="h-4 w-4" />
              </ObButton>
              {onSkip && (
                <ObButton
                  size="lg"
                  variant="ghost"
                  onClick={handleSkip}
                  disabled={pending !== null}
                >
                  {pending === "skip" && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t("onboarding.welcome.skip_existing")}
                </ObButton>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Right: the illustration. Hidden below `lg`. Inline from `lg`,
          `items-stretch` (the default) makes both columns take the container's full
          height, so the matte background goes from one edge to the other.
          `justify-center` inside centers the cards vertically, mirroring
          the centering of the left column. */}
      <div className="hidden border-l bg-muted/40 lg:flex lg:flex-1 lg:flex-col lg:overflow-hidden">
        <div className="flex flex-1 flex-col items-center justify-center gap-7 px-8 py-8">
          <p className="max-w-[440px] text-balance text-center font-serif text-body-lg italic leading-snug text-muted-foreground">
            {t("onboarding.welcome.illustration_caption")}
          </p>
          <WelcomeIllustration />
        </div>
      </div>
    </div>
  );
}

/**
 * A day in a workspace with several bots. Five activity
 * cards woven around three shared threads (openedbot-42 comes back three times)
 * so one SEES bots refer to one another's work: the thesis
 * "one workspace, a shared context", made concrete.
 *
 * The cards carry slight rotations and offsets to suggest a stack
 * set down by hand rather than a neatly filed thread, which answers the editorial
 * aesthetic of the left column.
 */
function WelcomeIllustration() {
  const { t } = useT();
  return (
    <div className="flex w-full max-w-[460px] flex-col gap-3">
      <MockActivityCard
        actor={{
          kind: "user",
          name: t("onboarding.welcome.illustration.card1_actor_name"),
          initial: t("onboarding.welcome.illustration.card1_actor_initial"),
        }}
        threadId="openedbot-42"
        content={
          <>
            <Mention>{t("onboarding.welcome.illustration.card1_mention_content")}</Mention>
            {t("onboarding.welcome.illustration.card1_body_prefix")}
            <Mention>{t("onboarding.welcome.illustration.card1_mention_research")}</Mention>
            {t("onboarding.welcome.illustration.card1_body_suffix")}
          </>
        }
      />
      <MockActivityCard
        className="-translate-x-5 -rotate-[1.2deg]"
        actor={{
          kind: "bot",
          name: t("onboarding.welcome.illustration.card2_actor_name"),
          face: { palette: "agrume", shape: "goutte", eyes: "malicieux", mouth: "sourire" },
        }}
        threadId="openedbot-42"
        content={t("onboarding.welcome.illustration.card2_body")}
        status="in_progress"
      />
      <MockActivityCard
        className="translate-x-8 rotate-[1.6deg]"
        actor={{
          kind: "bot",
          name: t("onboarding.welcome.illustration.card3_actor_name"),
          face: { palette: "lilas", shape: "slime", eyes: "surprise", mouth: "grand-sourire" },
        }}
        threadId="openedbot-38"
        content={t("onboarding.welcome.illustration.card3_body")}
        status="done"
        timestamp={t("onboarding.welcome.illustration.card3_timestamp")}
      />
      <MockActivityCard
        className="-translate-x-6 -rotate-[0.8deg]"
        actor={{
          kind: "bot",
          name: t("onboarding.welcome.illustration.card4_actor_name"),
          face: { palette: "menthe", shape: "disque", eyes: "neutre", mouth: "ligne" },
        }}
        threadId="openedbot-42"
        content={t("onboarding.welcome.illustration.card4_body")}
        status="in_review"
      />
      <MockActivityCard
        className="translate-x-6 rotate-[1deg]"
        actor={{
          kind: "bot",
          name: t("onboarding.welcome.illustration.card5_actor_name"),
          face: { palette: "ocean", shape: "coussin", eyes: "joie", mouth: "sourire" },
        }}
        threadId="openedbot-35"
        content={
          <>
            {t("onboarding.welcome.illustration.card5_body_prefix")}
            <Mention>{t("onboarding.welcome.illustration.card5_mention_you")}</Mention>
            {t("onboarding.welcome.illustration.card5_body_suffix")}
          </>
        }
        status="done"
        timestamp={t("onboarding.welcome.illustration.card5_timestamp")}
      />
    </div>
  );
}

type ActivityActor =
  | { kind: "user"; name: string; initial: string }
  /** The illustration's faces are hardcoded: these bots do not exist
   *  yet, and a head drawn at random on every render would make the
   *  stack flicker on every keystroke in the column beside it. */
  | { kind: "bot"; name: string; face: BotFaceSpec };

type MockStatus = "in_progress" | "done" | "in_review";

function MockActivityCard({
  actor,
  threadId,
  content,
  status,
  timestamp,
  className,
}: {
  actor: ActivityActor;
  threadId: string;
  content: ReactNode;
  status?: MockStatus;
  timestamp?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-card px-4 py-3.5 shadow-sm",
        // Decorative hover: the card lifts, straightens, its shadow
        // thickens. They are not clickable, it is an atmosphere varnish
        // so the illustration looks like a real interface rather than
        // a flat screenshot.
        "transition-all duration-200 ease-out will-change-transform",
        "hover:-translate-y-0.5 hover:rotate-0 hover:shadow-md",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <MockAvatar actor={actor} />
          <span className="truncate text-body font-medium text-foreground">{actor.name}</span>
        </div>
        <span className="shrink-0 font-mono text-micro text-muted-foreground">{threadId}</span>
      </div>

      <p className="mt-2.5 text-body leading-snug text-foreground">{content}</p>

      {status && <StatusFooter status={status} timestamp={timestamp} />}
    </div>
  );
}

function MockAvatar({ actor }: { actor: ActivityActor }) {
  if (actor.kind === "user") {
    return (
      <div
        aria-hidden
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-foreground text-micro font-semibold text-background"
      >
        {actor.initial}
      </div>
    );
  }
  return (
    <div
      aria-hidden
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-muted/40 text-foreground"
    >
      <BotFace name={actor.name} seed={actor.name} face={actor.face} className="h-4 w-4" />
    </div>
  );
}

/** A card's status foot: a status, possibly a time. */
const STATUS_CONFIG: Record<MockStatus, { icon: typeof CircleCheck; tone: string; labelKey: MessageKey }> = {
  in_progress: {
    icon: CircleDashed,
    tone: "text-warn-700",
    labelKey: "onboarding.welcome.illustration.status_in_progress",
  },
  in_review: {
    icon: CircleDot,
    tone: "text-info-700",
    labelKey: "onboarding.welcome.illustration.status_in_review",
  },
  done: {
    icon: CircleCheck,
    tone: "text-pos-700",
    labelKey: "onboarding.welcome.illustration.status_done",
  },
};

function StatusFooter({ status, timestamp }: { status: MockStatus; timestamp?: string }) {
  const { t } = useT();
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;
  return (
    <div className="mt-3 flex items-center gap-2 text-caption">
      <span className={cn("flex items-center gap-1.5 font-medium", config.tone)}>
        <Icon
          aria-hidden
          className={cn("h-3.5 w-3.5", status === "in_progress" && "animate-pulse")}
        />
        {t(config.labelKey)}
      </span>
      {timestamp && (
        <>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{timestamp}</span>
        </>
      )}
    </div>
  );
}

function Mention({ children }: { children: ReactNode }) {
  return <span className="font-medium text-brand">{children}</span>;
}
