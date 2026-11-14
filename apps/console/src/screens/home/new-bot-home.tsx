import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { composePersona } from "@openedbot/roster/domain/persona";
import { cn, toast, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@openedbot/browser-ui-kit";
import { ApiError, api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { shownPermissionMode, useAutoReviewAvailable } from "../../components/boardui/permission-picker";
import { creationAttempts } from "../../lib/bots/creation-attempts";
import { BotFace } from "../../components/bot-face";
import { SiteHeader } from "../../components/dashboard/site-header";
import { DRAFT_MODEL_DEFAULT, DraftModelPicker, type DraftModelChoice } from "../../components/bot-create/draft-model-picker";
import type { BotCreationRequest } from "../../components/bot-create/creation-request";
import { useBotCreationLaunch } from "../../components/bot-create/use-bot-launch";
import { DEFAULT_CREATION_OPTIONS } from "../../components/bot-create/creation-options";
import { consumeNewBotNameFocus } from "../../lib/bots/use-new-bot";
import {
  HOME_FACE_COLORS,
  HOME_FACE_HEX,
  HOME_FACE_PRESETS,
  HOME_SUGGESTIONS,
  homeFace,
  operatorTimeZone,
  defaultHomeFaceChoice,
  suggestionFaceChoice,
  suggestionRoutine,
  type HomeFaceChoice,
  type HomeSuggestion,
} from "./new-bot-faces";

/** The fields: tertiary background, a barely visible edge, 8 px corners (measured on the reference app). */
const FIELD =
  "w-full rounded-lg border border-border-button-default bg-background-tertiary-default text-base text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus-visible:border-border-focus-ring";
const LABEL = "text-caption-1-medium text-text-secondary";
/** A chosen pill or face: a blue edge, like the focus. */
const PICKED = "border-border-focus-ring";

type Draft = {
  name: string;
  mission: string;
  face: HomeFaceChoice;
  model: DraftModelChoice;
  /** The suggestion the form was filled from: it brings the role and the working rules. */
  suggestion: HomeSuggestion | null;
  /** Its routine is kept: the operator can drop it before creating. */
  withRoutine: boolean;
};

/**
 * The `/` home on desktop: create a bot on the page itself, like the reference app's
 * home. At the center, the face large, two rows of one click (the
 * colour, then the face), the name, what the bot must do and its model;
 * at the bottom, suggestions that fill the form: the cast of openedbot.app,
 * each a whole bot (cat face, role, mission, working rules) and, for
 * Rafale and Sillage, a routine created enabled with it. « Créer le bot »
 * starts like the « Nouveau bot » sheet (`useBotCreationLaunch`): the bot's
 * waiting screen opens at once, the request keeps its replay
 * identifier.
 *
 * Nothing else: no more « Options avancées » (2026-11-02). The job
 * description is composed from the name and the mission, the bot starts with the sheet's safe
 * defaults (`DEFAULT_CREATION_OPTIONS`, the organization's default
 * mode), and its persona, its approval rules or its end notice
 * are changed afterwards on its page.
 */
export function NewBotHome({ empty }: { empty: boolean }) {
  const { t, locale } = useT();
  const autoReview = useAutoReviewAvailable();
  const id = useId();
  const queryClient = useQueryClient();
  const launch = useBotCreationLaunch();
  const assignment = useQuery({ queryKey: queryKeys.runtimeConfiguration, queryFn: api.runtimeConfiguration });
  const fresh = (): Draft => ({
    name: t("newBotDialog.defaultName"),
    mission: "",
    face: defaultHomeFaceChoice(),
    model: DRAFT_MODEL_DEFAULT,
    suggestion: null,
    withRoutine: false,
  });
  const [draft, setDraft] = useState<Draft>(fresh);
  const [sending, setSending] = useState(false);
  useEffect(consumeNewBotNameFocus, []);
  const attempts = useRef(creationAttempts());
  const modelRow = useRef<HTMLDivElement>(null);
  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  const name = draft.name.trim();
  const previewName = name || t("newBotDialog.defaultName");
  const face = homeFace(draft.face);
  const mission = draft.mission.trim();
  // Without the reviewer (plug-in `permissions`) a new bot never starts in Auto.
  const permissionMode = shownPermissionMode(assignment.data?.defaultPermissionMode ?? DEFAULT_CREATION_OPTIONS.permissionMode, autoReview);
  const suggestion = draft.suggestion;
  const role = suggestion ? t(`homeNewBot.suggestion.${suggestion.id}.role`) : "";
  const persona = [
    composePersona({ name: previewName, role: role || null, mission: mission || null }),
    ...(suggestion ? ["", t("homeNewBot.rulesHeading"), t(`homeNewBot.suggestion.${suggestion.id}.rules`)] : []),
  ].join("\n");
  const routine = suggestion?.routine && draft.withRoutine ? suggestion.routine : null;
  const routineName = routine ? t(`homeNewBot.routines.${routine.key}.name`) : "";
  const canCreate = name.length > 0 && !sending;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canCreate) return;
    const { model, provider, effort } = draft.model;
    const content: Omit<BotCreationRequest, "clientRequestId"> = {
      name,
      role,
      mission,
      instructions: persona,
      hermesProfile: null,
      face,
      permissionMode,
      notifyOnFinish: DEFAULT_CREATION_OPTIONS.notifyOnFinish,
      greet: DEFAULT_CREATION_OPTIONS.greet,
      locale,
      copied: model ? { model, ...(effort ? { reasoningEffort: effort } : {}) } : null,
      presetLabel: null,
      provider,
      routine: routine
        ? suggestionRoutine(routine, { name: routineName, message: t(`homeNewBot.routines.${routine.key}.message`) }, operatorTimeZone())
        : null,
    };
    const request: BotCreationRequest = { clientRequestId: attempts.current.idFor(content), ...content };
    // Under the global assignment the worker ignores a bot's own model: a
    // model picked here moves the organization to « per bot », exactly like
    // a pick in the composer (`ThreadModelPicker`), BEFORE the bot exists.
    if (model && assignment.data?.modelAssignmentMode === "global") {
      setSending(true);
      try {
        await api.saveModelAssignmentMode("per_bot");
        void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfiguration });
      } catch (error) {
        toast.error(error instanceof ApiError ? error.message : t("composer.modelSaveFailed"));
        return;
      } finally {
        setSending(false);
      }
    }
    launch(request);
    attempts.current.reset();
    setDraft(fresh());
  };

  return (
    <>
      <SiteHeader
        title={previewName}
        avatar={<BotFace name={previewName} seed="home-draft" face={face} className="size-[18px]" />}
      />
      <div data-new-bot-home="" className="scrollbar-subtle flex min-h-0 flex-1 flex-col overflow-y-auto">
        <form
          onSubmit={(event) => void submit(event)}
          aria-labelledby={`${id}-heading`}
          className="mx-auto flex w-full max-w-[420px] flex-1 flex-col justify-center gap-3 px-4 py-6 sm:px-0"
        >
          <h2 id={`${id}-heading`} className="sr-only">{t(empty ? "homeNewBot.headingFirst" : "homeNewBot.heading")}</h2>
          <div className="flex justify-center pb-3" aria-live="polite">
            <BotFace name={previewName} seed="home-draft" face={face} className="size-[72px]" animated />
          </div>
          <fieldset>
            <legend className="sr-only">{t("homeNewBot.colorLegend")}</legend>
            <div className="flex flex-wrap justify-center gap-1">
              {(["auto", ...HOME_FACE_COLORS] as const).map((color) => {
                const hex = HOME_FACE_HEX.get(color === "auto" ? homeFace({ ...draft.face, color: "auto" }).palette : color);
                const label = color === "auto" ? t("homeNewBot.colorAuto") : t("homeNewBot.color", { color: t(`homeNewBot.colors.${color}`) });
                const picked = draft.face.color === color;
                return (
                  <button
                    key={color}
                    type="button"
                    aria-label={label}
                    title={label}
                    aria-pressed={picked}
                    onClick={() => update({ face: { ...draft.face, color } })}
                    className={cn(
                      "flex size-7 cursor-pointer items-center justify-center rounded-full border outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                      picked ? PICKED : "border-transparent",
                    )}
                  >
                    <span className="size-[18px] rounded-full border border-white/5" style={{ backgroundColor: hex }} />
                  </button>
                );
              })}
            </div>
          </fieldset>
          <fieldset className="pb-1">
            <legend className="sr-only">{t("homeNewBot.faceLegend")}</legend>
            <div className="flex flex-wrap justify-center gap-0.5">
              {HOME_FACE_PRESETS.map((_, index) => {
                const picked = draft.face.preset === index;
                const label = t("homeNewBot.face", { index: index + 1 });
                return (
                  <button
                    // Positions are the identity of this fixed list.
                    key={index}
                    type="button"
                    aria-label={label}
                    title={label}
                    aria-pressed={picked}
                    onClick={() => update({ face: { ...draft.face, preset: index } })}
                    className={cn(
                      "flex size-[33px] cursor-pointer items-center justify-center rounded-lg border outline-none hover:bg-background-secondary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                      picked ? PICKED : "border-transparent",
                    )}
                  >
                    <BotFace name={label} seed={`home-face-${index}`} face={homeFace(draft.face, index)} className="size-6" animated={false} />
                  </button>
                );
              })}
            </div>
          </fieldset>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-name`} className={LABEL}>
              {t("homeNewBot.nameLabel")}
              <span aria-hidden className="ms-0.5 text-destructive-text">*</span>
            </label>
            <input
              id={`${id}-name`}
              data-new-bot-name=""
              value={draft.name}
              maxLength={100}
              required
              autoComplete="off"
              onChange={(event) => update({ name: event.target.value })}
              className={cn(FIELD, "h-8 px-3")}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-mission`} className={LABEL}>{t("homeNewBot.missionLabel")}</label>
            <textarea
              id={`${id}-mission`}
              value={draft.mission}
              maxLength={1_000}
              rows={2}
              onChange={(event) => update({ mission: event.target.value })}
              className={cn(FIELD, "min-h-[66px] resize-y px-3 py-2")}
            />
          </div>
          {routine ? (
            <div data-new-bot-routine="" className="flex items-center justify-between gap-2 rounded-lg border border-border-button-default/60 ps-3 pe-1 py-1">
              <span className="min-w-0 truncate text-caption-1-medium text-text-secondary">
                {t("homeNewBot.routineLine", { name: routineName, when: t(`homeNewBot.routines.${routine.key}.when`) })}
              </span>
              <button
                type="button"
                aria-label={t("homeNewBot.routineRemove")}
                title={t("homeNewBot.routineRemove")}
                onClick={() => update({ withRoutine: false })}
                className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-text-tertiary outline-none hover:bg-background-secondary-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
              >
                <span aria-hidden>×</span>
              </button>
            </div>
          ) : null}
          {/* The whole row opens the picker, like a field; the picker's own
              button stays the control that screen readers and keys reach. */}
          <div
            ref={modelRow}
            data-new-bot-model=""
            onClick={(event) => {
              if (event.target === event.currentTarget || !(event.target as HTMLElement).closest("button")) {
                modelRow.current?.querySelector<HTMLButtonElement>("[data-composer-model-picker]")?.click();
              }
            }}
            // The picker's pill reads as plain text inside the row.
            className={cn(FIELD, "flex h-11 cursor-pointer items-center justify-between gap-2 ps-3 pe-1.5 [&_[data-composer-model-picker]]:border-transparent [&_[data-composer-model-picker]]:bg-transparent")}
          >
            <span className={cn(LABEL, "font-normal")}>{t("homeNewBot.modelLabel")}</span>
            <DraftModelPicker value={draft.model} onChange={(model) => update({ model })} />
          </div>
          <div className="flex justify-center pt-1">
            <button
              type="submit"
              disabled={!canCreate}
              className="h-9 cursor-pointer rounded-lg bg-text-primary px-4 text-body-medium text-background-primary-default outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("homeNewBot.create")}
            </button>
          </div>
        </form>
        <section aria-labelledby={`${id}-suggestions`} className="shrink-0 px-6 pb-4">
          <h2 id={`${id}-suggestions`} className="mb-2 text-caption-1-medium text-text-tertiary">{t("homeNewBot.suggestions")}</h2>
          {/* Name and role only on the card, every card the same height; the
              description waits for the hover (and the focus), so cards never
              wrap to different heights. */}
          <TooltipProvider delayDuration={200}>
            <ul className="flex gap-3 [scrollbar-width:none] overflow-x-auto p-px pb-1">
              {HOME_SUGGESTIONS.map((suggestion) => {
                const title = suggestion.name;
                const job = t(`homeNewBot.suggestion.${suggestion.id}.role`);
                const hint = t(`homeNewBot.suggestion.${suggestion.id}.hint`);
                return (
                  <li key={suggestion.id} className="shrink-0">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label={`${title}, ${job}. ${hint}`}
                          aria-pressed={draft.suggestion?.id === suggestion.id}
                          onClick={() => update({
                            name: title,
                            mission: t(`homeNewBot.suggestion.${suggestion.id}.mission`),
                            face: suggestionFaceChoice(suggestion),
                            suggestion,
                            withRoutine: suggestion.routine !== null,
                          })}
                          className="openedbot-row flex h-16 w-52 cursor-pointer items-center gap-3 rounded-xl border border-border-button-default/60 px-3 text-start outline-none hover:bg-background-secondary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring aria-pressed:border-border-focus-ring"
                        >
                          <BotFace name={title} seed={`home-suggestion-${suggestion.id}`} face={homeFace(suggestionFaceChoice(suggestion))} className="size-9 shrink-0" animated={false} />
                          <span className="flex min-w-0 flex-col">
                            <strong className="truncate text-body-medium font-medium text-text-primary">{title}</strong>
                            <small className="truncate text-[13px] leading-[18px] text-text-tertiary">{job}</small>
                          </span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent
                        side="top"
                        sideOffset={6}
                        // The BoardUI menu card, as `RunTiming`: theme tokens, no arrow.
                        className="max-w-[240px] rounded-xl border border-border-button-default bg-background-primary-default px-3 py-2 text-[13px] leading-[18px] text-text-primary shadow-dropdown [&>span]:hidden"
                      >
                        {hint}
                      </TooltipContent>
                    </Tooltip>
                  </li>
                );
              })}
            </ul>
          </TooltipProvider>
        </section>
      </div>
    </>
  );
}
