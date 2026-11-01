import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { refreshProviderLimits } from "@/components/dashboard/provider-limits-card";
import { Link } from "@tanstack/react-router";
import { IconExternalLink } from "@tabler/icons-react";
import { cn, Dialog, DotMatrix, Input, toast } from "@openedbot/browser-ui-kit";
import type { RuntimeModelProviderDto, RuntimeProviderOauthDto, RuntimePublicDto } from "@openedbot/contracts-api";
import { api, queryKeys } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { isKeylessProvider } from "@openedbot/runtimes/domain/runtime/keyless-providers";
import { ACTIONS, BUTTON, CopyButton, Note } from "../../../components/settings/primitives";

function cancelOauthIfOpen(
  runtimeId: string,
  provider: string,
  sessionId: string | null,
  status: RuntimeProviderOauthDto["status"] | undefined,
) {
  if (!sessionId) return;
  if (status === "connected" || status === "failed" || status === "cancelled") return;
  void api.cancelProviderOauth(runtimeId, provider, sessionId).catch(() => undefined);
}

export function ProviderConfigDialog({
  runtime,
  provider,
  hermesProfile,
  onClose,
  onConnected,
}: {
  runtime: RuntimePublicDto;
  provider: RuntimeModelProviderDto | null;
  hermesProfile: string | null;
  onClose: () => void;
  onConnected: (slug: string) => void;
}) {
  const { t } = useT();
  const [oauthUri, setOauthUri] = useState<string | null>(null);
  const oauthDismissRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!provider) setOauthUri(null);
  }, [provider]);
  const dismiss = () => {
    oauthDismissRef.current?.();
    onClose();
  };
  if (!provider) return null;
  if (runtime.reachability === "direct") return <Dialog open onClose={onClose} title={provider.name}><Note tone="info">{t("modelsSettings.hostManagedCredentials")} <code>edge-setup credentials add {provider.slug}</code></Note></Dialog>;
  const manual = !provider.acceptsOauth && !provider.acceptsApiKey;
  const sdkMissing = provider.sdkInstalled === false;
  return (
    <Dialog
      open
      onClose={dismiss}
      title={provider.name}
      closeLabel={t("modelsSettings.close")}
      className="max-w-lg"
      footer={
        <>
          <button type="button" className={oauthUri ? BUTTON.secondary : BUTTON.primary} onClick={dismiss}>
            {t("modelsSettings.close")}
          </button>
          {oauthUri ? (
            <a className={BUTTON.primary} href={oauthUri} target="_blank" rel="noreferrer">
              {t("modelsSettings.oauthOpen")}
              <IconExternalLink className="size-4" />
            </a>
          ) : null}
        </>
      }
    >
      <div className="space-y-4">
        {sdkMissing ? (
          <div className="space-y-2">
            <Note tone="warning" role="alert">
              <strong>{t("modelsSettings.sdkMissing")}</strong>{" "}
              {t(provider.sdkInstallable ? "modelsSettings.sdkMissingNote" : "modelsSettings.sdkMissingNotInstallableNote")}
            </Note>
            {provider.sdkInstallable ? (
              <>
                <p className="text-xs leading-5 text-muted-foreground">{t("modelsSettings.manualAuthCommand")}</p>
                <code className="scrollbar-subtle block max-w-full overflow-x-auto rounded-lg bg-surface-sunken px-3 py-2 text-xs">sudo edge-setup up</code>
              </>
            ) : null}
          </div>
        ) : hermesProfile ? (
          <Note tone="warning">
            {t("modelsSettings.profileManualOnly", { profile: hermesProfile })}
          </Note>
        ) : provider.alwaysAuthenticated ? (
          <Note tone="info">{t("modelsSettings.integratedProviderHint")}</Note>
        ) : isKeylessProvider(provider.slug) ? (
          <Note tone="info">{t("modelsSettings.keylessProviderHint", { provider: provider.name })}</Note>
        ) : (
          <>
            {provider.acceptsOauth ? (
              <ProviderOauthPanel
                key={`oauth-${provider.slug}`}
                runtime={runtime}
                provider={provider}
                dismissRef={oauthDismissRef}
                onConnected={(slug) => {
                  onConnected(slug);
                  onClose();
                }}
                onVerificationUri={setOauthUri}
              />
            ) : null}
            {provider.acceptsApiKey ? (
              <ApiKeyForm
                key={`api-key-${provider.slug}`}
                runtime={runtime}
                provider={provider}
                save={(apiKey) => api.setProviderApiKey(runtime.id!, provider.slug, apiKey)}
                writable={runtime.management.credentialsWritable}
                onConnected={onConnected}
              />
            ) : null}
            {manual ? (
              <Note tone="neutral">
                {provider.authenticated
                  ? t("modelsSettings.providerAlreadyAvailable")
                  : t("modelsSettings.providerManualOnly")}
              </Note>
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  );
}

export type ApiKeySaveResult = {
  verification: "confirmed" | "denied" | "unverified";
  detail: string | null;
};

type ApiKeyResultMessages = {
  confirmed: string;
  denied: string;
  unverified: string;
};

type ApiKeyFormCopy = {
  writeHint: string;
  placeholder: string;
  title: string;
  save: string;
  replace: string;
  saving: string;
};

export function ApiKeyForm({
  runtime,
  provider,
  save: saveApiKey,
  writable,
  onConnected,
  onSaved,
  resultMessages,
  unverifiedTone = "warning",
  errorMessage,
  copy,
}: {
  runtime: RuntimePublicDto;
  provider: RuntimeModelProviderDto;
  save: (apiKey: string) => Promise<ApiKeySaveResult>;
  writable: boolean;
  onConnected?: (slug: string) => void;
  onSaved?: (result: ApiKeySaveResult) => void | Promise<void>;
  resultMessages?: ApiKeyResultMessages;
  unverifiedTone?: "warning" | "neutral";
  errorMessage?: (error: unknown) => string;
  copy?: ApiKeyFormCopy;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const formCopy = copy ?? {
    writeHint: t("modelsSettings.apiKeyWriteHint"),
    placeholder: t("modelsSettings.apiKeyPlaceholder"),
    title: t("modelsSettings.apiKeyTitle", { provider: provider.name }),
    save: t("modelsSettings.saveKey"),
    replace: t("modelsSettings.replaceKey"),
    saving: t("modelsSettings.savingKey"),
  };
  const save = useMutation({
    mutationFn: (value: string) => saveApiKey(value),
    onSuccess: async (verdict) => {
      setApiKey("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.runtimeModels(runtime.id!) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfiguration });
      await queryClient.invalidateQueries({ queryKey: queryKeys.runtimes });
      void refreshProviderLimits(queryClient, runtime.id!);
      await onSaved?.(verdict);
      const message = verdict.verification === "confirmed"
        ? resultMessages?.confirmed ?? t("modelsSettings.keySaved", { provider: provider.name })
        : verdict.verification === "unverified"
          ? resultMessages?.unverified ?? verdict.detail ?? t("modelsSettings.keyDenied")
          : verdict.detail ?? resultMessages?.denied ?? t("modelsSettings.keyDenied");
      if (verdict.verification === "confirmed") toast.success(message);
      else if (verdict.verification === "unverified") toast.warning(message);
      else toast.error(message);
      if (verdict.verification === "confirmed") onConnected?.(provider.slug);
    },
    onSettled: () => setApiKey(""),
  });
  return (
    <div className="space-y-4">
      {!writable ? (
        <OwnedRuntimeNotice runtime={runtime} provider={provider} method="api-key" />
      ) : (
        <div className="space-y-3">
          <p className="text-xs leading-5 text-muted-foreground">{formCopy.writeHint}</p>
          <Input
            data-dialog-autofocus
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={formCopy.placeholder}
            aria-label={formCopy.title}
          />
          <div className={ACTIONS}>
            <button type="button" className={cn(BUTTON.primary, "w-full sm:w-auto")} disabled={!apiKey || save.isPending} onClick={() => save.mutate(apiKey)}>
              {save.isPending ? <DotMatrix state="uploading" className="size-4" /> : null}
              {save.isPending
                ? formCopy.saving
                : provider.authenticated
                  ? formCopy.replace
                  : formCopy.save}
            </button>
          </div>
        </div>
      )}
      {save.data ? (
        <Note tone={save.data.verification === "confirmed" ? "success" : save.data.verification === "unverified" ? unverifiedTone : "danger"}>
          {save.data.verification === "confirmed"
            ? resultMessages?.confirmed ?? t("modelsSettings.keyStoredInHermes")
            : save.data.verification === "unverified"
              ? resultMessages?.unverified ?? save.data.detail ?? t("modelsSettings.keyDenied")
              : save.data.detail ?? resultMessages?.denied ?? t("modelsSettings.keyDenied")}
        </Note>
      ) : null}
      {save.error ? <Note tone="danger">{errorMessage ? errorMessage(save.error) : save.error instanceof Error ? save.error.message : t("modelsSettings.keyDenied")}</Note> : null}
    </div>
  );
}

/** Keep a temporary connector outage distinct from unavailable host management. */
function OwnedRuntimeNotice({ runtime, provider, method }: { runtime: RuntimePublicDto; provider: RuntimeModelProviderDto; method: "api-key" | "oauth" }) {
  const { t } = useT();
  if (runtime.management.kind === "host") {
    return (
      <Note tone="warning">
        <span>{t("modelsSettings.providerLinkDisconnected")} </span>
        <Link to="/settings/runtime" className="font-medium underline underline-offset-4">
          {t("modelsSettings.openRuntimeSettings")}
        </Link>
      </Note>
    );
  }
  const manualCommand = method === "oauth"
    ? `sudo edge-setup credentials login ${provider.slug} --yes`
    : `sudo edge-setup credentials add ${provider.slug} --yes`;
  return (
    <div className="space-y-2">
      <Note tone="info">
        <span>{t("modelsSettings.ownedRuntimeNotice")} </span>
        <Link to="/settings/runtime" className="font-medium underline underline-offset-4">
          {t("modelsSettings.openRuntimeSettings")}
        </Link>
      </Note>
      <p className="text-xs leading-5 text-muted-foreground">{t("modelsSettings.manualAuthCommand")}</p>
      <code className="scrollbar-subtle block max-w-full overflow-x-auto rounded-lg bg-surface-sunken px-3 py-2 text-xs">{manualCommand}</code>
    </div>
  );
}

function ProviderOauthPanel({
  runtime,
  provider,
  dismissRef,
  onConnected,
  onVerificationUri,
}: {
  runtime: RuntimePublicDto;
  provider: RuntimeModelProviderDto;
  dismissRef: { current: (() => void) | null };
  onConnected: (slug: string) => void;
  onVerificationUri: (uri: string | null) => void;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const writable = runtime.management.oauthWritable;
  const dismissedRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const statusRef = useRef<RuntimeProviderOauthDto["status"] | undefined>(undefined);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () => api.startProviderOauth(runtime.id!, provider.slug),
    onSuccess: (session) => {
      setSessionId(session.sessionId);
      if (dismissedRef.current && runtime.id) {
        cancelOauthIfOpen(runtime.id, provider.slug, session.sessionId, session.status);
      }
    },
  });
  const session = useQuery({
    queryKey: queryKeys.providerOauth(runtime.id!, provider.slug, sessionId ?? "none"),
    queryFn: () => api.providerOauth(runtime.id!, provider.slug, sessionId!),
    enabled: Boolean(sessionId),
    refetchInterval: (query) => {
      // Une session perdue (serveur redémarré, 404) ne se sonde plus.
      if (query.state.status === "error") return false;
      const state = query.state.data?.status;
      return state === "starting" || state === "pending" ? 1_000 : false;
    },
  });
  const current: RuntimeProviderOauthDto | undefined = session.data ?? start.data;
  sessionIdRef.current = sessionId;
  statusRef.current = current?.status;
  dismissRef.current = () => {
    dismissedRef.current = true;
    if (!runtime.id) return;
    cancelOauthIfOpen(runtime.id, provider.slug, sessionIdRef.current, statusRef.current);
  };

  // Le clic sur la ligne ouvre ce panneau : la demande part tout de suite,
  // sans second geste « Vérifier l'accès ».
  useEffect(() => {
    if (!writable) return;
    start.mutate();
    // `start` change d'identité à chaque rendu : le slug et l'hôte bornent la
    // demande. Un 409 OAUTH_IN_PROGRESS rejoint la session déjà ouverte.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once per provider
  }, [writable, provider.slug, runtime.id]);

  useEffect(() => {
    onVerificationUri(current?.verificationUri ?? null);
    return () => onVerificationUri(null);
  }, [current?.verificationUri, onVerificationUri]);

  useEffect(() => () => {
    dismissRef.current = null;
  }, [dismissRef]);

  // Une session « connected » ferme le dialogue après le rafraîchissement du
  // catalogue : le tableau affiche déjà le nouvel accès.
  const notifiedSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (current?.status !== "connected") return;
    if (notifiedSessionRef.current === current.sessionId) return;
    notifiedSessionRef.current = current.sessionId;
    void (async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.runtimeModels(runtime.id!) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfiguration });
      await queryClient.invalidateQueries({ queryKey: queryKeys.runtimes });
      // Un accès renouvelé change le relevé de quota : on ne laisse pas la
      // carte Limites sur la lecture du compte d'avant.
      void refreshProviderLimits(queryClient, runtime.id!);
      onConnected(provider.slug);
    })();
  }, [current, onConnected, provider.slug, queryClient, runtime.id]);

  if (!writable) {
    return <OwnedRuntimeNotice runtime={runtime} provider={provider} method="oauth" />;
  }

  if (start.error) {
    return (
      <div className="space-y-4">
        <Note tone="danger">{start.error instanceof Error ? start.error.message : t("modelsSettings.oauthFailed")}</Note>
        <div className={ACTIONS}>
          <button type="button" className={BUTTON.primary} disabled={start.isPending} onClick={() => start.mutate()}>
            {provider.authenticated ? t("modelsSettings.verifyOauth") : t("modelsSettings.connectOauth")}
          </button>
        </div>
      </div>
    );
  }

  return <OauthSessionBody session={current} lost={Boolean(session.error)} />;
}

function OauthSessionBody({ session, lost }: { session: RuntimeProviderOauthDto | undefined; lost: boolean }) {
  const { t } = useT();
  if (lost) return <Note tone="danger" role="alert">{t("modelsSettings.oauthSessionLost")}</Note>;
  if (!session || session.status === "starting") {
    return (
      <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
        <DotMatrix state="connecting" label={t("modelsSettings.oauthPreparing")} />
        {t("modelsSettings.oauthPreparing")}
      </p>
    );
  }
  if (session.status === "connected") return <Note tone="success">{t("modelsSettings.oauthCompleted")}</Note>;
  if (session.status === "failed") return <Note tone="danger">{session.error ?? t("modelsSettings.oauthFailed")}</Note>;
  if (session.status === "cancelled") return <Note tone="neutral">{t("modelsSettings.oauthCancelled")}</Note>;
  return (
    <div className="flex flex-col items-center gap-6 py-2 text-center">
      {session.userCode ? (
        <div className="flex w-full flex-col items-center gap-3">
          <p className="text-sm text-muted-foreground">{t("modelsSettings.oauthCodeCaption")}</p>
          <p
            className="select-all font-mono text-[1.75rem] font-semibold tracking-[0.18em] text-foreground sm:text-3xl"
            aria-label={t("modelsSettings.oauthCode", { code: session.userCode })}
          >
            {session.userCode}
          </p>
          <CopyButton
            value={session.userCode}
            copyLabel={t("modelsSettings.oauthCopyCode")}
            copiedLabel={t("modelsSettings.oauthCopied")}
            className={BUTTON.secondary}
            copiedClassName={BUTTON.success}
          />
        </div>
      ) : null}
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <DotMatrix state="waiting" label={t("modelsSettings.oauthWaiting")} />
        {t("modelsSettings.oauthWaiting")}
      </p>
    </div>
  );
}
