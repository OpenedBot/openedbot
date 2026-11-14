import {
  IconBrain,
  IconBrowser,
  IconCheck,
  IconCode,
  IconEye,
  IconFile,
  IconHistory,
  IconListCheck,
  IconPhoto,
  IconSparkles,
  IconTerminal2,
  IconTool,
  IconWorld,
  type Icon,
} from "@tabler/icons-react";
import { cn } from "@openedbot/browser-ui-kit";
import type { BotFaceSpec, BotProfileProvisionProgress } from "@openedbot/contracts-api";
import { BotFace } from "./bot-face";
import { useT, type MessageKey } from "../lib/i18n";

type Step = BotProfileProvisionProgress["step"];
type StepState = "done" | "active" | "next";

const STEPS: ReadonlyArray<{ step: Step; label: MessageKey }> = [
  { step: "space", label: "botProfileProvision.stepSpace" },
  { step: "rules", label: "botProfileProvision.stepRules" },
  { step: "tools", label: "botProfileProvision.stepTools" },
];

/**
 * Each step's state from the one the worker publishes (0164). With no
 * step yet (creation in progress, provision queued), the first one spins.
 */
export function arrivalStepStates(progress: BotProfileProvisionProgress | null | undefined): StepState[] {
  const current = Math.max(0, STEPS.findIndex((entry) => entry.step === progress?.step));
  return STEPS.map((_, index) => (index < current ? "done" : index === current ? "active" : "next"));
}

/** The base Hermes toolsets, named and illustrated; an unknown name stays as it is. */
const TOOLS: Record<string, { icon: Icon; label: MessageKey }> = {
  web: { icon: IconWorld, label: "botProfileProvision.toolWeb" },
  terminal: { icon: IconTerminal2, label: "botProfileProvision.toolTerminal" },
  file: { icon: IconFile, label: "botProfileProvision.toolFile" },
  code_execution: { icon: IconCode, label: "botProfileProvision.toolCodeExecution" },
  vision: { icon: IconEye, label: "botProfileProvision.toolVision" },
  skills: { icon: IconSparkles, label: "botProfileProvision.toolSkills" },
  browser: { icon: IconBrowser, label: "botProfileProvision.toolBrowser" },
  image_gen: { icon: IconPhoto, label: "botProfileProvision.toolImageGen" },
  todo: { icon: IconListCheck, label: "botProfileProvision.toolTodo" },
  memory: { icon: IconBrain, label: "botProfileProvision.toolMemory" },
  session_search: { icon: IconHistory, label: "botProfileProvision.toolSessionSearch" },
};

/**
 * From the click on « Créer » until the profile is ready: the bot's face, « {nom} arrive… »
 * and the real steps of its preparation on the server (its space, its
 * rules, its tools, named as soon as the worker knows them). Rendered
 * identically by the provisional screen (`BotCreatingScreen`, before the
 * API answers) then by the conversation (`ThreadStartStage`): no entrance
 * animation, so the screen change is not visible. Only state
 * changes move: a finished step's check, the tools that
 * arrive one by one.
 */
export function BotArrivalStage({ bot, progress }: {
  bot: { id: string | null; name: string; face?: BotFaceSpec | null };
  progress: BotProfileProvisionProgress | null | undefined;
}) {
  const { t } = useT();
  const states = arrivalStepStates(progress);
  const tools = progress?.step === "tools" ? progress.tools ?? [] : [];
  return (
    <div
      data-thread-start=""
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-6 text-center"
    >
      <div className="flex flex-col items-center gap-4">
        <BotFace name={bot.name} seed={bot.id ?? "preview"} face={bot.face} animated className="size-24" />
        <p className="text-base font-semibold text-text-primary">{t("newBotDialog.creatingTitle", { name: bot.name })}</p>
      </div>
      <ol
        role="status"
        aria-live="polite"
        aria-label={t("botProfileProvision.stepsLabel", { name: bot.name })}
        className="flex w-full max-w-72 flex-col gap-2.5 text-left"
      >
        {STEPS.map((entry, index) => {
          const state = states[index]!;
          return (
            <li
              key={entry.step}
              data-arrival-step={entry.step}
              data-state={state}
              aria-current={state === "active" ? "step" : undefined}
              className="flex flex-col gap-2"
            >
              <div className="flex items-center gap-2.5">
                <StepMark state={state} />
                <span
                  className={cn(
                    "text-sm transition-colors duration-300 motion-reduce:transition-none",
                    state === "active" ? "text-text-primary" : state === "done" ? "text-text-secondary" : "text-text-tertiary",
                  )}
                >
                  {t(entry.label)}
                </span>
              </div>
              {entry.step === "tools" && tools.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5 pl-6.5">
                  {tools.map((name, toolIndex) => {
                    const known = TOOLS[name];
                    const ToolIcon = known?.icon ?? IconTool;
                    return (
                      <li
                        key={name}
                        data-arrival-tool={name}
                        // One by one: the list arrives as a block, the eye reads it in order.
                        style={{ animationDelay: `${toolIndex * 90}ms` }}
                        className="inline-flex items-center gap-1 rounded-full bg-background-tertiary-default px-2 py-0.5 text-xs text-text-secondary animate-in fade-in-0 zoom-in-90 slide-in-from-bottom-1 fill-mode-both duration-300 ease-out motion-reduce:animate-none"
                      >
                        <ToolIcon aria-hidden className="size-3.5" stroke={1.75} />
                        {known ? t(known.label) : name}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function StepMark({ state }: { state: StepState }) {
  if (state === "done") {
    return (
      <span
        aria-hidden
        className="flex size-4 shrink-0 items-center justify-center rounded-full bg-text-primary text-background-secondary-default animate-in zoom-in-50 fade-in-0 duration-200 ease-out motion-reduce:animate-none"
      >
        <IconCheck className="size-3" stroke={3} />
      </span>
    );
  }
  if (state === "active") {
    return (
      <span
        aria-hidden
        className="size-4 shrink-0 rounded-full border-2 border-text-tertiary border-t-text-primary animate-spin motion-reduce:animate-none"
      />
    );
  }
  return <span aria-hidden className="size-4 shrink-0 rounded-full border border-text-placeholder" />;
}
