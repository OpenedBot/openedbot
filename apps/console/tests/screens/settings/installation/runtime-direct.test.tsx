import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RuntimeDirectProbeDto, RuntimePublicDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../../../src/lib/i18n";
import { RuntimeDirectWizard, RuntimeDirectActions, RuntimePendingExposures, DIRECT_DIAGNOSTICS } from "../../../../src/components/runtime-direct";
import { api } from "../../../../src/lib/api";
import { RuntimeReplacement } from "../../../../src/screens/settings/installation/cloud";
import { StepRuntime } from "../../../../src/screens/onboarding/steps/step-runtime";
const realFetch = globalThis.fetch;
const green: RuntimeDirectProbeDto = { ok: true, steps: [{ step: "edge", ok: true }, { step: "auth", ok: true }, { step: "toolsets", ok: true }], hints: null, capabilities: {} };
let calls: { url: string; method: string; body: unknown }[];
let verdict = green;
let delayed: ((value: Response) => void) | null;
function mount(element: React.ReactNode) {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><I18nProvider>{element}</I18nProvider></QueryClientProvider>);
}
beforeEach(() => {
  calls = []; verdict = green; delayed = null;
  window.localStorage.setItem("ohb:locale", "fr");
  globalThis.fetch = (async (input, init) => {
    const url = String(input); calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith("test-draft")) return Response.json(verdict);
    if (url.endsWith("/test")) return Response.json(verdict);
    if (url.endsWith("/replace")) return Response.json({ runtime: { id: "direct-2", isActive: true } });
    return Response.json({ id: "direct-2", reachability: "direct", isActive: false });
  }) as typeof fetch;
});
afterEach(() => { cleanup(); globalThis.fetch = realFetch; window.localStorage.clear(); });
/** Choisit une voie de publication et passe l'étape du choix. */
function choosePath(name: RegExp) {
  fireEvent.click(screen.getByRole("radio", { name }));
  fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
}
const exposure = { id: "exp-1", kind: "managed_cloudflare", status: "awaiting_install", hostname: "mon-vps.rt.openedbot.app", endpoint: "https://mon-vps.rt.openedbot.app", runtimeId: null, edgeAuthProvisioned: true, lastTunnelStatus: null, lastCheckedAt: null, errorCode: null, createdAt: "2026-09-07T00:00:00.000Z" };
const TUNNEL_COMMAND = "sudo cloudflared service install eyJhIjoiSECRET-TUNNEL-TOKEN";
const FUNNEL_COMMAND = "sudo tailscale up --auth-key tskey-SECRET-AUTH-KEY --hostname mon-vps --advertise-tags tag:ohb-hermes && sudo tailscale funnel --bg 8642";
/** Le faux serveur des publications : création, relecture (joignable à la deuxième), test, déclaration. */
function exposureFetch(kind: string, reads: { current: number } = { current: 0 }) {
  const funnel = kind === "tailscale_funnel";
  const hostname = funnel ? "mon-vps.tail1234.ts.net" : exposure.hostname;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith("/api/runtime") && method === "GET") return Response.json({ runtime: null, managedTunnelAvailable: true, tailscaleFunnelAvailable: true });
    if (url.endsWith("/api/runtime/exposures") && method === "POST") {
      return Response.json({ exposure: { ...exposure, kind, hostname, edgeAuthProvisioned: !funnel }, installCommand: funnel ? FUNNEL_COMMAND : TUNNEL_COMMAND }, { status: 201 });
    }
    if (url.endsWith("/api/runtime/exposures/exp-1") && method === "GET") { reads.current++; return Response.json({ ...exposure, kind, hostname, status: reads.current >= 2 ? "reachable" : "awaiting_install", lastTunnelStatus: reads.current >= 2 ? "healthy" : null }); }
    if (url.endsWith("/exposures/exp-1/test")) return delayed ? new Promise<Response>((resolve) => { delayed = resolve; }) : Response.json(verdict);
    if (url.endsWith("/exposures/exp-1/declare")) return Response.json({ id: "direct-2", reachability: "direct", isActive: false, exposure: { id: "exp-1", kind, hostname, lastTunnelStatus: "healthy" } }, { status: 201 });
    return Response.json({ id: "direct-2", reachability: "direct", isActive: false });
  }) as typeof fetch;
}
const add = () => screen.getByRole("button", { name: "Ajouter" }) as HTMLButtonElement;
/** Publie, attend que l'hôte réponde, et s'arrête à l'étape « Déclarer et tester ». */
async function publish(_kind: string, radio: RegExp, fields: readonly (readonly [string, string])[]) {
  await screen.findByRole("radio", { name: radio });
  choosePath(radio);
  const publishButton = () => screen.getByRole("button", { name: "Publier" }) as HTMLButtonElement;
  expect(publishButton().disabled).toBe(fields.length > 0);
  for (const [label, value] of fields) fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(publishButton());
  const next = () => screen.getByRole("button", { name: "Continuer" }) as HTMLButtonElement;
  await screen.findByText("En attente de l’hôte");
  expect(next().disabled).toBe(true);
  await waitFor(() => expect(screen.getByText("Joignable")).toBeTruthy(), { timeout: 12_000 });
  fireEvent.click(next());
}
const PATHS = [
  ["managed_cloudflare", /Tunnel géré par openedbot/, [], TUNNEL_COMMAND],
  ["tailscale_funnel", /Tailscale Funnel/, [["Nom de la machine sur le tailnet", "mon-vps"], ["Client ID OAuth Tailscale", "ohb-client-id"], ["Client Secret OAuth Tailscale", "oauth-secret-with-enough-length"]], FUNNEL_COMMAND],
] as const;
for (const [kind, radio, fields, command] of PATHS) test(`publication ${kind} : publier, commande rendue une fois, attente du hostname, puis déclaration sans champs Access`, async () => {
  let done: unknown = null;
  globalThis.fetch = exposureFetch(kind);
  mount(<RuntimeDirectWizard onDone={(saved) => { done = saved; }} onCancel={() => { }} />);
  await screen.findByRole("radio", { name: radio });
  choosePath(radio);
  const publishButton = () => screen.getByRole("button", { name: "Publier" }) as HTMLButtonElement;
  expect(publishButton().disabled).toBe(fields.length > 0);
  for (const [label, value] of fields) fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(publishButton());
  const created = await waitFor(() => { const call = calls.find(c => c.url.endsWith("/api/runtime/exposures") && c.method === "POST"); expect(call).toBeTruthy(); return call!; });
  expect(created.body).toEqual(kind === "managed_cloudflare"
    // Le tunnel géré ne porte aucun nom : openedbot tire le sous-domaine.
    ? { kind }
    : { kind, slug: "mon-vps", oauthClientId: "ohb-client-id", oauthClientSecret: "oauth-secret-with-enough-length" });
  // The one command with the secret is shown here and nowhere else.
  await screen.findByText(command);
  const next = () => screen.getByRole("button", { name: "Continuer" }) as HTMLButtonElement;
  await screen.findByText("En attente de l’hôte");
  expect(next().disabled).toBe(true);
  await waitFor(() => expect(screen.getByText("Joignable")).toBeTruthy(), { timeout: 12_000 });
  expect(next().disabled).toBe(false);
  fireEvent.click(next());
  expect(screen.queryByLabelText("Client ID Access (facultatif)")).toBeNull();
  expect((screen.getByLabelText("URL Hermes") as HTMLInputElement).readOnly).toBe(true);
  fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "Mon gateway" } });
  fireEvent.change(screen.getByLabelText("Bearer API_SERVER_KEY"), { target: { value: "secret-bearer" } });
  expect(add().disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Tester" }));
  await waitFor(() => expect(screen.getAllByText("Vérifié")).toHaveLength(3));
  fireEvent.click(add());
  await waitFor(() => expect(done).toBeTruthy());
  const declare = calls.find(c => c.url.endsWith("/exposures/exp-1/declare"))!;
  expect(declare.body).toEqual({ name: "Mon gateway", token: "secret-bearer" });
  expect(JSON.stringify(calls.map(c => c.body))).not.toContain("SECRET");
}, 20_000);

test("le client OAuth du tailnet ne sert qu’à publier et n’est jamais renvoyé ensuite", async () => {
  globalThis.fetch = exposureFetch("tailscale_funnel");
  mount(<RuntimeDirectWizard onDone={() => { }} onCancel={() => { }} />);
  await publish(...PATHS[1]!.slice(0, 3) as [string, RegExp, readonly (readonly [string, string])[]]);
  const created = calls.find(c => c.url.endsWith("/api/runtime/exposures") && c.method === "POST")!;
  expect(created.body).toEqual({ kind: "tailscale_funnel", slug: "mon-vps", oauthClientId: "ohb-client-id", oauthClientSecret: "oauth-secret-with-enough-length" });
  fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "Mon gateway" } });
  fireEvent.change(screen.getByLabelText("Bearer API_SERVER_KEY"), { target: { value: "secret-bearer" } });
  fireEvent.click(screen.getByRole("button", { name: "Tester" }));
  await waitFor(() => expect(screen.getAllByText("Vérifié")).toHaveLength(3));
  fireEvent.click(add());
  await waitFor(() => expect(calls.some(c => c.url.endsWith("/declare"))).toBe(true));
  const afterPublish = calls.slice(calls.indexOf(created) + 1);
  expect(JSON.stringify(afterPublish.map(c => c.body))).not.toContain("oauth-secret");
}, 20_000);

test("une voie fermée reste affichée, désactivée : elle s’apprend au lieu de disparaître", async () => {
  mount(<RuntimeDirectWizard onDone={() => { }} onCancel={() => { }} />);
  const funnel = await screen.findByRole("radio", { name: /Tailscale Funnel/ }) as HTMLInputElement;
  const managed = screen.getByRole("radio", { name: /Tunnel géré par openedbot/ }) as HTMLInputElement;
  expect([funnel.disabled, managed.disabled]).toEqual([true, true]);
  expect(screen.getAllByText("Pas encore ouverte sur ce déploiement.")).toHaveLength(2);
  expect(screen.getByText(/Aucune voie de publication n’est ouverte/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Continuer" }) as HTMLButtonElement).disabled).toBe(true);
});

test("la voie ouverte porte « recommandé » et est présélectionnée", async () => {
  globalThis.fetch = exposureFetch("managed_cloudflare");
  mount(<RuntimeDirectWizard onDone={() => { }} onCancel={() => { }} />);
  const managed = await screen.findByRole("radio", { name: /Tunnel géré par openedbot \(recommandé\)/ }) as HTMLInputElement;
  await waitFor(() => expect(managed.checked).toBe(true));
  expect((screen.getByRole("button", { name: "Continuer" }) as HTMLButtonElement).disabled).toBe(false);
});

test("chaque diagnostic renvoie à une étape de la publication", () => {
  for (const [code, diagnostic] of Object.entries(DIRECT_DIAGNOSTICS)) {
    expect(diagnostic.step, code).toBeGreaterThanOrEqual(1);
    expect(diagnostic.step, code).toBeLessThanOrEqual(3);
  }
});

test("un diagnostic rouvre l’étape concernée de la publication", async () => {
  verdict = { ...green, ok: false, steps: [{ step: "edge", ok: false, code: "RUNTIME_TUNNEL_DOWN" }] };
  globalThis.fetch = exposureFetch("managed_cloudflare");
  mount(<RuntimeDirectWizard onDone={() => { }} onCancel={() => { }} />);
  await publish(...PATHS[0]!.slice(0, 3) as [string, RegExp, readonly (readonly [string, string])[]]);
  fireEvent.change(screen.getByLabelText("Bearer API_SERVER_KEY"), { target: { value: "secret-bearer" } });
  fireEvent.click(screen.getByRole("button", { name: "Tester" }));
  fireEvent.click(await screen.findByRole("button", { name: "Revoir l’étape 2" }));
  expect(screen.getByRole("heading", { name: /Étape 2 :/ })).toBeTruthy();
}, 20_000);

test("une réponse tardive ne valide pas un bearer modifié pendant le test", async () => {
  globalThis.fetch = exposureFetch("managed_cloudflare");
  mount(<RuntimeDirectWizard onDone={() => { }} onCancel={() => { }} />);
  await publish(...PATHS[0]!.slice(0, 3) as [string, RegExp, readonly (readonly [string, string])[]]);
  fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "Mon gateway" } });
  fireEvent.change(screen.getByLabelText("Bearer API_SERVER_KEY"), { target: { value: "secret-bearer" } });
  delayed = () => { };
  fireEvent.click(screen.getByRole("button", { name: "Tester" }));
  await waitFor(() => expect(typeof delayed).toBe("function"));
  fireEvent.change(screen.getByLabelText("Bearer API_SERVER_KEY"), { target: { value: "autre-bearer" } });
  delayed!(Response.json(green));
  await screen.findByRole("button", { name: "Tester" });
  expect(add().disabled).toBe(true);
  expect(screen.queryByText("Vérifié")).toBeNull();
}, 20_000);

test("une publication abandonnée se reprend sans rejouer la commande, ou se révoque", async () => {
  const pending = { ...exposure, status: "reachable", lastTunnelStatus: "healthy" };
  let listed = [pending];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith("/api/runtime/exposures") && method === "GET") return Response.json({ exposures: listed });
    if (url.endsWith("/api/runtime/exposures/exp-1") && method === "DELETE") { listed = []; return Response.json({ ok: true, cloudflareCleanup: "done" }); }
    if (url.endsWith("/api/runtime/exposures/exp-1")) return Response.json(pending);
    return Response.json({ runtimes: [] });
  }) as typeof fetch;
  mount(<RuntimePendingExposures />);

  await screen.findByText("mon-vps.rt.openedbot.app");
  fireEvent.click(screen.getByRole("button", { name: "Reprendre" }));
  // La reprise rouvre l'installation, dit pourquoi la commande n'est plus là, et n'offre pas de retour en arrière.
  expect(await screen.findByRole("heading", { name: /Étape 2 :/ })).toBeTruthy();
  expect(screen.getByText(/La commande d’installation n’est affichée qu’une fois/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Précédent" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Annuler" }));

  fireEvent.click(await screen.findByRole("button", { name: "Révoquer" }));
  await waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true));
  await waitFor(() => expect(screen.queryByText("mon-vps.rt.openedbot.app")).toBeNull());
});

const runtime = { id: "inactive-direct", name: "Inactif", baseUrl: "https://hermes.example.com", reachability: "direct", edgeAuthConfigured: true, isActive: false } as RuntimePublicDto;
test("modifier conserve les secrets vides et permet le retrait explicite Access sur l’id inactif", async () => {
  let done = false;
  mount(<RuntimeDirectWizard runtime={runtime} onDone={() => { done = true; }} onCancel={() => { }} />);
  expect((screen.getByLabelText("Bearer API_SERVER_KEY") as HTMLInputElement).value).toBe("");
  fireEvent.click(screen.getByRole("checkbox", { name: /Retirer le service token/ }));
  fireEvent.click(screen.getByRole("button", { name: "Enregistrer les accès" }));
  await waitFor(() => expect(done).toBe(true));
  // L'URL n'a pas bougé : les champs laissés vides gardent bien leurs secrets,
  // et le retrait Access reste explicite.
  expect(calls[0]).toEqual({ url: expect.stringContaining("/api/runtime/inactive-direct/access"), method: "PUT", body: { edgeAuth: null } });
});

// Un bearer enregistré ne suit pas son runtime vers un autre hôte : le renvoyer
// ailleurs serait l'exfiltrer, et l'API le refuse. L'écran demandait pourtant
// exactement ça, en omettant `token` dès que le champ était vide.
test("changer l’URL sans ressaisir le bearer ne part pas, et le dit", async () => {
  let done = false;
  mount(<RuntimeDirectWizard runtime={runtime} onDone={() => { done = true; }} onCancel={() => { }} />);
  fireEvent.change(screen.getByLabelText("URL Hermes"), { target: { value: "https://collecteur.attaquant.example" } });
  fireEvent.click(screen.getByRole("button", { name: "Enregistrer les accès" }));
  await waitFor(() => expect(screen.getByText(/saisissez le bearer de cet hôte/i)).toBeTruthy());
  expect(calls).toHaveLength(0);
  expect(done).toBe(false);
});

test("changer l’URL avec le bearer du nouvel hôte transmet les deux", async () => {
  let done = false;
  mount(<RuntimeDirectWizard runtime={runtime} onDone={() => { done = true; }} onCancel={() => { }} />);
  fireEvent.change(screen.getByLabelText("URL Hermes"), { target: { value: "https://new.example.com" } });
  fireEvent.change(screen.getByLabelText("Bearer API_SERVER_KEY"), { target: { value: "bearer-du-nouvel-hote" } });
  fireEvent.click(screen.getByRole("button", { name: "Enregistrer les accès" }));
  await waitFor(() => expect(done).toBe(true));
  expect(calls[0]).toEqual({ url: expect.stringContaining("/api/runtime/inactive-direct/access"), method: "PUT",
    body: { url: "https://new.example.com", token: "bearer-du-nouvel-hote" } });
});
test("retest et renouvellement ciblent le runtime inactif", async () => {
  mount(<RuntimeDirectActions runtime={runtime} />);
  fireEvent.click(screen.getByRole("button", { name: "Retester" }));
  await waitFor(() => expect(screen.getAllByText("Vérifié")).toHaveLength(3));
  expect(calls[0]?.url).toEndWith("/api/runtime/inactive-direct/test");
});
test("le remplacement est un POST séparé sur l’id choisi", async () => {
  await api.replaceRuntime("direct-2");
  expect(calls[0]).toEqual({ url: expect.stringContaining("/api/runtime/direct-2/replace"), method: "POST", body: {} });
});

test("renouveler exige la nouvelle paire Access et la transmet ensemble", async () => {
  mount(<RuntimeDirectWizard runtime={runtime} renew onDone={() => { }} onCancel={() => { }} />);
  const save = () => screen.getByRole("button", { name: "Enregistrer les accès" }) as HTMLButtonElement;
  expect(save().disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Client ID Access (facultatif)"), { target: { value: "new-id" } });
  expect(save().disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Client Secret Access (facultatif)"), { target: { value: "new-secret" } });
  fireEvent.click(save());
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]?.body).toEqual({ edgeAuth: { clientId: "new-id", clientSecret: "new-secret" } });
});


test("sans runtime qui sert, l’ajout met le runtime en service sans autre geste", async () => {
  const saved = { ...runtime, name: "Mon gateway", lastHealthStatus: "healthy", lastCheckedAt: null };
  const publishing = exposureFetch("managed_cloudflare");
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/list")) { calls.push({ url, method: init?.method ?? "GET", body: null }); return Response.json({ runtimes: [] }); }
    if (url.endsWith("/replace")) { calls.push({ url, method: "POST", body: null }); return Response.json({ runtime: { ...saved, isActive: true } }); }
    if (url.endsWith("/declare")) { calls.push({ url, method: "POST", body: null }); return Response.json(saved, { status: 201 }); }
    return publishing(input, init);
  }) as typeof fetch;
  mount(<RuntimeReplacement activeId={null} />);
  // L'ajout n'est offert qu'une fois la liste lue (vide ici) : pendant la
  // lecture, l'écran ne sait pas si un remplaçant attend déjà.
  fireEvent.click(await screen.findByRole("button", { name: "Ajouter un runtime" }));
  fireEvent.click(screen.getByRole("radio", { name: /Accès direct/ }));
  await publish(...PATHS[0]!.slice(0, 3) as [string, RegExp, readonly (readonly [string, string])[]]);
  fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "Mon gateway" } });
  fireEvent.change(screen.getByLabelText("Bearer API_SERVER_KEY"), { target: { value: "secret-bearer" } });
  fireEvent.click(screen.getByRole("button", { name: "Tester" }));
  await waitFor(() => expect(add().disabled).toBe(false));
  fireEvent.click(add());
  await screen.findByRole("dialog", { name: "Runtime ajouté" });
  // Le runtime déclaré n'est pas encore en service dans ce bouchon : la boîte
  // propose de le mettre en service, et sans actuel le geste part sans confirmation.
  expect(calls.some(call => call.url.endsWith("/replace"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Remplacer maintenant" }));
  await waitFor(() => expect(calls.some(call => call.url.endsWith("/runtime/inactive-direct/replace"))).toBe(true));
}, 20_000);

test("onboarding propose le même sélecteur avec le mode runtime external", async () => {
  globalThis.fetch = (async (input) => String(input).endsWith("/list")
    ? Response.json({ runtimes: [] })
    : Response.json({ runtime: null, runtimeMode: "external", adminMode: "disabled" })) as typeof fetch;
  mount(<StepRuntime onFinish={async () => { }} onSkip={async () => { }} />);
  expect(await screen.findByRole("radio", { name: "Lien openedbot (recommandé)" })).toBeTruthy();
  expect(screen.getByRole("radio", { name: /Accès direct/ })).toBeTruthy();
  expect(screen.queryAllByText(/Docker|Hermes intégré/)).toHaveLength(0);
});
