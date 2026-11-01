import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { IconArrowLeft, IconMessageCircle, IconMessages, IconPlus, IconRefresh, IconX } from "@tabler/icons-react";
import { RiAddLine } from "@remixicon/react";
import { createPortal } from "react-dom";
import { ageSince } from "@openedbot/browser-i18n";
import { isEmailSyntaxValid, normalizeEmail } from "@openedbot/identity/domain/email-address";
import type { SupportSnapshotDto, SupportThreadSummaryDto } from "@openedbot/contracts-api";
import { SUPPORT_MESSAGE_MAX_CHARS } from "@openedbot/contracts-api";
import {
  ATTACHMENT_LIMITS,
  SUPPORT_ATTACHMENT_ACCEPT,
  type MessageAttachmentInput,
} from "@openedbot/conversation/domain/attachments";
import { prepareAttachments, type AttachmentError } from "../../lib/attachments";
import { SupportImage } from "./support-image";
import { SupportMarkdown } from "./support-markdown";
import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import {
  cn,
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useIsMobile,
} from "@openedbot/browser-ui-kit";
import { BUTTON } from "../settings/primitives";
import { api, ApiError, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { useBoardAside } from "../boardui/board-frame";
import { randomId } from "../../lib/random-id";
import { readCloudSession } from "../../lib/cloud-session";
import {
  composerFieldMaxHeight,
  keepSoftKeyboard,
  releaseComposerKeyboard,
  resizeComposerField,
  shouldSendComposerOnPointerDown,
  shouldSubmitComposerOnEnter,
} from "../../lib/composer-keyboard";
import { isMobileShellPath } from "../../lib/mobile-navigation";
import { useVisualViewportInset } from "../../lib/use-visual-viewport-height";
import {
  clearSupportSession,
  readSupportSession,
  writeSupportSession,
} from "../../lib/support-session";
import {
  applySupportFrame,
  frameAttachmentCount,
  mergeSupportSnapshot,
  pendingMessage,
} from "../../lib/support-snapshot";
import { openSupportStream, type SupportStreamHandle } from "../../lib/support-stream";

/**
 * Le panneau du guichet : la porte e-mail, le fil, le composer.
 *
 * Le fil est un `message-scroller` de shadcn et non `ThreadTimeline` : ce
 * dernier rend huit variantes d'entrée (outils, plans, approbations, gates)
 * dont aucune n'existe ici, et il vit dans une colonne pleine hauteur, pas
 * dans un panneau de 380 px. Le comportement recherché est exactement celui
 * du `message-scroller` : la position de lecture tient pendant qu'un message
 * arrive, le tour est ancré, et « aller au dernier message » apparaît quand on
 * a remonté le fil.
 *
 * Deux géométries, une par porte :
 *
 * - `page` : l'écran `/support` de l'application, bureau comme mobile. Une
 *   colonne du cadre, comme un fil ; l'URL désigne la conversation
 *   (`/support/:id`), donc le retour, le partage et un lien d'e-mail mènent au
 *   bon fil. Pas de bouton de fermeture : on quitte une page en naviguant.
 * - `card` : la bulle des écrans SANS cadre (page publique, connexion, légal,
 *   onboarding). Carte flottante au bureau, feuille plein cadre au doigt.
 *
 * La feuille MOBILE de la bulle n'est pas une colonne : sa hauteur suit `visualViewport`,
 * la mesure et non `100dvh`, parce que Safari iOS ne rétrécit pas le viewport
 * de mise en page à l'ouverture du clavier. C'est le même
 * `useVisualViewportInset` que la coque, et pour la même raison. Le composer,
 * lui, reste en bas de la colonne flex : jamais `position: fixed`, sinon il
 * passe sous le clavier.
 *
 * Clavier : Entrée est un retour à la ligne au doigt, un envoi au pointeur
 * fin. Envoyer part au `pointerdown` avec `preventDefault`, donc pendant que
 * le clavier est encore là, et ne relâche le focus qu'après. Sans cela le
 * premier tap ne fait que refermer le clavier.
 */
export function SupportPanel({
  onClose,
  variant = "card",
  conversationId = null,
  onConversationChange,
  onPageActions,
}: {
  onClose?: () => void;
  /**
   * `card` : la carte flottante, sur le modèle de la démo message-scroller de
   * shadcn : titre et sous-titre, un bouton rond pour repartir, un état vide
   * centré, le composer en boîte avec « + » à gauche et la flèche à droite.
   * Au bureau seulement : sur téléphone la feuille plein cadre reste la règle.
   * `page` : l'écran `/support`.
   */
  variant?: "card" | "page";
  /** `page` : le fil que l'URL désigne. `null` ouvre le plus récent. */
  conversationId?: string | null;
  /**
   * `page` : le fil à l'écran a changé, l'URL doit suivre. `replace` quand le
   * panneau l'a choisi seul (le plus récent, un fil neuf), pour ne pas
   * empiler une entrée d'historique que l'on n'a pas demandée.
   */
  onConversationChange?: (conversationId: string | null, options: { replace: boolean }) => void;
  /**
   * `page` : le statut et l'historique vivent dans la barre de l'écran, à
   * côté de la pilule « Support ». Une seconde barre dans le panneau (un
   * sous-titre et un filet sur toute la largeur) se lisait comme un en-tête
   * vide sous le vrai.
   */
  onPageActions?: (actions: ReactNode) => void;
}) {
  const { t, locale } = useT();
  const isMobile = useIsMobile();
  const page = variant === "page";
  const card = variant === "card" && !isMobile;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // Mode assistance : une session en lecture seule ouverte par le staff. Aucune
  // écriture ne part en son nom (accusé de lecture, frappe, ouverture, envoi).
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe, refetchOnMount: false });
  const readOnly = me.data?.kind === "session" && me.data.session.impersonation !== null;
  const identityPending = me.isPending;
  /**
   * Qui compense le clavier, et surtout : UNE SEULE fois.
   *
   * Sur les écrans de la coque mobile, `Shell` mesure déjà le `visualViewport`
   * et pose hauteur + `translateY` sur son conteneur. Un ancêtre transformé
   * devient le bloc conteneur d'un descendant `fixed` : la feuille hérite donc
   * de cette géométrie sans rien calculer. Y ajouter la nôtre décalerait deux
   * fois, et le composer repasserait sous le clavier.
   *
   * Restent `/login`, `/onboarding` et `/legal/*`, où la coque ne mesure rien
   * (`isMobileShellPath`) : là, et là seulement, la feuille se mesure
   * elle-même.
   */
  const shellHandlesKeyboard = isMobile && isMobileShellPath(pathname);
  const keyboardInset = useVisualViewportInset(isMobile && !shellHandlesKeyboard);

  const [snapshot, setSnapshot] = useState<SupportSnapshotDto | null>(null);
  /**
   * L'historique de ce visiteur : le fil de son jeton, et les fils de son
   * compte s'il est connecté (porte compte, migration 0078).
   *
   * C'est ce qui manquait, et son absence se voyait : un opérateur connecté
   * qui ouvrait le panneau depuis une autre machine voyait un guichet vide
   * alors que le staff répondait dans son fil.
   */
  const [history, setHistory] = useState<SupportThreadSummaryDto[]>([]);
  const [view, setView] = useState<"thread" | "history">("thread");
  /**
   * Le fil désigné par l'URL AU MONTAGE : il a la priorité sur le plus récent,
   * et c'est l'effet qui suit `conversationId` qui l'ouvre. L'ouvrir aussi
   * depuis l'historique ferait deux lectures dont la dernière gagnerait.
   */
  const initialConversation = useRef(conversationId);
  /**
   * Le fil à l'écran, lu par l'effet qui suit l'URL : quand c'est le panneau
   * qui a fait bouger l'URL, le fil est déjà ouvert et il n'y a rien à relire.
   */
  const shownConversation = useRef<string | null>(null);
  /**
   * Cette fenêtre porte-t-elle une session ?
   *
   * Le miroir local suffit à DÉCIDER D'AFFICHER : un opérateur connecté ne
   * doit pas voir une porte e-mail qui lui demande l'adresse de son propre
   * compte. Il ne suffit pas à IDENTIFIER, et ce n'est pas lui qui le fait :
   * le serveur lit la session et prend l'adresse du compte, sinon n'importe
   * quel client annoncerait l'adresse de son choix.
   *
   * Lu une fois au montage, et démenti par le serveur si besoin : c'est le
   * refus nommé `SUPPORT_EMAIL_REQUIRED` qui remet la porte, parce que le
   * miroir local peut survivre à une session expirée. Relire le miroir en
   * continu ferait sauter l'écran sous les doigts.
   */
  const [identified, setIdentified] = useState(() => readCloudSession() !== null);
  const [email, setEmail] = useState("");
  const [draft, setDraft] = useState("");
  const [opening, setOpening] = useState(false);
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [staffTyping, setStaffTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  /**
   * Les captures du bug, préparées côté client : réduites, encodées, bornées.
   *
   * Elles vivent dans le composer jusqu'à l'envoi, comme celles du fil des
   * bots (`composer.tsx`). Une image envoyée n'est plus là : c'est le fil qui
   * la porte, servie par `GET /api/support/attachments/:id`.
   */
  const [attachments, setAttachments] = useState<MessageAttachmentInput[]>([]);
  const [attachmentErrors, setAttachmentErrors] = useState<AttachmentError[]>([]);
  const [preparing, setPreparing] = useState(false);

  const tokenRef = useRef<string | null>(null);
  /**
   * « Le prochain envoi ouvre un fil NEUF ».
   *
   * Sans ce drapeau, repartir de zéro serait impossible pour un opérateur
   * connecté : le serveur rejoint son dernier fil, précisément pour qu'une
   * nouvelle machine n'en crée pas un second. Le geste doit donc être
   * explicite, et il ne vaut que pour un envoi.
   */
  const freshRef = useRef(false);
  const streamRef = useRef<SupportStreamHandle | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSentAt = useRef(0);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const panel = useRef<HTMLElement | null>(null);

  // La carte flotte sur la page : un clic à côté la ferme, tout de suite, au
  // `pointerdown` et non au `click`, pour ne pas attendre le relâchement. Le
  // canva et la feuille mobile ne sont pas concernés : ils font partie de la
  // mise en page, on ne les quitte pas par accident.
  useEffect(() => {
    if (!card) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && panel.current?.contains(target)) return;
      onClose?.();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [card, onClose]);

  /**
   * Le flux n'est ouvert qu'APRÈS l'instantané, à son curseur : il n'y a donc
   * rien à rejouer, et aucun message ne peut se glisser entre la lecture et
   * l'abonnement.
   */
  const attachStream = useCallback((next: SupportSnapshotDto, token: string | null) => {
    streamRef.current?.close();
    streamRef.current = openSupportStream({
      conversationId: next.conversationId,
      token,
      cursor: next.cursor,
      handlers: {
        onStatus: setConnected,
        onEvent: (event) => {
          if (event.type === "support.typing") {
            if (event.payload.author !== "staff") return;
            setStaffTyping(true);
            if (typingTimer.current) clearTimeout(typingTimer.current);
            // Le signal n'est pas persisté : il s'éteint tout seul, sinon
            // « l'équipe écrit » resterait affiché après un onglet fermé.
            typingTimer.current = setTimeout(() => setStaffTyping(false), 5_000);
            return;
          }
          if (event.type === "support.message" && event.payload.author === "staff") {
            setStaffTyping(false);
          }
          setSnapshot((current) => (current === null ? current : applySupportFrame(current, event)));
          // La trame dit COMBIEN de captures accompagnent le message, jamais
          // lesquelles : seule une relecture du fil rend leur identité, donc
          // leur image. Sans cela, une réponse illustrée arriverait sans son
          // illustration jusqu'à la prochaine ouverture du panneau.
          if (frameAttachmentCount(event) > 0) {
            void api.support
              .snapshot(next.conversationId, token)
              .then((fresh) => setSnapshot((current) => mergeSupportSnapshot(current, fresh)))
              .catch(() => {
                // Le flux reviendra, et la prochaine ouverture relira le fil.
              });
          }
        },
      },
    });
  }, []);

  /**
   * Le jeton qui ouvre CE fil, ou rien.
   *
   * Le jeton du navigateur n'ouvre qu'un seul fil, celui qu'il a ouvert
   * lui-même. Pour un fil retrouvé par le compte, il ne vaut rien : le poser
   * ferait tenter une porte qui ne s'ouvre pas, et la session prend la relève.
   */
  const tokenFor = useCallback((conversationId: string): string | null => {
    const session = readSupportSession();
    return session && session.conversationId === conversationId ? session.token : null;
  }, []);

  /** Lit un fil et s'y abonne. Le flux part APRÈS l'instantané, à son curseur. */
  const openThread = useCallback(async (conversationId: string) => {
    const token = tokenFor(conversationId);
    const current = await api.support.snapshot(conversationId, token);
    tokenRef.current = token;
    setSnapshot(current);
    setView("thread");
    attachStream(current, token);
  }, [attachStream, tokenFor]);

  // Reprise : l'historique d'abord, le dernier fil ensuite. Un jeton que l'API
  // ne reconnaît plus est effacé, et le panneau repart sur la porte e-mail
  // plutôt que d'afficher une erreur que le visiteur ne peut pas résoudre.
  //
  // Au MONTAGE seulement : relire l'historique à chaque rendu ferait sauter
  // l'écran sous les doigts, et le flux tient déjà le fil à jour.
  useEffect(() => {
    const token = readSupportSession()?.token ?? null;
    // Ni jeton, ni session : rien à demander, et la porte e-mail est la suite.
    if (!token && !identified) return;
    let cancelled = false;
    setOpening(true);
    api.support
      .history(token)
      .then(async (result) => {
        if (cancelled) return;
        setHistory(result.conversations);
        if (initialConversation.current !== null) return;
        const latest = result.conversations[0];
        if (!latest) return;
        await openThread(latest.conversationId);
      })
      .catch((cause) => {
        if (cancelled) return;
        if (cause instanceof ApiError && (cause.status === 401 || cause.status === 404)) {
          clearSupportSession();
          return;
        }
        setError(t("support.errorOpen"));
      })
      .finally(() => {
        if (!cancelled) setOpening(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // L'URL désigne un fil (montage, retour arrière, lien collé) : on l'ouvre,
  // sauf s'il est déjà à l'écran parce que c'est le panneau qui l'y a mis.
  useEffect(() => {
    if (conversationId === null || conversationId === shownConversation.current) return;
    setOpening(true);
    void openThread(conversationId)
      .catch(() => setError(t("support.errorOpen")))
      .finally(() => setOpening(false));
  }, [conversationId, openThread, t]);

  // Le panneau a changé de fil de lui-même (le plus récent, un fil neuf) :
  // l'URL suit, sans entrée d'historique. Ne dépend QUE du fil à l'écran : un
  // retour vers `/support` nu ne doit pas être réécrit aussitôt.
  const snapshotConversation = snapshot?.conversationId ?? null;
  useEffect(() => {
    shownConversation.current = snapshotConversation;
    if (snapshotConversation === null) return;
    onConversationChange?.(snapshotConversation, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotConversation]);

  useEffect(() => () => {
    streamRef.current?.close();
    streamRef.current = null;
    if (typingTimer.current) clearTimeout(typingTimer.current);
  }, []);

  // Échap referme la carte, comme tout panneau de l'app ; une page ne se
  // ferme pas. Le garde écarte la saisie IME : valider un caractère japonais
  // ne doit pas fermer la conversation.
  useEffect(() => {
    if (!onClose) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Le visiteur a le panneau sous les yeux : ce qu'il voit est lu. L'accusé
  // ne part QUE quand le nombre de réponses du staff change : le poster à
  // chaque message ferait deux requêtes par envoi, dont une sans objet, et
  // une rafale de frappe toucherait le plafond de la route pour rien.
  const staffMessageCount = snapshot?.messages.filter((message) => message.author === "staff").length ?? 0;
  useEffect(() => {
    // Pas de garde sur le jeton : un opérateur connecté n'en a pas, et sa
    // session marque le fil lu tout aussi bien.
    if (!snapshot || staffMessageCount === 0) return;
    if (readOnly || identityPending) return;
    // Relu ensuite : sans cela, le fil lu garde son point « non lu » dans
    // l'historique jusqu'au prochain montage.
    void api.support.markRead(snapshot.conversationId, tokenRef.current).then(refreshHistory, () => {
      // Un accusé de lecture perdu ne change rien pour le visiteur.
    });
  }, [snapshot?.conversationId, staffMessageCount, readOnly, identityPending]);

  /**
   * Ajoute des fichiers au composer.
   *
   * Le filtre sur les images est posé ICI et pas seulement dans `accept` : un
   * glisser-déposer, un collage depuis le presse-papiers ou un sélecteur
   * système contournent `accept` sans difficulté, et le serveur refuserait en
   * 415 après le téléversement. Dire non tout de suite, en nommant le fichier,
   * coûte moins cher à tout le monde.
   */
  const addFiles = async (files: readonly File[]) => {
    if (files.length === 0 || readOnly) return;
    const images = files.filter((file) => file.type.startsWith("image/"));
    const refused: AttachmentError[] = files
      .filter((file) => !file.type.startsWith("image/"))
      .map((file) => ({ code: "unsupported", name: file.name }));
    setPreparing(true);
    try {
      const prepared = await prepareAttachments(images, attachments.length);
      setAttachments((current) => [...current, ...prepared.attachments]);
      setAttachmentErrors([...refused, ...prepared.errors]);
    } finally {
      setPreparing(false);
    }
  };

  const resize = () => {
    const element = field.current;
    if (element) resizeComposerField(element, composerFieldMaxHeight());
  };
  useLayoutEffect(resize, [draft]);

  const submitEmail = async () => {
    if (opening || readOnly) return;
    setError(null);
    // The same rule as the API (`SUPPORT_EMAIL_INVALID`), applied before the request.
    const address = normalizeEmail(email);
    if (!isEmailSyntaxValid(address)) {
      setError(t("support.gateEmailInvalid"));
      return;
    }
    setOpening(true);
    try {
      const opened = await api.support.open({ email: address, locale });
      tokenRef.current = opened.token;
      writeSupportSession({ conversationId: opened.conversationId, token: opened.token });
      setSnapshot(opened.snapshot);
      setView("thread");
      attachStream(opened.snapshot, opened.token);
      refreshHistory();
    } catch (cause) {
      // Le refus de l'API est nommé et destiné à être lu : adresse invalide,
      // jetable, domaine sans courrier. Le remplacer par un message générique
      // priverait le visiteur de ce qu'il doit corriger.
      setError(cause instanceof ApiError ? cause.message : t("support.errorOpen"));
    } finally {
      setOpening(false);
    }
  };

  /**
   * Le premier envoi d'un opérateur connecté OUVRE le fil.
   *
   * Il n'a pas de porte e-mail, donc rien avant ce geste ne dit qu'il veut
   * parler à quelqu'un. Créer le fil à l'ouverture du panneau aurait averti
   * toute l'équipe d'un clic de curiosité.
   *
   * Pas de bulle optimiste sur ce chemin : il n'y a pas encore de fil où la
   * poser, et fabriquer un instantané avec un identifiant inventé serait un
   * mensonge de plus à défaire. Le composer dit « Envoi… » le temps de
   * l'aller-retour.
   */
  const openWithFirstMessage = (body: string, files: readonly MessageAttachmentInput[]) => {
    if (readOnly) return;
    setError(null);
    setSending(true);
    setDraft("");
    setAttachments([]);
    const fresh = freshRef.current;
    api.support
      .open({ locale, body, attachments: files, ...(fresh ? { fresh: true } : {}) })
      .then((opened) => {
        freshRef.current = false;
        // Un jeton vide veut dire « c'est la session qui ouvre ce fil » : le
        // serveur a rejoint un fil existant du compte, et il n'y a aucun
        // secret porteur à retenir.
        const token = opened.token === "" ? null : opened.token;
        tokenRef.current = token;
        if (token) writeSupportSession({ conversationId: opened.conversationId, token });
        setSnapshot(opened.snapshot);
        setView("thread");
        attachStream(opened.snapshot, token);
        refreshHistory();
      })
      .catch((cause) => {
        setDraft(body);
        setAttachments([...files]);
        // `SUPPORT_EMAIL_REQUIRED` : le serveur ne voit aucune session, donc le
        // miroir local était périmé. Cette fenêtre n'est PAS identifiée, et la
        // porte e-mail reprend la main avec le message du serveur.
        setError(cause instanceof ApiError ? cause.message : t("support.errorSend"));
        if (cause instanceof ApiError && cause.code === "SUPPORT_EMAIL_REQUIRED") {
          setIdentified(false);
          setSnapshot(null);
        }
      })
      .finally(() => setSending(false));
  };

  const submitMessage = () => {
    const token = tokenRef.current;
    const body = draft.trim();
    if (readOnly || sending || preparing || body.length === 0) return;
    const files = attachments;
    if (snapshot === null) {
      if (!identified) return;
      openWithFirstMessage(body, files);
      return;
    }
    setError(null);
    setSending(true);
    setDraft("");
    setAttachments([]);
    // La bulle apparaît tout de suite, au-dessus du composer : c'est le geste
    // natif. Elle disparaît quand le serveur rend le vrai message.
    const optimistic = pendingMessage(randomId(), body);
    setSnapshot((current) => (current === null ? current : {
      ...current,
      messages: [...current.messages, optimistic],
    }));
    api.support
      .send(snapshot.conversationId, token, body, randomId(), files)
      .then((next) => setSnapshot((current) => mergeSupportSnapshot(current, next)))
      .catch((cause) => {
        // L'envoi a échoué : le texte revient dans le composer et la bulle
        // repart. Le perdre en silence serait le pire des deux.
        setSnapshot((current) => (current === null ? current : {
          ...current,
          messages: current.messages.filter((message) => message.id !== optimistic.id),
        }));
        setDraft(body);
        setAttachments([...files]);
        setError(cause instanceof ApiError ? cause.message : t("support.errorSend"));
      })
      .finally(() => setSending(false));
    requestAnimationFrame(() => {
      resize();
      if (isMobile) releaseComposerKeyboard();
    });
  };

  const notifyTyping = () => {
    const token = tokenRef.current;
    if (readOnly || !snapshot || !token) return;
    const now = Date.now();
    // Une trame toutes les quatre secondes au plus : le plafond de la route
    // est à soixante par minute, et un indicateur de frappe n'a pas besoin
    // d'être précis à la touche près.
    if (now - lastTypingSentAt.current < 4_000) return;
    lastTypingSentAt.current = now;
    void api.support.typing(snapshot.conversationId, token).catch(() => {
      // Un signal de frappe perdu n'a aucune conséquence.
    });
  };

  /**
   * Repartir de zéro : un composer vide, et le fil précédent qui reste dans
   * l'historique.
   *
   * Le jeton local part, parce que c'est lui qui rattacherait le prochain
   * message à l'ancien fil. Pour un opérateur connecté, cela ne suffit pas :
   * le serveur rejoindrait son dernier fil par la porte compte. C'est
   * `freshRef` qui le lui interdit, et seulement pour l'envoi suivant.
   */
  const restart = () => {
    if (readOnly) return;
    setRestarting(true);
    streamRef.current?.close();
    streamRef.current = null;
    clearSupportSession();
    tokenRef.current = null;
    freshRef.current = true;
    setSnapshot(null);
    setView("thread");
    onConversationChange?.(null, { replace: false });
    setEmail("");
    setDraft("");
    setAttachments([]);
    setAttachmentErrors([]);
    setError(null);
    setRestarting(false);
  };

  /**
   * Relit l'historique après une écriture qui l'a changé.
   *
   * Silencieux par choix : l'historique est un confort de navigation, pas le
   * fil. Un échec ici ne doit pas couvrir d'une erreur un panneau qui
   * fonctionne.
   */
  function refreshHistory(): void {
    void api.support
      .history(readSupportSession()?.token ?? null)
      .then((result) => setHistory(result.conversations))
      .catch(() => {});
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!shouldSubmitComposerOnEnter(event, isMobile)) return;
    event.preventDefault();
    submitMessage();
  };

  const messages = snapshot?.messages ?? [];
  /**
   * La liste ne s'ouvre que s'il y a un choix à faire : deux fils, ou un fil
   * ancien alors que le composer est vide (après « repartir de zéro »). Un
   * seul fil ouvert n'a rien à montrer qu'on ne voit pas déjà.
   */
  const canBrowseHistory = view === "history"
    || history.length >= 2
    || (history.length >= 1 && snapshot === null);
  /**
   * La page au bureau : l'historique est la carte « Chat history » du
   * template BoardUI « Chat Starter », sœur de la carte principale, toujours
   * ouverte à partir de `xl`. En dessous, la place manque pour trois cartes :
   * le bouton de la barre et la liste en place du fil restent la règle.
   */
  const boardAside = useBoardAside();
  const historyCanvas = page && !isMobile && boardAside !== null;
  // La carte reste ouverte à côté du fil : elle suit ce qui le change
  // (un envoi, une réponse du staff par le flux, une fermeture). Sinon
  // l'aperçu, l'âge et l'ordre restaient ceux du montage.
  const threadMessageCount = snapshot?.messages.length ?? 0;
  useEffect(() => {
    if (!historyCanvas || !snapshot) return;
    refreshHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyCanvas, snapshot?.conversationId, threadMessageCount, snapshot?.status]);
  const pickHistory = (conversationId: string) => {
    // Sur la page, c'est l'URL qui ouvre le fil : le clic est une
    // navigation, et le retour ramène au précédent.
    if (onConversationChange) {
      setView("thread");
      onConversationChange(conversationId, { replace: false });
      return;
    }
    void openThread(conversationId).catch(() => setError(t("support.errorOpen")));
  };
  const sentOnPointerDown = useRef(false);
  const pageActions = (
    <SupportPageActions
      isMobile={isMobile}
      connected={connected}
      showStatus={snapshot !== null && view === "thread"}
      closed={snapshot?.status === "closed"}
      canBrowseHistory={canBrowseHistory}
      historyOpen={view === "history"}
      historyCanvas={historyCanvas}
      onToggleHistory={() => setView((current) => (current === "history" ? "thread" : "history"))}
    />
  );
  // La barre de l'écran est AU-DESSUS du panneau : les actions y montent.
  // La signature évite de reposer le nœud à chaque rendu, ce qui relancerait
  // le parent, donc ce rendu, sans fin.
  const pageActionsKey = `${historyCanvas}:${isMobile}:${connected}:${snapshot !== null}:${snapshot?.status ?? ""}:${view}:${canBrowseHistory}`;
  useLayoutEffect(() => {
    if (!page || !onPageActions) return;
    onPageActions(pageActions);
    // La clé porte tout ce que les actions affichent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, onPageActions, pageActionsKey]);
  useLayoutEffect(() => () => onPageActions?.(null), [onPageActions]);
  const style: CSSProperties | undefined = isMobile && keyboardInset !== null
    ? {
        height: `${keyboardInset.height}px`,
        transform: keyboardInset.offsetTop !== 0 ? `translateY(${keyboardInset.offsetTop}px)` : undefined,
      }
    : undefined;

  return (
    <section
      ref={panel}
      aria-label={t("support.title")}
      style={style}
      className={cn(
        "flex flex-col overflow-hidden",
        page
          // Une colonne du cadre, comme l'écran d'un fil : le cadre porte
          // déjà le fond, la coque mobile mesure déjà le clavier.
          ? "min-h-0 flex-1"
          : card
          ? "ohb-support-card fixed right-[max(1.5rem,var(--ohb-safe-right))] bottom-[max(1.5rem,var(--ohb-safe-bottom))] z-50 h-[min(560px,calc(100dvh-3rem))] w-[min(384px,calc(100vw-2rem))] rounded-[24px] bg-(--sc-card) py-5 text-(--sc-fg) shadow-(--sc-ring)"
          // Feuille plein cadre : `bg-background`, comme une scène de la coque
          // mobile, et non `bg-card`. L'écran qu'elle recouvre est sur ce même
          // fond, et une feuille d'une autre teinte se lirait comme un
          // panneau étranger posé dessus.
          : "fixed inset-0 z-50 bg-background pt-[var(--ohb-safe-top)] pb-[var(--ohb-safe-bottom)] shadow-[var(--shadow-elevated)]",
      )}
    >
      <div className="flex min-h-0 w-full flex-1 flex-col">
        {/* Sur la page, la barre est celle de l'écran : pas de second en-tête,
            pas de filet. Sans `onPageActions` (un test), les mêmes actions
            restent ici, calées à droite, sans sous-titre orphelin. */}
        {page && !onPageActions ? (
          <div className="flex shrink-0 justify-end px-3 pt-2">{pageActions}</div>
        ) : null}
        {page ? null : (
        <header className={cn("shrink-0 border-b", card ? "border-(--sc-line)" : "border-border")}>
          <div className={cn("mx-auto flex w-full max-w-[38rem] items-start gap-2", card ? "px-5 pb-5" : "px-4 py-3")}>
            <div className="min-w-0 flex-1">
              <p className={card ? "text-base font-medium leading-6" : "text-sm font-medium"}>{t("support.title")}</p>
              <p className={cn("truncate", card ? "text-sm leading-5 text-(--sc-muted-fg)" : "text-xs text-muted-foreground")}>
                {snapshot?.status === "closed"
                  ? t("support.subtitleClosed")
                  : card ? t("support.cardSubtitle") : t("support.subtitleOpen")}
              </p>
            </div>
            {/* Carte : repartir de zéro, le bouton rond de la démo. Il n'existe
                qu'une fois un fil ouvert, sinon il n'y a rien à quitter. */}
            {card && snapshot && view === "thread" ? (
              <button
                type="button"
                onClick={restart}
                disabled={restarting}
                aria-label={t("support.restart")}
                title={t("support.restart")}
                className="ohb-press inline-flex size-8 shrink-0 items-center justify-center rounded-[18px] border border-(--sc-line) text-(--sc-fg) outline-none hover:bg-(--sc-tile) focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
              >
                <IconRefresh aria-hidden className="size-4" />
              </button>
            ) : null}
            {snapshot && view === "thread" && (!card || !connected) ? (
              <span
                className={cn(
                  "mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px]",
                  connected ? "bg-pos-soft text-pos-700" : "bg-muted text-muted-foreground",
                )}
              >
                {connected ? t("support.connected") : t("support.reconnecting")}
              </span>
            ) : null}
            {/* La porte de l'historique n'apparaît QUE s'il y a quelque chose
                derrière : un seul fil ouvert n'a pas de liste à montrer. */}
            {canBrowseHistory ? (
              <button
                type="button"
                data-support-history-toggle=""
                onClick={() => setView(view === "history" ? "thread" : "history")}
                aria-label={view === "history" ? t("support.historyBack") : t("support.historyOpen")}
                title={view === "history" ? t("support.historyBack") : t("support.historyOpen")}
                className="ohb-settings-action mt-0.5 inline-flex shrink-0 items-center justify-center rounded-md p-1 text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                {view === "history"
                  ? <IconArrowLeft aria-hidden className="size-4" />
                  : <IconMessages aria-hidden className="size-4" />}
              </button>
            ) : null}
            {onClose ? (
              <button
                type="button"
                onClick={onClose}
                aria-label={t("support.launcherClose")}
                className={card
                  ? "ohb-press inline-flex size-8 shrink-0 items-center justify-center rounded-[18px] border border-(--sc-line) text-(--sc-fg) outline-none hover:bg-(--sc-tile) focus-visible:ring-2 focus-visible:ring-ring"
                  : "ohb-settings-action mt-0.5 inline-flex shrink-0 items-center justify-center rounded-md p-1 text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"}
              >
              <IconX aria-hidden className="size-4" />
            </button>
            ) : null}
          </div>
        </header>
        )}

        {view === "history" ? (
          <div className="mx-auto flex min-h-0 w-full max-w-[38rem] flex-1 flex-col gap-2 overflow-y-auto px-4 py-4">
            <SupportHistoryList history={history} onPick={pickHistory} onNew={restart} />
          </div>
        ) : snapshot === null && !identified ? (
          <div className={cn("mx-auto flex min-h-0 w-full max-w-[38rem] flex-1 flex-col gap-3 overflow-y-auto px-4 py-4", card && "items-center justify-center px-6 text-center")}>
            {card ? (
              <span aria-hidden className="mb-2 flex size-10 items-center justify-center rounded-[14px] bg-(--sc-tile) text-(--sc-fg)">
                <IconMessageCircle className="size-5" />
              </span>
            ) : null}
            <p className={card ? "text-lg font-medium leading-7 tracking-tight" : "text-sm font-medium"}>{t("support.gateTitle")}</p>
            <p className={card ? "max-w-[18rem] text-sm leading-relaxed text-(--sc-muted-fg)" : "text-xs leading-5 text-muted-foreground"}>{t("support.gateBody")}</p>
            <label className={cn("flex flex-col gap-1.5 text-xs", card ? "w-full text-left text-(--sc-muted-fg)" : "text-muted-foreground")} htmlFor="ohb-support-email">
              {t("support.gateEmailLabel")}
              <input
                id="ohb-support-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  void submitEmail();
                }}
                placeholder={t("support.gateEmailPlaceholder")}
                className={card
                  ? "rounded-[18px] border border-transparent bg-(--sc-box) px-[13px] py-[11px] text-sm leading-5 text-(--sc-fg) outline-none placeholder:text-(--sc-muted-fg) focus-visible:border-(--sc-line)"
                  : "rounded-md border border-border bg-background px-3 py-2 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"}
              />
            </label>
            {error ? <p role="alert" className="text-xs leading-5 text-destructive-text">{error}</p> : null}
            <div className={cn("pt-2", card ? "w-full" : "mt-auto")}>
              <button
                type="button"
                className={card
                  ? "ohb-press flex h-8 w-full items-center justify-center rounded-[18px] bg-(--sc-send) text-sm font-medium text-(--sc-send-fg) outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
                  : cn(BUTTON.primary, "w-full")}
                disabled={readOnly || opening || email.trim().length === 0}
                onClick={() => void submitEmail()}
              >
                {opening ? t("support.gateSubmitting") : t("support.gateSubmit")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <MessageScrollerProvider autoScroll defaultScrollPosition="end">
              <MessageScroller className="min-h-0 flex-1">
                <MessageScrollerViewport aria-label={t("support.title")}>
                  <MessageScrollerContent className="mx-auto w-full max-w-[38rem] gap-3 px-4 py-4">
                    {/* `snapshot` est nul tant qu'un opérateur connecté n'a
                        rien envoyé : le fil n'est créé qu'au premier message.
                        L'écran est le même, il est simplement vide. */}
                    {messages.length === 0 ? (
                      <div className={cn("m-auto text-center", card ? "flex max-w-[20rem] flex-col items-center py-10" : "max-w-[17rem]")}>
                        {card ? (
                          <span aria-hidden className="mb-2 flex size-10 items-center justify-center rounded-[14px] bg-(--sc-tile) text-(--sc-fg)">
                            <IconMessageCircle className="size-5" />
                          </span>
                        ) : null}
                        <p className={card ? "text-lg font-medium leading-7 tracking-tight" : "text-sm font-medium"}>{t("support.emptyTitle")}</p>
                        <p className={card ? "mt-2 max-w-[18rem] text-sm leading-relaxed text-(--sc-muted-fg)" : "mt-1 text-xs leading-5 text-muted-foreground"}>{t("support.emptyBody")}</p>
                      </div>
                    ) : null}
                    {messages.map((message) => (
                      <MessageScrollerItem
                        key={message.id}
                        messageId={message.id}
                        scrollAnchor={message.author === "guest"}
                        className={cn("flex flex-col", message.author === "guest" ? "items-end" : "items-start")}
                      >
                        <span className="px-1 text-[11px] text-muted-foreground">
                          {message.author === "guest"
                            ? t("support.authorGuest")
                            : message.staffName ?? t("support.authorStaffFallback")}
                        </span>
                        <div
                          className={cn(
                            "mt-0.5 max-w-[85%] rounded-2xl px-3 py-2 text-sm",
                            message.author === "guest"
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted text-foreground",
                          )}
                        >
                          <SupportMarkdown body={message.body} />
                          {message.attachments.length > 0 ? (
                            <div className="mt-1.5 flex flex-col gap-1.5">
                              {message.attachments.map((attachment) => (
                                <SupportImage
                                  key={attachment.id}
                                  attachment={attachment}
                                  token={tokenRef.current}
                                />
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </MessageScrollerItem>
                    ))}
                    {staffTyping ? (
                      <MessageScrollerItem messageId="typing" className="px-1 text-[11px] text-muted-foreground">
                        {t("support.staffTyping")}
                      </MessageScrollerItem>
                    ) : null}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton label={t("support.scrollToEnd")} />
              </MessageScroller>
            </MessageScrollerProvider>

            {/* Aucun filet au-dessus du composer : le fil et la pilule
                flottent sur le même fond, comme dans la conversation. Le seul
                trait de l'écran est celui de la pilule. */}
            <div className={cn("shrink-0", card ? "px-5 pt-2" : "px-3 pt-2 pb-3")}>
              <div className="mx-auto w-full max-w-[38rem]">
                {page && snapshot?.status === "closed" ? (
                  <p className="px-1 pb-2 text-xs leading-5 text-muted-foreground">{t("support.subtitleClosed")}</p>
                ) : null}
                {error ? <p className="px-1 pb-2 text-xs leading-5 text-destructive-text">{error}</p> : null}
                {/* La MÊME pilule que le composer du fil
                    (`components/composer.tsx`), et les mêmes attributs
                    `data-composer*` : sous la coque mobile, `mobile.css` lui
                    donne la capsule 44 pt, le corps de texte de 17 px et la
                    mise en page au focus, sans une ligne de CSS de plus ici. */}
                {attachmentErrors.length > 0 ? (
                  <p role="alert" className="px-1 pb-1 text-xs leading-5 text-destructive-text">
                    {attachmentErrors.map(attachmentErrorText).join(" ")}
                  </p>
                ) : null}
                <div
                  data-composer-shell=""
                  className={cn(
                    "flex flex-col gap-2 rounded-[24px] border border-border/60 bg-card p-[10px] transition-colors dark:bg-muted/40",
                    card && "rounded-[18px] border-transparent bg-(--sc-box) p-0 dark:bg-(--sc-box)",
                  )}
                >
                  {/* Les vignettes vivent DANS la pilule, au-dessus de la
                      rangée : c'est la place qu'elles ont dans le composer du
                      fil, et elles suivent son rembourrage. */}
                  {attachments.length > 0 ? (
                    <ul data-composer-attachments="" className="flex flex-wrap gap-2 pb-1">
                      {attachments.map((attachment, index) => (
                        <li key={`${attachment.name}-${index}`} className="relative">
                          <button
                            type="button"
                            onPointerDown={keepSoftKeyboard}
                            onClick={() => setAttachments((current) => current.filter((_, at) => at !== index))}
                            aria-label={t("support.attachmentRemove", { name: attachment.name })}
                            className="absolute -top-1 -right-1 z-10 flex size-4 items-center justify-center rounded-full bg-foreground text-background"
                          >
                            <IconX aria-hidden className="size-2.5" />
                          </button>
                          <span className="block size-14 overflow-hidden rounded-[12px] border border-border/60 bg-muted">
                            {attachmentPreview(attachment) ? (
                              <img
                                src={attachmentPreview(attachment)!}
                                alt={attachment.name}
                                className="size-full object-cover"
                              />
                            ) : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div
                    data-composer-row=""
                    className={cn(
                      "flex items-end gap-2 sm:flex-wrap sm:items-center sm:gap-y-5",
                      card && "flex-wrap px-2.5 pt-1 pb-2",
                    )}
                  >
                    {/* Le vrai champ reste hors écran : sa présentation native
                        ne peut pas être stylée, et c'est le bouton qui porte
                        le libellé accessible. */}
                    <input
                      ref={fileInput}
                      type="file"
                      multiple
                      accept={SUPPORT_ATTACHMENT_ACCEPT}
                      className="hidden"
                      onChange={(event) => {
                        void addFiles([...(event.target.files ?? [])]);
                        // Sans ce vidage, re-choisir LE MÊME fichier n'émettrait
                        // plus aucun `change`.
                        event.target.value = "";
                      }}
                    />
                    <button
                      data-composer-attachment=""
                      type="button"
                      onPointerDown={keepSoftKeyboard}
                      onClick={() => fileInput.current?.click()}
                      disabled={readOnly || preparing || attachments.length >= ATTACHMENT_LIMITS.maxCount}
                      aria-label={t("support.attachmentAdd")}
                      title={t("support.attachmentAdd")}
                      className={cn(
                        "ohb-press flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
                        card && "order-2 rounded-[18px] border border-(--sc-line) bg-(--sc-plus-bg) text-(--sc-muted-fg) hover:bg-(--sc-tile) hover:text-(--sc-fg)",
                      )}
                    >
                      <IconPlus aria-hidden className="size-4" />
                    </button>
                    <div
                      data-composer-field=""
                      className={cn(
                        "relative min-w-0 flex-1 sm:order-first sm:basis-full sm:px-1.5",
                        card && "order-1 -mx-2.5 -mt-1 basis-[calc(100%+1.25rem)] px-0 sm:order-1 sm:px-0",
                      )}
                    >
                      <textarea
                        ref={field}
                        data-composer
                        rows={1}
                        value={draft}
                        disabled={readOnly}
                        maxLength={SUPPORT_MESSAGE_MAX_CHARS}
                        placeholder={t("support.composerPlaceholder")}
                        onChange={(event) => {
                          setDraft(event.target.value);
                          notifyTyping();
                        }}
                        onKeyDown={onKeyDown}
                        // `text-base` reste à 16 px au doigt pour éviter le
                        // zoom Safari. `mobile.css` passe le corps à 17 px.
                        className={cn(
                          "scrollbar-subtle relative block max-h-[min(40vh,200px)] min-h-10 w-full resize-none overflow-hidden bg-transparent px-2.5 py-1 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground md:text-base",
                          card && "px-[13px] pt-[11px] pb-1 text-sm leading-5 text-(--sc-fg) placeholder:text-(--sc-muted-fg) md:text-sm",
                        )}
                      />
                    </div>
                    <button
                      data-composer-action="send"
                      data-composer-primary-action=""
                      data-composer-send-action=""
                      type="button"
                      aria-label={t("support.send")}
                      disabled={readOnly || sending || draft.trim().length === 0}
                      onPointerDown={(event) => {
                        if (!shouldSendComposerOnPointerDown(isMobile)) return;
                        keepSoftKeyboard(event);
                        sentOnPointerDown.current = true;
                        submitMessage();
                      }}
                      onClick={() => {
                        if (sentOnPointerDown.current) {
                          sentOnPointerDown.current = false;
                          return;
                        }
                        submitMessage();
                      }}
                      className={cn(
                        "ohb-press relative flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 after:absolute after:-inset-2 after:rounded-full sm:ml-auto",
                        card && "order-3 ml-auto rounded-[18px] bg-(--sc-send) text-(--sc-send-fg)",
                      )}
                    >
                      <svg viewBox="0 0 16 16" className="size-4" fill="none" aria-hidden>
                        <path
                          d="M8 13V3m0 0L4 7m4-4 4 4"
                          stroke="currentColor"
                          strokeWidth="1.75"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  </div>
                  {/* Le compteur n'apparaît qu'à l'approche du plafond : une
                      jauge permanente sous un champ vide n'apprend rien et
                      fait peur pour rien. Le `maxLength` du champ empêche
                      déjà de dépasser ; ce texte explique pourquoi la frappe
                      s'arrête. */}
                  {readOnly ? (
                    <p role="status" className="px-1.5 pt-0.5 text-xs leading-5 text-muted-foreground">
                      {t("navUser.impersonationReadOnly")}
                    </p>
                  ) : null}
                  {draft.length >= SUPPORT_MESSAGE_MAX_CHARS * 0.8 ? (
                    <p
                      aria-live="polite"
                      className={cn(
                        "px-1.5 pt-0.5 text-right text-[11px]",
                        draft.length >= SUPPORT_MESSAGE_MAX_CHARS
                          ? "text-destructive-text"
                          : "text-muted-foreground",
                      )}
                    >
                      {t("support.composerCount", {
                        count: String(draft.length),
                        max: String(SUPPORT_MESSAGE_MAX_CHARS),
                      })}
                    </p>
                  ) : null}
                </div>
                {/* Repartir de zéro n'est proposé QUE sur un fil clos :
                    ailleurs, c'est un bouton qui jette la conversation en
                    cours, et le visiteur ne peut pas revenir en arrière. */}
                {snapshot?.status === "closed" ? (
                  <button
                    type="button"
                    className={cn(BUTTON.small, "mt-2")}
                    disabled={restarting || readOnly}
                    onClick={restart}
                  >
                    {t("support.restart")}
                  </button>
                ) : null}
              </div>
            </div>
          </>
        )}
      </div>
      {historyCanvas && boardAside
        ? createPortal(
            <SupportHistoryCanvas
              history={history}
              activeId={snapshot?.conversationId ?? null}
              onPick={pickHistory}
              onNew={restart}
            />,
            boardAside,
          )
        : null}
    </section>
  );
}

/**
 * Le côté droit de la barre de `/support` : la même hauteur que la pilule
 * « Support » (31 px), le même verre. Au doigt, 44 pt, comme les autres
 * commandes de la barre mobile.
 */
function SupportPageActions({
  isMobile,
  connected,
  showStatus,
  closed,
  canBrowseHistory,
  historyOpen,
  historyCanvas,
  onToggleHistory,
}: {
  isMobile: boolean;
  connected: boolean;
  showStatus: boolean;
  closed: boolean;
  canBrowseHistory: boolean;
  historyOpen: boolean;
  /** La carte d'historique tient la liste à partir de `xl` : le bouton s'efface. */
  historyCanvas: boolean;
  onToggleHistory: () => void;
}) {
  const { t } = useT();
  const statusLabel = closed
    ? t("support.historyClosed")
    : connected ? t("support.connected") : t("support.reconnecting");
  return (
    <div className="flex items-center gap-1.5">
      {showStatus ? (
        <span
          className={cn(
            "inline-flex items-center gap-1.5 text-text-secondary",
            isMobile ? "h-11 px-2 text-sm" : "bui-glass h-[31px] rounded-full px-2.5 text-xs",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              closed ? "bg-muted-foreground" : connected ? "bg-pos-700" : "animate-pulse bg-muted-foreground",
            )}
          />
          <span className="max-w-[14rem] truncate">{statusLabel}</span>
        </span>
      ) : null}
      {canBrowseHistory ? (
        <button
          type="button"
          data-support-history-toggle=""
          onClick={onToggleHistory}
          aria-label={historyOpen ? t("support.historyBack") : t("support.historyOpen")}
          title={historyOpen ? t("support.historyBack") : t("support.historyOpen")}
          className={cn(
            "inline-flex shrink-0 items-center justify-center text-text-secondary outline-none focus-visible:ring-2 focus-visible:ring-ring",
            isMobile ? "ohb-press size-11 rounded-lg text-foreground" : "bui-glass size-[31px] rounded-full",
            historyCanvas && "xl:hidden",
          )}
        >
          {historyOpen
            ? <IconArrowLeft aria-hidden className={isMobile ? "size-6" : "size-4"} />
            : <IconMessages aria-hidden className={isMobile ? "size-6" : "size-4"} />}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Les fils de ce visiteur, du plus récent au plus ancien, et la seule porte
 * vers un fil neuf : la liste en place du fil (carte, mobile, page étroite).
 */
function SupportHistoryList({
  history,
  onPick,
  onNew,
}: {
  history: readonly SupportThreadSummaryDto[];
  onPick: (conversationId: string) => void;
  onNew: () => void;
}) {
  const { t, formatDate } = useT();
  return (
    <>
      <p className="text-sm font-medium">{t("support.historyTitle")}</p>
      {history.length === 0 ? (
        <p className="text-xs leading-5 text-muted-foreground">{t("support.historyEmpty")}</p>
      ) : null}
      {history.map((item) => (
          <button
            key={item.conversationId}
            type="button"
            data-support-history-item={item.conversationId}
            onClick={() => onPick(item.conversationId)}
            className="ohb-press flex w-full flex-col gap-1 rounded-2xl border border-border/60 bg-card px-3 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring dark:bg-muted/40"
          >
            <span className="flex w-full items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                {formatDate(item.lastMessageAt ?? item.createdAt)}
              </span>
              {item.status === "closed" ? (
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {t("support.historyClosed")}
                </span>
              ) : null}
              {item.unreadCount > 0 ? (
                <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-[11px] text-primary-foreground">
                  {item.unreadCount}
                </span>
              ) : null}
            </span>
            <span className="line-clamp-2 text-sm text-foreground">
              {item.lastMessagePreview ?? t("support.historyNoMessage")}
            </span>
          </button>
      ))}
      {/* Un fil neuf se demande ICI, et nulle part ailleurs : c'est le seul
          endroit où l'on voit ce qu'on laisse derrière soi. */}
      <div className="mt-auto pt-2">
        <button type="button" className={cn(BUTTON.secondary, "w-full")} onClick={onNew}>
          {t("support.historyNew")}
        </button>
      </div>
    </>
  );
}

/**
 * La carte « Chat history » du template BoardUI « Chat Starter », à droite
 * de la carte principale : « Nouvelle conversation » en tête, puis les fils
 * récents sur une ligne (aperçu tronqué, âge à droite, point si une réponse
 * du staff attend). Le fil à l'écran est surligné.
 */
function SupportHistoryCanvas({
  history,
  activeId,
  onPick,
  onNew,
}: {
  history: readonly SupportThreadSummaryDto[];
  activeId: string | null;
  onPick: (conversationId: string) => void;
  onNew: () => void;
}) {
  const { t, locale } = useT();
  return (
    <aside
      aria-label={t("support.historyTitle")}
      data-support-history-canvas=""
      className="ms-4 hidden h-full w-[260px] shrink-0 flex-col gap-6 overflow-hidden rounded-3xl bg-background-secondary-default p-3 xl:flex"
    >
      <button
        type="button"
        onClick={onNew}
        className="flex w-full cursor-pointer items-center gap-2 rounded-2lg px-2 py-2 text-body-medium text-text-primary outline-none transition-colors hover:bg-background-secondary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        <RiAddLine aria-hidden className="size-5 shrink-0 text-foreground-icon-secondary" />
        {t("support.historyNew")}
      </button>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto [scrollbar-width:none]">
        <p className="px-2 pb-1 text-body-2-medium text-text-tertiary">{t("support.historyTitle")}</p>
        {history.length === 0 ? (
          <p className="px-2 text-body-2-regular text-text-tertiary">{t("support.historyEmpty")}</p>
        ) : null}
        {history.map((item) => {
          const active = item.conversationId === activeId;
          const unread = item.unreadCount > 0;
          const closed = item.status === "closed";
          return (
            <button
              key={item.conversationId}
              type="button"
              data-support-history-item={item.conversationId}
              aria-current={active ? "true" : undefined}
              title={closed ? t("support.historyClosed") : undefined}
              onClick={() => {
                if (!active) onPick(item.conversationId);
              }}
              className={cn(
                "flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-2lg py-1.5 ps-2 pe-2 text-start outline-none transition-colors focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                active ? "bg-background-secondary-hover" : "hover:bg-background-secondary-hover",
              )}
            >
              {unread ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-button-primary" /> : null}
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-body-2-regular",
                  unread ? "text-text-primary" : closed ? "text-text-tertiary" : "text-text-secondary",
                )}
              >
                {item.lastMessagePreview ?? t("support.historyNoMessage")}
              </span>
              <span className="shrink-0 text-caption-1-regular text-text-tertiary">
                {ageSince(locale, item.lastMessageAt ?? item.createdAt)}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

/**
 * L'aperçu d'une capture AVANT l'envoi : le data-URI que le client vient
 * d'encoder, tel quel.
 *
 * Rien n'est retéléversé ni retéléchargé pour afficher une vignette : les
 * octets sont déjà là, dans le brouillon. Après l'envoi, c'est l'autre chemin
 * qui sert (`SupportImage`), parce que les octets ne sont plus dans le client.
 */
function attachmentPreview(attachment: MessageAttachmentInput): string | null {
  const part = attachment.content[0];
  return part && part.type === "image" ? part.image : null;
}

/**
 * Ce qu'on dit d'un fichier refusé. Nommé, jamais générique : le visiteur doit
 * savoir lequel et pourquoi, sinon il réessaie le même.
 */
function attachmentErrorText(error: AttachmentError): string {
  if (error.code === "too-many") return `${ATTACHMENT_LIMITS.maxCount} images maximum.`;
  if (error.code === "too-large") return `${error.name} dépasse 1 Mo.`;
  if (error.code === "unsupported") return `${error.name} n’est pas une image.`;
  return `${error.name} n’a pas pu être lu.`;
}
