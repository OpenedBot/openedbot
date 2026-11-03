import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@openedbot/browser-ui-kit";
import type { BotFaceSpec, BotProfileProvisionProgress } from "@openedbot/contracts-api";
import { BotArrivalStage } from "./bot-arrival-stage";

/**
 * Le démarrage d'un bot neuf. Tant que son profil n'est pas prêt sur l'hôte,
 * l'écran du centre reste seul : ni fil ni composer, qui apparaîtraient puis
 * bougeraient. L'accueil attend ce profil (la file du worker le retient) :
 * profil prêt, le fil vide et le composer arrivent, puis l'accueil s'y écrit
 * en direct avec les indicateurs habituels. Un run en échec rend la main au
 * fil, qui sait dire l'échec.
 */
export function threadStartShown(input: {
  provisioning: boolean;
  runs: ReadonlyArray<{ status: string }>;
}): boolean {
  if (input.runs.some((run) => run.status === "failed")) return false;
  return input.provisioning;
}

/**
 * Le même écran que « {name} arrive… » (bot-creating-screen.tsx), qui le
 * précède : du clic sur « Créer » au profil prêt, le visage et les vraies
 * étapes de la préparation (`BotArrivalStage`), au centre.
 */
export function ThreadStartStage({ bot }: {
  bot: { id: string; name: string; face?: BotFaceSpec | null; profileProvisionProgress?: BotProfileProvisionProgress | null };
}) {
  return <BotArrivalStage bot={bot} progress={bot.profileProvisionProgress} />;
}

type ProvisionStatus = "preparing" | "failed" | null | undefined;

/**
 * Vrai quand ce bot vient de sortir de la préparation sous les yeux de
 * l'utilisateur (`preparing` puis ni `preparing` ni `failed`) : jamais au
 * montage d'un bot déjà prêt, ni en passant d'un bot à l'autre.
 */
export function provisionJustFinished(
  previous: { botId: string; status: ProvisionStatus } | null,
  current: { botId: string; status: ProvisionStatus },
): boolean {
  return previous?.botId === current.botId && previous.status === "preparing" &&
    current.status !== "preparing" && current.status !== "failed";
}

/**
 * Vrai, pour ce bot, à partir du moment où on l'a vu sortir de la
 * préparation.
 */
function useProvisionArrival(bot: { id: string }, status: ProvisionStatus): boolean {
  const previous = useRef<{ botId: string; status: ProvisionStatus } | null>(null);
  const [arrivedFor, setArrivedFor] = useState<string | null>(null);
  useEffect(() => {
    const current = { botId: bot.id, status };
    if (provisionJustFinished(previous.current, current)) {
      setArrivedFor(bot.id);
    }
    previous.current = current;
  }, [bot.id, status]);
  return arrivedFor === bot.id;
}

/**
 * Le fil d'un bot neuf : quand le profil devient prêt, il remplace l'écran
 * du centre en fondu, au même instant que le composer.
 */
export function ThreadArrival({ bot, status, children }: {
  bot: { id: string };
  status: ProvisionStatus;
  children: ReactNode;
}) {
  const arrived = useProvisionArrival(bot, status);
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", arrived && "animate-in fade-in-0 duration-500 ease-out motion-reduce:animate-none")}>
      {children}
    </div>
  );
}

/**
 * Le composer d'un bot qui se prépare : absent tant que son profil n'est pas
 * prêt (l'écran du centre parle seul). Profil prêt, il entre (fondu +
 * montée) avec le fil. Pas de toast : le composer qui arrive le dit déjà,
 * et le toast recouvrait son bouton d'envoi.
 */
export function ComposerArrival({ bot, status, children }: {
  bot: { id: string; name: string };
  status: ProvisionStatus;
  children: ReactNode;
}) {
  const arrived = useProvisionArrival(bot, status);
  if (status === "preparing") return null;
  return (
    <div
      data-composer-arrival={arrived ? "" : undefined}
      className={cn(
        "w-full shrink-0",
        arrived && "animate-in fade-in-0 slide-in-from-bottom-6 duration-500 ease-out motion-reduce:animate-none",
      )}
    >
      {children}
    </div>
  );
}
