import { useEffect, useMemo, useState } from "react";
import { ListChecks, MessageCircleQuestion, MessageSquareText, ShieldCheck } from "lucide-react";
import { Dialog } from "@openedbot/browser-ui-kit";
import { useT } from "../lib/i18n";
import { BUTTON } from "./settings/primitives";

type FeatureLabScenario = {
  id: "approval" | "question" | "plan" | "conversation";
  label: string;
  description: string;
  prompt: string;
  icon: typeof ShieldCheck;
};

export function FeatureLabDialog({
  open,
  botName,
  disabledReason,
  onClose,
  onLaunch,
}: {
  open: boolean;
  botName: string;
  disabledReason?: string;
  onClose: () => void;
  onLaunch: (prompt: string) => void;
}) {
  const { t } = useT();
  const [selectedId, setSelectedId] = useState<FeatureLabScenario["id"]>("approval");
  const scenarios = useMemo<FeatureLabScenario[]>(() => [
    {
      id: "approval",
      label: t("featureLab.approvalTitle"),
      description: t("featureLab.approvalDescription"),
      prompt: t("featureLab.approvalPrompt"),
      icon: ShieldCheck,
    },
    {
      id: "question",
      label: t("featureLab.questionTitle"),
      description: t("featureLab.questionDescription"),
      prompt: t("featureLab.questionPrompt"),
      icon: MessageCircleQuestion,
    },
    {
      id: "plan",
      label: t("featureLab.planTitle"),
      description: t("featureLab.planDescription"),
      prompt: t("featureLab.planPrompt"),
      icon: ListChecks,
    },
    {
      id: "conversation",
      label: t("featureLab.conversationTitle"),
      description: t("featureLab.conversationDescription"),
      prompt: t("featureLab.conversationPrompt"),
      icon: MessageSquareText,
    },
  ], [t]);

  useEffect(() => {
    if (open) setSelectedId("approval");
  }, [open]);

  const selected = scenarios.find((scenario) => scenario.id === selectedId) ?? scenarios[0]!;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("featureLab.title", { name: botName })}
      description={t("featureLab.description")}
      closeLabel={t("common.close")}
      className="max-w-xl"
      bodyClassName="p-0"
      footerClassName="flex-row sm:flex-nowrap"
      footer={
        <>
          <button type="button" onClick={onClose} className={`${BUTTON.secondary} flex-1 sm:flex-none`}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={Boolean(disabledReason)}
            onClick={() => onLaunch(selected.prompt)}
            className={`${BUTTON.primary} flex-1 sm:flex-none`}
          >
            {t("featureLab.launch")}
          </button>
        </>
      }
    >
      <div role="radiogroup" aria-label={t("featureLab.scenariosLabel")} className="divide-y divide-border/60">
        {scenarios.map((scenario) => {
          const Icon = scenario.icon;
          const selected = scenario.id === selectedId;
          return (
            <button
              key={scenario.id}
              type="button"
              role="radio"
              aria-checked={selected}
              data-feature-lab-scenario={scenario.id}
              onClick={() => setSelectedId(scenario.id)}
              className="openedbot-press group flex min-h-16 w-full items-start gap-3 px-5 py-3 text-left outline-none openedbot-row hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span
                aria-hidden
                className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-[10px] border ${
                  selected
                    ? "border-primary/30 bg-[var(--button-ghost)] text-[var(--button-ghost-fg)]"
                    : "border-border bg-card text-muted-foreground"
                }`}
              >
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">{scenario.label}</span>
                <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{scenario.description}</span>
              </span>
              <span
                aria-hidden
                className={`mt-2 size-2 shrink-0 rounded-full ${selected ? "bg-primary" : "bg-border"}`}
              />
            </button>
          );
        })}
      </div>
      {disabledReason ? (
        <p role="status" className="border-t border-border/60 bg-muted/40 px-5 py-3 text-xs text-muted-foreground">
          {disabledReason}
        </p>
      ) : null}
    </Dialog>
  );
}
