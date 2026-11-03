import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, SlidersHorizontal, X } from "lucide-react";
import type { BotSettingProposalDto, BotSettingProposalFields, BotSettingProposalStatus } from "@openedbot/contracts-api";
import { ApiError, api, queryKeys } from "../lib/api";
import { useT, type MessageKey } from "../lib/i18n";
import { BUTTON } from "./settings/primitives";

const SHORT_FIELDS = ["label", "replyLanguage", "notifyOnFinish"] as const;
type ShortField = (typeof SHORT_FIELDS)[number];

const FIELD_LABEL: Record<ShortField | "instructions", MessageKey> = {
  instructions: "settingProposal.fieldInstructions",
  label: "settingProposal.fieldLabel",
  replyLanguage: "settingProposal.fieldReplyLanguage",
  notifyOnFinish: "settingProposal.fieldNotifyOnFinish",
};

const SETTLED_LABEL: Record<Exclude<BotSettingProposalStatus, "pending">, MessageKey> = {
  applied: "settingProposal.applied",
  rejected: "settingProposal.rejected",
  superseded: "settingProposal.superseded",
  stale: "settingProposal.stale",
};

/**
 * La proposition d'un bot de changer sa persona ou ses réglages légers, rendue
 * dans le tour du run qui l'a faite. Le bot propose, l'opérateur tranche : rien
 * n'est écrit avant « Appliquer », et `expectedHash` lie ce que l'opérateur a
 * sous les yeux à ce que le serveur applique (409 si la persona a bougé).
 *
 * Aucun contrôle de rôle ici, comme `GateCard` : le serveur refuse la décision
 * d'un non-opérateur et l'erreur s'affiche dans la carte.
 */
export function SettingProposalCard({ proposal, botId }: { proposal: BotSettingProposalDto; botId: string }) {
  const { t, locale } = useT();
  const queryClient = useQueryClient();
  const [showCurrent, setShowCurrent] = useState(false);
  const currentId = `setting-proposal-current-${proposal.id}`;

  const decide = useMutation({
    mutationFn: (decision: "apply" | "reject") =>
      api.decideBotSettingProposal(botId, proposal.id, { decision, expectedHash: proposal.hash }),
    // Un refus du serveur (409 déjà tranchée, hash périmé) change l'état de la
    // proposition aussi sûrement qu'un succès : le fil se relit dans les deux cas.
    onSettled: (_data, error) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.thread(proposal.threadId) });
      if (!error) {
        // Une persona appliquée doit se retrouver dans l'éditeur de l'agent.
        void queryClient.invalidateQueries({ queryKey: queryKeys.roster });
        void queryClient.invalidateQueries({ queryKey: queryKeys.personaDraft(botId) });
      }
    },
  });

  const status = decide.data?.status ?? proposal.status;
  const live = status === "pending" && !decide.isSuccess;
  const chosen = decide.isPending ? decide.variables : null;

  // Un verrou synchrone : `isPending` n'existe qu'au rendu suivant, deux clics
  // rapprochés enverraient deux décisions.
  const sent = useRef(false);
  const respond = (decision: "apply" | "reject") => {
    if (!live || sent.current) return;
    sent.current = true;
    decide.mutate(decision, { onError: () => { sent.current = false; } });
  };

  const display = (field: ShortField, fields: BotSettingProposalFields): string => {
    const value = fields[field];
    if (field === "label") return typeof value === "string" && value ? value : t("settingProposal.noLabel");
    if (field === "notifyOnFinish") return t(value === true ? "settingProposal.on" : "settingProposal.off");
    if (value === undefined || value === "auto") return t("settingProposal.autoLanguage");
    const name = typeof Intl !== "undefined" && "DisplayNames" in Intl
      ? new Intl.DisplayNames([locale], { type: "language" }).of(String(value))
      : null;
    return (name ?? String(value)).replace(/^./, (letter) => letter.toUpperCase());
  };

  const shortRows = SHORT_FIELDS.filter((field) => proposal.proposed[field] !== undefined);
  const proposedInstructions = proposal.proposed.instructions;
  const currentInstructions = proposal.current.instructions;

  const error = decide.error;
  const errorText = error
    ? error instanceof ApiError && error.code === "BOT_SETTING_PROPOSAL_STALE"
      ? t("settingProposal.staleError")
      : error instanceof ApiError ? error.message : t("settingProposal.failed")
    : null;

  return (
    <div
      data-setting-proposal-id={proposal.id}
      data-setting-proposal-status={status}
      role="group"
      aria-label={t("settingProposal.title")}
      className="my-3 w-full min-w-0 max-w-[85%] self-start overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default p-4 shadow-dropdown"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-full bg-info-100 text-info-700">
          <SlidersHorizontal className="size-5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="min-w-0 truncate text-body-medium text-text-primary">{t("settingProposal.title")}</p>
          {proposal.reason ? (
            <p className="whitespace-pre-wrap break-words text-body-regular text-text-secondary">{proposal.reason}</p>
          ) : null}
        </div>
      </div>

      <dl className="mt-3 flex min-w-0 flex-col gap-3">
        {proposedInstructions !== undefined ? (
          <div className="min-w-0">
            <dt className="text-caption-1-medium text-text-tertiary">{t(FIELD_LABEL.instructions)}</dt>
            <dd className="mt-1 min-w-0">
              <div className="scrollbar-subtle max-h-48 overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded-lg border border-border-button-default bg-background-secondary-default px-3 py-2 text-body-regular text-text-primary">
                {proposedInstructions || t("settingProposal.emptyValue")}
              </div>
              {currentInstructions !== undefined ? (
                <>
                  <button
                    type="button"
                    aria-expanded={showCurrent}
                    aria-controls={currentId}
                    onClick={() => setShowCurrent(!showCurrent)}
                    className="mt-1.5 flex items-center gap-1.5 text-caption-1-regular text-text-tertiary outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
                  >
                    <ChevronDown
                      aria-hidden
                      className={`size-3.5 shrink-0 transition-transform motion-reduce:transition-none ${showCurrent ? "rotate-180" : ""}`}
                    />
                    {showCurrent ? t("settingProposal.hideCurrent") : t("settingProposal.showCurrent")}
                  </button>
                  {showCurrent ? (
                    <div
                      id={currentId}
                      className="scrollbar-subtle mt-1.5 max-h-48 overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded-lg border border-border-button-default px-3 py-2 text-body-regular text-text-secondary"
                    >
                      {currentInstructions || t("settingProposal.emptyValue")}
                    </div>
                  ) : null}
                </>
              ) : null}
            </dd>
          </div>
        ) : null}
        {shortRows.map((field) => (
          <div key={field} className="min-w-0">
            <dt className="text-caption-1-medium text-text-tertiary">{t(FIELD_LABEL[field])}</dt>
            <dd className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-2 text-body-regular">
              <span className="min-w-0 break-words text-text-tertiary line-through">{display(field, proposal.current)}</span>
              <span aria-hidden className="text-text-tertiary">→</span>
              <span className="min-w-0 break-words text-text-primary">{display(field, proposal.proposed)}</span>
            </dd>
          </div>
        ))}
      </dl>

      {errorText ? (
        <p role="alert" className="mt-3 text-body-regular text-destructive-text">{errorText}</p>
      ) : null}

      {status === "pending" ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button type="button" className={BUTTON.primary} disabled={!live || decide.isPending} onClick={() => respond("apply")}>
            {chosen === "apply" ? t("settingProposal.applying") : t("settingProposal.apply")}
          </button>
          <button type="button" className={BUTTON.secondary} disabled={!live || decide.isPending} onClick={() => respond("reject")}>
            {chosen === "reject" ? t("settingProposal.rejecting") : t("settingProposal.reject")}
          </button>
        </div>
      ) : (
        <p className="mt-3 flex items-center gap-2 text-body-regular text-text-secondary">
          {status === "applied" ? <Check aria-hidden className="size-3.5 shrink-0 text-pos-700" /> : null}
          {status === "rejected" ? <X aria-hidden className="size-3.5 shrink-0" /> : null}
          {t(SETTLED_LABEL[status])}
        </p>
      )}
    </div>
  );
}
