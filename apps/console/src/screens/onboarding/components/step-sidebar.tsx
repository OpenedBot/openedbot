import type { ReactNode } from "react";
import { ArrowLeft, Check } from "lucide-react";
import { ONBOARDING_STEP_ORDER, railIndex, type OnboardingStep, type RailStep } from "@/lib/session/onboarding";
import { cn } from "@openedbot/browser-ui-kit";
import {
  DotSphere,
  ObButton,
  Stepper,
  StepperDescription,
  StepperIndicator,
  StepperItem,
  StepperNav,
  StepperSeparator,
  StepperTitle,
} from "@openedbot/browser-ui-kit/components/onboarding";
import { useT } from "../../../lib/i18n";
import { Wordmark } from "./wordmark";

/**
 * Le rail persistant : où en est l'opérateur, et par où revenir.
 *
 * Trois choses valent d'être sues :
 *
 *   - **`dark` posé sur le panneau, pas des utilitaires inversés.** `.dark`
 *     est un simple sélecteur de classe dans notre feuille de tokens :
 *     l'écrire ici redéfinit les propriétés personnalisées POUR CE
 *     sous-arbre. `text-muted-foreground` veut alors dire la bonne chose sur
 *     une surface sombre. Mélanger des `text-background/60` à la main est ce
 *     qui rendait le bouton « Se déconnecter » quasi invisible chez Multica.
 *   - **Ce n'est pas une `tablist`.** Le stepper porté vaut `role="tablist"`
 *     par défaut, chaque déclencheur possédant un `aria-controls` sur un
 *     panneau : juste pour un stepper qui rend ses propres panneaux, faux
 *     ici, où le panneau est une étape routée et ces identifiants
 *     pendouilleraient. On utilise les emplacements présentationnels et on
 *     marque la position par `aria-current="step"`.
 *   - **Seules les étapes franchies sont cliquables.** Avancer exige de jouer
 *     la validation et l'envoi de l'étape courante : sauter en avant depuis le
 *     rail les contournerait. Revenir est toujours sûr.
 */

/**
 * Le travail du rail (où suis-je, et par où revenir) aux largeurs trop
 * étroites pour le rail lui-même. Rendu uniquement sous `md`, là où
 * `StepSidebar` est masqué.
 *
 * Des segments plutôt qu'une reprise de la liste : à 375 px, l'enjeu est de
 * dépenser le moins de hauteur possible, et le nom de l'étape courante plus sa
 * position est ce que la liste communiquait de toute façon. Elle réutilise la
 * même copie `step_nav`, pour n'avoir qu'un endroit à traduire.
 */
export function StepProgressBar({
  currentStep,
  onBack,
  backDisabled,
  footer,
}: {
  currentStep: OnboardingStep;
  onBack?: () => void;
  backDisabled?: boolean;
  /** Le même emplacement que le pied du rail : la sortie « Se déconnecter ».
   *  Il DOIT être répété ici : le rail est masqué à ces largeurs, ce qui
   *  laissait toute étape autre que l'accueil sans issue. */
  footer?: ReactNode;
}) {
  const { t } = useT();
  const currentIndex = railIndex(currentStep);
  const key = ONBOARDING_STEP_ORDER[currentIndex] ?? ONBOARDING_STEP_ORDER[0]!;

  return (
    <div className="mb-6 flex items-center gap-3 md:hidden">
      {onBack ? (
        <ObButton
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          disabled={backDisabled}
          aria-label={t("onboarding.common.back")}
          className="-ml-2 shrink-0"
        >
          <ArrowLeft />
        </ObButton>
      ) : null}
      <span aria-hidden className="flex flex-1 items-center gap-1.5">
        {ONBOARDING_STEP_ORDER.map((stepId, index) => (
          <span
            key={stepId}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors",
              index <= currentIndex ? "bg-foreground" : "bg-border",
            )}
          />
        ))}
      </span>
      <span className="min-w-0 truncate text-caption font-medium text-muted-foreground">
        {t(`onboarding.step_nav.${key}.label`)}
      </span>
      {footer ? <span className="shrink-0">{footer}</span> : null}
    </div>
  );
}

export function StepSidebar({
  currentStep,
  onBack,
  backDisabled,
  onStepChange,
  footer,
}: {
  currentStep: OnboardingStep;
  onBack?: () => void;
  backDisabled?: boolean;
  /** Revenir à une étape déjà franchie. Injecté par le parcours, qui possède
   *  l'ordre des étapes ; absent, le rail est purement indicatif. */
  onStepChange?: (step: OnboardingStep) => void;
  /** Injecté par le parcours : la sortie « Se déconnecter ». Un emplacement
   *  plutôt qu'un rendu direct, pour que ce composant reste présentationnel. */
  footer?: ReactNode;
}) {
  const { t } = useT();
  const currentIndex = railIndex(currentStep);

  return (
    // Masqué sous `md`, où il ne rentre pas : le panneau ne descendait jamais
    // sous 15rem tandis que le panneau de contenu gardait sa gouttière, ce qui
    // laissait ~87 px de formulaire à 375 px. `StepProgressBar` porte la même
    // information, et le bouton Retour de cet en-tête, à ces largeurs.
    <aside data-onboarding-rail="" className="hidden w-[15rem] shrink-0 p-2 md:block md:w-[19rem] md:p-3 lg:w-[22rem] lg:p-4">
      <div className="dark relative isolate flex h-full w-full flex-col overflow-hidden rounded-2xl bg-background px-5 pb-5 text-foreground ring-1 ring-border">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-background">
          <DotSphere
            dotGap={19}
            motion="wave"
            sphereCount={5}
            sphereRadius="20%"
            dotRadiusMax={1.9}
            speed={0.4}
          />
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col pt-5">
          <header className="flex min-h-9 shrink-0 items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2">
              <Wordmark className="size-5 shrink-0" />
              <span className="truncate text-label font-medium text-foreground">
                {t("onboarding.step_nav.wordmark")}
              </span>
            </span>
            {onBack ? (
              <ObButton
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={onBack}
                disabled={backDisabled}
                aria-label={t("onboarding.common.back")}
              >
                <ArrowLeft />
              </ObButton>
            ) : null}
          </header>

          <div className="flex min-h-0 flex-1 items-center justify-center py-10">
            <Stepper
              value={currentIndex + 1}
              orientation="vertical"
              role="group"
              aria-label={t("onboarding.step_nav.label")}
              className="flex w-full flex-col items-start justify-center gap-0"
            >
              <StepperNav className="w-full">
                {ONBOARDING_STEP_ORDER.map((stepId, index) => {
                  const isDone = index < currentIndex;
                  const isCurrent = index === currentIndex;
                  const isLast = index === ONBOARDING_STEP_ORDER.length - 1;
                  const canReturn = isDone && !!onStepChange && !backDisabled;
                  const key: RailStep = stepId;

                  const body = (
                    <>
                      <StepperIndicator
                        className={cn(
                          "mt-0.5 size-4 shrink-0 border-0 bg-transparent ring-1 transition-colors",
                          isDone
                            ? "bg-foreground text-background ring-foreground"
                            : isCurrent
                              ? "text-transparent ring-muted-foreground"
                              : "text-transparent ring-border",
                        )}
                      >
                        {isDone ? (
                          <Check aria-hidden className="size-3" />
                        ) : isCurrent ? (
                          <span aria-hidden className="block size-1.5 rounded-full bg-foreground" />
                        ) : (
                          <span className="sr-only">{index + 1}</span>
                        )}
                      </StepperIndicator>
                      <div className="min-w-0 flex-1 text-left">
                        <StepperTitle
                          className={cn(
                            "transition-colors",
                            isCurrent || isDone ? "text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {t(`onboarding.step_nav.${key}.label`)}
                        </StepperTitle>
                        <StepperDescription className="mt-0.5 max-w-none text-muted-foreground">
                          {t(`onboarding.step_nav.${key}.description`)}
                        </StepperDescription>
                      </div>
                    </>
                  );

                  return (
                    <StepperItem
                      key={stepId}
                      step={index + 1}
                      completed={isDone}
                      className="relative w-full items-start not-last:flex-1"
                      {...(isCurrent ? { "aria-current": "step" as const } : {})}
                    >
                      {canReturn ? (
                        <button
                          type="button"
                          onClick={() => onStepChange(stepId)}
                          className="flex w-full items-start gap-3 rounded-md pb-6 text-left transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {body}
                        </button>
                      ) : (
                        <div
                          className={cn(
                            "flex w-full items-start gap-3 text-left",
                            !isLast && "pb-6",
                          )}
                        >
                          {body}
                        </div>
                      )}

                      {/* Un filet continu DERRIÈRE la rangée plutôt qu'un
                          tronçon entre deux, pour que le rail se lise comme
                          une seule piste. `-order-1` le place sous le contenu. */}
                      {!isLast ? (
                        <StepperSeparator
                          className={cn(
                            "absolute left-2 top-6 -order-1 m-0 w-px -translate-x-1/2",
                            // Le séparateur porté fige une hauteur de 3rem en
                            // vertical, qui dépassait la rangée et traversait
                            // l'indicateur suivant. Même variante, donc
                            // tailwind-merge laisse tomber la leur.
                            "group-data-[orientation=vertical]/stepper-nav:h-[calc(100%-1.75rem)]",
                            isDone ? "bg-muted-foreground" : "bg-border",
                          )}
                        />
                      ) : null}
                    </StepperItem>
                  );
                })}
              </StepperNav>
            </Stepper>
          </div>

          {footer ? (
            <footer className="flex min-h-8 shrink-0 items-end justify-between gap-4">
              {footer}
            </footer>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
