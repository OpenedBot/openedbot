import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@openedbot/browser-ui-kit";
import type { BotFaceSpec, BotProfileProvisionProgress } from "@openedbot/contracts-api";
import { BotArrivalStage } from "./bot-arrival-stage";

/**
 * The start of a new bot. For as long as its profile is not ready on the host,
 * the centre screen stays alone: neither thread nor composer, which would appear then
 * move. The welcome waits for that profile (the worker's queue holds it):
 * profile ready, the empty thread and the composer arrive, then the welcome writes itself
 * there live with the usual indicators. A failed run hands back to the
 * thread, which knows how to say the failure.
 */
export function threadStartShown(input: {
  provisioning: boolean;
  runs: ReadonlyArray<{ status: string }>;
}): boolean {
  if (input.runs.some((run) => run.status === "failed")) return false;
  return input.provisioning;
}

/**
 * The same screen as « {name} arrive… » (bot-creating-screen.tsx), which
 * precedes it: from the click on « Créer » until the profile is ready, the face and the real
 * preparation steps (`BotArrivalStage`), at the centre.
 */
export function ThreadStartStage({ bot }: {
  bot: { id: string; name: string; face?: BotFaceSpec | null; profileProvisionProgress?: BotProfileProvisionProgress | null };
}) {
  return <BotArrivalStage bot={bot} progress={bot.profileProvisionProgress} />;
}

type ProvisionStatus = "preparing" | "failed" | null | undefined;

/**
 * True when this bot has just come out of preparation under the user's
 * eyes (`preparing` then neither `preparing` nor `failed`): never on
 * mount of an already ready bot, nor when switching from one bot to another.
 */
export function provisionJustFinished(
  previous: { botId: string; status: ProvisionStatus } | null,
  current: { botId: string; status: ProvisionStatus },
): boolean {
  return previous?.botId === current.botId && previous.status === "preparing" &&
    current.status !== "preparing" && current.status !== "failed";
}

/**
 * True, for this bot, from the moment one has seen it come out of
 * preparation.
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
 * A new bot's thread: when the profile becomes ready, it replaces the centre
 * screen with a fade, at the same instant as the composer.
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
 * The composer of a bot that is preparing: absent for as long as its profile is not
 * ready (the centre screen speaks alone). Profile ready, it enters (fade +
 * rise) with the thread. No toast: the composer arriving already says it,
 * and the toast covered its send button.
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
