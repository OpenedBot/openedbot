import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Download, Loader2, X } from "lucide-react";
import { cn, useCoarsePointer, useIsMobile } from "@openedbot/browser-ui-kit";
import {
  attachmentBytes,
  type AttachmentContentPart,
  type MessageAttachmentInput,
} from "@openedbot/conversation/domain/attachments";
import { formatBytes } from "@openedbot/browser-i18n";
import type { MessageContent } from "@openedbot/contracts-api";
import { api } from "../lib/api";
import { releaseComposerKeyboard } from "../lib/composer/composer-keyboard";
import { useT } from "../lib/i18n";
import { documentMarkdownComponents } from "./thread-markdown";

/** La part « pièce jointe » d'un message, telle que le cloud API la persiste. */
export type MessageAttachmentChip = Extract<MessageContent[number], { type: "attachment" }>;

/** Forme commune au fichier persistant du fil et au fichier encore local du
 * composer. Le second porte son contenu direct, le premier seulement son id. */
export type AttachmentCanvasItem = {
  id?: string;
  name: string;
  contentType: string;
  kind: "image" | "document";
  bytes: number;
  content?: readonly AttachmentContentPart[];
};

export function draftAttachmentCanvasItem(attachment: MessageAttachmentInput): AttachmentCanvasItem {
  return { ...attachment, bytes: attachmentBytes(attachment) };
}

/**
 * Le canevas de lecture d'une pièce jointe.
 *
 * Par CONTEXTE et non par props : la puce qui l'ouvre vit au fond de
 * `ThreadTimeline`, sous deux `memo` (`UserMessage`, `AttachmentTile`) dont
 * l'existence tient à ce que le fil ne se re-rende pas à chaque delta du flux.
 * Faire descendre un `onOpen` jusque-là passerait une nouvelle identité de
 * fonction à chaque rendu et casserait exactement ce que ces `memo` protègent.
 *
 * Un seul fichier ouvert à la fois : c'est un panneau de lecture, pas un
 * gestionnaire d'onglets.
 */
/**
 * Un panneau qui n'est pas un fichier (le détail du contexte et des quotas) :
 * le canva lui prête sa coque (place dans la rangée, carte, animation) et un
 * emplacement DOM ; son propriétaire y rend son contenu par portail. Le
 * contenu reste ainsi chez lui, avec ses requêtes et son état, au lieu d'être
 * figé dans un nœud React passé au contexte.
 *
 * `id` désigne l'instance qui l'a ouvert : plusieurs déclencheurs du même
 * panneau peuvent être montés ensemble (pastille de l'en-tête, ligne sous le
 * composer), et un seul doit remplir l'emplacement.
 */
export type CanvasPanel = { id: string; label: string };

/** L'emplacement du panneau ouvert, avec l'instance qui doit le remplir. */
export type CanvasPanelSlot = { owner: string; element: HTMLElement };

const AttachmentCanvasContext = createContext<{
  open: (attachment: AttachmentCanvasItem) => void;
  opened: AttachmentCanvasItem | null;
  openPanel: (panel: CanvasPanel) => void;
  panel: CanvasPanel | null;
  panelSlot: CanvasPanelSlot | null;
  setPanelSlot: (slot: CanvasPanelSlot | null) => void;
  close: () => void;
} | null>(null);

export function AttachmentCanvasProvider({ children }: { children: ReactNode }) {
  const [opened, setOpened] = useState<AttachmentCanvasItem | null>(null);
  const [panel, setPanel] = useState<CanvasPanel | null>(null);
  const [panelSlot, setPanelSlot] = useState<CanvasPanelSlot | null>(null);
  const close = useCallback(() => {
    setOpened(null);
    setPanel(null);
  }, []);
  const open = useCallback((attachment: AttachmentCanvasItem) => {
    // Le panneau prend toute la scène au doigt : ouvert clavier déployé, il se
    // serait affiché dans la bande au-dessus de lui, et le lâcher ensuite
    // aurait fait sauter la mise en page sous les yeux.
    releaseComposerKeyboard();
    // Un seul contenu à la fois : le fichier remplace le panneau.
    setPanel(null);
    setOpened(attachment);
  }, []);
  const openPanel = useCallback((next: CanvasPanel) => {
    releaseComposerKeyboard();
    setOpened(null);
    setPanel(next);
  }, []);
  const value = useMemo(
    () => ({ open, opened, openPanel, panel, panelSlot, setPanelSlot, close }),
    [open, opened, openPanel, panel, panelSlot, close],
  );
  return (
    <AttachmentCanvasContext.Provider value={value}>{children}</AttachmentCanvasContext.Provider>
  );
}

/**
 * Rend `null` hors d'un fournisseur plutôt que de lever : la timeline est aussi
 * rendue par des tests et des écrans qui n'ont pas de canevas, et une puce sans
 * panneau doit rester une puce, pas une page blanche.
 */
export function useAttachmentCanvas() {
  return useContext(AttachmentCanvasContext);
}

/**
 * La durée du repli, en millisecondes.
 *
 * Elle est écrite DEUX fois : ici et dans `duration-200` de la classe, parce
 * que Tailwind ne lit que des classes littérales. Le commentaire est le lien :
 * changer l'une sans l'autre laisse soit un contenu démonté trop tôt (on voit
 * la colonne se vider), soit retenu trop longtemps.
 */
const CLOSE_MS = 200;

/**
 * La largeur du canva sur un écran de bureau, déclarée UNE fois : le
 * conteneur l'anime, l'intérieur la garde. Deux valeurs qui divergeraient
 * feraient danser le texte pendant la transition.
 *
 * Même part de viewport que le canva du guichet (`min(34rem, 38vw)` dans
 * `support-panel.tsx`), avec un plafond un peu plus haut : ici on lit un
 * document ou une image, pas une conversation dont les lignes cassent trop
 * tôt.
 */
/**
 * La carte du canevas au bureau : la surface de la carte de la barre latérale
 * (`BOARD_SIDEBAR_CARD`), même fond et même bord. Elle se pose sur le fond du
 * fil (`CANVAS_GUTTER`), comme la barre latérale sur la page : transparente,
 * la gouttière laissait voir le gris de `main` sous la carte, en rectangle.
 */
const CANVAS_CARD = "overflow-hidden rounded-3xl border border-border-button-white bg-background-secondary-default shadow-sm";
const CANVAS_GUTTER = "bg-background";
const ATTACHMENT_CANVAS_WIDTH = "w-[min(42rem,38vw)] min-w-80";

/**
 * La largeur du canevas se règle à la main : une poignée sur son bord, côté
 * fil. `null` = la largeur par défaut (`ATTACHMENT_CANVAS_WIDTH`), celle
 * qu'un double-clic sur la poignée rétablit. Le réglage survit au
 * rechargement : c'est une préférence d'écran, pas un état du fil.
 */
export const CANVAS_MIN_WIDTH = 320;
/** Ce que le fil garde au moins à côté du canevas : un composer utilisable. */
export const CANVAS_THREAD_MIN_WIDTH = 360;
const CANVAS_KEY_STEP = 32;
const CANVAS_WIDTH_KEY = "ohb:attachment-canvas-width";

/** La largeur bornée : jamais sous le minimum, jamais au point d'écraser le fil. */
export function clampCanvasWidth(width: number, rowWidth: number | null): number {
  const max = rowWidth === null ? Number.POSITIVE_INFINITY : Math.max(CANVAS_MIN_WIDTH, rowWidth - CANVAS_THREAD_MIN_WIDTH);
  return Math.round(Math.min(Math.max(width, CANVAS_MIN_WIDTH), max));
}

/** La largeur mémorisée, ou `null` : rien de stocké, valeur illisible, ou stockage indisponible. */
export function readCanvasWidth(): number | null {
  try {
    const raw = globalThis.localStorage?.getItem(CANVAS_WIDTH_KEY);
    if (raw == null) return null;
    const width = Number(raw);
    return Number.isFinite(width) && width >= CANVAS_MIN_WIDTH ? Math.round(width) : null;
  } catch {
    // Stockage refusé (navigation privée, politique du profil) : la largeur
    // par défaut, et le réglage vit le temps de la session.
    return null;
  }
}

export function writeCanvasWidth(width: number | null): void {
  try {
    if (width === null) globalThis.localStorage?.removeItem(CANVAS_WIDTH_KEY);
    else globalThis.localStorage?.setItem(CANVAS_WIDTH_KEY, String(width));
  } catch {
    // Même cas que la lecture : rien à mémoriser, rien de cassé.
  }
}

/**
 * Le panneau lui-même : à côté du fil, jamais par-dessus.
 *
 * Une modale cacherait la conversation, or c'est précisément en la lisant
 * qu'on veut consulter le fichier dont elle parle. Le panneau prend donc sa
 * place dans la rangée, et le fil se resserre.
 */
export function AttachmentCanvas() {
  const { t, locale } = useT();
  const isMobile = useIsMobile();
  const coarse = useCoarsePointer();
  const canvas = useAttachmentCanvas();
  const opened = canvas?.opened ?? null;
  const panel = canvas?.panel ?? null;
  const close = canvas?.close;
  const setPanelSlot = canvas?.setPanelSlot;

  /**
   * Le fichier encore RENDU alors qu'il n'est plus ouvert : le temps que le
   * panneau se replie.
   *
   * Sans lui, refermer viderait le contenu d'abord et replierait ensuite : on
   * verrait une colonne blanche se rétracter. `onTransitionEnd` le démonte une
   * fois la place rendue, ce qui libère au passage l'URL objet d'une image.
   */
  const [closing, setClosing] = useState<AttachmentCanvasItem | null>(null);
  const [closingPanel, setClosingPanel] = useState<CanvasPanel | null>(null);
  useEffect(() => {
    if (opened) {
      setClosing(opened);
      // Un panneau remplacé ne doit pas revenir pendant un repli ultérieur.
      setClosingPanel(null);
      return;
    }
    // Le FILET sous `onTransitionEnd` (posé plus bas), pas son remplaçant :
    // sous `prefers-reduced-motion` la transition est désarmée et l'événement
    // ne tombe JAMAIS : le contenu resterait monté à vie dans un panneau de
    // largeur nulle, avec son URL objet et ses boutons.
    const timer = setTimeout(() => setClosing(null), CLOSE_MS);
    return () => clearTimeout(timer);
  }, [opened]);
  // Même retenue pour un panneau : son propriétaire garde son portail tant que
  // l'emplacement existe, donc tant que la carte se replie.
  useEffect(() => {
    if (panel) {
      setClosingPanel(panel);
      setClosing(null);
      return;
    }
    const timer = setTimeout(() => setClosingPanel(null), CLOSE_MS);
    return () => clearTimeout(timer);
  }, [panel]);
  // Le contenu ouvert gagne sur celui qui se replie : passer d'un fichier au
  // panneau (ou l'inverse) montre tout de suite le nouveau.
  const displayed = opened ?? (panel ? null : closing);
  const shownPanel = panel ?? (opened ? null : closingPanel);
  const shownPanelId = shownPanel?.id ?? null;
  const panelSlotRef = useCallback(
    (element: HTMLDivElement | null) => {
      setPanelSlot?.(element && shownPanelId ? { owner: shownPanelId, element } : null);
    },
    [setPanelSlot, shownPanelId],
  );

  const [text, setText] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // Échap ferme, comme toute surface qui se referme dans l'application. Posé
  // sur le document : le focus peut être resté dans le composer.
  const active = Boolean(opened || panel);
  useEffect(() => {
    if (!active || !close) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, close]);

  // Sur l'IDENTITÉ du fichier, pas sur l'objet : la fermeture change la
  // référence (`opened` → `closing`) sans changer le fichier, et re-télécharger
  // pendant que le panneau se replie serait du travail pour personne.
  const shownId = displayed?.id ?? null;
  const shownKind = displayed?.kind ?? null;
  useEffect(() => {
    setText(null);
    setHtml(null);
    setImageUrl(null);
    setFailed(false);
    const directImage = displayed?.content?.find(
      (part): part is Extract<AttachmentContentPart, { type: "image" }> => part.type === "image",
    );
    if (shownKind === "image" && directImage) {
      setImageUrl(directImage.image);
      return;
    }
    const directText = displayed?.content
      ?.filter((part): part is Extract<AttachmentContentPart, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (shownKind === "document" && directText !== undefined) {
      if (displayed && isHtml(displayed)) setHtml(directText);
      else setText(directText);
      return;
    }
    if (!shownId) {
      setFailed(true);
      return;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    void api
      .attachment(shownId)
      .then(async (blob) => {
        if (cancelled) return;
        if (shownKind === "image") {
          objectUrl = URL.createObjectURL(blob);
          setImageUrl(objectUrl);
          return;
        }
        const body = await blob.text();
        if (displayed && isHtml(displayed)) setHtml(body);
        else setText(body);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      // Sans révocation, ouvrir dix pièces garde dix fichiers en mémoire
      // jusqu'à la fermeture de la fenêtre.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [displayed, shownId, shownKind]);

  // La largeur réglée à la poignée, bornée par la rangée qui contient le fil :
  // la fenêtre qui rétrécit ne doit pas pousser le fil sous son minimum.
  const asideRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState<number | null>(readCanvasWidth);
  const [rowWidth, setRowWidth] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; sign: 1 | -1 } | null>(null);
  const mounted = Boolean(close);
  useEffect(() => {
    const row = asideRef.current?.parentElement;
    if (isMobile || !row || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setRowWidth(entry.contentRect.width);
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, [isMobile, mounted]);
  // Mémorisée au lâcher, pas à chaque pixel du glisser.
  useEffect(() => {
    if (!resizing) writeCanvasWidth(width);
  }, [resizing, width]);
  const shownWidth = !isMobile && width !== null ? clampCanvasWidth(width, rowWidth) : null;
  const maxWidth = rowWidth === null ? undefined : Math.max(CANVAS_MIN_WIDTH, rowWidth - CANVAS_THREAD_MIN_WIDTH);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const aside = asideRef.current;
    if (event.button !== 0 || !aside) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    // La poignée est côté fil : à gauche en LTR, où tirer vers la gauche
    // élargit ; à droite en RTL, où c'est l'inverse.
    const sign = getComputedStyle(aside).direction === "rtl" ? -1 : 1;
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: aside.getBoundingClientRect().width, sign };
    setResizing(true);
  };
  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    setWidth(clampCanvasWidth(current.startWidth + current.sign * (current.startX - event.clientX), rowWidth));
  };
  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setResizing(false);
  };
  const keyResize = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const aside = asideRef.current;
    if (!aside) return;
    const rtl = getComputedStyle(aside).direction === "rtl";
    const base = aside.getBoundingClientRect().width;
    const wider = rtl ? "ArrowRight" : "ArrowLeft";
    const narrower = rtl ? "ArrowLeft" : "ArrowRight";
    let next: number | null | undefined;
    if (event.key === wider) next = base + CANVAS_KEY_STEP;
    else if (event.key === narrower) next = base - CANVAS_KEY_STEP;
    else if (event.key === "Home") next = CANVAS_MIN_WIDTH;
    else if (event.key === "End") next = maxWidth ?? base;
    else if (event.key === "Enter") next = null;
    if (next === undefined) return;
    event.preventDefault();
    setWidth(next === null ? null : clampCanvasWidth(next, rowWidth));
  };

  // Hors fournisseur seulement. Le panneau reste MONTÉ même vide : une
  // transition CSS ne joue que sur un élément qui existait déjà à la frame
  // précédente : le monter au moment de l'ouverture le ferait apparaître
  // déjà déplié, sans animation.
  if (!close) return null;

  const open = active;
  // L'intérieur garde la largeur réglée, même pendant le repli (voir plus bas).
  const innerWidth = shownWidth !== null ? { width: shownWidth } : undefined;
  return (
    <aside
      ref={asideRef}
      style={open && shownWidth !== null ? { width: shownWidth } : undefined}
      aria-label={shownPanel ? shownPanel.label : t("attachmentCanvas.label", { name: displayed?.name ?? "" })}
      aria-hidden={!open}
      // Refermé, le panneau ne doit pas rester dans l'ordre de tabulation le
      // temps de son repli : `inert` retire ses boutons du clavier tout de
      // suite, sans attendre le démontage.
      inert={!open}
      onTransitionEnd={(event) => {
        // La fin du repli, dès qu'elle arrive : le panneau ne transitionne que
        // sa largeur et son opacité, qui finissent ensemble : inutile de
        // distinguer laquelle. `target === currentTarget` écarte les
        // transitions des enfants (les boutons ont les leurs).
        if (event.target === event.currentTarget && !open) {
          setClosing(null);
          setClosingPanel(null);
        }
      }}
      data-attachment-canvas=""
      className={cn(
        "flex shrink-0 flex-col overflow-hidden",
        // `duration-200` doit rester d'accord avec `CLOSE_MS`, des deux côtés.
        // `motion-reduce` désarme le mouvement, pas la fonction.
        "duration-200 ease-out motion-reduce:transition-none",
        isMobile
          // Téléphone : une vue POUSSÉE dans la scène, pas une couche posée
          // sur la fenêtre. `position: fixed` se cale sur le viewport de mise
          // en page, que ni le clavier logiciel ni la barre d'URL de Safari ne
          // rétrécissent : le panneau passait alors sous le clavier et sous
          // l'indicateur d'accueil. En `absolute`, il hérite de la géométrie
          // que la coque tient du `visualViewport`, et le drawer l'emmène avec
          // la scène au lieu de le laisser collé à l'écran.
          ? [
              // Pas de `z-index` : l'`absolute` passe déjà devant le fil et le
              // composer, restés statiques, et le givre puis le voile du
              // drawer, qui viennent après dans la scène, le recouvrent
              // comme ils recouvrent le reste quand le panneau s'ouvre.
              "absolute inset-0 bg-background transition-[transform,opacity]",
              open ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-4 opacity-0",
            ]
          // Bureau : une carte (`CANVAS_CARD`) dans une gouttière de 8 px au
          // fond du fil (`CANVAS_GUTTER`). La transition porte sur la largeur
          // du CONTENEUR ; la carte intérieure garde sa taille finale dans un
          // parent qui coupe, sinon le texte se recomposerait à chaque frame.
          // La marge n'est PAS sur le conteneur : un `m-2` survivrait au
          // `w-0` et laisserait une bande vide une fois le panneau refermé.
          : [
              // Au glisser, la largeur suit le pointeur : pas d'animation qui traîne derrière.
              "relative",
              resizing ? "transition-none select-none" : "transition-[width,opacity]",
              CANVAS_GUTTER,
              open ? cn(ATTACHMENT_CANVAS_WIDTH, "opacity-100") : "pointer-events-none w-0 opacity-0",
            ],
      )}
    >
      {/* La poignée occupe la gouttière côté fil (8 px) : on la trouve au bord
          de la carte sans qu'elle mange le contenu. Aucun trait dessiné :
          seul le curseur de redimensionnement la signale. Bureau seulement :
          au téléphone le panneau prend tout l'écran. */}
      {!isMobile && open ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("attachmentCanvas.resize")}
          title={t("attachmentCanvas.resize")}
          aria-valuemin={CANVAS_MIN_WIDTH}
          aria-valuemax={maxWidth}
          aria-valuenow={shownWidth ?? undefined}
          tabIndex={0}
          data-canvas-resize=""
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onLostPointerCapture={endResize}
          onDoubleClick={() => setWidth(null)}
          onKeyDown={keyResize}
          className="absolute inset-y-0 start-0 z-10 w-2 cursor-col-resize touch-none outline-none"
        />
      ) : null}
      {shownPanel ? (
        <div className={cn("flex min-h-0 flex-1 flex-col", isMobile ? "w-full" : cn(ATTACHMENT_CANVAS_WIDTH, "p-2"))} style={innerWidth}>
          <div
            ref={panelSlotRef}
            data-canvas-panel=""
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              !isMobile && CANVAS_CARD,
            )}
          />
        </div>
      ) : displayed ? (
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            // Le conteneur bureau rétrécit jusqu'à 0 : l'intérieur garde sa
            // largeur finale pour ne pas recomposer son texte à chaque frame.
            // `p-2` est la gouttière de la carte (le `m-2` du guichet), clipée
            // avec le panneau.
            isMobile ? "w-full" : cn(ATTACHMENT_CANVAS_WIDTH, "p-2"),
          )}
          style={innerWidth}
        >
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              !isMobile && CANVAS_CARD,
            )}
          >
            <header
              className={cn(
                "flex shrink-0 items-center gap-2 border-b px-4",
                // 44 pt au doigt (HIG / WCAG 2.5.8) : la barre du panneau se
                // manipule comme une barre de navigation, pas comme une chrome
                // de bureau. Au bureau, les mêmes boutons que le guichet.
                coarse ? "border-border/60 py-1.5" : "border-border py-3",
              )}
            >
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium" title={displayed.name}>
                {displayed.name}
              </span>
              <span className="text-xs text-muted-foreground">{formatBytes(locale, displayed.bytes)}</span>
            </div>
            <button
              type="button"
              onClick={() => void downloadCanvasAttachment(displayed)}
              aria-label={t("attachmentCanvas.download")}
              title={t("attachmentCanvas.download")}
              className={canvasChromeButton(coarse)}
            >
              <Download className="size-4" />
            </button>
            <button
              type="button"
              onClick={close}
              aria-label={t("attachmentCanvas.close")}
              title={t("attachmentCanvas.close")}
              className={canvasChromeButton(coarse)}
            >
              <X className="size-4" />
            </button>
          </header>

          <div
            className={cn(
              "min-h-0 flex-1",
              html !== null
                // Le HTML tourne dans son cadre : c'est lui qui défile, pas le
                // panneau, sinon on aurait deux ascenseurs pour une page.
                ? "flex flex-col overflow-hidden"
                : [
                    // `overscroll-contain` : arrivé en bout de course, le geste
                    // ne repart pas dans le fil resté derrière.
                    "scrollbar-subtle overflow-y-auto overscroll-contain px-4 py-3",
                    // Le panneau descend jusqu'au bord de la scène, où repose
                    // l'indicateur d'accueil : c'est le CONTENU qui garde ses
                    // distances, pas le fond.
                    isMobile && "pb-[max(0.75rem,var(--ohb-safe-bottom))]",
                    // Une image se lit en entier, centrée, sans faire défiler.
                    imageUrl ? "flex items-center justify-center bg-muted/30" : undefined,
                  ],
            )}
          >
            {failed ? (
              <p className="text-sm text-destructive-text">{t("attachmentCanvas.unreadable")}</p>
            ) : imageUrl ? (
              <img
                src={imageUrl}
                alt={displayed.name}
                className="h-full w-full object-contain"
              />
            ) : html !== null ? (
              // Un srcdoc hérite de la CSP de la console (`vite-csp.ts`) : les
              // scripts du document n'y tournent pas, et c'est voulu. Une URL
              // data: ou blob: hérite pareil dans Chromium (vérifié le
              // 2026-10-17) ; seul 'unsafe-inline' les rouvrirait, au prix de
              // la protection de toute la console. Le sandbox reste.
              <iframe
                title={displayed.name}
                srcDoc={html}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                className="h-full min-h-[24rem] w-full flex-1 border-0 bg-white"
              />
            ) : text !== null ? (
              isMarkdown(displayed) ? (
                <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:mt-4 prose-headings:mb-2 prose-p:my-2">
                  <Markdown remarkPlugins={[remarkGfm]} components={documentMarkdownComponents}>
                    {text}
                  </Markdown>
                </div>
              ) : (
                // Tout ce qui n'est pas du markdown se lit tel qu'il est écrit :
                // passer un `.ts` ou un `.csv` au parseur en ferait du gras et
                // de l'italique au premier `*`.
                <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                  {text}
                </pre>
              )
            ) : (
              <div className="flex items-center justify-center py-8">
                <Loader2
                  className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
                  aria-hidden
                />
              </div>
            )}
          </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}

/** Bureau : les mêmes boutons que le canva du guichet. Doigt : 44 pt. */
export function canvasChromeButton(coarse: boolean): string {
  return coarse
    ? "ohb-press flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    : "ohb-settings-action mt-0.5 inline-flex shrink-0 items-center justify-center rounded-md p-1 text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";
}

/** Le type MIME d'abord, l'extension ensuite : un `.md` arrive parfois nu. */
function isMarkdown(attachment: Pick<AttachmentCanvasItem, "contentType" | "name">): boolean {
  return (
    attachment.contentType === "text/markdown" || /\.(md|markdown)$/i.test(attachment.name)
  );
}

/** Même règle que le GET : le MIME d'abord, l'extension ensuite. */
function isHtml(attachment: Pick<AttachmentCanvasItem, "contentType" | "name">): boolean {
  const mime = attachment.contentType.toLowerCase().split(";")[0]?.trim();
  return mime === "text/html" || /\.(html|htm)$/i.test(attachment.name);
}

/**
 * Rendre le fichier à son propriétaire : un `<a download>` sur une URL objet,
 * révoquée juste après. Créée au clic et pas au rendu : garder une URL vivante
 * pour un clic qui n'arrivera peut-être jamais retiendrait le fichier en
 * mémoire pour rien.
 */
export async function downloadAttachment(attachment: MessageAttachmentChip): Promise<void> {
  // Sans `id`, rien n'a été rangé (message antérieur à `0020`) : on ne
  // télécharge pas un fichier qui n'existe plus.
  if (!attachment.id) return;
  await downloadCanvasAttachment(attachment);
}

async function downloadCanvasAttachment(attachment: AttachmentCanvasItem): Promise<void> {
  let blob: Blob;
  if (attachment.id) {
    blob = await api.attachment(attachment.id);
  } else {
    const image = attachment.content?.find(
      (part): part is Extract<AttachmentContentPart, { type: "image" }> => part.type === "image",
    );
    if (image) blob = await (await fetch(image.image)).blob();
    else {
      const text = attachment.content
        ?.filter((part): part is Extract<AttachmentContentPart, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (text === undefined) return;
      blob = new Blob([text], { type: attachment.contentType || "text/plain" });
    }
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = attachment.name;
  anchor.click();
  URL.revokeObjectURL(url);
}
