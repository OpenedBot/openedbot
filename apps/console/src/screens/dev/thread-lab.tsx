/**
 * `/dev/thread-lab` (dev only, mounted by `route-tree.tsx` under
 * `import.meta.env.DEV === true`): the current thread and composer next to a
 * prototype drawn from streaming-ui.pulseview.app (composers, responses,
 * templates), both fed by ONE scripted event stream
 * (`lib/dev/thread-lab-script.ts`). Nothing here calls the API or a runtime.
 */
import type { MessageAuthorBot } from "@openedbot/contracts-api";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { cn, useIsMobile } from "@openedbot/browser-ui-kit";
import { Composer } from "../../components/composer";
import { LAB_ACTIVITY_STYLES } from "../../components/dev/thread-lab/lab-activity";
import { LAB_TEXT_MODES } from "../../components/dev/thread-lab/lab-answer";
import { LabComposer, type LabComposerVariant } from "../../components/dev/thread-lab/lab-composer";
import { LAB_INDICATORS } from "../../components/dev/thread-lab/lab-indicators";
import { LabThread, type LabResponseStyle } from "../../components/dev/thread-lab/lab-thread";
import { SiteHeader } from "../../components/dashboard/site-header";
import { RunActivityDock } from "../../components/run-activity-dock";
import { BUTTON } from "../../components/settings/primitives";
import { ThreadTimeline } from "../../components/thread-timeline";
import { deriveLabTurns, LAB_SCENARIOS, labScenario } from "../../lib/dev/thread-lab-script";
import { LAB_MODEL, useThreadLabPlayback } from "../../lib/dev/use-thread-lab-playback";
import "../../styles/components/thread-lab.css";

type LabView = "current" | "prototype" | "split";

const LAB_AUTHOR: MessageAuthorBot = { id: "lab-bot", name: "Lab", slug: "lab", face: null };
const NO_APPROVALS: never[] = [];
const SPEEDS = [0.5, 1, 2, 4] as const;
const STARTERS = LAB_SCENARIOS.map((scenario) => scenario.prompt);

export function ThreadLabScreen() {
  const isMobile = useIsMobile();
  const [view, setView] = useState<LabView>("split");
  const [scenarioId, setScenarioId] = useState(LAB_SCENARIOS[0]!.id);
  const [speed, setSpeed] = useState<number>(1);
  const [variant, setVariant] = useState<LabComposerVariant>("box");
  const [centered, setCentered] = useState(false);
  const [responseStyle, setResponseStyle] = useState<LabResponseStyle>({ indicator: "wave", activity: "fold", text: "smooth" });
  const [currentDraft, setCurrentDraft] = useState("");
  const [prototypeDraft, setPrototypeDraft] = useState("");
  const lab = useThreadLabPlayback(speed);
  const scenario = labScenario(scenarioId);
  // A phone has no room for two threads: the split falls back to the prototype.
  const shown: LabView = isMobile && view === "split" ? "prototype" : view;

  const turns = useMemo(() => deriveLabTurns(lab.userInputs, lab.events, lab.runs), [lab.userInputs, lab.events, lab.runs]);
  const { send, reset, stop } = lab;

  /** A typed message gets the selected scenario's reply; a starter picks its own scenario. */
  const sendText = useCallback((text: string) => {
    const own = LAB_SCENARIOS.find((candidate) => candidate.prompt === text);
    if (own) setScenarioId(own.id);
    send(text, own ?? scenario);
  }, [scenario, send]);

  const replay = () => {
    reset();
    send(scenario.prompt, scenario);
  };

  const regenerate = () => {
    const last = lab.userInputs[lab.userInputs.length - 1];
    if (last) send(last.text, scenario);
  };

  const current = (
    <LabPane label="Actuel" detail="ThreadTimeline + Composer">
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ThreadTimeline
          events={lab.events}
          userInputs={lab.userInputs}
          runs={lab.runDtos}
          approvals={NO_APPROVALS}
          running={lab.running}
          defaultAuthor={LAB_AUTHOR}
          scrollToBottomOnThreadKey="thread-lab"
        />
      </div>
      <RunActivityDock runs={lab.runDtos} events={lab.events} approvals={NO_APPROVALS} running={lab.running} streaming statusInThread />
      <Composer
        value={currentDraft}
        onChange={setCurrentDraft}
        onSubmit={() => {
          sendText(currentDraft);
          setCurrentDraft("");
        }}
        onCancel={stop}
        botName={LAB_AUTHOR.name ?? "Lab"}
        disabled={false}
        running={lab.running}
        showPlugins={false}
      />
    </LabPane>
  );

  const prototype = (
    <LabPane
      label="Prototype"
      detail={`${LAB_INDICATORS.find((item) => item.value === responseStyle.indicator)?.label} · ${LAB_ACTIVITY_STYLES.find((item) => item.value === responseStyle.activity)?.label} · ${LAB_TEXT_MODES.find((item) => item.value === responseStyle.text)?.label} · composer ${variant === "box" ? "Box" : "Pill"}`}
    >
      <LabThread
        turns={turns}
        responseStyle={responseStyle}
        centered={centered}
        followUps={scenario.followUps}
        starters={STARTERS}
        onPick={sendText}
        onRegenerate={regenerate}
      />
      <div className={cn("shrink-0 px-4 pb-3 sm:px-6", centered && "mx-auto w-full max-w-3xl")}>
        <LabComposer
          variant={variant}
          value={prototypeDraft}
          onChange={setPrototypeDraft}
          onSend={() => {
            sendText(prototypeDraft);
            setPrototypeDraft("");
          }}
          onStop={stop}
          busy={lab.running}
          model={LAB_MODEL}
        />
      </div>
    </LabPane>
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <SiteHeader title="Thread lab" />
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-separator-border px-4 py-2 sm:px-6">
        <LabSegmented
          label="Vue"
          value={view}
          onChange={setView}
          options={[
            { value: "current", label: "Actuel" },
            { value: "prototype", label: "Prototype" },
            ...(isMobile ? [] : [{ value: "split" as const, label: "Côte à côte" }]),
          ]}
        />
        <label className="flex items-center gap-2 text-body-2-medium text-text-secondary">
          Scénario
          <select
            value={scenarioId}
            onChange={(event) => setScenarioId(event.target.value)}
            className="h-8 rounded-md border border-border-button-default bg-background-primary-default px-2 text-body-2-regular text-text-primary"
          >
            {LAB_SCENARIOS.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-body-2-medium text-text-secondary">
          Vitesse
          <select
            value={speed}
            onChange={(event) => setSpeed(Number(event.target.value))}
            className="h-8 rounded-md border border-border-button-default bg-background-primary-default px-2 text-body-2-regular text-text-primary"
          >
            {SPEEDS.map((value) => <option key={value} value={value}>{value}×</option>)}
          </select>
        </label>
        {shown !== "current" ? (
          <>
            <LabSegmented
              label="Composer"
              value={variant}
              onChange={setVariant}
              options={[{ value: "box", label: "Box" }, { value: "pill", label: "Pill" }]}
            />
            <LabSegmented
              label="Colonne"
              value={centered ? "centered" : "full"}
              onChange={(next) => setCentered(next === "centered")}
              options={[{ value: "full", label: "Pleine largeur" }, { value: "centered", label: "Centrée" }]}
            />
          </>
        ) : null}
        <div className="ms-auto flex items-center gap-2">
          <button type="button" className={BUTTON.secondary} onClick={replay}>Rejouer</button>
          <button type="button" className={BUTTON.secondary} onClick={reset}>Vider</button>
        </div>
      </div>
      {shown !== "current" ? (
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-separator-border px-4 py-2 sm:px-6">
          <span className="text-body-2-medium text-text-tertiary">Réponse</span>
          <LabSelect
            label="Indicateur"
            value={responseStyle.indicator}
            options={LAB_INDICATORS}
            onChange={(indicator) => setResponseStyle((current) => ({ ...current, indicator }))}
          />
          <LabSelect
            label="Activité"
            value={responseStyle.activity}
            options={LAB_ACTIVITY_STYLES}
            onChange={(activity) => setResponseStyle((current) => ({ ...current, activity }))}
          />
          <LabSelect
            label="Texte"
            value={responseStyle.text}
            options={LAB_TEXT_MODES}
            onChange={(text) => setResponseStyle((current) => ({ ...current, text }))}
          />
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        {shown !== "prototype" ? current : null}
        {shown !== "current" ? prototype : null}
      </div>
    </div>
  );
}

function LabPane({ label, detail, children }: { label: string; detail: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="flex min-h-0 min-w-0 flex-1 flex-col border-separator-border not-first:border-l">
      <p className="shrink-0 px-4 pt-2 text-caption-1-regular text-text-tertiary sm:px-6">
        <span className="text-text-secondary">{label}</span> · {detail}
      </p>
      {children}
    </section>
  );
}

function LabSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (next: T) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-body-2-medium text-text-secondary">
      {label}
      <select
        value={value}
        onChange={(event) => {
          const next = options.find((option) => option.value === event.target.value);
          if (next) onChange(next.value);
        }}
        className="h-8 rounded-md border border-border-button-default bg-background-primary-default px-2 text-body-2-regular text-text-primary"
      >
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function LabSegmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (next: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-2 text-body-2-medium text-text-secondary">
      {label}
      <div className="flex rounded-lg bg-background-tertiary-default p-0.5">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
            className="rounded-md px-2.5 py-1 text-body-2-medium text-text-secondary transition-colors hover:text-text-primary aria-pressed:bg-background-primary-default aria-pressed:text-text-primary aria-pressed:shadow-xs"
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
