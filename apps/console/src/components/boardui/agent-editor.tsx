import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RiPlayMiniFill, RiStopMiniFill, RiVolumeUpLine } from "@remixicon/react";
import {
  BOT_SPEECH_RATES,
  defaultFaceFor,
  type BotDto,
  type BotFaceSpec,
  type BotSpeechRate,
  type RosterDto,
  type UpdateBotInput,
} from "@openedbot/contracts-api";
import { cn, toast } from "@openedbot/browser-ui-kit";
import { BOT_ARTWORKS, defaultArtworkFor } from "@openedbot/browser-face/artworks";
import { isMascotFace, mascotFace } from "@openedbot/browser-face/mascot";
import { COLORS, DEFAULT_FACE, EXPRESSIONS, resolveFace, SHAPES } from "@openedbot/browser-face/presets";
import { ApiError, api, queryKeys } from "../../lib/api";
import { useBotDialogs } from "../../lib/bots/bot-dialogs";
import { BUTTON } from "../settings/primitives";
import { useT } from "../../lib/i18n";
import { createBrowserSpeechSynthesisAdapter, type SpeechVoice } from "../../lib/voice/web-speech-synthesis";
import { BloubBotFace } from "../bloub-bot";
import { BotFace } from "../bot-face";
import { BuiCloseGlyph, BuiPopover, BuiPopoverContent, BuiPopoverTrigger } from "./menu";
import { BuiSelect, PreferencesCard, type SelectOption } from "./agent-editor-preferences";
import { ArcPicker } from "./agent-editor-arc-picker";
import { CatStage } from "./agent-editor-cat-stage";


/**
 * The edited bot without the fields every run patches (`running`, `preview`,
 * `unread`, activity dates, approval dot). The panel stays mounted beside the
 * thread, hidden or not, and edits the bot of that thread: selecting this
 * projection (structural sharing keeps its reference while it is unchanged)
 * stops the 202, the read receipt and every SSE flush from re-rendering the
 * whole editor and its faces.
 */
export type EditorBot = Omit<BotDto, "running" | "unread" | "preview" | "lastActivityAt" | "lastRunAt" | "awaitingApproval" | "updatedAt">;

/** Writes a bot setting; the cached roster follows without waiting. */
function useBotPatch(bot: EditorBot) {
  const { t } = useT();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateBotInput) => api.updateBot(bot.id, input),
    onMutate: (input) => {
      queryClient.setQueryData<RosterDto>(queryKeys.roster, (roster) => roster
        ? {
            ...roster,
            bots: roster.bots.map((candidate) => candidate.id === bot.id
              ? { ...candidate, ...(input as Partial<BotDto>) }
              : candidate),
          }
        : roster);
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : t("boardui.saveFailed"));
      void queryClient.invalidateQueries({ queryKey: queryKeys.roster });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.roster }),
  });
}

export const AgentEditor = memo(function AgentEditor({ bot, onClose }: { bot: EditorBot; onClose: () => void }) {
  const { t } = useT();
  const patch = useBotPatch(bot);
  const openManage = useBotDialogs((state) => state.openManage);
  // With no face chosen, `BotFace` shows the mascot derived from the id: the editor
  // starts from that same face, so the preview does not change on open.
  const face: BotFaceSpec = bot.face ?? { ...defaultFaceFor(bot.id), artwork: defaultArtworkFor(bot.id).id };
  const setFace = (next: BotFaceSpec) => patch.mutate({ face: next });
  // Each tab edits only the avatar type on display: switching tabs is the
  // only gesture that goes from one type to another. Returning to « Mascotte »
  // restores the last mascot worn during this opening, « Chat » the last cat
  // (the editor is remounted per bot).
  const kind = face.artwork ? 0 : isMascotFace(face) ? 2 : 1;
  const lastArtwork = useRef(face.artwork ?? defaultArtworkFor(bot.id).id);
  const lastCat = useRef<BotFaceSpec>(isMascotFace(face) ? face : mascotFace("orange", "pill", null));
  useEffect(() => {
    if (face.artwork) lastArtwork.current = face.artwork;
    else if (isMascotFace(face)) lastCat.current = face;
  }, [face]);
  const pickKind = (index: number) => {
    if (index === kind) return;
    if (index === 0) {
      setFace({ ...face, artwork: lastArtwork.current });
      return;
    }
    if (index === 2) {
      setFace(lastCat.current);
      return;
    }
    // A bloub face: a cat's eyes and sign mean nothing on a bloub shape.
    const { artwork: _artwork, accessory: _accessory, ...rest } = face;
    setFace(isMascotFace(face) ? { ...DEFAULT_FACE, palette: face.palette } : { ...DEFAULT_FACE, ...rest });
  };

  return (
    <section aria-label={t("boardui.agentEditor")} className="flex h-full min-h-0 flex-col bg-background-full ps-1 pe-2">
      <header data-titlebar-drag="" className="relative flex h-8 shrink-0 items-start justify-center pt-4">
        <h2 className="max-w-[260px] truncate text-body-medium text-text-primary">{bot.name}</h2>
        <button
          type="button"
          aria-label={t("boardui.closeEditor")}
          onClick={onClose}
          className="absolute end-0 top-3.5 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full bg-background-tertiary-default text-foreground-icon-tertiary outline-none transition-colors duration-150 select-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2"
        >
          <BuiCloseGlyph />
        </button>
      </header>
      <div className="relative min-h-0 flex-1">
        <div
          aria-label={t("boardui.agentAppearance")}
          tabIndex={0}
          className="bui-scroll h-full overflow-y-auto overscroll-contain pb-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring"
        >
          <div className="mx-auto mt-3 w-full max-w-[240px]">
            <Segmented
              label={t("boardui.avatarKind")}
              index={kind}
              options={[t("boardui.avatarMascot"), t("boardui.avatarFace"), t("boardui.avatarCat")]}
              onChange={pickKind}
            />
          </div>
          {kind === 0 ? (
            <MascotStage bot={bot} face={face} onFace={setFace} />
          ) : kind === 2 ? (
            <>
              <CatStage seed={bot.id} name={bot.name} face={face} onFace={setFace} />
              <ColorPill face={face} onFace={setFace} />
            </>
          ) : (
            <>
              <AvatarStage bot={bot} face={face} onFace={setFace} />
              <ColorPill face={face} onFace={setFace} />
            </>
          )}
          <DetailsCard bot={bot} onPatch={(input) => patch.mutate(input)} />
          <div className="mt-4 flex flex-col gap-3 pb-3">
            <PreferencesCard bot={bot} onPatch={(input) => patch.mutate(input)} />
            <VoiceCard bot={bot} onPatch={(input) => patch.mutate(input)} />
            {/* The rest of the bot (persona, model, approvals, capabilities,
                memory, routines, archiving, deletion) lives on its page. */}
            <button type="button" className={cn(BUTTON.secondary, "w-full justify-center")} onClick={() => openManage(bot.id)}>
              {t("botManage.openAll")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
});

/* --- Apparence ------------------------------------------------------------ */

function lighten(hex: string, amount: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const mix = (channel: number) => Math.round(channel + (255 - channel) * amount);
  const r = mix((value >> 16) & 255);
  const g = mix((value >> 8) & 255);
  const b = mix(value & 255);
  return `rgb(${r} ${g} ${b})`;
}

function AvatarStage({ bot, face, onFace }: { bot: EditorBot; face: BotFaceSpec; onFace: (face: BotFaceSpec) => void }) {
  const { t } = useT();
  const resolved = resolveFace(face, bot.id);
  // The tint shows only through the eyes (cutouts of the body). The
  // face body makes the bubble (200/240 of 41 px = 34 px) and the tint stops
  // 2 px from the edge (`bg-clip-content`): nothing pale on the outline, against
  // which the selection ring and the hover ring sit.
  const ringTint = lighten(resolved.color.hex, 0.62);
  const bloub = (next: Partial<BotFaceSpec>): BotFaceSpec => {
    const { artwork: _artwork, ...rest } = face;
    return { ...DEFAULT_FACE, ...rest, ...next };
  };
  return (
    <div className="relative h-[360px] overflow-hidden">
      <div className="pointer-events-none absolute top-[30px] left-1/2 z-10 -translate-x-1/2">
        <div role="group" aria-label={t("boardui.agentEmotion")} className="pointer-events-auto relative size-[268px] rounded-full">
          {EXPRESSIONS.map((expression, index) => {
            const angle = index * (360 / EXPRESSIONS.length);
            const selected = !face.artwork && resolved.expression.id === expression.id;
            const name = t(`face.expressions.${expression.id}`);
            return (
              <div
                key={expression.id}
                className="absolute top-1/2 left-1/2 -mt-[17px] -ml-[17px] size-[34px]"
                style={{ transform: `rotate(${angle}deg) translateY(-116px)` }}
              >
                <div style={{ transform: `rotate(${-angle}deg)` }}>
                  <button
                    type="button"
                    aria-label={name}
                    title={name}
                    aria-pressed={selected}
                    onClick={() => onFace(bloub({ eyes: expression.id }))}
                    className={cn(
                      "pointer-events-auto flex size-[34px] cursor-pointer items-center justify-center overflow-hidden rounded-full bg-clip-content p-[2px] outline-none transition-[box-shadow] focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                      selected ? "ring-2 ring-foreground-icon-secondary" : "hover:ring-2 hover:ring-border-button-hover",
                    )}
                    style={{ backgroundColor: ringTint }}
                  >
                    <BloubBotFace
                      face={resolveFace({ palette: resolved.color.id, shape: "cercle", eyes: expression.id })}
                      seed={`ring:${expression.id}`}
                      animated={false}
                      className="size-[41px] shrink-0"
                    />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="pointer-events-none absolute top-[83px] left-1/2 -translate-x-1/2">
        <BotFace name={t("boardui.livePreview", { name: bot.name })} seed={bot.id} face={face} className="size-[162px]" />
      </div>
      <ArcPicker
        label={t("boardui.avatarShape")}
        items={SHAPES}
        selectedId={resolved.shape.id}
        itemLabel={(shape) => t(`face.shapes.${shape.id}`)}
        onPick={(shape) => onFace(bloub({ shape: shape.id }))}
        renderItem={(shape) => (
          <BloubBotFace
            face={resolveFace({ palette: resolved.color.id, shape: shape.id, eyes: resolved.expression.id })}
            seed={`shape:${shape.id}`}
            animated={false}
            className="size-12"
          />
        )}
      />
    </div>
  );
}

/**
 * The Mascot tab, in the exact place of the face preview, and its mascots
 * on the same arc as the shapes. Portraits (painted canvases, not
 * mascots) are no longer offered there; a bot that already wears one still finds it.
 */
function MascotStage({ bot, face, onFace }: { bot: EditorBot; face: BotFaceSpec; onFace: (face: BotFaceSpec) => void }) {
  const { t } = useT();
  const mascots = useMemo(
    () => BOT_ARTWORKS.filter((artwork) => !artwork.portrait || artwork.id === face.artwork),
    [face.artwork],
  );
  return (
    <div className="relative h-[360px] overflow-hidden">
      <div className="pointer-events-none absolute top-[83px] left-1/2 -translate-x-1/2">
        <BotFace name={t("boardui.livePreview", { name: bot.name })} seed={bot.id} face={face} className="size-[162px]" />
      </div>
      <ArcPicker
        label={t("boardui.mascots")}
        items={mascots}
        selectedId={face.artwork}
        itemLabel={(artwork) => artwork.name}
        onPick={(artwork) => artwork.id !== face.artwork && onFace({ ...face, artwork: artwork.id })}
        renderItem={(artwork) => (
          <BotFace name={artwork.name} seed={artwork.id} face={{ ...face, artwork: artwork.id }} animated={false} className="size-12" />
        )}
      />
    </div>
  );
}

/** The pill's nine tints; the others under the rainbow. */
const PILL_COLORS = ["bleu", "turquoise", "violet", "rose", "rouge", "orange", "ambre", "vert", "gris"] as const;

function Swatch({ hex, label, selected, onSelect }: { hex: string; label: string; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={selected}
      onClick={onSelect}
      className="relative size-[26px] shrink-0 cursor-pointer overflow-hidden rounded-full outline-none transition-transform duration-150 ease-out hover:scale-110 focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2"
      style={{ background: `radial-gradient(closest-side circle at 50% 50%, ${lighten(hex, 0.18)} 0%, ${hex} 100%)` }}
    >
      <span aria-hidden className="absolute inset-0 bg-linear-to-b from-[#ffffff00] to-[#ffffff4d]" />
      <span aria-hidden className="absolute top-0 left-[7.7%] h-[38.5%] w-[84.6%] rounded-[50%] bg-linear-to-b from-[#ffffff80] to-[#ffffff00] blur-[0.5px]" />
      <span aria-hidden className="absolute top-0 left-[34.6%] h-[11.5%] w-[30.8%] rounded-[50%] bg-linear-to-b from-[#ffffff80] to-[#ffffff00] blur-[1px]" />
      <span aria-hidden className="absolute top-[73.1%] left-[-23.1%] h-[53.8%] w-[138.5%] rounded-[50%] bg-linear-to-b from-[#ffffff00] to-[#ffffff80] blur-[0.5px]" />
      {selected ? <span aria-hidden className="pointer-events-none absolute inset-0 rounded-full shadow-[inset_0_0_0_2px_rgb(0_0_0/0.30)]" /> : null}
    </button>
  );
}

function ColorPill({ face, onFace }: { face: BotFaceSpec; onFace: (face: BotFaceSpec) => void }) {
  const { t } = useT();
  const [moreOpen, setMoreOpen] = useState(false);
  const pick = (palette: string) => {
    const { artwork: _artwork, ...rest } = face;
    onFace({ ...DEFAULT_FACE, ...rest, palette });
  };
  const current = face.artwork ? null : face.palette;
  return (
    <div className="mt-[15px] flex justify-center">
      <div role="group" aria-label={t("boardui.avatarColor")} className="flex h-[38px] shrink-0 items-center gap-1 rounded-full border border-border-button-default bg-background-primary-default p-[5px] shadow-xs">
        {PILL_COLORS.map((id) => {
          const color = COLORS.find((candidate) => candidate.id === id)!;
          return <Swatch key={id} hex={color.hex} label={t(`face.colors.${id}`)} selected={current === id} onSelect={() => pick(id)} />;
        })}
        <BuiPopover open={moreOpen} onOpenChange={setMoreOpen}>
          <BuiPopoverTrigger asChild>
            <button
              type="button"
              aria-label={t("boardui.moreAppearance")}
              title={t("boardui.moreAppearance")}
              className="relative size-[26px] shrink-0 cursor-pointer overflow-hidden rounded-full outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
              style={{ background: "conic-gradient(from 90deg, #ff6b6b, #ffd93d, #6bcb77, #4d96ff, #9b5de5, #ff6b6b)" }}
            >
              <span aria-hidden className="absolute inset-[3px] rounded-full bg-[radial-gradient(circle,rgb(255_255_255/0.85)_0%,rgb(255_255_255/0.2)_70%)]" />
              {current && !PILL_COLORS.includes(current as (typeof PILL_COLORS)[number])
                ?<span aria-hidden className="pointer-events-none absolute inset-0 rounded-full shadow-[inset_0_0_0_2px_rgb(0_0_0/0.30)]" />
                : null}
            </button>
          </BuiPopoverTrigger>
          <BuiPopoverContent side="bottom" align="end" className="w-[300px] gap-3 p-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-body-medium text-text-secondary">{t("boardui.allColors")}</span>
              <div className="flex flex-wrap gap-1.5">
                {COLORS.map((color) => (
                  <Swatch
                    key={color.id}
                    hex={color.hex}
                    label={t(`face.colors.${color.id}`)}
                    selected={current === color.id}
                    onSelect={() => { pick(color.id); setMoreOpen(false); }}
                  />
                ))}
              </div>
            </div>
          </BuiPopoverContent>
        </BuiPopover>
      </div>
    </div>
  );
}

/* --- Name, role, description ---------------------------------------------- */

const FIELD_SHELL =
  "relative flex w-full items-center rounded-2lg bg-background-tertiary-default text-foreground-icon-tertiary ring-2 ring-inset ring-transparent transition-[background-color,box-shadow,color] duration-150 focus-within:ring-border-focus-ring";
const FIELD_INPUT =
  "m-0 min-w-0 flex-1 border-0 bg-transparent p-0 px-1 text-left font-sans text-body-regular text-text-primary outline-none placeholder:text-text-tertiary focus:placeholder:text-text-primary disabled:cursor-not-allowed";

/** A text field that saves on leaving it (or Enter), with no button. */
function CommitField({
  id,
  label,
  value,
  maxLength,
  placeholder,
  multiline = false,
  required = false,
  onCommit,
}: {
  id: string;
  label: string;
  value: string;
  maxLength: number;
  placeholder: string;
  multiline?: boolean;
  required?: boolean;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  const commit = () => {
    focused.current = false;
    const next = draft.trim();
    if (required && !next) {
      setDraft(value);
      return;
    }
    if (next !== value.trim()) onCommit(next);
  };
  const common = {
    id,
    "aria-label": label,
    value: draft,
    maxLength,
    placeholder,
    onFocus: () => { focused.current = true; },
    onBlur: commit,
  };
  return multiline ? (
    <div role="presentation" className={cn(FIELD_SHELL, "h-[62px] flex-col px-1.5 py-2")}>
      <textarea
        {...common}
        rows={2}
        onChange={(event) => setDraft(event.target.value)}
        className={cn(FIELD_INPUT, "block w-full resize-none")}
      />
    </div>
  ) : (
    <div role="presentation" className={cn(FIELD_SHELL, "h-8 px-1.5 py-2")}>
      <input
        {...common}
        type="text"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          if (event.key === "Escape") {
            setDraft(value);
            focused.current = false;
            (event.target as HTMLInputElement).blur();
          }
        }}
        className={FIELD_INPUT}
      />
    </div>
  );
}

function DetailsCard({ bot, onPatch }: { bot: EditorBot; onPatch: (input: UpdateBotInput) => void }) {
  const { t } = useT();
  const prefix = `agent-${bot.id}`;
  return (
    <div className="mt-[15px] overflow-hidden rounded-2xl bg-background-secondary-default ps-3">
      <div className="grid h-[52px] grid-cols-[96px_minmax(0,1fr)] items-center border-b border-border-button-default pe-2.5 dark:border-border-button-default/35">
        <label htmlFor={`${prefix}-name`} className="text-body-regular text-text-primary">{t("boardui.fieldName")}</label>
        <CommitField
          id={`${prefix}-name`}
          label={t("boardui.agentName")}
          value={bot.name}
          maxLength={48}
          required
          placeholder={t("boardui.namePlaceholder")}
          onCommit={(name) => onPatch({ name })}
        />
      </div>
      {/* The role is the only line under the name: the creation description
          no longer feeds the bot afterwards (its mission lives in the persona), so
          it is no longer edited here (operator choice, 2026-10-26). */}
      <div className="grid h-[52px] grid-cols-[96px_minmax(0,1fr)] items-center pe-2.5">
        <label htmlFor={`${prefix}-label`} className="text-body-regular text-text-primary">{t("boardui.fieldLabel")}</label>
        <CommitField
          id={`${prefix}-label`}
          label={t("boardui.agentLabel")}
          value={bot.label ?? ""}
          maxLength={60}
          placeholder={t("boardui.labelPlaceholder")}
          onCommit={(label) => onPatch({ label: label || null })}
        />
      </div>
    </div>
  );
}

/* --- Voix ---------------------------------------------------------------- */

const DEFAULT_VOICE = "__default__";

function VoiceCard({ bot, onPatch }: { bot: EditorBot; onPatch: (input: UpdateBotInput) => void }) {
  const { t, locale } = useT();
  const speech = useMemo(() => createBrowserSpeechSynthesisAdapter(), []);
  const [voices, setVoices] = useState<SpeechVoice[]>(() => speech.voices());
  const [previewing, setPreviewing] = useState(false);
  useEffect(() => speech.subscribeVoicesChanged(() => setVoices(speech.voices())), [speech]);
  useEffect(() => () => speech.cancel(), [speech]);
  const rate: BotSpeechRate = bot.speechRate ?? 1;
  const options = useMemo<SelectOption[]>(() => {
    const list: SelectOption[] = [{ value: DEFAULT_VOICE, label: t("boardui.systemVoice") }];
    if (bot.voiceId && !voices.some((voice) => voice.voiceURI === bot.voiceId)) {
      list.push({ value: bot.voiceId, label: t("botSettingsDialog.voiceUnavailable", { id: bot.voiceId }) });
    }
    for (const voice of voices) list.push({ value: voice.voiceURI, label: voice.name });
    return list;
  }, [bot.voiceId, t, voices]);
  const preview = () => {
    if (previewing) {
      speech.cancel();
      setPreviewing(false);
      return;
    }
    setPreviewing(true);
    speech.speak({
      text: t("boardui.voicePreviewText", { name: bot.name }),
      lang: locale,
      voiceURI: bot.voiceId,
      rate,
      onEnd: () => setPreviewing(false),
      onError: () => setPreviewing(false),
    });
  };
  const rateIndex = BOT_SPEECH_RATES.indexOf(rate);
  return (
    <div className="flex w-full flex-col gap-3 rounded-2xl bg-background-secondary-default p-3 pt-2">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-body-medium text-text-primary">
          <RiVolumeUpLine aria-hidden className="size-5 shrink-0 text-foreground-icon-secondary" />
          {t("boardui.voice")}
        </span>
        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            aria-label={previewing ? t("boardui.stopPreview") : t("boardui.previewVoice")}
            title={previewing ? t("boardui.stopPreview") : t("boardui.previewVoice")}
            disabled={!speech.supported}
            onClick={preview}
            className="button-press-motion inline-flex size-7 cursor-pointer items-center justify-center rounded-lg text-foreground-icon-secondary outline-none hover:bg-background-secondary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:cursor-not-allowed disabled:opacity-40"
          >
            {previewing ? <RiStopMiniFill className="size-5" /> : <RiPlayMiniFill className="size-5" />}
          </button>
          <BuiSelect
            value={bot.voiceId ?? DEFAULT_VOICE}
            options={options}
            label={t("boardui.agentVoice")}
            onChange={(value) => onPatch({ voiceId: value === DEFAULT_VOICE ? null : value })}
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-caption-1-regular text-text-secondary">{t("boardui.playbackSpeed")}</span>
        <Segmented
          label={t("boardui.playbackSpeed")}
          index={Math.max(0, rateIndex)}
          options={BOT_SPEECH_RATES.map((value) => (
            <span key={value}>{String(value).replace(".", locale === "fr" ? "," : ".")}<span aria-hidden>×</span></span>
          ))}
          onChange={(index) => onPatch({ speechRate: BOT_SPEECH_RATES[index]! })}
        />
      </div>
    </div>
  );
}

/** The template's segmented control: a white indicator slides under the chosen option. */
function Segmented({
  label,
  index,
  options,
  onChange,
}: {
  label: string;
  index: number;
  options: ReactNode[];
  onChange: (index: number) => void;
}) {
  const style: CSSProperties = {
    width: `calc((100% - 8px - ${(options.length - 1) * 2}px) / ${options.length})`,
    transform: `translateX(calc(${index} * (100% + 2px)))`,
  };
  return (
    <div role="radiogroup" aria-label={label} className="relative inline-flex w-full items-start gap-0.5 rounded-2lg bg-background-tertiary-default p-1 dark:bg-segmented-control-background">
      <span aria-hidden className="pointer-events-none absolute start-1 top-1 h-7 rounded-md bg-segmented-control-selected-background shadow-2xs transition-transform duration-200" style={style} />
      {options.map((option, optionIndex) => (
        <button
          key={optionIndex}
          type="button"
          role="radio"
          aria-checked={optionIndex === index}
          onClick={() => optionIndex !== index && onChange(optionIndex)}
          className={cn(
            "relative z-10 inline-flex h-7 min-w-0 flex-1 cursor-pointer items-center justify-center rounded-md px-1 py-1 text-center whitespace-nowrap outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-border-focus-ring",
            optionIndex === index ? "text-body-medium text-text-primary" : "text-body-regular text-text-secondary hover:text-text-primary",
          )}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
