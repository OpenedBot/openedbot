import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { COLORS } from "@openedbot/contracts-api";
import { composePersona } from "@openedbot/roster/domain/persona";
import { cn, toast } from "@openedbot/browser-ui-kit";
import { ApiError, api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
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
  HOME_FACE_PRESETS,
  HOME_SUGGESTIONS,
  homeFace,
  randomHomeFaceChoice,
  type HomeFaceChoice,
} from "./new-bot-faces";

const HEX = new Map(COLORS.map((color) => [color.id, color.hex]));

/** Les champs : fond tertiaire, liseré à peine visible, coins de 8 px (relevés sur OpenBot). */
const FIELD =
  "w-full rounded-lg border border-border-button-default bg-background-tertiary-default text-base text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus-visible:border-border-focus-ring";
const LABEL = "text-caption-1-medium text-text-secondary";
/** Une pastille ou un visage choisi : un liseré bleu, comme le focus. */
const PICKED = "border-border-focus-ring";

type Draft = {
  name: string;
  mission: string;
  face: HomeFaceChoice;
  model: DraftModelChoice;
};

/**
 * L'accueil `/` au bureau : créer un bot sur la page même, comme l'accueil
 * d'OpenBot. Au centre, le visage en grand, deux rangées d'un clic (la
 * couleur, puis le visage), le nom, ce que le bot doit faire et son modèle ;
 * en bas, des suggestions qui remplissent le formulaire. « Créer le bot »
 * part comme la feuille « Nouveau bot » (`useBotCreationLaunch`) : l'écran
 * d'attente du bot s'ouvre aussitôt, la requête garde son identifiant de
 * rejeu.
 *
 * Rien d'autre : plus d'« Options avancées » (2026-11-02). La fiche de poste
 * est composée depuis le nom et la mission, le bot part avec les défauts sûrs
 * de la feuille (`DEFAULT_CREATION_OPTIONS`, le mode par défaut de
 * l'organisation), et sa persona, ses règles d'approbation ou son avis de fin
 * se changent ensuite sur sa page.
 */
export function NewBotHome({ empty }: { empty: boolean }) {
  const { t, locale } = useT();
  const id = useId();
  const queryClient = useQueryClient();
  const launch = useBotCreationLaunch();
  const assignment = useQuery({ queryKey: queryKeys.runtimeConfiguration, queryFn: api.runtimeConfiguration });
  const fresh = (): Draft => ({
    name: t("newBotDialog.defaultName"),
    mission: "",
    face: randomHomeFaceChoice(),
    model: DRAFT_MODEL_DEFAULT,
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
  const permissionMode = assignment.data?.defaultPermissionMode ?? DEFAULT_CREATION_OPTIONS.permissionMode;
  const persona = composePersona({ name: previewName, role: null, mission: mission || null });
  const canCreate = name.length > 0 && !sending;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canCreate) return;
    const { model, provider, effort } = draft.model;
    const content: Omit<BotCreationRequest, "clientRequestId"> = {
      name,
      role: "",
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
                const hex = HEX.get(color === "auto" ? HOME_FACE_PRESETS[draft.face.preset]!.color : color);
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
              placeholder={t("homeNewBot.missionPlaceholder")}
              onChange={(event) => update({ mission: event.target.value })}
              className={cn(FIELD, "min-h-[66px] resize-y px-3 py-2")}
            />
          </div>
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
          <ul className="flex gap-3 [scrollbar-width:none] overflow-x-auto p-px pb-1">
            {HOME_SUGGESTIONS.map((suggestion) => {
              const title = t(`homeNewBot.suggestion.${suggestion.id}.name`);
              const hint = t(`homeNewBot.suggestion.${suggestion.id}.hint`);
              return (
                <li key={suggestion.id} className="shrink-0">
                  <button
                    type="button"
                    aria-label={`${title}. ${hint}`}
                    onClick={() => update({
                      name: title,
                      mission: t(`homeNewBot.suggestion.${suggestion.id}.mission`),
                      face: suggestion.face,
                    })}
                    className="flex h-28 w-64 cursor-pointer items-center gap-4 rounded-xl border border-border-button-default/60 p-4 text-start outline-none transition-colors hover:bg-background-secondary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring"
                  >
                    <BotFace name={title} seed={`home-suggestion-${suggestion.id}`} face={homeFace(suggestion.face)} className="size-[42px]" animated={false} />
                    <span className="flex min-w-0 flex-col gap-1">
                      <strong className="text-base leading-[22px] font-medium text-text-primary">{title}</strong>
                      <small className="line-clamp-3 text-[13px] leading-[18px] text-text-secondary">{hint}</small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </>
  );
}
