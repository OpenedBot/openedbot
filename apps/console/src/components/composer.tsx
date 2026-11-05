import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type ComponentType,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { Square } from "lucide-react";
import { RiAddFill, RiApps2AddLine, RiAttachment2, RiCheckLine, RiFocus3Line, RiListCheck3 } from "@remixicon/react";
import { BUI_PANEL_ITEM, BuiPopover, BuiPopoverContent, BuiPopoverTrigger, BuiSectionLabel } from "./boardui/menu";
import { GrokIcon } from "./grok/grok-icons";
import { useMobileDrawer } from "./mobile/mobile-drawer-shell";
import {
  cn,
  Dialog,
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  useCoarsePointer,
} from "@openedbot/browser-ui-kit";
import {
  composerFieldMaxHeight,
  keepSoftKeyboard,
  releaseComposerKeyboard,
  resizeComposerField,
  shouldSendComposerOnPointerDown,
  shouldSubmitComposerOnEnter,
} from "../lib/composer/composer-keyboard";
import { ComposerReplyTab } from "./composer-reply-tab";
import { nextComposerExpanded } from "../lib/composer/composer-pill";
import { animateComposerExpand } from "../lib/thread/thread-motion";
import { focusComposerField } from "../lib/composer/composer-desktop-focus";
import { isNativeShell } from "../lib/platform/native-bridge";
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_LIMITS,
  attachmentBytes,
  type MessageAttachmentInput,
} from "@openedbot/conversation/domain/attachments";
import { formatBytes } from "@openedbot/browser-i18n";
import { prepareAttachments, type AttachmentError } from "../lib/composer/attachments";
import {
  applyMention,
  bestPlainMatch,
  findMentionTrigger,
  findWordAtCaret,
  matchBots,
  type MentionableBot,
  type TextRange,
} from "@openedbot/roster/domain/mentions";
import { attachmentKindFor } from "@/lib/composer/attachments-file";
import { segmentMcpPlugins } from "@/lib/runtime/mcp-plugins";
import {
  caretOffsetLeft,
  markMentions,
  mentionEndingAt,
  mentionRanges,
  removeRange,
} from "../lib/composer/composer-mentions";
import { ComposerAttachmentTile } from "./composer-attachment-tile";
import { MentionSuggestions, mentionOptionId } from "./mention-suggestions";
import { draftAttachmentCanvasItem, useAttachmentCanvas } from "./attachment-canvas";
import { haptics } from "../lib/platform/haptics";
import { useT } from "../lib/i18n";
import { BUTTON } from "./settings/primitives";

/**
 * Le composer en pilule.
 *
 * Le textarea grandit avec le contenu jusqu'à un plafond, puis scrolle : une
 * hauteur fixe couperait un message multi-lignes qu'on est en train d'écrire,
 * et une croissance sans plafond mangerait le fil. La mesure passe par
 * `resizeComposerField` : `height: auto` seul est un no-op sur WebKit.
 */

/**
 * Un mot, lettre par lettre, sur l'arc-en-ciel.
 *
 * La teinte court sur 300°, du rouge au magenta, plutôt que sur le tour
 * complet : boucler ramènerait la dernière lettre à la couleur de la première,
 * et un mot de trois lettres n'aurait presque pas d'écart. La graduation se
 * fait sur `length - 1` pour que la dernière lettre atteigne vraiment le bout
 * du spectre ; un mot d'une lettre part au milieu.
 *
 * Le découpage passe par `Array.from` : `split("")` couperait un emoji ou un
 * caractère hors BMP en deux moitiés invalides, et le miroir n'afficherait
 * plus le même texte que le champ.
 */
const RAINBOW_ARC_DEGREES = 300;

function rainbowLetters(word: string): ReactNode[] {
  const letters = Array.from(word);
  return letters.map((letter, index) => (
    <span
      key={index}
      className="openedbot-mcp-letter"
      style={{
        "--openedbot-mcp-hue": `${
          letters.length === 1
            ? RAINBOW_ARC_DEGREES / 2
            : (index / (letters.length - 1)) * RAINBOW_ARC_DEGREES
        }deg`,
      } as CSSProperties}
    >
      {letter}
    </span>
  ));
}

type PendingTile = { index: number; name: string; image?: string; progress: number };

/** Référence stable : un `[]` littéral en défaut de prop re-rendrait à chaque frappe. */
const EMPTY_ATTACHMENTS: readonly MessageAttachmentInput[] = [];
const EMPTY_MCP_PLUGINS: readonly string[] = [];

function ComposerDisabledSurface({
  disabled,
  reason,
  coarse,
  children,
}: {
  disabled: boolean;
  reason?: string;
  coarse: boolean;
  children: ReactNode;
}) {
  const { t } = useT();
  const [dialogOpen, setDialogOpen] = useState(false);
  if (!disabled || !reason) return children;

  const trigger = coarse ? (
    <div className="relative w-full" data-composer-disabled-surface="">
      {children}
      <button
        type="button"
        aria-label={reason}
        className="absolute inset-0 z-10 cursor-not-allowed rounded-[22px] bg-transparent"
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => setDialogOpen(true)}
      />
    </div>
  ) : (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div data-composer-disabled-surface="">{children}</div>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8}>{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );

  return (
    <>
      {trigger}
      {coarse ? (
        <Dialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          role="alertdialog"
          title={t("conversation.unavailable")}
          description={reason}
          showClose={false}
          swipeToDismiss={false}
          closeLabel={t("common.close")}
          footer={(
            <button type="button" className={BUTTON.primary} onClick={() => setDialogOpen(false)}>
              {t("common.close")}
            </button>
          )}
        />
      ) : null}
    </>
  );
}

export function Composer({
  value,
  onChange,
  onSubmit,
  onCancel,
  botName,
  disabled,
  disabledReason,
  running,
  sending = false,
  mentionables = [],
  mcpPlugins = EMPTY_MCP_PLUGINS,
  attachments = EMPTY_ATTACHMENTS,
  onAttachmentsChange,
  modelControl,
  statusTab,
  statusLeft,
  contextMeter,
  notice,
  replyPreview,
  onCancelReply,
  goal,
  onSetGoal,
  onClearGoal,
  planFirst = false,
  onPlanFirstChange,
  onManagePlugins,
  showPlugins = true,
  planPending = false,
  onPlanLaunch,
  escapeStopsRun = true,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  /**
   * Desktop Escape stops the run when the field is empty (the Stop button's
   * own condition). A salon passes `false`: its stop ends the whole room,
   * too heavy for a key pressed by reflex.
   */
  escapeStopsRun?: boolean;
  botName: string;
  disabled: boolean;
  disabledReason?: string;
  running: boolean;
  /** Un POST d'envoi en vol : Envoyer se grise, il n'est pas rejoué. */
  sending?: boolean;
  /** Bot mode : les bots qu'une mention `@slug` peut atteindre (jamais celui du fil). */
  mentionables?: MentionableBot[];
  /**
   * Les serveurs MCP que l'hôte sert RÉELLEMENT aux runs, par leur nom. Écrire
   * l'un d'eux colore le mot dans le champ. Aide de lecture seulement : rien
   * ici ne décide qu'un outil sera appelé, c'est le runtime qui choisit.
   */
  mcpPlugins?: readonly string[];
  /**
   * Les pièces jointes du brouillon (US-CHAT-08). Tenues par l'ÉCRAN, comme le
   * texte : c'est lui qui sait si l'envoi a abouti, et donc quand vider. Un
   * état interne au composer se viderait à l'envoi, y compris quand le cloud API
   * refuse et que l'utilisateur devrait pouvoir réessayer.
   */
  attachments?: readonly MessageAttachmentInput[];
  onAttachmentsChange?: (next: MessageAttachmentInput[]) => void;
  /**
   * La ligne de statut sous la carte (26 px, texte tertiaire) : `statusLeft`
   * à gauche, `contextMeter` (anneau de contexte et pourcentage) à droite.
   * Chacun ne porte qu'une donnée réelle ; rien ne s'écrit sans eux.
   */
  statusLeft?: ReactNode;
  contextMeter?: ReactNode;
  /** Choix du modèle du prochain run, rendu dans la rangée d'actions. */
  modelControl?: ReactNode;
  /**
   * La barre de statut accrochée au bord HAUT de la coque : ce que le tour
   * précédent a occupé du contexte, et ce qui l'exécute. Elle fait corps avec
   * la carte (bordure basse partagée), donc elle vit ici et pas au-dessus du
   * composer en élément libre : détachée, elle flottait au milieu et ne se
   * lisait plus comme une propriété du composer.
   */
  statusTab?: ReactNode;
  /**
   * The status tab of BoardUI's Composer Panel: hung off the card's top
   * edge, 28 px in from each side, its lower part tucked under the card. It
   * says why the composer is held (the runtime is offline) and carries its
   * own actions, so the disabled surface adds neither tooltip nor tap veil.
   */
  notice?: ReactNode;
  /** Citation plate sélectionnée dans le fil; elle part avec le prochain envoi. */
  replyPreview?: { author: string; text: string } | null;
  onCancelReply?: () => void;
  /** L'objectif du fil : il précède chaque message tant qu'il est posé. */
  goal?: string | null;
  onSetGoal?: () => void;
  onClearGoal?: () => void;
  /**
   * « Planifier d'abord » (menu « + ») : les messages de ce fil demandent un
   * plan, sans toucher au mode du bot. Absent : le menu ne le propose pas.
   */
  planFirst?: boolean;
  onPlanFirstChange?: (next: boolean) => void;
  /** Aucun plugin branché : le menu mène aux intégrations. */
  onManagePlugins?: () => void;
  /** Salon : le menu « + » n'offre pas les plugins. */
  showPlugins?: boolean;
  /**
   * Une carte de plan est ouverte : le champ corrige le plan, le bouton
   * primaire est Lancer (champ vide) plutôt qu'Envoyer.
   */
  planPending?: boolean;
  onPlanLaunch?: () => void;
}) {
  const { t, locale } = useT();
  const coarse = useCoarsePointer();
  const mobileDrawer = useMobileDrawer();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Coque native : le champ prend le focus quand le fil devient disponible
  // (ouverture, changement de bot, gate tranchée) et au retour dans la
  // fenêtre (`lib/composer/composer-desktop-focus.ts`).
  const nativeShell = isNativeShell();
  useEffect(() => {
    if (nativeShell && !disabled) focusComposerField(textarea.current);
  }, [nativeShell, disabled, botName]);
  useEffect(() => {
    if (!nativeShell) return;
    // Chromium rend d'abord le focus au dernier élément, puis émet `focus` :
    // la décision se prend après lui.
    const onWindowFocus = () => requestAnimationFrame(() => focusComposerField(textarea.current, "return"));
    window.addEventListener("focus", onWindowFocus);
    return () => window.removeEventListener("focus", onWindowFocus);
  }, [nativeShell]);
  const listId = useId();
  const attachmentCanvas = useAttachmentCanvas();
  const [addOpen, setAddOpen] = useState(false);

  /**
   * Pièces jointes, trois entrées pour un seul geste : le bouton trombone, le
   * dépôt sur la pilule, le collage depuis le presse-papiers. Les trois
   * passent par `addFiles`, donc par les mêmes bornes et les mêmes refus
   * nommés ; une capture collée n'est pas un chemin à part.
   */
  const [preparing, setPreparing] = useState(false);
  const [errors, setErrors] = useState<AttachmentError[]>([]);
  // Compteur et non booléen : quitter un enfant de la pilule émet un
  // `dragleave` alors qu'on est toujours au-dessus d'elle.
  const [dragDepth, setDragDepth] = useState(0);

  /**
   * Les tuiles en cours de lecture. Le progrès est celui du `FileReader`
   * (`prepareAttachments`), jamais une horloge : un fichier qui n'en émet pas
   * saute de 0 à fait. Elles quittent la bande quand le lot est rendu à
   * l'écran, qui pose alors les vraies pièces à leur place.
   */
  const [pending, setPending] = useState<PendingTile[]>([]);

  const addFiles = async (files: readonly File[]) => {
    if (!files.length || !onAttachmentsChange || disabled) return;
    setPreparing(true);
    const previews: string[] = [];
    setPending(
      files.flatMap((file, index) => {
        const kind = attachmentKindFor(file);
        if (!kind) return [];
        let image: string | undefined;
        if (kind === "image" && typeof URL.createObjectURL === "function") {
          image = URL.createObjectURL(file);
          previews.push(image);
        }
        return [{ index, name: file.name, image, progress: 0 }];
      }),
    );
    try {
      const result = await prepareAttachments(files, attachments.length, (index, fraction) => {
        setPending((tiles) =>
          tiles.map((tile) => (tile.index === index ? { ...tile, progress: fraction * 100 } : tile)),
        );
      });
      if (result.attachments.length) onAttachmentsChange([...attachments, ...result.attachments]);
      setErrors(result.errors);
    } finally {
      setPending([]);
      for (const url of previews) URL.revokeObjectURL(url);
      setPreparing(false);
    }
  };

  const removeAttachment = (index: number) => {
    onAttachmentsChange?.(attachments.filter((_, position) => position !== index));
    setErrors([]);
  };

  /**
   * Le refus, dit à l'utilisateur : le nom du fichier ET la raison. Un
   * « fichier invalide » global laisserait deviner lequel des cinq coince.
   */
  const attachmentErrorText = (error: AttachmentError): string => {
    switch (error.code) {
      case "unsupported":
        return t("composer.attachmentUnsupported", { name: error.name });
      case "too-large":
        return t("composer.attachmentTooLarge", {
          name: error.name,
          size: formatBytes(locale, error.bytes),
          max: formatBytes(locale, ATTACHMENT_LIMITS.maxBytesEach),
        });
      case "too-many":
        return t("composer.attachmentTooMany", { max: String(ATTACHMENT_LIMITS.maxCount) });
      case "unreadable":
        return t("composer.attachmentUnreadable", { name: error.name });
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    // Un collage de TEXTE porte aussi des `items` : ne détourner l'événement
    // que s'il y a de vrais fichiers, sinon coller du texte n'insérerait plus
    // rien dans le champ.
    const files = [...event.clipboardData.files];
    if (!files.length) return;
    event.preventDefault();
    void addFiles(files);
  };

  /**
   * Bot mode, deux aides à la saisie dérivées du texte ET du caret :
   * - `@…` sous le caret ouvre la liste (flèches, Entrée/Tab, Échap) ;
   * - un mot nu qui commence comme un bot (« ne… ») propose « Mentionner
   *   @neo ? », accepté par Tab SEULEMENT. Entrée garde son sens (envoyer),
   *   sinon valider une phrase qui contient un nom de bot la réécrirait.
   */
  const [caret, setCaret] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  // Échap sur la liste : fermée jusqu'à la prochaine frappe.
  const [closedTriggerStart, setClosedTriggerStart] = useState<number | null>(null);
  // Échap sur la suggestion : muette tant qu'on est sur ce mot-là.
  const [dismissedWordStart, setDismissedWordStart] = useState<number | null>(null);

  const trigger = useMemo(() => findMentionTrigger(value, caret), [value, caret]);
  const atMatches = useMemo(
    () =>
      trigger && trigger.start !== closedTriggerStart ? matchBots(trigger.query, mentionables) : [],
    [trigger, closedTriggerStart, mentionables],
  );
  const atOpen = atMatches.length > 0;
  const word = useMemo(() => (atOpen ? null : findWordAtCaret(value, caret)), [atOpen, value, caret]);
  const plainHint = useMemo(
    () => (word && word.start !== dismissedWordStart ? bestPlainMatch(word.word, mentionables) : null),
    [word, dismissedWordStart, mentionables],
  );
  const activeBot = atMatches[Math.min(activeIndex, atMatches.length - 1)] ?? null;

  /**
   * Surbrillance des plugins MCP connectés, lettre par lettre.
   *
   * Un `textarea` ne colore pas un mot : le calque miroir posé DERRIÈRE lui
   * peint le texte entier, et le champ efface le sien
   * (`data-composer-text="mirrored"`, app.css). Ce qu'on y perd est rendu
   * ailleurs : le curseur par `caret-color`, la sélection par `::selection`
   * qui repeint le texte sélectionné.
   *
   * Reste un cas que le CSS ne peut pas rattraper : la PRÉ-ÉDITION IME. Tant
   * qu'une composition n'est pas validée, le champ affiche des caractères que
   * `value` ne porte pas encore. Le miroir ne les connaît donc pas, et un
   * champ effacé les rendrait invisibles pendant qu'on les tape. Le miroir se
   * retire le temps de la composition.
   */
  const [composing, setComposing] = useState(false);
  // Les pastilles de mention sont ce même calque : le champ reste un
  // `textarea`, la valeur reste `@slug` en clair, seule la peinture change.
  const mentionSlugs = useMemo(() => mentionables.map((bot) => bot.slug), [mentionables]);
  const mentionSpans = useMemo(() => mentionRanges(value, mentionSlugs), [value, mentionSlugs]);
  const mirrorSegments = useMemo(() => {
    const base = mcpPlugins.length
      ? segmentMcpPlugins(value, mcpPlugins)
      : value
        ? [{ kind: "text" as const, text: value }]
        : [];
    return markMentions(base, mentionSpans);
  }, [value, mcpPlugins, mentionSpans]);
  const highlightMcp =
    !composing &&
    mirrorSegments.some((segment) => segment.kind === "plugin" || segment.kind === "mention");
  const highlight = useRef<HTMLDivElement>(null);

  // La liste s'ouvre au caret (x du `@`), pas au coin de la carte.
  const column = useRef<HTMLDivElement>(null);
  const [menuLeft, setMenuLeft] = useState(0);
  const triggerStart = trigger?.start;
  useLayoutEffect(() => {
    const field = textarea.current;
    const box = column.current;
    if (!atOpen || triggerStart === undefined || !field || !box) return;
    const MENU_WIDTH = 288;
    const x =
      field.getBoundingClientRect().left - box.getBoundingClientRect().left +
      caretOffsetLeft(field, triggerStart) - 8;
    setMenuLeft(Math.max(0, Math.min(x, box.clientWidth - MENU_WIDTH)));
  }, [atOpen, triggerStart, value]);

  const readCaret = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    const element = event.currentTarget;
    setCaret(element.selectionStart ?? element.value.length);
  };

  const accept = (bot: MentionableBot, range: TextRange) => {
    const next = applyMention(value, range, bot.slug);
    onChange(next.text);
    setCaret(next.caret);
    setActiveIndex(0);
    setDismissedWordStart(null);
    // React repose la valeur au commit ; le caret se replace après, sinon il
    // finit en bout de texte.
    requestAnimationFrame(() => {
      const element = textarea.current;
      if (!element) return;
      element.setSelectionRange(next.caret, next.caret);
      element.focus();
      resize();
    });
  };

  /**
   * Pilule (bureau) : une rangée `+` | champ | actions tant que le texte tient
   * sur une ligne, une carte (texte en pleine largeur, actions dessous) dès
   * qu'il en demande une deuxième. La règle est dans `lib/composer/composer-pill.ts` ;
   * le shell mobile pose sa propre grille (`mobile.css`) et l'ignore.
   */
  const [expanded, setExpanded] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  // La hauteur et le rayon de la pilule juste avant qu'elle devienne carte :
  // le ressort part d'eux (`animateComposerExpand`).
  const expandFrom = useRef<{ height: number; radius: string } | null>(null);
  // Vrai après le premier rendu : une icône montée ensuite (envoyer, arrêter,
  // micro) apparaît comme chez Grok, celles de l'ouverture restent immobiles.
  const motionReady = useRef(false);
  useEffect(() => {
    motionReady.current = true;
  }, []);

  const resize = () => {
    const element = textarea.current;
    if (!element) return;
    // Champ vidé (après Envoyer, ou tout effacer au clavier) : rien à
    // mesurer. `resizeComposerField` pose `height: 0` PUIS lit `scrollHeight`,
    // une lecture qui force un reflow synchrone sur tout le document, mesuré
    // à 308 ms sur un fil de ~3500 nœuds pendant le commit de la touche
    // Entrée. `min-h-5` donne déjà la hauteur d'une ligne vide : on retire la
    // hauteur inline sans rien lire.
    if (element.value === "") {
      element.style.height = "";
      element.style.overflowY = "hidden";
      setExpanded(false);
      return;
    }
    const { height } = resizeComposerField(element, composerFieldMaxHeight());
    // Ouverte, la pilule le reste jusqu'au champ vide : pas de lecture de
    // style à chaque touche.
    if (!expanded) {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || 20;
      const next = nextComposerExpanded(false, { value: element.value, scrollHeight: height }, lineHeight);
      // Une seule lecture, et seulement à la bascule : la pilule est encore là.
      if (next && !coarse && shell.current) {
        expandFrom.current = {
          height: shell.current.getBoundingClientRect().height,
          radius: getComputedStyle(shell.current).borderRadius,
        };
      }
      setExpanded(next);
    }
  };

  // `value` est contrôlé par l'écran. Redimensionner uniquement dans
  // `onChange` arrive avant le commit React et manque les changements produits
  // par une mention, une reprise de brouillon ou un remplissage programmatique.
  // Le layout effect mesure la valeur réellement rendue, sans flash d'une
  // hauteur, puis laisse le textarea scroller au-delà de MAX_HEIGHT.
  // `expanded` aussi : la carte élargit le champ, sa hauteur se remesure
  // avant peinture.
  useLayoutEffect(() => {
    resize();
  }, [value, expanded]);

  // Pilule → carte : le cadre suit le ressort de Grok (300 ms) au lieu de
  // sauter. Le retour à la pilule (champ vidé, envoi) reste net, comme chez lui.
  useLayoutEffect(() => {
    const from = expandFrom.current;
    expandFrom.current = null;
    if (!expanded || from === null || !shell.current) return;
    animateComposerExpand(shell.current, from);
  }, [expanded]);

  /** Ce qu'il y a à envoyer : du texte, OU des pièces jointes. Joindre une
   *  capture sans écrire un mot est un envoi légitime. */
  const empty = !value.trim() && attachments.length === 0;
  // Carte de plan ouverte, champ vide : Lancer, pas la flèche Envoyer.
  // Un texte dans le champ reste une correction, envoyée par la flèche.
  const showLaunch = Boolean(planPending && onPlanLaunch) && !running && empty;
  // Pendant un run, un brouillon remplace Stop par Envoyer : les deux actions
  // côte à côte donnaient deux boutons primaires concurrents et faisaient
  // croire qu'il fallait interrompre avant d'ajouter une instruction.
  const showSend = !showLaunch && (running ? !empty : true);
  // Sans languette ni modèle (salon), personne ne porte `ml-auto` : le bouton
  // principal pousse alors le groupe droit au bout.
  const anchorRight = !statusTab && !modelControl;
  const primaryAnchor = anchorRight && "sm:ml-auto";
  const sendBlocked = disabled || preparing || empty || sending;
  // Partagé par le champ et son calque miroir, sinon le calque peint à côté.
  const fieldPadding = expanded ? "sm:px-2.5 sm:pt-2 sm:pb-1" : "sm:px-2";
  // Doigt : l'envoi part au pointerdown. Sans ce verrou, `click` le rejouerait.
  const sentOnPointerDown = useRef(false);

  const submit = () => {
    // `preparing` bloque : envoyer pendant qu'un fichier se lit partirait sans
    // lui, en silence.
    if (sendBlocked) return;
    setErrors([]);
    onSubmit();
    // La hauteur ne revient pas seule : le contenu part, le style inline reste.
    // Doigt : blur APRÈS l'envoi. Blur au pointerdown refermait le clavier
    // avant le click. Le premier tap ne servait qu'à rentrer le clavier.
    requestAnimationFrame(() => {
      resize();
      if (coarse) releaseComposerKeyboard();
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // `isComposing` protège la saisie IME : sans lui, valider un caractère
    // japonais enverrait le message ou accepterait une mention.
    if (event.nativeEvent.isComposing) return;

    if (atOpen && trigger) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((index) => (index + step + atMatches.length) % atMatches.length);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        // Entrée choisit, elle n'envoie pas : la liste est ouverte.
        event.preventDefault();
        if (activeBot) accept(activeBot, trigger);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setClosedTriggerStart(trigger.start);
        return;
      }
    } else if (plainHint && word) {
      if (event.key === "Tab") {
        event.preventDefault();
        accept(plainHint, word);
        return;
      }
      if (event.key === "Escape") {
        setDismissedWordStart(word.start);
        return;
      }
    }

    // Une pastille de mention part d'un bloc : Retour arrière juste après
    // `@slug` retire tout le jeton, pas une lettre (sinon il cesse d'en être un).
    if (event.key === "Backspace" && mentionSpans.length) {
      const field = event.currentTarget;
      if (field.selectionStart === field.selectionEnd) {
        const range = mentionEndingAt(value, field.selectionStart, mentionSlugs);
        if (range) {
          event.preventDefault();
          const next = removeRange(value, range);
          onChange(next.text);
          setCaret(next.caret);
          requestAnimationFrame(() => field.setSelectionRange(next.caret, next.caret));
          return;
        }
      }
    }

    // Bureau : Entrée envoie. Doigt : Entrée = newline (pas de Maj sur iOS).
    if (shouldSubmitComposerOnEnter(event, coarse)) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === "Escape" && replyPreview && onCancelReply) {
      event.preventDefault();
      onCancelReply();
      return;
    }
    // Desktop: Escape stops the run in progress, as every agent composer
    // does (pulseview composer kit, `busy`), but only while the Stop button
    // is the one shown, i.e. the field is empty: Escape inside a draft is
    // not an order to stop. Never on a finger: a soft keyboard has no
    // Escape, and a hardware one on a tablet should not stop a run by surprise.
    if (event.key === "Escape" && running && empty && escapeStopsRun && !coarse) {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <ComposerDisabledSurface disabled={disabled && !notice} reason={disabledReason} coarse={coarse}>
      <div
      data-thread-composer=""
      className="shrink-0 px-4 pt-2 pb-[max(1rem,var(--openedbot-safe-bottom))] sm:p-1"
      >
      <div ref={column} className="relative w-full">
        {atOpen ? (
          <MentionSuggestions
            id={listId}
            left={menuLeft}
            bots={atMatches}
            activeIndex={Math.min(activeIndex, atMatches.length - 1)}
            onHover={setActiveIndex}
            onPick={(bot) => trigger && accept(bot, trigger)}
          />
        ) : plainHint && word ? (
          <p
            role="status"
            aria-live="polite"
            className="absolute bottom-full left-4 mb-1 flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <span>{t("composer.mentionHint", { slug: plainHint.slug })}</span>
            <kbd className="rounded border border-border px-1 font-mono text-[10px]">
              {t("composer.mentionHintKey")}
            </kbd>
          </p>
        ) : null}
        {errors.length ? (
          <p role="alert" className="mb-1 px-4 text-xs text-destructive-text">
            {errors.map(attachmentErrorText).join(" ")}
          </p>
        ) : null}
        {notice ? (
          // Not positioned on purpose: the card that follows paints its
          // background over the tab's lower padding, which hides under it.
          <div data-composer-notice="" className="mx-7 -mb-3">
            {notice}
          </div>
        ) : null}
        {replyPreview ? <ComposerReplyTab preview={replyPreview} onCancel={onCancelReply} /> : null}
        <div
          ref={shell}
          data-composer-shell=""
          onDragEnter={(event) => {
            if (!onAttachmentsChange || disabled || !event.dataTransfer.types.includes("Files")) return;
            setDragDepth((depth) => depth + 1);
          }}
          onDragOver={(event) => {
            // Sans ce `preventDefault`, le navigateur OUVRE le fichier déposé.
            // l'onglet est remplacé par l'image et la conversation est perdue.
            if (dragDepth > 0) event.preventDefault();
          }}
          onDragLeave={() => setDragDepth((depth) => Math.max(0, depth - 1))}
          onDrop={(event: DragEvent<HTMLDivElement>) => {
            if (!dragDepth) return;
            event.preventDefault();
            setDragDepth(0);
            void addFiles([...event.dataTransfer.files]);
          }}
          className={cn(
            // Mesuré sur streaming-ui.pulseview.app (composer Mention) :
            // carte blanche, rayon 22, liseré 1 px
            // (#ebebeb), `shadow-xs`, rembourrage 8 (7 au bureau : la pilule de
            // Grok Bot fait 44 px, actions de 28 px comprises). Au focus-within le
            // liseré prend la bordure de survol et l'ombre passe à `shadow-sm`,
            // en 200 ms sur `border-color` et `box-shadow`.
            "relative flex flex-col border border-composer-edge bg-background-primary-default p-2 sm:p-[7px] shadow-xs transition-[border-color,box-shadow,background-color] duration-200 focus-within:border-composer-edge-hover focus-within:shadow-sm",
            // Les QUATRE coins restent arrondis, barre de statut ou non :
            // mesuré sur BoardUI, la barre est posée DERRIÈRE la carte et
            // dépasse par le haut. C'est ce liseré gris aux extrémités qui
            // fait l'onglet. Une carte à coins hauts droits ne se lit plus
            // comme une carte.
            "rounded-[var(--radius-2-5xl)]",
            // Grok Bot : la pilule est à 22, la carte à 18 (au bureau ; le
            // shell mobile garde sa forme).
            expanded && "sm:rounded-[18px]",
            // A translucent card would let the tucked-in tab show through it.
            disabled && !notice && "opacity-60",
            dragDepth > 0 && "bg-primary/10",
          )}
        >
          {goal ? (
            <div data-composer-goal="" className="flex min-w-0 items-center gap-2 px-1.5 pt-1">
              <RiFocus3Line className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
              <p className="min-w-0 flex-1 truncate text-body-2-medium text-text-secondary" title={goal}>
                <span className="text-text-primary">{t("boardui.goal")}</span>
                <span className="ms-1.5">{goal}</span>
              </p>
              {onClearGoal ? (
                <button
                  type="button"
                  onPointerDown={keepSoftKeyboard}
                  onClick={onClearGoal}
                  aria-label={t("boardui.clearGoal")}
                  title={t("boardui.clearGoal")}
                  className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-background-tertiary-default text-foreground-icon-secondary outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
                >
                  <svg width="8" height="8" viewBox="0 0 10.8 10.8" fill="none" aria-hidden>
                    <path d="M2 2L8.8 8.8M8.8 2L2 8.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              ) : null}
            </div>
          ) : null}
          {planFirst ? (
            <div data-composer-plan-first="" className="flex min-w-0 items-center gap-2 px-1.5 pt-1">
              <RiListCheck3 className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
              <p className="min-w-0 flex-1 truncate text-body-2-medium text-text-secondary">
                <span className="text-text-primary">{t("boardui.planFirstOn")}</span>
                <span className="ms-1.5">{t("boardui.planFirstChip", { name: botName })}</span>
              </p>
              {onPlanFirstChange ? (
                <button
                  type="button"
                  onPointerDown={keepSoftKeyboard}
                  onClick={() => onPlanFirstChange(false)}
                  aria-label={t("boardui.clearPlanFirst")}
                  title={t("boardui.clearPlanFirst")}
                  className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-background-tertiary-default text-foreground-icon-secondary outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
                >
                  <svg width="8" height="8" viewBox="0 0 10.8 10.8" fill="none" aria-hidden>
                    <path d="M2 2L8.8 8.8M8.8 2L2 8.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              ) : null}
            </div>
          ) : null}
          {attachments.length || pending.length ? (
            /* Bande de tuiles de 56 px, espacées de 8 (composer Mention du
               kit streaming-ui) : anneau d'accent et pourcentage pendant la
               lecture, puis le bouton de retrait. */
            <ul
              data-composer-attachments=""
              className="flex flex-wrap gap-2 px-1 pt-1 pb-1"
              aria-label={t("composer.attachmentsLabel")}
            >
              {attachments.map((attachment, index) => {
                const image = attachment.kind === "image"
                  ? attachment.content.find(
                      (part): part is Extract<(typeof attachment.content)[number], { type: "image" }> => part.type === "image",
                    )
                  : undefined;
                return (
                  <ComposerAttachmentTile
                    key={`${attachment.name}:${index}`}
                    landed
                    name={attachment.name}
                    image={image?.image}
                    title={`${attachment.name} · ${formatBytes(locale, attachmentBytes(attachment))}`}
                    onRemove={() => removeAttachment(index)}
                    removeLabel={t("composer.attachmentRemove", { name: attachment.name })}
                    open={image && attachmentCanvas
                      ? {
                          label: t("composer.attachmentOpen", { name: attachment.name }),
                          onOpen: () => {
                            releaseComposerKeyboard();
                            attachmentCanvas.open(draftAttachmentCanvasItem(attachment));
                          },
                        }
                      : undefined}
                  />
                );
              })}
              {pending.map((tile) => (
                <ComposerAttachmentTile
                  key={`pending:${tile.index}`}
                  name={tile.name}
                  image={tile.image}
                  progress={tile.progress}
                  removeLabel={t("composer.attachmentRemove", { name: tile.name })}
                />
              ))}
            </ul>
          ) : null}
          {/* Une seule rangée dans le DOM, deux lignes au rendu large : le
              champ prend toute la largeur, les contrôles passent dessous. Les
              boutons restent enfants DIRECTS de la rangée, sinon les `order`
              du shell mobile (mobile.css) ne les atteignent plus. */}
          <div
            data-composer-row=""
            data-composer-expanded={expanded ? "" : undefined}
            className={cn("flex items-end gap-2 sm:items-center sm:gap-1.5", expanded && "sm:flex-wrap sm:gap-y-1")}
          >
            {onAttachmentsChange ? (
              <>
                {/* Le vrai champ reste hors écran : sa présentation native ne
                    peut pas être stylée, et c'est le bouton qui porte le
                    libellé accessible. */}
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  accept={ATTACHMENT_ACCEPT}
                  className="hidden"
                  onChange={(event) => {
                    void addFiles([...(event.target.files ?? [])]);
                    // Sans ce vidage, re-choisir LE MÊME fichier n'émettrait
                    // plus aucun `change`.
                    event.target.value = "";
                  }}
                />
                {mobileDrawer ? (
                  <Drawer
                    open={addOpen}
                    shouldScaleBackground={false}
                    onOpenChange={(next) => {
                      if (next) haptics.light();
                      setAddOpen(next);
                    }}
                  >
                    <DrawerTrigger asChild>
                      <button
                        data-composer-attachment=""
                        type="button"
                        onPointerDown={keepSoftKeyboard}
                        disabled={disabled || preparing}
                        aria-label={t("composer.addAttachment")}
                        title={t("composer.addAttachment")}
                        className="openedbot-press mb-0.5 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:opacity-40"
                      >
                        {addOpen
                          ? <svg width="10.8" height="10.8" viewBox="0 0 10.8 10.8" fill="none" aria-hidden><path d="M2 2L8.8 8.8M8.8 2L2 8.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                          : <RiAddFill className="size-5 transition-transform duration-200" aria-hidden />}
                      </button>
                    </DrawerTrigger>
                    <DrawerContent
                      aria-label={t("boardui.addToChat")}
                      className="border-0 bg-background-primary-default px-3 pb-[max(0.75rem,var(--openedbot-safe-bottom))] text-text-primary"
                      style={{ borderTopLeftRadius: 16, borderTopRightRadius: 16 }}
                    >
                      <DrawerTitle className="sr-only">{t("boardui.addToChat")}</DrawerTitle>
                      <AddMenuBody
                        sheet
                        attachmentsCount={attachments.length}
                        mcpPlugins={mcpPlugins}
                        value={value}
                        onChange={onChange}
                        textareaRef={textarea}
                        fileInput={fileInput}
                        onSetGoal={onSetGoal}
                        planFirst={planFirst}
                        onPlanFirstChange={onPlanFirstChange}
                        onManagePlugins={onManagePlugins}
                        showPlugins={showPlugins}
                        close={() => setAddOpen(false)}
                      />
                    </DrawerContent>
                  </Drawer>
                ) : (
                <BuiPopover open={addOpen} onOpenChange={setAddOpen}>
                  <BuiPopoverTrigger asChild>
                    <button
                      data-composer-attachment=""
                      type="button"
                      onPointerDown={keepSoftKeyboard}
                      disabled={disabled || preparing}
                      aria-label={t("composer.addAttachment")}
                      title={t("composer.addAttachment")}
                      className="openedbot-press mb-0.5 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:opacity-40 sm:order-1 sm:mb-0 sm:size-7 sm:bg-composer-panel-add-background sm:p-1 sm:text-foreground-icon-primary sm:hover:bg-composer-panel-add-hover-background sm:active:scale-[0.96]"
                    >
                      {addOpen
                        ? <svg width="10.8" height="10.8" viewBox="0 0 10.8 10.8" fill="none" aria-hidden><path d="M2 2L8.8 8.8M8.8 2L2 8.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                        : <GrokIcon name="plus" className="size-5 transition-transform duration-200" />}
                    </button>
                  </BuiPopoverTrigger>
                  <BuiPopoverContent
                    side="top"
                    align="start"
                    sideOffset={8}
                    className="w-[343px] gap-2"
                    aria-label={t("boardui.addToChat")}
                  >
                    <div className="flex w-full flex-col gap-1.5 pt-1">
                      <BuiSectionLabel>{t("boardui.add")}</BuiSectionLabel>
                      <div className="flex w-full flex-col gap-1">
                        <AddMenuRow
                          icon={RiAttachment2}
                          title={t("boardui.filesAndFolders")}
                          disabled={attachments.length >= ATTACHMENT_LIMITS.maxCount}
                          onSelect={() => { setAddOpen(false); fileInput.current?.click(); }}
                        />
                        {onSetGoal ? (
                          <AddMenuRow
                            icon={RiFocus3Line}
                            title={t("boardui.goal")}
                            hint={t("boardui.goalHint")}
                            onSelect={() => { setAddOpen(false); onSetGoal(); }}
                          />
                        ) : null}
                        {onPlanFirstChange ? (
                          <AddMenuRow
                            icon={RiListCheck3}
                            title={t("boardui.planFirst")}
                            hint={t("boardui.planFirstHint")}
                            checked={planFirst}
                            onSelect={() => { setAddOpen(false); onPlanFirstChange(!planFirst); }}
                          />
                        ) : null}
                      </div>
                    </div>
                    {showPlugins ? <div className="flex w-full flex-col gap-1.5 pt-1">
                      <BuiSectionLabel>{t("boardui.plugins")}</BuiSectionLabel>
                      <div className="flex w-full flex-col gap-1">
                        {mcpPlugins.map((plugin) => (
                          <AddMenuRow
                            key={plugin}
                            leading={<PluginBadge name={plugin} />}
                            title={plugin}
                            hint={t("boardui.pluginHint")}
                            onSelect={() => {
                              setAddOpen(false);
                              const next = value.trim() ? `${value.replace(/\s+$/, "")} ${plugin} ` : `${plugin} `;
                              onChange(next);
                              requestAnimationFrame(() => {
                                const field = textarea.current;
                                if (!field) return;
                                field.focus();
                                field.setSelectionRange(next.length, next.length);
                              });
                            }}
                          />
                        ))}
                        {onManagePlugins ? (
                          <AddMenuRow
                            icon={RiApps2AddLine}
                            title={mcpPlugins.length ? t("boardui.managePlugins") : t("boardui.connectPlugins")}
                            hint={mcpPlugins.length ? undefined : t("boardui.connectPluginsHint")}
                            onSelect={() => { setAddOpen(false); onManagePlugins(); }}
                          />
                        ) : null}
                      </div>
                    </div> : null}
                  </BuiPopoverContent>
                </BuiPopover>
                )}
              </>
            ) : null}
            {statusTab ? (
              <div data-composer-status="" className="hidden min-w-0 sm:order-3 sm:ml-auto sm:flex">
                {statusTab}
              </div>
            ) : null}
            {/* Le champ n'est plus l'enfant direct de la rangée : le calque
                miroir a besoin d'un parent positionné. C'est donc CE nœud qui
                porte la place du champ dans la barre du bas mobile : ordre,
                marges (`data-composer-field`, mobile.css). Sans lui, `order`
                visait un nœud sorti du contexte flex : le trombone passait
                après le champ. */}
            <div
              data-composer-field=""
              className={cn(
                "relative my-1.5 min-w-0 flex-1 sm:my-0",
                // Compacte, le champ suit le `+` (même `order`, placé après
                // lui dans le DOM) et précède la permission.
                expanded ? "sm:order-first sm:basis-full" : "sm:order-1",
                fieldPadding,
              )}
            >
              {highlightMcp ? (
                /* `aria-hidden` : le lecteur d'écran lit le champ, pas son
                   décor. `pointer-events-none` : le tap traverse jusqu'au
                   champ, y compris sur un mot coloré. */
                <div
                  ref={highlight}
                  aria-hidden
                  data-composer-mcp-highlight=""
                  className={cn("pointer-events-none absolute inset-0 select-none overflow-hidden whitespace-pre-wrap break-words text-body-regular text-text-primary", fieldPadding)}
                >
                  {mirrorSegments.map((segment, index) =>
                    segment.kind === "mention" ? (
                      // Pastille teintée sur les caractères tapés : le rembourrage
                      // est repris par une marge négative, la largeur du texte ne bouge pas.
                      <span
                        key={index}
                        data-composer-mention-chip=""
                        className="-mx-[3px] rounded-md bg-violet-500/10 px-[3px] text-violet-700 dark:bg-violet-400/15 dark:text-violet-300"
                      >
                        {segment.text}
                      </span>
                    ) : segment.kind === "plugin" ? (
                      <span
                        key={index}
                        data-composer-mcp-plugin={segment.name}
                        data-composer-mcp-match={segment.match}
                        className={cn(
                          "font-medium",
                          // Un nom approché reste une SUPPOSITION : il se
                          // souligne, pour ne pas se lire comme un nom juste.
                          segment.match === "approximate" &&
                            "underline decoration-dotted underline-offset-2",
                        )}
                      >
                        {rainbowLetters(segment.text)}
                      </span>
                    ) : (
                      <span key={index}>{segment.text}</span>
                    ),
                  )}
                </div>
              ) : null}
              <textarea
                ref={textarea}
                data-composer=""
                value={value}
                onChange={(event) => {
                  onChange(event.target.value);
                  readCaret(event);
                  setClosedTriggerStart(null);
                  const nextCaret = event.currentTarget.selectionStart ?? event.target.value.length;
                  // Le mot a changé de nature (espace, texte vidé) : la suggestion
                  // muette peut reparler sur le prochain mot.
                  if (!findWordAtCaret(event.target.value, nextCaret)) setDismissedWordStart(null);
                  // Pas de `resize()` ici : le layout effect ci-dessus mesure la
                  // valeur RÉELLEMENT rendue, avant peinture. Le faire aussi dans
                  // `onChange` doublait les reflows synchrones (`height: 0` puis
                  // lecture de `scrollHeight`) à chaque touche, sans rien changer
                  // au résultat.
                }}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                onKeyUp={readCaret}
                onClick={readCaret}
                onSelect={readCaret}
                // Motif « textbox avec liste d'auto-complétion » : `aria-controls`
                // + `aria-activedescendant` suffisent à annoncer la liste et
                // l'option active. Pas de `role="combobox"` ni d'`aria-expanded` :
                // ni l'un ni l'autre n'est permis sur un `textarea` (axe :
                // `aria-allowed-role`, `aria-allowed-attr`).
                aria-autocomplete="list"
                aria-controls={atOpen ? listId : undefined}
                aria-activedescendant={atOpen && activeBot ? mentionOptionId(listId, activeBot.id) : undefined}
                rows={1}
                spellCheck={coarse ? false : undefined}
                enterKeyHint={coarse ? "enter" : "send"}
                disabled={disabled}
                placeholder={
                  disabled && disabledReason
                    ? disabledReason
                    : planPending
                      ? t("planCard.correctPlaceholder")
                      : replyPreview
                        ? t("composer.replyPlaceholder")
                        : coarse
                          // Au doigt, le nom du bot est déjà dans l'en-tête :
                          // « Message CTO architecte symfony » passait sur deux lignes.
                          ? t("mobileComposer.placeholder")
                          : t("composer.messagePlaceholder", { botName })
                }
                aria-label={t("composer.messageAriaLabel", { botName })}
                // `mirrored` : le champ efface son texte et laisse le calque le
                // peindre (couleur, curseur et sélection : app.css). L'attribut
                // n'est posé QUE le temps qu'un nom de plugin soit à l'écran.
                data-composer-text={highlightMcp ? "mirrored" : undefined}
                // Une composition IME affiche des caractères que `value` ne
                // porte pas encore : le calque se retire, le champ reprend son
                // texte. `onKeyDown` a déjà son propre garde-fou `isComposing`.
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={() => setComposing(false)}
                className="scrollbar-subtle relative block max-h-[200px] min-h-5 w-full resize-none overflow-hidden bg-transparent p-0 text-body-regular text-text-primary caret-accent-500 outline-none placeholder:text-text-tertiary [&:placeholder-shown]:truncate"
                // Au-delà du plafond le champ scrolle : sans ce report, les fonds
                // restaient en haut pendant que le texte défilait.
                onScroll={(event) => {
                  const layer = highlight.current;
                  if (layer) layer.scrollTop = event.currentTarget.scrollTop;
                }}
              />
            </div>

            {/* Le groupe droit commence ici : `ml-auto` le pousse au bout de
                la deuxième ligne. Sur le shell mobile, le wrapper n'a pas
                d'`order` propre, exactement comme le nœud qu'il remplace. */}
            {modelControl ? (
              <div data-composer-model="" className={cn("contents sm:order-4 sm:me-2 sm:block", !statusTab && "sm:ml-auto")}>
                {modelControl}
              </div>
            ) : null}

            {running && empty ? (
              <button
                data-composer-action="stop"
                data-composer-stop-action=""
                data-composer-primary-action=""
                type="button"
                onPointerDown={keepSoftKeyboard}
                onClick={onCancel}
                className={cn("openedbot-press mb-0.5 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full bg-background-tertiary-default text-foreground-icon-primary outline-none transition-colors hover:bg-background-tertiary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring sm:order-6 sm:mb-0 sm:size-7", primaryAnchor)}
                aria-label={t("composer.stopGeneration")}
                aria-keyshortcuts={coarse || !escapeStopsRun ? undefined : "Escape"}
                title={coarse || !escapeStopsRun ? undefined : t("composer.stopGenerationShortcut")}
              >
                <SwapIcon ready={motionReady}>
                  <Square className="size-3.5 fill-current" />
                </SwapIcon>
              </button>
            ) : null}
            {showLaunch ? (
              <button
                data-composer-action="launch"
                data-composer-primary-action=""
                data-plan-launch=""
                type="button"
                onPointerDown={keepSoftKeyboard}
                onClick={onPlanLaunch}
                disabled={disabled || preparing || sending}
                className={cn("openedbot-press bg-button-primary mb-0.5 flex h-11 min-h-11 shrink-0 cursor-pointer items-center justify-center rounded-full px-3.5 text-[15px] font-semibold text-white outline-none transition-opacity duration-200 focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40 sm:order-6 sm:mb-0 sm:h-7 sm:min-h-7 sm:px-2.5 sm:text-[13px]", primaryAnchor)}
                aria-label={t("planCard.launch")}
              >
                {t("planCard.launch")}
              </button>
            ) : null}
            {showSend ? (
              <button
                data-composer-action="send"
                data-composer-primary-action=""
                data-composer-send-action=""
                type="button"
                onPointerDown={(event) => {
                  keepSoftKeyboard(event);
                  if (!shouldSendComposerOnPointerDown(coarse)) return;
                  sentOnPointerDown.current = true;
                  submit();
                }}
                onClick={() => {
                  if (sentOnPointerDown.current) {
                    sentOnPointerDown.current = false;
                    return;
                  }
                  submit();
                }}
                disabled={sendBlocked}
                className={cn("openedbot-press bg-button-primary mb-0.5 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full p-2 text-white outline-none transition-[opacity,scale] duration-200 focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-30 sm:order-6 sm:mb-0 sm:size-7 sm:p-1 sm:active:scale-95", primaryAnchor)}
                aria-label={planPending ? t("planCard.sendCorrection") : t("composer.send")}
              >
                <SwapIcon ready={motionReady}>
                  <GrokIcon name="arrowUp" className="size-4 sm:size-5" />
                </SwapIcon>
              </button>
            ) : null}
          </div>
        </div>
        {statusLeft || contextMeter ? (
          // The line under the card (composer Mention): 26 px, tertiary text,
          // 16 px icons, one real fact on each side.
          <div
            data-composer-statusline=""
            className="flex h-[26px] items-center justify-between gap-3 px-2 text-body-2-medium text-text-tertiary [&_svg]:size-4"
          >
            {statusLeft ?? <span />}
            <span className="flex min-w-0 items-center gap-2">{contextMeter}</span>
          </div>
        ) : null}
      </div>
      </div>
    </ComposerDisabledSurface>
  );
}

function AddMenuBody({
  sheet,
  attachmentsCount,
  mcpPlugins,
  value,
  onChange,
  textareaRef,
  fileInput,
  onSetGoal,
  planFirst,
  onPlanFirstChange,
  onManagePlugins,
  showPlugins,
  close,
}: {
  sheet?: boolean;
  attachmentsCount: number;
  mcpPlugins: readonly string[];
  value: string;
  onChange: (next: string) => void;
  textareaRef: { current: HTMLTextAreaElement | null };
  fileInput: { current: HTMLInputElement | null };
  onSetGoal?: () => void;
  planFirst: boolean;
  onPlanFirstChange?: (next: boolean) => void;
  onManagePlugins?: () => void;
  showPlugins: boolean;
  close: () => void;
}) {
  const { t } = useT();
  const row = sheet ? "min-h-11" : undefined;
  return (
    <>
      <div className="flex w-full flex-col gap-1.5 pt-1">
        <BuiSectionLabel>{t("boardui.add")}</BuiSectionLabel>
        <div className="flex w-full flex-col gap-1">
          <AddMenuRow
            className={row}
            icon={RiAttachment2}
            title={t("boardui.filesAndFolders")}
            disabled={attachmentsCount >= ATTACHMENT_LIMITS.maxCount}
            onSelect={() => { close(); fileInput.current?.click(); }}
          />
          {onSetGoal ? (
            <AddMenuRow className={row} icon={RiFocus3Line} title={t("boardui.goal")} hint={t("boardui.goalHint")} onSelect={() => { close(); onSetGoal(); }} />
          ) : null}
          {onPlanFirstChange ? (
            <AddMenuRow
              className={row}
              icon={RiListCheck3}
              title={t("boardui.planFirst")}
              hint={t("boardui.planFirstHint")}
              checked={planFirst}
              onSelect={() => { close(); onPlanFirstChange(!planFirst); }}
            />
          ) : null}
        </div>
      </div>
      {showPlugins ? <div className="flex w-full flex-col gap-1.5 pt-1">
        <BuiSectionLabel>{t("boardui.plugins")}</BuiSectionLabel>
        <div className="flex w-full flex-col gap-1">
          {mcpPlugins.map((plugin) => (
            <AddMenuRow
              key={plugin}
              className={row}
              leading={<PluginBadge name={plugin} />}
              title={plugin}
              hint={t("boardui.pluginHint")}
              onSelect={() => {
                close();
                const next = value.trim() ? `${value.replace(/\s+$/, "")} ${plugin} ` : `${plugin} `;
                onChange(next);
                requestAnimationFrame(() => {
                  const field = textareaRef.current;
                  if (!field) return;
                  field.focus();
                  field.setSelectionRange(next.length, next.length);
                });
              }}
            />
          ))}
          {onManagePlugins ? (
            <AddMenuRow
              className={row}
              icon={RiApps2AddLine}
              title={mcpPlugins.length ? t("boardui.managePlugins") : t("boardui.connectPlugins")}
              hint={mcpPlugins.length ? undefined : t("boardui.connectPluginsHint")}
              onSelect={() => { close(); onManagePlugins(); }}
            />
          ) : null}
        </div>
      </div> : null}
    </>
  );
}

/** Une ligne du menu « + » : icône 20 px, titre, puis l'aide en gris sur la même ligne. */
function AddMenuRow({
  icon: Icon,
  leading,
  title,
  hint,
  disabled,
  checked,
  onSelect,
  className,
}: {
  icon?: ComponentType<{ className?: string }>;
  leading?: ReactNode;
  title: string;
  hint?: string;
  disabled?: boolean;
  /** A switch row: pressed while on, with a check at the end. */
  checked?: boolean;
  onSelect: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={checked === undefined ? undefined : checked}
      onClick={onSelect}
      className={cn(BUI_PANEL_ITEM, "active:bg-background-primary-hover", className)}
    >
      {leading ?? (Icon ? <Icon className="size-5 shrink-0 text-foreground-icon-secondary" /> : null)}
      <span className="min-w-0 flex-1 truncate text-body-medium whitespace-nowrap">
        <span className="text-text-primary">{title}</span>
        {hint ? <span className="ms-1.5 text-text-secondary">{hint}</span> : null}
      </span>
      {checked ? <RiCheckLine className="size-4 shrink-0 text-text-primary" aria-hidden /> : null}
    </button>
  );
}

/** La pastille d'un plugin MCP : son initiale sur une tuile de 24 px. */
function PluginBadge({ name }: { name: string }) {
  return (
    <span aria-hidden className="openedbot-mcp-letter flex size-6 shrink-0 items-center justify-center rounded-md bg-background-tertiary-default text-caption-1-semibold text-text-primary">
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * L'icône du bouton principal qui change (envoyer, arrêter, micro) passe de
 * 0,5 à 1 en 200 ms, comme Grok Bot. Décidé au montage (`useState`) : une
 * icône déjà là ne rejoue jamais l'animation sur un rendu suivant.
 */
function SwapIcon({ ready, children }: { ready: RefObject<boolean>; children: ReactNode }) {
  const [swap] = useState(() => ready.current === true);
  return <span className={cn("relative inline-flex", swap && "openedbot-icon-swap")}>{children}</span>;
}
