import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@openedbot/browser-ui-kit";
import type { BotDto, RuntimePublicDto } from "@openedbot/contracts-api";
import { ApiKeyForm, type ApiKeySaveResult } from "../../screens/settings/installation/models-provider-dialog";
import { ApiError, api, queryKeys } from "../../lib/api";
import { useT, type MessageKey } from "../../lib/i18n";
import { ACTIONS, BUTTON, Note } from "../settings/primitives";

const CREDENTIAL_ERROR_KEYS: Record<string, MessageKey> = {
  HERMES_PROFILE_REQUIRED: "botSettingsDialog.credentials.errors.HERMES_PROFILE_REQUIRED",
  PROFILE_CREDENTIALS_UNAVAILABLE: "botSettingsDialog.credentials.errors.PROFILE_CREDENTIALS_UNAVAILABLE",
  CREDENTIAL_IN_PROGRESS: "botSettingsDialog.credentials.errors.CREDENTIAL_IN_PROGRESS",
  RUNTIME_PROVIDER_KEY_INVALID: "botSettingsDialog.credentials.errors.RUNTIME_PROVIDER_KEY_INVALID",
};

function credentialErrorMessage(error: unknown, t: ReturnType<typeof useT>["t"]): string {
  const key = error instanceof ApiError && error.code ? CREDENTIAL_ERROR_KEYS[error.code] : undefined;
  if (key) {
    return t(key);
  }
  return error instanceof Error ? error.message : t("botSettingsDialog.credentials.errors.generic");
}

function resultTone(result: ApiKeySaveResult): "success" | "danger" | "neutral" {
  if (result.verification === "confirmed") return "success";
  if (result.verification === "denied") return "danger";
  return "neutral";
}

export function BotCredentialSection({
  bot,
  runtime,
  open,
}: {
  bot: BotDto;
  runtime: RuntimePublicDto;
  open: boolean;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [providerSlug, setProviderSlug] = useState<string | null>(null);
  const [formRevision, setFormRevision] = useState(0);
  const catalog = useQuery({
    queryKey: queryKeys.runtimeModels(runtime.id!),
    queryFn: () => api.runtimeModels(runtime.id!),
    enabled: open,
  });
  const providers = catalog.data?.providers ?? [];
  const defaultProvider = bot.model
    ? providers.find((provider) => provider.models.some((model) => model.id === bot.model))?.slug ?? null
    : null;
  const selectedProvider = providers.find((provider) => provider.slug === providerSlug) ?? null;

  useEffect(() => {
    setProviderSlug(null);
    setFormRevision(0);
  }, [bot.id, runtime.id]);

  useEffect(() => {
    if (providerSlug !== null) return;
    const next = defaultProvider ?? catalog.data?.currentProvider ?? providers[0]?.slug ?? null;
    if (next) setProviderSlug(next);
  }, [catalog.data?.currentProvider, defaultProvider, providerSlug, providers]);

  const invalidateBotCredentialReads = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.runtimeModels(runtime.id!) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.botCapabilities(bot.id) }),
    ]);
  };

  const remove = useMutation({
    mutationFn: () => api.deleteBotCredential(bot.id, providerSlug!),
    onMutate: () => {
      setFormRevision((value) => value + 1);
    },
    onSuccess: async () => {
      await invalidateBotCredentialReads();
    },
  });

  const selectProvider = (next: string) => {
    remove.reset();
    setFormRevision((value) => value + 1);
    setProviderSlug(next);
  };

  const confirmRemove = () => {
    if (!providerSlug || remove.isPending) return;
    if (globalThis.confirm?.(t("botSettingsDialog.credentials.removeConfirm", { provider: selectedProvider?.name ?? providerSlug })) === false) return;
    remove.mutate();
  };

  if (catalog.isPending) {
    return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
  }
  if (catalog.isError) {
    return <Note tone="danger" role="alert">{credentialErrorMessage(catalog.error, t)}</Note>;
  }
  if (providers.length === 0) {
    return <Note tone="neutral">{t("botSettingsDialog.credentials.noProviders")}</Note>;
  }
  if (!selectedProvider || !providerSlug) {
    return <Note tone="neutral">{t("botSettingsDialog.credentials.chooseProvider")}</Note>;
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <h3 className="text-base font-semibold text-foreground">{t("botSettingsDialog.credentials.title")}</h3>
        <p className="text-sm leading-5 text-muted-foreground">{t("botSettingsDialog.credentials.description")}</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="bot-credential-provider">{t("botSettingsDialog.credentials.providerLabel")}</Label>
        <Select value={providerSlug} onValueChange={selectProvider} disabled={remove.isPending}>
          <SelectTrigger id="bot-credential-provider">
            <SelectValue placeholder={t("botSettingsDialog.credentials.chooseProvider")} />
          </SelectTrigger>
          <SelectContent rows={8}>
            {providers.map((provider) => (
              <SelectItem key={provider.slug} value={provider.slug}>
                {provider.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ApiKeyForm
        key={`${providerSlug}-${formRevision}`}
        runtime={runtime}
        provider={selectedProvider}
        save={(apiKey) => api.setBotCredential(bot.id, providerSlug, { apiKey })}
        writable
        resultMessages={{
          confirmed: t("botSettingsDialog.credentials.verificationConfirmed"),
          denied: t("botSettingsDialog.credentials.verificationDenied"),
          unverified: t("botSettingsDialog.credentials.verificationUnverified"),
        }}
        copy={{
          writeHint: t("botSettingsDialog.credentials.apiKeyWriteHint"),
          placeholder: t("botSettingsDialog.credentials.apiKeyPlaceholder"),
          title: t("botSettingsDialog.credentials.apiKeyTitle", { provider: selectedProvider.name }),
          save: t("botSettingsDialog.credentials.saveKey"),
          replace: t("botSettingsDialog.credentials.replaceKey"),
          saving: t("botSettingsDialog.credentials.savingKey"),
        }}
        unverifiedTone="neutral"
        errorMessage={(error) => credentialErrorMessage(error, t)}
        onSaved={async () => {
          remove.reset();
          await invalidateBotCredentialReads();
        }}
      />
      <div className={ACTIONS}>
        <button type="button" className={BUTTON.danger} disabled={remove.isPending} onClick={confirmRemove}>
          {remove.isPending ? t("botSettingsDialog.credentials.removing") : t("botSettingsDialog.credentials.remove")}
        </button>
      </div>
      {remove.data ? (
        <Note tone={resultTone(remove.data)}>
          {remove.data.verification === "confirmed"
            ? t("botSettingsDialog.credentials.removeConfirmed")
            : remove.data.verification === "denied"
              ? remove.data.detail ?? t("botSettingsDialog.credentials.removeDenied")
              : t("botSettingsDialog.credentials.removeUnverified")}
        </Note>
      ) : null}
      {remove.error ? <Note tone="danger" role="alert">{credentialErrorMessage(remove.error, t)}</Note> : null}
    </div>
  );
}
