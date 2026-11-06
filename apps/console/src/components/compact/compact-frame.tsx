import { useEffect, useMemo, useState } from "react";
import { Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@openedbot/browser-ui-kit";
import { api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { BUTTON } from "../settings/primitives";
import { BotFace } from "../bot-face";
import { SettingsOverlayContext, type SettingsOverlay } from "../../lib/shell/settings-overlay";
import { nativeBridge, openInBrowser } from "../../lib/platform";
import { readCloudSession, subscribeCloudSession } from "../../lib/session/cloud-session";
import { rememberCompactLastBot } from "../../lib/shell/compact-shell";
import { APP_HOME_HREF } from "../../lib/workspace/workspace-location";
import { visibleRosterItems } from "../../lib/thread/thread-visibility";

/**
 * Le cadre de la fenêtre compacte (DEV-139) : une barre d'un bot et le fil.
 *
 * Pas de `BoardFrame`, pas de barre latérale, pas de surcouche de réglages :
 * tout ce qui n'est pas la conversation s'ouvre hors de la fenêtre
 * (`openInBrowser`). L'écran de conversation est le même qu'ailleurs
 * (`screens/conversation/conversation.tsx`) : à 420 px de large il rend sa
 * variante téléphone, ce qui est voulu ; seul le composer garde la sémantique
 * souris + clavier, décidée par `pointer: coarse`, pas par la largeur.
 */
export function CompactFrame({ signedOut }: { signedOut: boolean }) {
  const [sessionLost, setSessionLost] = useState(signedOut);
  useEffect(() => {
    if (signedOut) return;
    // Un 401 nommé efface la session (`lib/api.ts`) : ici personne ne renvoie
    // vers `/login`, la fenêtre dit elle-même que la session est perdue.
    return subscribeCloudSession(() => {
      if (!readCloudSession()) setSessionLost(true);
    });
  }, [signedOut]);
  const overlay = useMemo<SettingsOverlay>(() => ({ open: (to) => openInBrowser(to), close: () => undefined }), []);
  if (sessionLost) return <CompactSignedOut />;
  return (
    <SettingsOverlayContext.Provider value={overlay}>
      <div className="flex h-full min-h-0 w-full flex-col bg-background">
        <CompactBotBar />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Outlet />
        </div>
      </div>
    </SettingsOverlayContext.Provider>
  );
}

/** Le choix du bot : un sélecteur natif, lisible au clavier, et la porte vers la console entière. */
function CompactBotBar() {
  const { t } = useT();
  const navigate = useNavigate();
  const { botId } = useParams({ strict: false }) as { botId?: string };
  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster });
  const bots = useMemo(
    () => visibleRosterItems(roster.data?.bots ?? []).filter((bot) => bot.archivedAt === null),
    [roster.data],
  );
  const current = bots.find((bot) => bot.id === botId);
  useEffect(() => {
    if (botId && current) rememberCompactLastBot(botId);
  }, [botId, current]);
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-sidebar px-3 py-1.5 text-sm">
      {current ? <BotFace name={current.name} seed={current.id} face={current.face} className="size-6 shrink-0" /> : null}
      <label className="flex min-w-0 flex-1 items-center gap-2">
        <span className="sr-only">{t("compactShell.pickBot")}</span>
        <Select
          value={current?.id ?? ""}
          disabled={bots.length === 0}
          onValueChange={(next) => {
            if (next) void navigate({ to: "/compact/$botId", params: { botId: next } });
          }}
        >
          <SelectTrigger size="sm" aria-label={t("compactShell.pickBot")} className="min-w-0 flex-1">
            <SelectValue placeholder={t("compactShell.pickBot")} />
          </SelectTrigger>
          <SelectContent>
            {bots.map((bot) => (
              <SelectItem key={bot.id} value={bot.id}>{bot.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <button type="button" className={BUTTON.small} onClick={() => openInBrowser(current ? `/bot/${current.id}` : APP_HOME_HREF)}>
        {t("compactShell.openConsole")}
      </button>
    </div>
  );
}

/** `/compact` sans aucun bot : la création se fait dans la console entière. */
export function CompactEmpty() {
  const { t } = useT();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
      <p>{t("compactShell.noBot")}</p>
      <button type="button" className={BUTTON.primary} onClick={() => openInBrowser(APP_HOME_HREF)}>
        {t("compactShell.openConsole")}
      </button>
    </div>
  );
}

/**
 * Session absente ou perdue. Dans la coque, `signOut()` lui rend la main : elle
 * montre sa page « Se connecter avec Google ». Dans un navigateur, `/login`.
 */
function CompactSignedOut() {
  const { t } = useT();
  const navigate = useNavigate();
  const bridge = nativeBridge();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
      <p>{t("compactShell.signedOut")}</p>
      <button
        type="button"
        className={BUTTON.primary}
        onClick={() => {
          if (bridge) void bridge.signOut();
          else void navigate({ to: "/login", search: { redirect: window.location.href }, replace: true });
        }}
      >
        {t("compactShell.signIn")}
      </button>
    </div>
  );
}
