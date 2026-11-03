import { useState, type ReactNode } from "react";
import { ArrowRight, CircleCheck, CircleDashed, CircleDot, Loader2 } from "lucide-react";
import { cn } from "@openedbot/browser-ui-kit";
import { ObButton } from "@openedbot/browser-ui-kit/components/onboarding";
import type { BotFaceSpec } from "@openedbot/contracts-api";
import { BotFace } from "../../../components/bot-face";
import { useT, type MessageKey } from "../../../lib/i18n";
import { Wordmark } from "../components/wordmark";

/**
 * Étape 0 : l'intro produit, jouée à CHAQUE entrée dans le parcours (l'étape
 * courante n'est pas persistée). Qui a déjà terminé l'accueil n'arrive jamais
 * ici : la route l'écarte plus tôt, sur `completed` (le flag de la personne).
 *
 * Mise en page : héros éditorial à deux colonnes à partir de `lg`, une seule
 * colonne en dessous. À gauche = marque + titre serif + chapô + action ; à
 * droite = une pile de cartes d'activité qui montrent à quoi ressemble le
 * travail partagé entre un humain et ses bots : la chose que l'utilisateur
 * s'apprête à créer. La colonne de droite est une ILLUSTRATION, pas du
 * contenu : masquée sous `lg` pour que le titre et l'action restent le sujet.
 *
 * `onSkip`, quand il est fourni, rend une action secondaire fantôme qui marque
 * l'accueil terminé côté cloud API et emmène directement dans l'espace. Le
 * parcours ne le passe que si au moins un bot existe déjà, sans ça, passer
 * atterrirait dans le vide.
 */
export function StepWelcome({
  onNext,
  onSkip,
}: {
  onNext: () => void | Promise<void>;
  onSkip?: () => void | Promise<void>;
}) {
  const { t } = useT();
  // Quel bouton est en vol : une roue par bouton, les deux désarmés pendant.
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
      {/* Gauche : la prose et l'action */}
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

      {/* Droite : l'illustration. Masquée sous `lg`. En ligne à partir de `lg`,
          `items-stretch` (le défaut) fait prendre aux deux colonnes toute la
          hauteur du conteneur, pour que le fond mat aille d'un bord à l'autre.
          `justify-center` à l'intérieur centre les cartes verticalement, en
          miroir du centrage de la colonne de gauche. */}
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
 * Une journée dans un espace de travail à plusieurs bots. Cinq cartes
 * d'activité tissées autour de trois fils partagés (openedbot-42 revient trois fois)
 * pour qu'on VOIE des bots se référer au travail les uns des autres : la thèse
 * « un seul espace, un contexte partagé », rendue concrète.
 *
 * Les cartes portent de légères rotations et décalages pour évoquer une pile
 * posée à la main plutôt qu'un fil bien rangé, ce qui répond à l'esthétique
 * éditoriale de la colonne de gauche.
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
  /** Les visages de l'illustration sont écrits en dur : ces bots n'existent
   *  pas encore, et une tête tirée au sort à chaque rendu ferait clignoter la
   *  pile à chaque frappe dans la colonne d'à côté. */
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
        // Survol décoratif : la carte se lève, se redresse, son ombre
        // s'épaissit. Elles ne sont pas cliquables, c'est un vernis d'ambiance
        // pour que l'illustration ait l'air d'une vraie interface plutôt que
        // d'une capture d'écran plate.
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

/** Le pied d'état d'une carte : un statut, éventuellement une heure. */
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
