import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconCopy, IconPlus, IconRefresh, IconTrash } from "@tabler/icons-react";
import type {
  BotDto,
  CreateWebhookEndpointInput,
  WebhookCredentialDto,
  WebhookEndpointCreatedDto,
  WebhookEndpointDto,
} from "@openedbot/contracts-api";
import { isAmbiguousWebhookManagementFailure } from "@/lib/bots/webhook-management";
import { Button, Input, Label, Switch, toast } from "@openedbot/browser-ui-kit";
import { API_ORIGIN, ApiError, api, queryKeys } from "../lib/api";
import { publicConsoleOrigin } from "../lib/platform";
import { randomId } from "../lib/random-id";
import { useT } from "../lib/i18n";
import { BUTTON } from "./settings/primitives";

type SecretAttempt =
  | { kind: "create"; key: string; input: CreateWebhookEndpointInput }
  | { kind: "rotate"; key: string; endpointId: string; endpointName: string };

export function BotWebhooksPanel({ bot, open }: { bot: BotDto; open: boolean }) {
  return <ThreadWebhooksPanel threadId={bot.threadId} open={open} />;
}

/**
 * Administration d'ingress attachée à un fil, indépendamment de sa forme
 * (DM de bot ou salon de groupe). Le contrat API est volontairement thread-
 * scoped : garder ce composant générique évite qu'une capacité backend réelle
 * reste artificiellement réservée aux seuls bots dans l'interface.
 */
export function ThreadWebhooksPanel({ threadId, open }: { threadId: string; open: boolean }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [credential, setCredential] = useState<WebhookCredentialDto | null>(null);
  const [secretBusy, setSecretBusy] = useState(false);
  const [secretError, setSecretError] = useState<unknown>(null);
  const [uncertainAttempt, setUncertainAttempt] = useState<SecretAttempt | null>(null);
  const secretRequestInFlight = useRef(false);
  const query = useQuery({
    queryKey: queryKeys.webhooks(threadId),
    queryFn: () => api.webhooks(threadId),
    enabled: open,
  });

  useEffect(() => {
    if (!open) setCredential(null);
  }, [open]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.webhooks(threadId) });
  const runSecretMutation = async (attempt: SecretAttempt) => {
    if (secretRequestInFlight.current || credential) return;
    secretRequestInFlight.current = true;
    setSecretBusy(true);
    setSecretError(null);
    try {
      const result = attempt.kind === "create"
        ? await api.createWebhook(attempt.input, attempt.key)
        : await api.rotateWebhook(attempt.endpointId, attempt.key);
      if (!isWebhookSecretResult(result)) {
        throw new ApiError(502, t("webhookPanel.failed"), "INVALID_RESPONSE");
      }
      setCredential(result.credential);
      if (attempt.kind === "create") {
        setName("");
        setInstructions("");
      }
      setUncertainAttempt(null);
      await refresh();
    } catch (error) {
      if (isAmbiguousWebhookManagementFailure(error)) {
        setUncertainAttempt(attempt);
        setSecretError(null);
        void refresh();
      } else {
        setUncertainAttempt(null);
        setSecretError(error);
      }
    } finally {
      secretRequestInFlight.current = false;
      setSecretBusy(false);
    }
  };
  const createEndpoint = () => {
    if (uncertainAttempt || !name.trim() || !instructions.trim()) return;
    void runSecretMutation({
      kind: "create",
      key: randomId(),
      input: { threadId, name: name.trim(), instructions: instructions.trim() },
    });
  };
  const rotateEndpoint = (endpoint: WebhookEndpointDto) => {
    if (!globalThis.window?.confirm(t("webhookPanel.rotateConfirm", { name: endpoint.name }))) return;
    void runSecretMutation({
      kind: "rotate",
      key: randomId(),
      endpointId: endpoint.id,
      endpointName: endpoint.name,
    });
  };
  const update = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.updateWebhook(id, { enabled }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: api.deleteWebhook,
    onSuccess: refresh,
  });
  const error = secretError ?? update.error ?? remove.error ?? query.error;
  const endpoints = query.data?.endpoints.filter((endpoint) => endpoint.deletedAt === null) ?? [];

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <p className="text-sm leading-5 text-muted-foreground">{t("webhookPanel.intro")}</p>
        <p className="text-xs leading-5 text-muted-foreground">{t("webhookPanel.security")}</p>
      </div>

      {credential ? (
        <div role="status" className="space-y-2 rounded-lg border border-warn-300 bg-warn-50 p-3 text-sm dark:border-warn-900 dark:bg-warn-950/30">
          <p className="font-medium text-foreground">{t("webhookPanel.secretOnce")}</p>
          <CredentialLine label={t("webhookPanel.urlLabel")} value={absoluteIngressUrl(credential.ingressPath)} />
          <CredentialLine label={t("webhookPanel.secretLabel")} value={credential.secret} />
          <button type="button" onClick={() => setCredential(null)} className={BUTTON.secondary}>{t("webhookPanel.dismissSecret")}</button>
        </div>
      ) : null}

      {uncertainAttempt ? (
        <div role="alert" className="space-y-2 rounded-lg border border-warn-300 bg-warn-50 p-3 text-sm dark:border-warn-900 dark:bg-warn-950/30">
          <p className="text-foreground">{t("webhookPanel.resultUncertain", {
            name: uncertainAttempt.kind === "create" ? uncertainAttempt.input.name : uncertainAttempt.endpointName,
          })}</p>
          <button
            type="button"
            disabled={secretBusy}
            onClick={() => void runSecretMutation(uncertainAttempt)}
            className={BUTTON.secondary}
          >
            {t("webhookPanel.recoverResult")}
          </button>
        </div>
      ) : null}

      <div className="space-y-3 rounded-lg border border-border p-3">
        <div className="space-y-1.5">
          <Label htmlFor="webhook-name">{t("webhookPanel.nameLabel")}</Label>
          <Input id="webhook-name" maxLength={80} disabled={Boolean(uncertainAttempt)} value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="webhook-instructions">{t("webhookPanel.instructionsLabel")}</Label>
          <textarea
            id="webhook-instructions"
            maxLength={20_000}
            rows={4}
            disabled={Boolean(uncertainAttempt)}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p className="text-xs leading-5 text-muted-foreground">{t("webhookPanel.instructionsHint")}</p>
        </div>
        <button
          type="button"
          disabled={!name.trim() || !instructions.trim() || secretBusy || Boolean(uncertainAttempt || credential)}
          onClick={createEndpoint}
          className={BUTTON.primary}
        >
          <IconPlus className="size-4" aria-hidden />
          {t("webhookPanel.create")}
        </button>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive-text">
          {error instanceof ApiError ? error.message : t("webhookPanel.failed")}
        </p>
      ) : null}

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">{t("webhookPanel.endpointsTitle")}</h3>
        {query.isPending ? <p className="text-sm text-muted-foreground">{t("common.loading")}</p> : null}
        {!query.isPending && endpoints.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("webhookPanel.empty")}</p>
        ) : null}
        {endpoints.map((endpoint) => (
          <div key={endpoint.id} className="space-y-2 rounded-lg border border-border p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{endpoint.name}</p>
                <p className="text-xs text-muted-foreground">
                  {t("webhookPanel.deliveries", { count: endpoint.deliveryCount })}
                </p>
              </div>
              <Switch
                checked={endpoint.enabled}
                aria-label={t("webhookPanel.enabled", { name: endpoint.name })}
                disabled={update.isPending}
                onCheckedChange={(enabled) => update.mutate({ id: endpoint.id, enabled })}
              />
            </div>
            <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">{endpoint.instructions}</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={secretBusy || Boolean(uncertainAttempt || credential)}
                onClick={() => rotateEndpoint(endpoint)}
                className={BUTTON.secondary}
              >
                <IconRefresh className="size-4" aria-hidden />
                {t("webhookPanel.rotate")}
              </button>
              <button
                type="button"
                disabled={remove.isPending}
                onClick={() => {
                  if (globalThis.window?.confirm(t("webhookPanel.revokeConfirm", { name: endpoint.name }))) {
                    remove.mutate(endpoint.id);
                  }
                }}
                className={BUTTON.small}
              >
                <IconTrash className="size-3.5" aria-hidden />
                {t("webhookPanel.revoke")}
              </button>
            </div>
          </div>
        ))}
      </div>

      {(query.data?.receipts.length ?? 0) > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">{t("webhookPanel.receiptsTitle")}</h3>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {query.data!.receipts.slice(0, 10).map((receipt) => (
              <li key={receipt.id} className="flex justify-between gap-3 rounded border border-border px-2 py-1.5">
                <span className="truncate">{receipt.eventName ?? receipt.idempotencyKey}</span>
                <span>{receipt.workflowStatus ?? t("webhookPanel.accepted")}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function isWebhookSecretResult(value: unknown): value is WebhookEndpointCreatedDto {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<WebhookEndpointCreatedDto>;
  return typeof result.endpoint?.id === "string" &&
    typeof result.credential?.ingressPath === "string" &&
    /^whsec_[A-Za-z0-9_-]+$/.test(result.credential.secret ?? "");
}

function CredentialLine({ label, value }: { label: string; value: string }) {
  const { t } = useT();
  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex gap-2">
        <code className="scrollbar-subtle min-w-0 flex-1 overflow-x-auto rounded bg-background px-2 py-1.5 text-xs">{value}</code>
        <Button
          variant="ghost"
          size="icon-sm"
          iconOnly
          leadingIcon={IconCopy}
          aria-label={t("webhookPanel.copy", { label })}
          onClick={() => {
            void navigator.clipboard?.writeText(value)
              .then(() => toast.success(t("webhookPanel.copied")))
              .catch(() => toast.error(t("webhookPanel.copyFailed")));
          }}
        />
      </div>
    </div>
  );
}

export function absoluteIngressUrl(path: string): string {
  // The API's own origin first; on the web the API shares the public console
  // origin, which `publicConsoleOrigin` gives (never a desktop app's local one).
  for (const base of [() => API_ORIGIN, publicConsoleOrigin]) {
    try {
      const origin = base();
      if (origin) return new URL(path, origin).toString();
    } catch {
      // Test DOMs may expose a non-URL origin (for example `null`), and a
      // desktop app may lack its public URL: the relative path stays valid.
    }
  }
  return path;
}
