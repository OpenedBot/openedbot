import { useEffect, useId, useRef, useState } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconBrush, IconDice5, IconX } from "@tabler/icons-react";
import type { BotDto, BotFaceSpec, RosterDto, RuntimeModelSelectionStateDto } from "@openedbot/contracts-api";
import { displayedCreatePersona } from "@openedbot/roster/domain/persona";
import { BotCloneDraftError, botCreationDraftFromClone, type PortableBotCreationDraft } from "@openedbot/roster/domain/bot-clone";
import { Dialog, Input, Label, useIsMobile } from "@openedbot/browser-ui-kit";
import { randomFace } from "@openedbot/browser-face/presets";
import { randomBotArtwork } from "@openedbot/browser-face/artworks";
import { ApiError, api, queryKeys, runtimesQueryOptions } from "../../lib/api";
import { useT, type MessageKey } from "../../lib/i18n";
import { creationAttempts } from "../../lib/bots/creation-attempts";
import {
  failPendingBotCreation,
  resumePendingBotCreation,
  settlePendingBotCreation,
  startPendingBotCreation,
} from "../../lib/bots/pending-bot-creations";
import { BotFace } from "../bot-face";
import { FaceFields } from "../face-fields";
import { BUTTON } from "../settings/primitives";
import { BotRoutinesDialog } from "../bot-routines-dialog";
import { CreatePersonaSection } from "./persona-sheet";
import { CreationOptions, RuntimePromiseLine, isRuntimeLinked, type CreationOptionsValue } from "./creation-options";
import { sendBotCreation, type BotCreationRequest } from "./creation-request";

/** The `bots.label` bound (0099): the role is the label shown under the name. */
export const BOT_ROLE_MAX_CHARS = 60;

const CLONE_ERRORS: Record<BotCloneDraftError["code"], MessageKey> = {
  BOT_CLONE_INSTRUCTIONS_TOO_LONG: "botCloneDialog.errorInstructions",
  BOT_CLONE_DESCRIPTION_TOO_LONG: "botCloneDialog.errorDescription",
  BOT_CLONE_HERMES_PROFILE_TOO_LONG: "botCloneDialog.errorProfileLong",
  BOT_CLONE_HERMES_PROFILE_REUSED: "botCloneDialog.errorProfileReused",
};

/**
 * A duplicate on a host without `profile_management` names its own profile:
 * left empty, the copy would be created with no named profile, and the
 * source's profile is never shared (the old clone dialog's guard).
 */
function cloneProfileError(source: BotDto, profile: string): MessageKey | null {
  if (!profile.trim()) return "botCloneDialog.errorProfileRequired";
  try {
    botCreationDraftFromClone(source, { hermesProfile: profile });
    return null;
  } catch (error) {
    if (!(error instanceof BotCloneDraftError)) throw error;
    return CLONE_ERRORS[error.code];
  }
}

const MODEL_PROOF_POLL_MS = 2_000;

function modelProofPending(selection: RuntimeModelSelectionStateDto | null | undefined): boolean {
  return selection?.status === "queued" || selection?.status === "running";
}

function randomArtworkFace(): BotFaceSpec {
  return { ...randomFace(), artwork: randomBotArtwork().id };
}

type Draft = {
  name: string;
  role: string;
  mission: string;
  personaTouched: boolean;
  personaText: string;
  face: BotFaceSpec;
  options: CreationOptionsValue;
  /**
   * D-1: until someone picks a mode (the operator, a template, a copy), the
   * sheet shows and sends the organization's default (`auto` once the review
   * is proven, PERM2-7), read from the runtime configuration.
   */
  permissionModeChosen: boolean;
  copied: BotCreationRequest["copied"];
  presetLabel: string | null;
  cloneError: MessageKey | null;
};

const DEFAULT_OPTIONS: CreationOptionsValue = {
  profile: "",
  permissionMode: "manual",
  notifyOnFinish: false,
  firstRoutine: false,
  greet: true,
};

function blankDraft(): Draft {
  return {
    name: "",
    role: "",
    mission: "",
    personaTouched: false,
    personaText: "",
    face: randomArtworkFace(),
    options: DEFAULT_OPTIONS,
    permissionModeChosen: false,
    copied: null,
    presetLabel: null,
    cloneError: null,
  };
}

/**
 * A duplicate starts from the safe clone projection (`bot-clone.ts`): persona,
 * face, model and presentation settings follow; the profile, the identity and
 * the permission mode never do (a copy asks before acting until told otherwise).
 */
function duplicateDraft(source: BotDto, copyLabel: string): Draft {
  let draft: PortableBotCreationDraft;
  try {
    draft = botCreationDraftFromClone(source, { copyLabel });
  } catch (error) {
    if (!(error instanceof BotCloneDraftError)) throw error;
    return { ...blankDraft(), name: source.name, cloneError: CLONE_ERRORS[error.code] };
  }
  const { name, instructions, face, label, hermesProfile: _profile, ...copied } = draft;
  const role = label ?? (draft.description && draft.description.length <= BOT_ROLE_MAX_CHARS ? draft.description : "");
  return {
    name,
    role,
    mission: "",
    personaTouched: true,
    personaText: instructions,
    face: face ?? randomArtworkFace(),
    options: { ...DEFAULT_OPTIONS, notifyOnFinish: draft.notifyOnFinish ?? false, greet: false },
    permissionModeChosen: true,
    copied,
    presetLabel: null,
    cloneError: null,
  };
}

/**
 * « Nouveau bot » : une modale large en deux étapes au plus. À gauche,
 * l'aperçu du bot (tête, nom, rôle) et le rail des étapes ; à droite, l'étape :
 * d'abord le point de départ (un modèle officiel ou « Sur mesure », un clic
 * choisit et avance), puis l'identité (nom, rôle, mission).
 *
 * La fiche de poste (persona) reste exactement le texte envoyé, éditable, mais
 * repliée avec le reste (règles d'approbation, avis de fin, accueil, profil
 * explicite) dans « Options avancées », avec des défauts sûrs, et part dans la
 * MÊME requête que le bot (création atomique, 0135). « Créer » ferme la
 * feuille et ouvre l'écran d'attente du bot ; la demande garde un
 * `clientRequestId` que « Réessayer » rejoue sans risque de doublon.
 *
 * `source` : dupliquer un bot (la feuille part de sa copie sûre).
 */
export function CreateBotSheet({ open, onClose, source = null }: {
  open: boolean;
  onClose: () => void;
  source?: BotDto | null;
}) {
  const { t, locale } = useT();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  const idPrefix = useId();
  const isMobile = useIsMobile();
  const runtimeQuery = useQuery({ ...runtimesQueryOptions(), enabled: open });
  const runtime = runtimeQuery.data?.runtimes[0] ?? null;
  const profileManagement = runtime?.linkFeatures?.includes("profile_management") === true;
  // Same cache entry as the model picker: the organization's assignment mode.
  // While the runtime's new model is still being proven, read it again so the
  // warning below leaves as soon as the proof settles.
  const assignment = useQuery({
    queryKey: queryKeys.runtimeConfiguration,
    queryFn: api.runtimeConfiguration,
    enabled: open,
    refetchInterval: (query) => modelProofPending(query.state.data?.runtime?.modelSelection) ? MODEL_PROOF_POLL_MS : false,
  });
  const [draft, setDraft] = useState<Draft>(() => source ? duplicateDraft(source, t("botCloneDialog.copyLabel")) : blankDraft());
  const attempts = useRef(creationAttempts());
  const [faceEditing, setFaceEditing] = useState(false);
  const [personaProposing, setPersonaProposing] = useState(false);
  const [routineBot, setRoutineBot] = useState<BotDto | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  // Each opening is a new creation attempt: a fresh draft and a fresh request id.
  useEffect(() => {
    if (!open) return;
    setDraft(source ? duplicateDraft(source, t("botCloneDialog.copyLabel")) : blankDraft());
    attempts.current.reset();
    setFaceEditing(false);
  }, [open, source, t]);

  const trimmedName = draft.name.trim();
  const previewName = trimmedName || t("newBotDialog.defaultName");
  const displayedPersona = displayedCreatePersona({
    name: previewName,
    role: draft.role.trim() || null,
    mission: draft.mission.trim() || null,
    editedText: draft.personaText,
    edited: draft.personaTouched,
  });
  // L'identité s'ouvre sur le nom : c'est le seul champ requis.
  useEffect(() => {
    if (open && !isMobile) nameInput.current?.focus({ preventScroll: true });
  }, [open, isMobile]);
  // A duplicate waits for the runtime: whether it needs a profile depends on it.
  const cloneRuntimePending = source !== null && runtimeQuery.isPending;
  const profileRequired = source !== null && !cloneRuntimePending && !profileManagement;
  const profileError = profileRequired ? cloneProfileError(source, draft.options.profile) : null;
  // The model the copy will actually run: its source's, else the runtime's.
  // Under global assignment the runner ignores a bot's own model whenever the
  // runtime has one (`applyRuntimeModelSelection`): the copy keeps the setting
  // in its request, but the promise names the runtime model.
  const globalModel = assignment.data?.modelAssignmentMode === "global" && Boolean(runtime?.selectedModel?.trim());
  const creationOptions: CreationOptionsValue = draft.permissionModeChosen
    ? draft.options
    : { ...draft.options, permissionMode: assignment.data?.defaultPermissionMode ?? "manual" };
  const ownModel = globalModel ? null : draft.copied?.model ?? null;
  // A bot that follows the runtime runs the runtime's CURRENT model: until the
  // new one is proven (and promoted), that is still the previous model.
  const proof = assignment.data?.runtime?.id === runtime?.id ? assignment.data?.runtime?.modelSelection ?? null : null;
  const pendingModel = !ownModel && modelProofPending(proof) ? proof?.model ?? null : null;
  const canCreate = trimmedName.length > 0 && !personaProposing && draft.cloneError === null
    && !cloneRuntimePending && profileError === null;

  const close = () => {
    onClose();
    setFaceEditing(false);
  };

  // The request is frozen at the click: the sheet resets before the answer.
  // Its id follows its content: the same request sent again (double submit,
  // retry after an error) keeps its id, an edited one gets a new id (0136).
  const freeze = (): BotCreationRequest => {
    const content: Omit<BotCreationRequest, "clientRequestId"> = {
      name: trimmedName,
      role: draft.role.trim(),
      mission: draft.mission.trim(),
      instructions: displayedPersona,
      hermesProfile: profileManagement ? null : draft.options.profile.trim() || null,
      face: draft.face,
      permissionMode: creationOptions.permissionMode,
      notifyOnFinish: draft.options.notifyOnFinish,
      greet: draft.options.greet,
      locale,
      copied: draft.copied,
      presetLabel: draft.presetLabel,
    };
    return { clientRequestId: attempts.current.idFor(content), ...content };
  };

  const errorMessage = (error: unknown) => error instanceof ApiError ? error.message : t("newBotDialog.createFailed");

  /**
   * The roster knows the bot BEFORE any screen looks for it: the answered bot
   * goes into the cached roster, then the roster is read again. Opening
   * `/bot/<id>` first would show « ce bot n'existe plus » while a slow
   * refetch is still under way (the query is not pending, it has data).
   */
  const rememberCreated = async (bot: BotDto) => {
    queryClient.setQueryData<RosterDto>(queryKeys.roster, (current) => current && !current.bots.some((entry) => entry.id === bot.id)
      ? { ...current, bots: [...current.bots, bot] }
      : current);
    await queryClient.invalidateQueries({ queryKey: queryKeys.roster });
  };

  /** The waiting screen owns the attempt: it can replay it, with the same id. */
  const launch = (request: BotCreationRequest, pendingId: string, openRoutine: boolean) => {
    sendBotCreation(request).then(async (bot) => {
      await rememberCreated(bot);
      settlePendingBotCreation(pendingId);
      // Toujours sur l'écran de création : il devient la conversation du bot.
      // Parti ailleurs entre-temps : le bot attend dans la liste.
      if (router.state.location.pathname.endsWith(`/bot/${pendingId}`)) {
        void navigate({ to: "/bot/$botId", params: { botId: bot.id }, replace: true });
      }
      if (openRoutine) setRoutineBot(bot);
    }, (error: unknown) => {
      failPendingBotCreation(pendingId, errorMessage(error), () => {
        resumePendingBotCreation(pendingId);
        launch(request, pendingId, openRoutine);
      });
    });
  };

  const submit = () => {
    if (!canCreate) return;
    const request = freeze();
    const openRoutine = draft.options.firstRoutine;
    const pendingId = startPendingBotCreation({ name: request.name, face: request.face });
    launch(request, pendingId, openRoutine);
    close();
    void navigate({ to: "/bot/$botId", params: { botId: pendingId } });
  };

  const preview = (
    <aside className="ohb-new-bot-aside" aria-label={t("newBotDialog.identity")}>
      <div className="ohb-new-bot-avatar" aria-live="polite">
        <BotFace name={previewName} seed="preview" face={draft.face} className="ohb-new-bot-avatar-face" animated />
        <div className="ohb-new-bot-avatar-text">
          <p className="truncate text-sm font-semibold text-text-primary">{previewName}</p>
          <p className="truncate text-xs text-text-tertiary">{draft.role.trim() || t("newBotDialog.previewRole")}</p>
        </div>
        <div className="flex gap-1.5">
          <button
            type="button"
            aria-label={t("newBotDialog.randomize")}
            title={t("newBotDialog.randomize")}
            onClick={() => update({ face: draft.face.artwork ? randomArtworkFace() : randomFace() })}
            className="ohb-new-bot-card-action ohb-new-bot-card-action-icon"
          >
            <IconDice5 className="size-[18px]" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={t("newBotDialog.customizeFace")}
            title={t("newBotDialog.customizeFace")}
            aria-pressed={faceEditing}
            aria-controls={`${idPrefix}-face-studio`}
            onClick={() => setFaceEditing((current) => !current)}
            className="ohb-new-bot-card-action ohb-new-bot-card-action-icon"
          >
            <IconBrush className="size-4" aria-hidden />
          </button>
        </div>
      </div>
      {/* Où et comment il travaillera : une donnée du bot, donc dans sa fiche,
          pas dans le pied, qui ne garde que les actions. */}
      {!isMobile ? (
        <div className="ohb-new-bot-aside-foot">
          <RuntimePromiseLine runtime={runtime} model={ownModel} pendingModel={pendingModel} mode={creationOptions.permissionMode} />
        </div>
      ) : null}
    </aside>
  );

  const faceStudio = (
    <section id={`${idPrefix}-face-studio`} className="space-y-4" aria-label={t("newBotDialog.changeFace")}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-text-primary">{t("newBotDialog.changeFace")}</h3>
        <button type="button" onClick={() => setFaceEditing(false)} className={BUTTON.small}>{t("newBotDialog.faceDone")}</button>
      </div>
      <FaceFields face={draft.face} onChange={(face) => update({ face })} />
    </section>
  );

  const fields = (
    <div className="space-y-4">
      <div className="ohb-new-bot-fields">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-name`}>{t("newBotDialog.nameLabel")}</Label>
          <Input
            ref={nameInput}
            id={`${idPrefix}-name`}
            {...(!isMobile ? { "data-dialog-autofocus": "" } : {})}
            value={draft.name}
            maxLength={100}
            required
            aria-invalid={draft.name.length > 0 && !trimmedName ? true : undefined}
            onChange={(event) => update({ name: event.target.value })}
            onKeyDown={(event) => {
              // Entrée crée (OpenBot), sauf pendant une composition IME.
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              submit();
            }}
            placeholder={t("newBotDialog.namePlaceholder")}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-role`}>{t("newBotDialog.roleLabel")}</Label>
          <Input
            id={`${idPrefix}-role`}
            maxLength={BOT_ROLE_MAX_CHARS}
            value={draft.role}
            onChange={(event) => update({ role: event.target.value })}
            placeholder={t("newBotDialog.rolePlaceholder")}
          />
        </div>
      </div>
      {source ? null : (
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-mission`}>{t("newBotDialog.missionLabel")}</Label>
          <Input
            id={`${idPrefix}-mission`}
            maxLength={1_000}
            value={draft.mission}
            onChange={(event) => update({ mission: event.target.value })}
            placeholder={t("newBotDialog.missionPlaceholder")}
          />
        </div>
      )}
    </div>
  );

  // La fiche de poste reste exactement le texte envoyé, mais repliée avec le
  // reste : un nom et une mission suffisent pour créer.
  const options = (
    <CreationOptions
      id={idPrefix}
      runtime={runtime}
      profileManagement={profileManagement}
      profileRequired={profileRequired}
      profileError={profileError ? t(profileError) : null}
      model={ownModel}
      value={creationOptions}
      onChange={(next) => update({
        options: next,
        permissionModeChosen: draft.permissionModeChosen || next.permissionMode !== creationOptions.permissionMode,
      })}
    >
      <CreatePersonaSection
        id={`${idPrefix}-persona`}
        displayed={displayedPersona}
        onEdit={(next) => update({ personaTouched: true, personaText: next })}
        onPendingChange={setPersonaProposing}
        runtimeConnected={isRuntimeLinked(runtime)}
        name={previewName}
        role={draft.role}
        mission={draft.mission}
      />
    </CreationOptions>
  );

  const error = draft.cloneError ? <p role="alert" className="text-sm text-destructive-text">{t(draft.cloneError)}</p> : null;
  const content = faceEditing ? faceStudio : (
    <div className="space-y-5">
      {error}
      {fields}
      {options}
    </div>
  );

  const title = source ? t("newBotDialog.duplicateTitle", { name: source.name }) : t("newBotDialog.title");
  const description = source
    ? t("newBotDialog.duplicateDescription")
    : t("newBotDialog.identityDescription");
  const actions = (
    <>
      <button type="button" onClick={close} className={BUTTON.secondary}>{t("common.cancel")}</button>
      <button type="button" onClick={submit} disabled={!canCreate} className={BUTTON.primary}>
        {t("newBotDialog.create")}
      </button>
    </>
  );

  // Au bureau, la modale dessine son propre habillage : aucun trait
  // horizontal, la colonne teintée est la seule séparation et descend sur
  // toute la hauteur ; titre en haut et actions en bas vivent dans la colonne
  // de droite. Au téléphone, la feuille du bas garde l'en-tête et la barre
  // d'actions natives du `Dialog` (contrat PWA).
  return (
    <>
      <Dialog
        open={open}
        onClose={close}
        ariaLabel={title}
        ariaDescribedBy={isMobile ? undefined : `${idPrefix}-lede`}
        title={isMobile ? title : undefined}
        description={isMobile ? description : undefined}
        closeLabel={t("common.close")}
        className="ohb-new-bot-dialog max-w-4xl"
        bodyClassName="ohb-new-bot-body p-0"
        footer={isMobile ? (
          <div className="ohb-new-bot-footer">
            <RuntimePromiseLine runtime={runtime} model={ownModel} pendingModel={pendingModel} mode={creationOptions.permissionMode} />
            <div className="flex justify-end gap-2">{actions}</div>
          </div>
        ) : undefined}
      >
        <div className="ohb-new-bot-layout">
          {preview}
          <div className="ohb-new-bot-pane">
            {isMobile ? null : (
              <header className="ohb-new-bot-head">
                <div className="min-w-0 flex-1">
                  <h2 className="ohb-new-bot-title">{title}</h2>
                  <p id={`${idPrefix}-lede`} className="ohb-new-bot-lede">{description}</p>
                </div>
                <button type="button" onClick={close} aria-label={t("common.close")} className="ohb-new-bot-close">
                  <IconX className="size-4" aria-hidden />
                </button>
              </header>
            )}
            <div className="ohb-new-bot-main">{content}</div>
            {isMobile ? null : <div className="ohb-new-bot-actions">{actions}</div>}
          </div>
        </div>
      </Dialog>
      {routineBot ? (
        <BotRoutinesDialog
          bot={routineBot}
          open
          onClose={() => {
            const bot = routineBot;
            setRoutineBot(null);
            void navigate({ to: "/bot/$botId", params: { botId: bot.id } });
          }}
        />
      ) : null}
    </>
  );
}
