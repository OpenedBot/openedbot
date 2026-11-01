import { useRef, type ReactNode } from "react";
import { cn } from "@openedbot/browser-ui-kit";
import { useScrollFade } from "@openedbot/browser-ui-kit/components/onboarding";
import type { OnboardingStep } from "@/lib/onboarding";
import { StepProgressBar, StepSidebar } from "./step-sidebar";

/**
 * La géométrie des étapes, reprise du bloc ReUI onboarding-3 de Multica pour
 * que les deux panneaux se lisent comme un seul dessin.
 *
 * UNE mesure, pas trois : une étape qui doit en sortir le dit localement
 * plutôt que d'aller chercher une autre valeur globale.
 */
export const STEP_COLUMN = "mx-auto flex min-h-full w-full max-w-[28rem] flex-col";
export const STEP_GUTTER =
  "px-6 pt-8 pb-[max(2rem,var(--ohb-safe-bottom))] sm:px-10 lg:px-14 lg:pt-10 lg:pb-[max(2.5rem,var(--ohb-safe-bottom))]";

/**
 * Le titre d'une étape et sa ligne d'appui.
 *
 * `aria-live` parce que les panneaux PERSISTENT d'une étape à l'autre : un
 * lecteur d'écran ne reçoit aucun événement de navigation en changeant
 * d'étape, c'est donc au titre de s'annoncer.
 */
export function StepHeading({
  title,
  description,
}: {
  title: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      <h1 className="text-balance text-title-lg font-semibold text-foreground">{title}</h1>
      {description ? (
        <p className="text-pretty text-body text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}

/**
 * Les actions de l'étape, épinglées au bas de la colonne.
 *
 * Boutons pleine largeur empilés plutôt qu'une rangée alignée à droite : la
 * colonne fait 28rem, une barre en ligne laisserait l'action principale
 * flotter au milieu de l'écran au lieu d'atterrir là où l'œil finit le
 * formulaire. C'est `mt-auto` contre le `min-h-full` de la colonne qui l'y
 * épingle.
 */
export function StepFooter({
  children,
  hint,
}: {
  children: ReactNode;
  /** Ligne d'état au-dessus des boutons (validation, progression). */
  hint?: ReactNode;
}) {
  return (
    <div className="mt-auto flex flex-col gap-2 pb-2 pt-10">
      {hint ? (
        <p aria-live="polite" className="text-caption text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {children}
    </div>
  );
}

/**
 * Le cadre dans lequel chaque étape se rend : le rail de progression à gauche,
 * le contenu de l'étape qui défile à droite.
 *
 * Il possède la fenêtre, pas seulement un bandeau : c'est ce qui évite aux
 * étapes de répéter le même préambule, y compris le câblage du dégradé de
 * défilement, posé ici une seule fois.
 *
 * La colonne est `min-h-full` DANS un panneau qui défile plutôt que centrée
 * par lui : `items-center` sur un conteneur de défilement rogne le haut de
 * tout ce qui dépasse la fenêtre, et ces étapes débordent sur un écran court.
 */
export function StepShell({
  currentStep,
  onBack,
  backDisabled,
  onStepChange,
  chromeFooter,
  children,
}: {
  currentStep: OnboardingStep;
  onBack?: () => void;
  /** « Organisation » et « Espace de travail » désarment Retour pendant leur enregistrement. */
  backDisabled?: boolean;
  /** Revenir à une étape déjà franchie depuis le rail. */
  onStepChange?: (step: OnboardingStep) => void;
  /** Injecté par le parcours : la sortie « Se déconnecter ». Rendu dans le
   *  chrome visible : le rail à partir de `md`, la barre compacte en dessous. */
  chromeFooter?: ReactNode;
  children: ReactNode;
}) {
  const mainRef = useRef<HTMLElement>(null);
  const fadeStyle = useScrollFade(mainRef);

  return (
    <div className="animate-onboarding-enter flex h-full min-h-0 flex-col bg-background">
      {/* La barre de titre de la coque native : vide et masquée hors d'elle
          (`native-titlebar.css`), elle garde les feux de macOS et les boutons
          de Windows hors du rail, et sert de poignée à la fenêtre. */}
      <div data-onboarding-titlebar="" data-titlebar-drag="" aria-hidden />
      <div className="flex min-h-0 flex-1">
        <StepSidebar
          currentStep={currentStep}
          onBack={onBack}
          backDisabled={backDisabled}
          onStepChange={onStepChange}
          footer={chromeFooter}
        />

        <main
          ref={mainRef}
          style={fadeStyle}
          className={cn("scrollbar-subtle min-h-0 min-w-0 flex-1 overflow-y-auto", STEP_GUTTER)}
        >
          <div className={STEP_COLUMN}>
            <StepProgressBar
              currentStep={currentStep}
              onBack={onBack}
              backDisabled={backDisabled}
              footer={chromeFooter}
            />
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
