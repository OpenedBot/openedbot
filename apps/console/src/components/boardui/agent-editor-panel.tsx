import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RiArrowDownSLine, RiGlobalLine, RiPlayMiniFill, RiStopMiniFill, RiVolumeUpLine } from "@remixicon/react";
import {
  BOT_REPLY_LANGUAGES,
  BOT_SPEECH_RATES,
  defaultFaceFor,
  type BotDto,
  type BotFaceSpec,
  type BotReplyLanguage,
  type BotSpeechRate,
  type RosterDto,
  type UpdateBotInput,
} from "@openedbot/contracts-api";
import { cn, toast } from "@openedbot/browser-ui-kit";
import { BOT_ARTWORKS, defaultArtworkFor } from "@openedbot/browser-face/artworks";
import { COLORS, DEFAULT_FACE, EXPRESSIONS, resolveFace, SHAPES } from "@openedbot/browser-face/presets";
import { ApiError, api, queryKeys } from "../../lib/api";
import { EDITOR_INLINE_QUERY, useAgentEditor } from "../../lib/bots/agent-editor";
import { useBotDialogs } from "../../lib/bots/bot-dialogs";
import { BUTTON } from "../settings/primitives";
import { useT } from "../../lib/i18n";
import { createBrowserSpeechSynthesisAdapter, type SpeechVoice } from "../../lib/voice/web-speech-synthesis";
import { BloubBotFace } from "../bloub-bot";
import { BotFace } from "../bot-face";
import { BuiCloseGlyph, BuiPopover, BuiPopoverContent, BuiPopoverTrigger } from "./menu";

const INLINE_QUERY = EDITOR_INLINE_QUERY;

function subscribeInline(onChange: () => void) {
  const query = window.matchMedia(INLINE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const inlineSnapshot = () => window.matchMedia(INLINE_QUERY).matches;

/**
 * The edited bot without the fields every run patches (`running`, `preview`,
 * `unread`, activity dates, approval dot). The panel stays mounted beside the
 * thread, hidden or not, and edits the bot of that thread: selecting this
 * projection (structural sharing keeps its reference while it is unchanged)
 * stops the 202, the read receipt and every SSE flush from re-rendering the
 * whole editor and its faces (OHB-141).
 */
type EditorBot = Omit<BotDto, "running" | "unread" | "preview" | "lastActivityAt" | "lastRunAt" | "awaitingApproval" | "updatedAt">;

function editorBotOf(roster: RosterDto, botId: string | undefined): EditorBot | null {
  const bot = roster.bots.find((candidate) => candidate.id === botId && candidate.archivedAt === null);
  if (!bot) return null;
  const {
    running: _running,
    unread: _unread,
    preview: _preview,
    lastActivityAt: _lastActivityAt,
    lastRunAt: _lastRunAt,
    awaitingApproval: _awaitingApproval,
    updatedAt: _updatedAt,
    ...editable
  } = bot;
  return editable;
}

/**
 * L'éditeur d'agent du template BoardUI, à droite du fil.
 *
 * Il édite le bot du fil ouvert (ou celui que « Modifier le bot » a désigné)
 * et écrit chaque réglage tout de suite, comme la référence : apparence
 * (expression, forme, couleur du visage bloub, ou mascotte), nom, rôle,
 * description, langue de réponse, avis de fin, voix et vitesse de lecture.
 */
export function AgentEditorPanel() {
  const { botId: routeBotId } = useParams({ strict: false }) as { botId?: string };
  const open = useAgentEditor((state) => state.open);
  const pinnedBotId = useAgentEditor((state) => state.botId);
  const close = useAgentEditor((state) => state.close);
  const inline = useSyncExternalStore(subscribeInline, inlineSnapshot, () => true);
  const botId = pinnedBotId ?? routeBotId;
  const selectEditorBot = useCallback((roster: RosterDto) => editorBotOf(roster, botId), [botId]);
  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster, select: selectEditorBot });
  const bot = roster.data ?? null;
  // Sous 1100 px, le panneau couvre le fil : il ne s'ouvre que sur demande
  // (pilule du titre, « Modifier le bot »), jamais d'office à l'arrivée.
  const [overlayOpened, setOverlayOpened] = useState(false);
  useEffect(() => {
    if (inline) setOverlayOpened(false);
  }, [inline]);
  useEffect(() => useAgentEditor.subscribe((state) => {
    setOverlayOpened(state.open);
  }), []);
  const visible = Boolean(bot) && open && (inline || overlayOpened);
  // The inline editor stays mounted once opened (close transition, draft),
  // but not before: mounted closed, it cost every first paint ~50 ms.
  const [editorMounted, setEditorMounted] = useState(visible);
  if (visible && !editorMounted) setEditorMounted(true);

  if (inline) {
    return (
      <div
        className="min-h-0 shrink-0 overflow-hidden transition-[width,opacity] duration-300 ease-out motion-reduce:transition-none"
        style={{ width: visible ? 356 : 0, opacity: visible ? 1 : 0 }}
        aria-hidden={!visible}
        inert={!visible}
      >
        <div className="h-full w-[356px] ps-4">
          {bot && editorMounted ? <AgentEditor key={bot.id} bot={bot} onClose={close} /> : null}
        </div>
      </div>
    );
  }
  if (!visible || !bot) return null;
  return (
    <>
      <div
        aria-hidden
        className="fixed inset-0 z-40 bg-background-full/30 backdrop-blur-[6px]"
        onClick={() => { setOverlayOpened(false); close(); }}
      />
      <div className="bui-popover fixed inset-y-0 end-2 z-50 w-[min(340px,calc(100vw-16px))]">
        <AgentEditor key={bot.id} bot={bot} onClose={() => { setOverlayOpened(false); close(); }} />
      </div>
    </>
  );
}

/** Écrit un réglage du bot ; le roster en cache suit sans attendre. */
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

const AgentEditor = memo(function AgentEditor({ bot, onClose }: { bot: EditorBot; onClose: () => void }) {
  const { t } = useT();
  const patch = useBotPatch(bot);
  const openManage = useBotDialogs((state) => state.openManage);
  // Sans visage choisi, `BotFace` montre la mascotte dérivée de l'id : l'éditeur
  // part de ce même visage, pour que l'aperçu ne change pas à l'ouverture.
  const face: BotFaceSpec = bot.face ?? { ...defaultFaceFor(bot.id), artwork: defaultArtworkFor(bot.id).id };
  const setFace = (next: BotFaceSpec) => patch.mutate({ face: next });
  // Chaque onglet n'édite que le type d'avatar affiché : changer d'onglet est le
  // seul geste qui passe de la mascotte au visage. Revenir à « Mascotte » rend la
  // dernière mascotte portée pendant cette ouverture (l'éditeur est remonté par bot).
  const mascot = Boolean(face.artwork);
  const lastArtwork = useRef(face.artwork ?? defaultArtworkFor(bot.id).id);
  useEffect(() => {
    if (face.artwork) lastArtwork.current = face.artwork;
  }, [face.artwork]);
  const pickKind = (index: number) => {
    if (index === 0) {
      setFace({ ...face, artwork: lastArtwork.current });
      return;
    }
    const { artwork: _artwork, ...rest } = face;
    setFace({ ...DEFAULT_FACE, ...rest });
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
              index={mascot ? 0 : 1}
              options={[t("boardui.avatarMascot"), t("boardui.avatarFace")]}
              onChange={pickKind}
            />
          </div>
          {mascot ? (
            <MascotStage bot={bot} face={face} onFace={setFace} />
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
            {/* Le reste du bot (persona, modèle, approbations, capacités,
                mémoire, routines, archivage, suppression) vit sur sa page. */}
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

/** Les neuf places de l'arc des formes (décalages relevés sur la cible, en px). */
const SHAPE_SLOTS: ReadonlyArray<[number, number]> = [
  [-205.35, -132.06],
  [-178.94, -66.09],
  [-132.05, -12.71],
  [-70.03, 21.98],
  [0, 34],
  [70.03, 21.98],
  [132.05, -12.71],
  [178.94, -66.09],
  [205.35, -132.06],
];

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
  // La teinte ne se voit qu'à travers les yeux (des découpes du corps). Le corps
  // du visage fait la bulle (200/240 de 41 px = 34 px) et la teinte s'arrête à
  // 2 px du bord (`bg-clip-content`) : rien de pâle sur le contour, contre
  // lequel se posent l'anneau de sélection et celui du survol.
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
 * L'onglet Mascotte, à la place exacte de l'aperçu du visage, et ses mascottes
 * sur le même arc que les formes. Les portraits (toiles peintes, pas des
 * mascottes) ne s'y proposent plus ; un bot qui en porte déjà un le retrouve.
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

/** L'arc du bas : l'élément choisi au centre, ses voisins de part et d'autre. */
function ArcPicker<T extends { id: string }>({
  label,
  items,
  selectedId,
  itemLabel,
  onPick,
  renderItem,
}: {
  label: string;
  items: readonly T[];
  selectedId: string | undefined;
  itemLabel: (item: T) => string;
  onPick: (item: T) => void;
  renderItem: (item: T) => ReactNode;
}) {
  const selectedIndex = Math.max(0, items.findIndex((item) => item.id === selectedId));
  const arc = SHAPE_SLOTS.map((slot, slotIndex) => {
    const offset = slotIndex - 4;
    if (offset < -Math.floor(items.length / 2) || offset > Math.ceil(items.length / 2) - 1) return null;
    const item = items[(selectedIndex + offset + items.length) % items.length]!;
    return { slot, item, selected: offset === 0 };
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0">
      <div
        role="listbox"
        aria-label={label}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const step = event.key === "ArrowRight" ? 1 : -1;
          onPick(items[(selectedIndex + step + items.length) % items.length]!);
        }}
        className="pointer-events-auto relative h-[126px] w-full touch-pan-y overflow-hidden outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring"
        style={{
          maskImage: "linear-gradient(to right, transparent, black 8%, black 92%, transparent)",
          clipPath: "polygon(0 0, 15% 0, 30% 36%, 50% 50%, 70% 36%, 85% 0, 100% 0, 100% 100%, 0 100%)",
        }}
      >
        {arc.map(({ slot, item, selected }) => {
          const name = itemLabel(item);
          return (
            <div
              key={`${item.id}:${slot[0]}`}
              className="pointer-events-auto absolute top-[35px] left-1/2 -ml-7 size-14 transition-transform duration-300 ease-out motion-reduce:transition-none"
              style={{ transform: `translate(${slot[0]}px, ${slot[1]}px)` }}
            >
              <button
                type="button"
                role="option"
                aria-selected={selected}
                aria-label={name}
                title={name}
                tabIndex={-1}
                onClick={() => onPick(item)}
                className={cn(
                  "flex size-14 cursor-pointer items-center justify-center rounded-[16px] outline-none transition-colors hover:bg-background-secondary-default",
                  selected && "bg-background-secondary-default ring-1 ring-border-button-default",
                )}
              >
                {renderItem(item)}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Les neuf teintes de la pilule ; les autres sous l'arc-en-ciel. */
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

/* --- Nom, rôle, description ----------------------------------------------- */

const FIELD_SHELL =
  "relative flex w-full items-center rounded-2lg bg-background-tertiary-default text-foreground-icon-tertiary ring-2 ring-inset ring-transparent transition-[background-color,box-shadow,color] duration-150 focus-within:ring-border-focus-ring";
const FIELD_INPUT =
  "m-0 min-w-0 flex-1 border-0 bg-transparent p-0 px-1 text-left font-sans text-body-regular text-text-primary outline-none placeholder:text-text-tertiary focus:placeholder:text-text-primary disabled:cursor-not-allowed";

/** Un champ texte qui enregistre à la sortie (ou Entrée), sans bouton. */
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
      {/* Le rôle est la seule ligne sous le nom : la description de la création
          ne nourrit plus le bot ensuite (sa mission vit dans la persona), elle
          n'est donc plus éditée ici (choix de l'opérateur, 2026-10-26). */}
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

/* --- Langue, avis, voix --------------------------------------------------- */

type SelectOption = { value: string; label: string };

/** La liste déroulante du template : bouton bordé, liste de 240 px au plus. */
function BuiSelect({
  value,
  options,
  label,
  onChange,
  className,
}: {
  value: string;
  options: readonly SelectOption[];
  label: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((option) => option.value === value) ?? options[0];
  return (
    <BuiPopover open={open} onOpenChange={setOpen}>
      <BuiPopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${current?.label ?? ""} ${label}`}
          aria-haspopup="listbox"
          className={cn(
            "flex h-7 max-w-36 cursor-pointer items-center justify-between gap-1 rounded-2lg border border-border-button-default bg-background-primary-default ps-2 pe-1.5 text-text-primary shadow-xs outline-none transition-[background-color,border-color] duration-200 hover:border-border-button-hover hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2",
            className,
          )}
        >
          <span className="truncate text-body-2-medium">{current?.label}</span>
          <RiArrowDownSLine aria-hidden className={cn("size-4 shrink-0 text-foreground-icon-secondary transition-transform duration-200", open && "rotate-180")} />
        </button>
      </BuiPopoverTrigger>
      <BuiPopoverContent align="end" className="max-h-[240px] w-[174px] gap-1" role="listbox" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={option.value === value}
            onClick={() => { setOpen(false); if (option.value !== value) onChange(option.value); }}
            className={cn(
              "flex w-full shrink-0 cursor-pointer items-center gap-2 rounded-2lg px-2 py-1.5 text-start text-body-2-medium text-text-primary outline-none transition-colors hover:bg-dropdown-item-hover-background focus-visible:bg-dropdown-item-hover-background",
              option.value === value && "bg-dropdown-item-hover-background",
            )}
          >
            <span className="truncate">{option.label}</span>
          </button>
        ))}
      </BuiPopoverContent>
    </BuiPopover>
  );
}

function PreferencesCard({ bot, onPatch }: { bot: EditorBot; onPatch: (input: UpdateBotInput) => void }) {
  const { t, locale } = useT();
  const languages = useMemo<SelectOption[]>(() => {
    const names = typeof Intl !== "undefined" && "DisplayNames" in Intl
      ? new Intl.DisplayNames([locale], { type: "language" })
      : null;
    return BOT_REPLY_LANGUAGES.map((code) => ({
      value: code,
      label: code === "auto"
        ? t("boardui.autoDetect")
        : (names?.of(code) ?? code).replace(/^./, (letter) => letter.toUpperCase()),
    }));
  }, [locale, t]);
  return (
    <div className="flex w-full flex-col rounded-2xl bg-background-secondary-default px-3">
      <div className="flex min-h-14 items-center justify-between gap-3 py-3">
        <span className="flex items-center gap-2 text-body-medium text-text-primary">
          <RiGlobalLine aria-hidden className="size-5 shrink-0 text-foreground-icon-secondary" />
          {t("boardui.language")}
        </span>
        <BuiSelect
          value={bot.replyLanguage ?? "auto"}
          options={languages}
          label={t("boardui.agentLanguage")}
          onChange={(value) => onPatch({ replyLanguage: value as BotReplyLanguage })}
        />
      </div>
    </div>
  );
}

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

/** Le contrôle segmenté du template : un indicateur blanc glisse sous l'option choisie. */
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
