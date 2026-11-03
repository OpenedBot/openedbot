import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  RuntimeDirectAccessInput,
  RuntimeDirectAccessUpdateInput,
  RuntimeDirectProbeDto,
  RuntimeExposureCreatedDto,
  RuntimeExposureDto,
  RuntimeExposureKind,
  RuntimeExposureStoredKind,
  RuntimeProbeDiagnosticCode,
  RuntimePublicDto,
} from "@openedbot/contracts-api";
import { Checkbox, Dialog, Input, Label } from "@openedbot/browser-ui-kit";
import { ApiError, api, queryKeys } from "../lib/api";
import { useT, type MessageKey } from "../lib/i18n";
import {
  BUTTON,
  CardHeading,
  Note,
  SettingsCard,
  StatusList,
  StatusRow,
  ToneBadge,
} from "./settings/primitives";
import { DialogFooterRow, EnrollmentStep, HostCommandList, INSTALL_COMMANDS } from "./runtime-command";

import { TailscaleOauthGuide } from "./tailscale-step-guide";

/**
 * La largeur des boîtes qui portent l'assistant accès direct : assez large
 * pour qu'un prérequis ou une commande tienne sur une ligne sur desktop,
 * bornée par l'écran (`w-full` + le padding du fond) sur les plus petits.
 */
export const DIRECT_DIALOG_WIDTH = "sm:max-w-4xl";

type RuntimeReachability = "connector" | "direct";

type RuntimeReachabilityPickerProps = {
  value: RuntimeReachability;
  onChange: (value: RuntimeReachability) => void;
};

/**
 * Le choix du chemin réseau du runtime.
 *
 * Le connecteur reste le chemin par défaut ; l'option directe ouvre le choix
 * de la voie de publication quand l'utilisateur veut publier son gateway.
 */
export function RuntimeReachabilityPicker({
  value,
  onChange,
}: RuntimeReachabilityPickerProps) {
  const { t } = useT();
  const options = [
    ["connector", t("runtimeDirect.connectorOption")],
    ["direct", t("runtimeDirect.directOption")],
  ] as const;

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-semibold">
        {t("runtimeDirect.selector")}
      </legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {options.map(([id, label]) => (
          <label
            key={id}
            className="flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm"
          >
            <input
              type="radio"
              name="runtime-reachability"
              value={id}
              checked={value === id}
              onChange={() => onChange(id)}
            />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Les messages et l'étape à revoir pour chaque diagnostic de sonde.
 *
 * Les numéros sont ceux de l'assistant de publication tel qu'il s'affiche :
 * 1 publier, 2 installer sur l'hôte, 3 déclarer et tester.
 */
export const DIRECT_DIAGNOSTICS: Record<
  RuntimeProbeDiagnosticCode,
  { message: MessageKey; step: number }
> = {
  RUNTIME_QUICK_TUNNEL_REFUSED: {
    message: "runtimeDirect.quickTunnel",
    step: 1,
  },
  RUNTIME_DNS_UNRESOLVED: {
    message: "runtimeDirect.dns",
    step: 2,
  },
  RUNTIME_TUNNEL_DOWN: {
    message: "runtimeDirect.tunnelDown",
    step: 2,
  },
  RUNTIME_EDGE_AUTH_REQUIRED: {
    message: "runtimeDirect.edgeRequired",
    step: 1,
  },
  RUNTIME_EDGE_AUTH_REJECTED: {
    message: "runtimeDirect.edgeRejected",
    step: 1,
  },
  RUNTIME_BEARER_REJECTED: {
    message: "runtimeDirect.bearerRejected",
    step: 3,
  },
  RUNTIME_NOT_HERMES: {
    message: "runtimeDirect.notHermes",
    step: 2,
  },
  RUNTIME_CAPABILITIES_MISSING: {
    message: "runtimeDirect.capabilitiesMissing",
    step: 3,
  },
  RUNTIME_TOOLSET_FORBIDDEN: {
    message: "runtimeDirect.toolsetForbidden",
    step: 3,
  },
  RUNTIME_PROBE_INDETERMINATE: {
    message: "runtimeDirect.indeterminate",
    step: 2,
  },
};

/**
 * Vérifie que les trois lectures qui prouvent l'accès direct ont réussi.
 *
 * Le `ok` global ne suffit pas : chaque étape doit avoir été relue avec succès
 * pour que l'enregistrement puisse être proposé.
 */
export function directProbePassed(
  probe: RuntimeDirectProbeDto | null,
): boolean {
  return (
    probe?.ok === true &&
    (["edge", "auth", "toolsets"] as const).every((step) =>
      probe.steps.some((result) => result.step === step && result.ok === true),
    )
  );
}

type RuntimeDirectProofsProps = {
  probe: RuntimeDirectProbeDto;
  onStep?: (step: number) => void;
};

/**
 * Affiche les preuves de la sonde et le diagnostic associé à chaque échec.
 *
 * Le lien « revoir » ramène l'utilisateur à l'étape concernée de la
 * publication, afin qu'une erreur de tunnel reste actionnable au lieu de
 * devenir une alerte isolée.
 */
export function RuntimeDirectProofs({
  probe,
  onStep,
}: RuntimeDirectProofsProps) {
  const { t } = useT();
  const proofSteps = [
    ["edge", t("runtimeDirect.edge")],
    ["auth", t("runtimeDirect.auth")],
    ["toolsets", t("runtimeDirect.toolsets")],
  ] as const;

  return (
    <div aria-live="polite" className="space-y-3">
      <StatusList>
        {proofSteps.map(([step, label]) => {
          const result = probe.steps.find((item) => item.step === step);
          const tone =
            result?.ok === true
              ? "success"
              : result?.ok === false
                ? "danger"
                : "neutral";
          const status =
            result?.ok === true
              ? t("runtimeDirect.verified")
              : result?.ok === false
                ? t("runtimeDirect.failed")
                : t("runtimeDirect.unverified");

          return (
            <StatusRow
              key={step}
              label={label}
              value={<ToneBadge tone={tone}>{status}</ToneBadge>}
            />
          );
        })}
      </StatusList>
      {probe.steps
        .filter((result) => result.code)
        .map((result, index) => {
          const diagnostic =
            DIRECT_DIAGNOSTICS[result.code!] ??
            DIRECT_DIAGNOSTICS.RUNTIME_PROBE_INDETERMINATE;

          return (
            <Note key={index} tone="warning">
              <span className="block">{t(diagnostic.message)}</span>
              {result.detail ? (
                <span className="block break-words">
                  {result.detail.slice(0, 300)}
                </span>
              ) : null}
              {onStep ? (
                <button
                  type="button"
                  className={BUTTON.small}
                  onClick={() => onStep(diagnostic.step)}
                >
                  {t("runtimeDirect.reviewStep", { step: diagnostic.step })}
                </button>
              ) : (
                <span className="block">
                  {t("runtimeDirect.diagnosticStep", {
                    step: diagnostic.step,
                  })}
                </span>
              )}
            </Note>
          );
        })}
      {!probe.ok && probe.hints ? (
        <p className="break-words text-xs text-muted-foreground">
          HTTP {probe.hints.status ?? t("runtimeDirect.unknown")} · Content-Type :{" "}
          {probe.hints.contentType?.slice(0, 100) ?? t("runtimeDirect.unknown")}
        </p>
      ) : null}
    </div>
  );
}

/** Rafraîchit toutes les vues qui peuvent afficher le runtime nouvellement enregistré. */
async function refreshRuntimes(
  queryClient: ReturnType<typeof useQueryClient>,
): Promise<void> {
  await Promise.all(
    [
      queryKeys.runtimeConfiguration,
      queryKeys.runtime,
      queryKeys.runtimeList,
      queryKeys.runtimes,
      queryKeys.runtimeExposures,
    ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
}

type RuntimeDirectDraft = {
  name: string;
  url: string;
  token: string;
  clientId: string;
  clientSecret: string;
};

const DIRECT_FIELDS = [
  { key: "name", translation: "runtimeDirect.name" },
  { key: "url", translation: "runtimeDirect.url" },
  { key: "token", translation: "runtimeDirect.bearer" },
  { key: "clientId", translation: "runtimeDirect.clientId" },
  { key: "clientSecret", translation: "runtimeDirect.clientSecret" },
] as const;

/** Détermine le type HTML adapté à chaque champ du brouillon. */
function inputTypeForField(
  key: keyof RuntimeDirectDraft,
): "password" | "url" | "text" {
  if (["token", "clientId", "clientSecret"].includes(key)) {
    return "password";
  }
  return key === "url" ? "url" : "text";
}

/** Identifie les deux champs qui forment la paire Cloudflare Access. */
function isEdgeField(key: keyof RuntimeDirectDraft): boolean {
  return key === "clientId" || key === "clientSecret";
}

/** Les deux façons de publier le gateway, l'une et l'autre sans domaine à posséder. */
export type PublicationPath = RuntimeExposureKind;

const PATHS: Array<{ id: PublicationPath; label: MessageKey; hint: MessageKey }> = [
  { id: "managed_cloudflare", label: "runtimeDirect.pathManaged", hint: "runtimeDirect.pathManagedHint" },
  { id: "tailscale_funnel", label: "runtimeDirect.pathFunnel", hint: "runtimeDirect.pathFunnelHint" },
];

/**
 * Le choix de la publication, sous les prérequis.
 *
 * Les deux cartes sont toujours affichées, même fermées : une voie qu'on fait
 * disparaître ne s'apprend nulle part, et l'utilisateur ne peut alors ni la
 * demander ni comprendre pourquoi l'accès direct ne mène à rien. Fermée, la
 * carte est désactivée et le dit ; le serveur refuse de toute façon
 * (`MANAGED_TUNNEL_UNAVAILABLE`, `TAILSCALE_FUNNEL_UNAVAILABLE`).
 *
 * « Recommandé » suit la première voie réellement ouverte : aucune étiquette
 * ne doit désigner un chemin sur lequel l'utilisateur ne peut pas cliquer.
 */
function RuntimePublicationPicker({ value, onChange }: { value: PublicationPath | null; onChange: (value: PublicationPath) => void }) {
  const { t } = useT();
  const configuration = useQuery({ queryKey: queryKeys.runtimeConfiguration, queryFn: api.runtimeConfiguration });
  const available: Record<PublicationPath, boolean> = {
    managed_cloudflare: configuration.data?.managedTunnelAvailable === true,
    tailscale_funnel: configuration.data?.tailscaleFunnelAvailable === true,
  };
  const recommended = PATHS.find((path) => available[path.id])?.id ?? null;

  // La voie recommandée est présélectionnée dès que le serveur a dit laquelle est ouverte.
  useEffect(() => {
    if (value === null && recommended !== null) onChange(recommended);
  }, [value, recommended, onChange]);

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-semibold">{t("runtimeDirect.pathTitle")}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {PATHS.map((path) => (
          <label
            key={path.id}
            className={`flex items-start gap-3 rounded-xl border p-3 text-sm ${available[path.id] ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}
          >
            <input
              type="radio"
              name="runtime-publication"
              className="mt-1"
              value={path.id}
              disabled={!available[path.id]}
              checked={value === path.id}
              onChange={() => onChange(path.id)}
            />
            <span className="space-y-1">
              <span className="block font-medium">
                {t(path.label)}
                {recommended === path.id ? ` ${t("runtimeDirect.recommended")}` : ""}
              </span>
              <span className="block text-muted-foreground">{t(path.hint)}</span>
              {available[path.id] ? null : <span className="block text-muted-foreground">{t("runtimeDirect.pathUnavailable")}</span>}
            </span>
          </label>
        ))}
      </div>
      {recommended === null ? <Note tone="info">{t("runtimeDirect.pathNone")}</Note> : null}
    </fieldset>
  );
}

/** `customer_cloudflare` ne se crée plus ; les publications déjà écrites gardent un libellé. */
const EXPOSURE_KIND_LABEL: Record<RuntimeExposureStoredKind, MessageKey> = {
  customer_cloudflare: "runtimeDirect.kindCustomer",
  managed_cloudflare: "runtimeDirect.kindManaged",
  tailscale_funnel: "runtimeDirect.kindFunnel",
};

const EXPOSURE_TITLES: MessageKey[] = [
  "runtimeDirect.exposureStepPublish",
  "runtimeDirect.exposureStepInstall",
  "runtimeDirect.exposureStepDeclare",
];

/** Avant la commande publiée : seule l'installation du paquet reste à faire à la main. */
const FUNNEL_COMMANDS: { title: MessageKey; value: string }[] = [
  { title: "runtimeDirect.funnelInstall", value: "curl -fsSL https://tailscale.com/install.sh | sh" },
];

/** Le guide pas à pas de chaque voie (dépôt openedbot-docs), Hermes à préparer sans edge-setup compris. */
const PUBLICATION_GUIDES: Record<PublicationPath, string> = {
  managed_cloudflare: "https://docs.openedbot.app/docs/machine-cloudflare",
  tailscale_funnel: "https://docs.openedbot.app/docs/machine-tailscale",
};

/** Le badge d'état d'une publication, d'après ce que la dernière sonde a vu. */
function exposureStatus(exposure: RuntimeExposureDto | undefined): { key: MessageKey; tone: "success" | "warning" | "neutral" } {
  if (!exposure) return { key: "runtimeDirect.statusAwaiting", tone: "neutral" };
  if (exposure.status === "declared") return { key: "runtimeDirect.statusDeclared", tone: "success" };
  if (exposure.status === "reachable" || exposure.lastTunnelStatus === "healthy") return { key: "runtimeDirect.statusReachable", tone: "success" };
  switch (exposure.lastTunnelStatus) {
    case "down": return { key: "runtimeDirect.statusDown", tone: "warning" };
    case "dns_pending": return { key: "runtimeDirect.statusDns", tone: "warning" };
    case "access_rejected": return { key: "runtimeDirect.statusAccess", tone: "warning" };
    case "unreachable": return { key: "runtimeDirect.statusUnreachable", tone: "warning" };
    default: return { key: "runtimeDirect.statusAwaiting", tone: "neutral" };
  }
}

type RuntimeExposureFlowProps = {
  kind: RuntimeExposureKind;
  onDone: (runtime: RuntimePublicDto) => void;
  onCancel: () => void;
  onBack: () => void;
  /** Publication déjà créée que l'on rouvre : le parcours démarre à l'installation. */
  resume?: RuntimeExposureDto;
};

/**
 * Les trois écrans d'une publication assistée : publier (rien pour le tunnel
 * géré, un nom et un client OAuth pour Funnel), installer (UNE commande à
 * coller, puis l'attente du hostname), déclarer (nom, bearer, trois preuves,
 * ajout inactif).
 *
 * La commande d'installation n'existe que dans l'état de ce composant : le
 * serveur ne la rend qu'à la création, et fermer le dialogue l'oublie. Une
 * publication laissée en plan reparaît sous « Publications en cours » dans le
 * registre, où elle se reprend (sans la commande) ou se révoque.
 */
/** Chaque changement d'étape ramène le corps du wizard en haut : sinon on continue au milieu du texte. */
function useStepScrollReset(step: number) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: 0 });
  }, [step]);
  return ref;
}

function RuntimeExposureFlow({ kind, onDone, onCancel, onBack, resume }: RuntimeExposureFlowProps) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<0 | 1 | 2>(resume ? 1 : 0);
  const bodyRef = useStepScrollReset(stage);
  const [form, setForm] = useState({ slug: "", oauthClientId: "", oauthClientSecret: "", name: "", token: "" });
  // À la reprise, la commande n'est pas rejouée : le serveur ne la rend qu'à la création.
  const [created, setCreated] = useState<RuntimeExposureCreatedDto | null>(resume ? { exposure: resume, installCommand: "" } : null);
  const [probe, setProbe] = useState<RuntimeDirectProbeDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokenRevision = useRef(0);

  const exposureId = created?.exposure.id ?? null;
  const status = useQuery({
    queryKey: ["runtime-exposure", exposureId],
    queryFn: () => api.readRuntimeExposure(exposureId!),
    enabled: exposureId !== null && stage === 1,
    refetchInterval: (query) => (query.state.data?.status === "reachable" || query.state.data?.status === "declared" ? false : 5_000),
  });
  const exposure = status.data ?? created?.exposure;
  const reachable = exposure?.status === "reachable";
  const badge = exposureStatus(exposure);

  const update = (key: keyof typeof form, value: string): void => {
    if (key === "token") { tokenRevision.current++; setProbe(null); }
    setError(null);
    setForm((current) => ({ ...current, [key]: value }));
  };

  const slugValid = /^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$/.test(form.slug.trim().toLowerCase());
  // Le tunnel géré ne demande rien : openedbot tire le sous-domaine sur sa propre zone.
  const formValid = kind === "managed_cloudflare"
    ? true
    : slugValid && form.oauthClientId.trim().length >= 8 && form.oauthClientSecret.trim().length >= 20;

  const publish = async (): Promise<void> => {
    if (busy || !formValid) return;
    setBusy(true);
    setError(null);
    try {
      const slug = form.slug.trim().toLowerCase();
      const result = await api.createRuntimeExposure(
        kind === "managed_cloudflare"
          ? { kind }
          : { kind, slug, oauthClientId: form.oauthClientId.trim(), oauthClientSecret: form.oauthClientSecret.trim() },
      );
      // The OAuth secret has done its job: never keep it in state once published.
      setForm((current) => ({ ...current, oauthClientSecret: "" }));
      setCreated(result);
      setStage(1);
    } catch (caught) {
      setError(t("runtimeDirect.provisionError", { code: caught instanceof ApiError ? caught.code ?? String(caught.status) : "réseau" }));
    } finally {
      setBusy(false);
    }
  };

  const test = async (): Promise<void> => {
    if (busy || !exposureId || !form.token.trim()) return;
    const started = tokenRevision.current;
    setBusy(true);
    setProbe(null);
    setError(null);
    try {
      const result = await api.testRuntimeExposure(exposureId, form.token.trim());
      if (started === tokenRevision.current) setProbe(result);
    } catch {
      if (started === tokenRevision.current) setError(t("runtimeDirect.probeError"));
    } finally {
      setBusy(false);
    }
  };

  const declare = async (): Promise<void> => {
    if (busy || !exposureId || !directProbePassed(probe) || !form.name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.declareRuntimeExposure(exposureId, { name: form.name.trim(), token: form.token.trim() });
      await refreshRuntimes(queryClient);
      onDone(saved);
    } catch {
      setError(t("runtimeDirect.saveError"));
    } finally {
      setBusy(false);
    }
  };

  const installCommands = created?.installCommand
    ? kind === "tailscale_funnel"
      ? [...FUNNEL_COMMANDS.map((item) => ({ title: t(item.title), value: item.value })),
          { title: t("runtimeDirect.funnelPublish"), value: created.installCommand },
          { title: t("runtimeDirect.funnelStatus"), value: "tailscale funnel status" }]
      : [...INSTALL_COMMANDS.slice(0, 3).map((item) => ({ title: t(item.title), value: item.value })),
          { title: t("runtimeDirect.installService"), value: created.installCommand },
          { title: t("runtimeDirect.installStatus"), value: INSTALL_COMMANDS[4]!.value }]
    : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div ref={bodyRef} className="scrollbar-subtle scroll-y-ring-safe min-h-0 flex-1 space-y-4 text-sm">
        <h3 className="font-semibold">
          {t("runtimeDirect.stepHeading", { step: stage + 1, title: t(EXPOSURE_TITLES[stage]!) })}
        </h3>
        {stage === 0 ? (
          <div className="space-y-4">
            <a href={PUBLICATION_GUIDES[kind]} target="_blank" rel="noopener noreferrer" className="text-primary outline-none transition-colors hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring">
              {t("runtimeDirect.guideLink")}
            </a>
            {kind === "managed_cloudflare" ? (
              <Note tone="info">{t("runtimeDirect.managedAutoHint")}</Note>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="exposure-slug">{t("runtimeDirect.funnelSlugLabel")}</Label>
                  <Input id="exposure-slug" autoComplete="off" placeholder="mon-vps" value={form.slug} onChange={(event) => update("slug", event.target.value)} />
                </div>
                <p className="text-muted-foreground">
                  {t("runtimeDirect.funnelSlugHint", { hostname: `${form.slug.trim().toLowerCase() || "<nom>"}.<votre-tailnet>.ts.net` })}
                </p>
                <TailscaleOauthGuide />
                <div className="space-y-2">
                  <Label htmlFor="exposure-oauth-id">{t("runtimeDirect.tsClientIdLabel")}</Label>
                  <Input id="exposure-oauth-id" autoComplete="off" value={form.oauthClientId} onChange={(event) => update("oauthClientId", event.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="exposure-oauth-secret">{t("runtimeDirect.tsClientSecretLabel")}</Label>
                  <Input id="exposure-oauth-secret" type="password" autoComplete="off" value={form.oauthClientSecret} onChange={(event) => update("oauthClientSecret", event.target.value)} />
                </div>
                <Note tone="info">{t("runtimeDirect.tsCredentialsHint")}</Note>
                <Note tone="warning">{t("runtimeDirect.funnelWarning")}</Note>
              </>
            )}
          </div>
        ) : stage === 1 ? (
          <div className="space-y-4">
            <p>{t(kind === "tailscale_funnel" ? "runtimeDirect.installIntroFunnel" : "runtimeDirect.installIntroCloudflare")}</p>
            <StatusList>
              <StatusRow label={t("runtimeDirect.publishedHostname")} value={exposure?.hostname ?? ""} mono />
              <StatusRow
                label={t("runtimeDirect.publicationStatus")}
                value={<ToneBadge tone={badge.tone}>{t(badge.key)}</ToneBadge>}
              />
            </StatusList>
            {installCommands.length > 0 ? (
              <ol className="space-y-4">
                {installCommands.map((item, index) => (
                  <EnrollmentStep key={item.title} index={index + 1} title={item.title} value={item.value} copyLabel={item.title} />
                ))}
              </ol>
            ) : (
              <Note tone="warning">{t("runtimeDirect.resumeNoCommand")}</Note>
            )}
            {!reachable ? <Note tone="info" role="status">{t("runtimeDirect.waitingHint")}</Note> : null}
          </div>
        ) : (
          <div className="space-y-4">
            <Note tone="info">{t(kind === "tailscale_funnel" ? "runtimeDirect.exposureDeclareHintFunnel" : "runtimeDirect.exposureDeclareHint")} {t("runtimeDirect.addHint")}</Note>
            <div className="space-y-2">
              <Label htmlFor="exposure-name">{t("runtimeDirect.name")}</Label>
              <Input id="exposure-name" autoComplete="off" value={form.name} onChange={(event) => update("name", event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="exposure-url">{t("runtimeDirect.url")}</Label>
              <Input id="exposure-url" readOnly value={exposure?.endpoint ?? ""} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="exposure-token">{t("runtimeDirect.bearer")}</Label>
              <Input id="exposure-token" type="password" autoComplete="off" value={form.token} onChange={(event) => update("token", event.target.value)} />
            </div>
            {probe ? <RuntimeDirectProofs probe={probe} onStep={(step) => setStage(Math.min(Math.max(step - 1, 0), 2) as 0 | 1 | 2)} /> : null}
          </div>
        )}
        {error ? <p role="alert" className="text-destructive-text">{error}</p> : null}
      </div>
      <DialogFooterRow>
        <button type="button" className={BUTTON.secondary} disabled={busy} onClick={onCancel}>{t("common.cancel")}</button>
        {resume && stage <= 1 ? null : (
          <button
            type="button"
            className={BUTTON.secondary}
            disabled={busy}
            onClick={() => (stage === 0 ? onBack() : setStage((stage - 1) as 0 | 1 | 2))}
          >
            {t("runtimeDirect.previous")}
          </button>
        )}
        {stage === 0 ? (
          <button type="button" className={BUTTON.primary} disabled={busy || !formValid} onClick={() => void publish()}>
            {busy ? t("runtimeDirect.provisioning") : t("runtimeDirect.provision")}
          </button>
        ) : stage === 1 ? (
          <button type="button" className={BUTTON.primary} disabled={!reachable} onClick={() => setStage(2)}>
            {t("runtimeDirect.continue")}
          </button>
        ) : (
          <>
            <button type="button" className={BUTTON.secondary} disabled={busy || !form.token.trim()} onClick={() => void test()}>
              {busy ? t("runtimeDirect.testing") : t("runtimeDirect.test")}
            </button>
            <button type="button" className={BUTTON.primary} disabled={busy || !form.name.trim() || !directProbePassed(probe)} onClick={() => void declare()}>
              {t("runtimeDirect.add")}
            </button>
          </>
        )}
      </DialogFooterRow>
    </div>
  );
}

/**
 * Les publications qu'aucun runtime ne porte encore.
 *
 * Sans cette liste, un dialogue fermé entre « Publier » et « Ajouter »
 * laissait un tunnel, un DNS, une application Access et un service token chez
 * le fournisseur, invisibles depuis l'application et donc jamais retirés.
 *
 * Reprendre rouvre le parcours à l'installation ; la commande, elle, n'est pas
 * rejouée : le serveur ne la rend qu'à la création, et un secret ne repasse
 * pas par le navigateur à chaque reprise.
 */
export function RuntimePendingExposures() {
  const { t } = useT();
  const queryClient = useQueryClient();
  const pending = useQuery({ queryKey: queryKeys.runtimeExposures, queryFn: api.listRuntimeExposures });
  const [resumed, setResumed] = useState<RuntimeExposureDto | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<MessageKey | null>(null);

  const exposures = pending.data ?? [];
  if (exposures.length === 0) return null;

  const revoke = async (exposure: RuntimeExposureDto): Promise<void> => {
    if (busyId) return;
    setBusyId(exposure.id);
    setNotice(null);
    try {
      const result = await api.deleteRuntimeExposure(exposure.id);
      if (result.cloudflareCleanup === "manual") setNotice("runtimeDirect.revokeManual");
      await refreshRuntimes(queryClient);
    } catch {
      setNotice("runtimeDirect.revokeError");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <SettingsCard className="space-y-3">
      <CardHeading title={t("runtimeDirect.pendingTitle")} description={t("runtimeDirect.pendingHint")} />
      <StatusList>
        {exposures.map((exposure) => {
          const badge = exposureStatus(exposure);
          return (
            <StatusRow
              key={exposure.id}
              label={exposure.hostname}
              value={
                <span className="flex flex-wrap items-center justify-end gap-2">
                  <ToneBadge tone={badge.tone}>{t(badge.key)}</ToneBadge>
                  <button type="button" className={BUTTON.secondary} disabled={busyId !== null} onClick={() => setResumed(exposure)}>
                    {t("runtimeDirect.resume")}
                  </button>
                  <button type="button" className={BUTTON.secondary} disabled={busyId !== null} onClick={() => void revoke(exposure)}>
                    {busyId === exposure.id ? t("runtimeDirect.revoking") : t("runtimeDirect.revoke")}
                  </button>
                </span>
              }
            />
          );
        })}
      </StatusList>
      {notice ? <Note tone="warning" role="alert">{t(notice)}</Note> : null}
      {resumed ? (
        <Dialog
          open
          className={DIRECT_DIALOG_WIDTH}
          bodyClassName="flex flex-col overflow-y-hidden"
          onClose={() => setResumed(null)}
          title={t("runtimeDirect.pendingTitle")}
        >
          <RuntimeExposureFlow
            kind={resumed.kind === "customer_cloudflare" ? "managed_cloudflare" : resumed.kind}
            resume={resumed}
            onDone={() => setResumed(null)}
            onCancel={() => setResumed(null)}
            onBack={() => setResumed(null)}
          />
        </Dialog>
      ) : null}
    </SettingsCard>
  );
}

type RuntimeDirectWizardProps = {
  onDone: (runtime: RuntimePublicDto) => void;
  onCancel: () => void;
  runtime?: RuntimePublicDto;
  renew?: boolean;
};

/**
 * Le parcours de création ou de modification d'un accès direct.
 *
 * Ajouter, c'est choisir une voie de publication puis la suivre : l'assistant
 * publie, l'hôte joue une commande, le runtime est déclaré. Modifier ou
 * renouveler ouvre directement les champs que le serveur conserve pour sonder
 * un gateway déjà publié, par openedbot ou par un autre moyen.
 */
export function RuntimeDirectWizard({
  onDone,
  onCancel,
  runtime,
  renew = false,
}: RuntimeDirectWizardProps) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [path, setPath] = useState<PublicationPath | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [draft, setDraft] = useState<RuntimeDirectDraft>({
    name: runtime?.name ?? "",
    url: runtime?.baseUrl ?? "",
    token: "",
    clientId: "",
    clientSecret: "",
  });
  const [removeEdge, setRemoveEdge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useStepScrollReset(publishing ? 1 : 0);

  const updateDraftField = (
    key: keyof RuntimeDirectDraft,
    value: string,
  ): void => {
    setError(null);
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const hasMatchingEdgeCredentials =
    Boolean(draft.clientId.trim()) === Boolean(draft.clientSecret.trim());
  const edgeConfigurationComplete = removeEdge || hasMatchingEdgeCredentials;
  const isValid =
    draft.url.trim().length > 0 &&
    edgeConfigurationComplete &&
    (!renew || Boolean(draft.clientId.trim() && draft.clientSecret.trim())) &&
    Boolean(runtime?.id);
  const input: RuntimeDirectAccessInput = {
    name: draft.name.trim(),
    url: draft.url.trim(),
    token: draft.token.trim(),
    ...(draft.clientId.trim() && !removeEdge
      ? {
          edgeAuth: {
            clientId: draft.clientId.trim(),
            clientSecret: draft.clientSecret.trim(),
          },
        }
      : {}),
  };

  /**
   * Enregistre les accès du runtime affiché ; les secrets laissés vides restent
   * inchangés, SAUF si l'URL change.
   *
   * Un bearer enregistré ne suit pas son runtime vers un autre hôte : l'API le
   * refuse, parce que le renvoyer ailleurs serait l'exfiltrer. Changer l'URL
   * sans ressaisir le bearer partait donc en 400 ; on le demande ici, avant
   * l'aller-retour, avec la raison.
   */
  const saveRuntime = async (): Promise<void> => {
    if (busy || !isValid || !runtime?.id) return;

    const movesHost = input.url !== runtime.baseUrl;
    if (movesHost && !input.token) {
      setError("Cette URL est nouvelle : saisissez le bearer de cet hôte. Celui enregistré ne le suit pas.");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const update: RuntimeDirectAccessUpdateInput = {
        ...(movesHost ? { url: input.url } : {}),
        ...(input.token ? { token: input.token } : {}),
        ...(removeEdge
          ? { edgeAuth: null }
          : input.edgeAuth
            ? { edgeAuth: input.edgeAuth }
            : {}),
      };
      const saved = await api.updateRuntimeAccess(runtime.id, update);

      await refreshRuntimes(queryClient);
      onDone(saved);
    } catch {
      setError(t("runtimeDirect.saveError"));
    } finally {
      setBusy(false);
    }
  };

  // OHB-75 : la publication assistée est un parcours à part entière.
  if (!runtime && publishing && path) {
    return <RuntimeExposureFlow kind={path} onDone={onDone} onCancel={onCancel} onBack={() => setPublishing(false)} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div ref={bodyRef} className="scrollbar-subtle scroll-y-ring-safe min-h-0 flex-1 space-y-4 text-sm">
        {runtime ? (
          <>
            <Note tone="info">
              {t("runtimeDirect.scopeHint")} {t("runtimeDirect.updateHint")}
            </Note>
            {DIRECT_FIELDS.map(({ key, translation }) =>
              key === "name" ? null : (
                <div key={key} className="space-y-2">
                  <Label htmlFor={`direct-${key}`}>
                    {t(translation)}
                  </Label>
                  <Input
                    id={`direct-${key}`}
                    type={inputTypeForField(key)}
                    autoComplete="off"
                    value={draft[key]}
                    disabled={busy || (removeEdge && isEdgeField(key))}
                    onChange={(event) =>
                      updateDraftField(key, event.target.value)
                    }
                    placeholder={
                      key === "url"
                        ? "https://hermes.example.com"
                        : undefined
                    }
                  />
                </div>
              ),
            )}
            {runtime.edgeAuthConfigured ? (
              <label className="flex min-h-11 items-center gap-3">
                <Checkbox
                  disabled={busy}
                  checked={removeEdge}
                  onCheckedChange={(checked) => setRemoveEdge(checked === true)}
                />
                {t("runtimeDirect.removeEdge")}
              </label>
            ) : null}
            {!edgeConfigurationComplete ? (
              <p role="alert">{t("runtimeDirect.pairRequired")}</p>
            ) : null}
          </>
        ) : (
          <RuntimePublicationPicker value={path} onChange={setPath} />
        )}
        {error ? (
          <p role="alert" className="text-destructive-text">
            {error}
          </p>
        ) : null}
      </div>
      <DialogFooterRow>
        <button
          type="button"
          className={BUTTON.secondary}
          disabled={busy}
          onClick={onCancel}
        >
          {t("common.cancel")}
        </button>
        {runtime ? (
          <button
            type="button"
            className={BUTTON.primary}
            disabled={busy || !isValid}
            onClick={() => void saveRuntime()}
          >
            {t("runtimeDirect.save")}
          </button>
        ) : (
          <button
            type="button"
            className={BUTTON.primary}
            disabled={busy || path === null}
            onClick={() => setPublishing(true)}
          >
            {t("runtimeDirect.continue")}
          </button>
        )}
      </DialogFooterRow>
    </div>
  );
}

type RuntimeDirectStatusProps = {
  runtime: RuntimePublicDto;
};

/** La carte de statut et les commandes opérateur d'un runtime direct. */
export function RuntimeDirectStatus({ runtime }: RuntimeDirectStatusProps) {
  const { t, formatDate } = useT();

  return (
    <SettingsCard className="space-y-4">
      <CardHeading
        title={t("runtimeDirect.direct")}
        description={t("runtimeDirect.statusDescription")}
      />
      <StatusList>
        <StatusRow
          label={t("runtimeDirect.reachability")}
          value={t("runtimeDirect.direct")}
        />
        <StatusRow
          label={t("runtimeDirect.url")}
          value={runtime.baseUrl ?? "..."}
        />
        <StatusRow
          label={t("runtimeDirect.lastTest")}
          value={
            runtime.lastCheckedAt
              ? formatDate(runtime.lastCheckedAt)
              : t("common.never")
          }
        />
        <StatusRow
          label={t("runtimeDirect.lastError")}
          value={
            runtime.lastHealthError?.slice(0, 300) ||
            t("runtimeDirect.noError")
          }
        />
        <StatusRow
          label={t("runtimeDirect.serviceToken")}
          value={
            runtime.edgeAuthConfigured
              ? t("runtimeDirect.configured")
              : t("runtimeDirect.notConfigured")
          }
        />
        {runtime.exposure ? (
          <>
            <StatusRow
              label={t("runtimeDirect.exposureKind")}
              value={t(EXPOSURE_KIND_LABEL[runtime.exposure.kind])}
            />
            {runtime.exposure.kind !== "tailscale_funnel" ? (
              <StatusRow
                label={t("runtimeDirect.tunnelState")}
                value={runtime.exposure.lastTunnelStatus ?? t("runtimeDirect.tunnelStateUnknown")}
              />
            ) : null}
          </>
        ) : null}
        <StatusRow
          label={t("runtimeDirect.profile")}
          value={t("runtimeDirect.sharedProfile")}
        />
        <StatusRow
          label={t("runtimeDirect.capabilities")}
          value={t("runtimeDirect.hostCapabilities")}
        />
      </StatusList>
      <section aria-labelledby="runtime-direct-host-commands" className="space-y-3">
        <div>
          <h3 id="runtime-direct-host-commands" className="text-sm font-semibold text-text-primary">
            {t("runtimeDirect.hostCommandsTitle")}
          </h3>
          <p className="mt-1 text-sm text-text-tertiary">{t("runtimeDirect.hostCommandsDescription")}</p>
        </div>
        <HostCommandList
          commands={[
            {
              label: t("runtimeDirect.hostProviders"),
              value: `edge-setup credentials add ${t("runtimeDirect.hostProviderPlaceholder")}`,
            },
            { label: t("runtimeDirect.hostToolsets"), value: "edge-setup toolsets" },
            { label: t("runtimeDirect.hostMcp"), value: "edge-setup mcp" },
          ]}
        />
      </section>
    </SettingsCard>
  );
}

type RuntimeDirectActionsProps = {
  runtime: RuntimePublicDto;
};

/** Les actions de retest, renouvellement et modification d'un runtime direct. */
export function RuntimeDirectActions({ runtime }: RuntimeDirectActionsProps) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [view, setView] = useState<"edit" | "renew" | "test" | null>(null);
  const [probe, setProbe] = useState<RuntimeDirectProbeDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  /** Relance la sonde du runtime affiché et rafraîchit ses cartes de statut. */
  const retestRuntime = async (): Promise<void> => {
    if (!runtime.id || busy) return;

    setView("test");
    setBusy(true);
    setProbe(null);
    setFailed(false);

    try {
      setProbe(await api.testDirectRuntime(runtime.id));
      await refreshRuntimes(queryClient);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={BUTTON.secondary}
        disabled={busy}
        onClick={() => void retestRuntime()}
      >
        {t("runtimeDirect.retest")}
      </button>
      <button
        type="button"
        className={BUTTON.secondary}
        disabled={!runtime.id || busy}
        onClick={() => {
          setView("renew");
        }}
      >
        {t("runtimeDirect.renew")}
      </button>
      <button
        type="button"
        className={BUTTON.secondary}
        disabled={!runtime.id || busy}
        onClick={() => setView("edit")}
      >
        {t("runtimeDirect.edit")}
      </button>
      <Dialog
        className={DIRECT_DIALOG_WIDTH}
        bodyClassName="flex flex-col overflow-y-hidden"
        open={view !== null}
        onClose={() => {
          if (!busy) setView(null);
        }}
        title={
          view === "test"
            ? t("runtimeDirect.testTitle", { name: runtime.name ?? "..." })
            : view === "renew"
              ? t("runtimeDirect.renew")
              : t("runtimeDirect.edit")
        }
      >
        {view === "test" ? (
          <div className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="scrollbar-subtle scroll-y-ring-safe min-h-0 flex-1 space-y-4">
              {busy ? (
                <p role="status">{t("runtimeDirect.testing")}</p>
              ) : null}
              {failed ? (
                <p role="alert">{t("runtimeDirect.retryError")}</p>
              ) : null}
              {probe ? <RuntimeDirectProofs probe={probe} /> : null}
            </div>
            <DialogFooterRow>
              <button
                type="button"
                className={BUTTON.primary}
                disabled={busy}
                onClick={() => void retestRuntime()}
              >
                {t("runtimeDirect.retest")}
              </button>
            </DialogFooterRow>
          </div>
        ) : view ? (
          <RuntimeDirectWizard
            key={view}
            runtime={runtime}
            renew={view === "renew"}
            onDone={() => setView(null)}
            onCancel={() => setView(null)}
          />
        ) : null}
      </Dialog>
    </>
  );
}
