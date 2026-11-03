import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RuntimePublicDto } from "@openedbot/contracts-api";
import { IconCloud, IconServer, IconServerBolt } from "@tabler/icons-react";
import { TooltipProvider } from "@openedbot/browser-ui-kit";
import { I18nProvider } from "../../../src/lib/i18n";
import { displayedRuntimeHealth } from "../../../src/lib/runtime/runtime-health";
import { useRuntimeHealth, type RuntimeHealthReading } from "../../../src/lib/runtime/use-runtime-health";
import {
  RUNTIME_SETTINGS_PATH,
  RailRuntimeHealth,
  railRuntimeIcon,
  railRuntimeState,
} from "../../../src/components/boardui/rail-runtime-health";

const realFetch = globalThis.fetch;

function runtime(overrides: Partial<RuntimePublicDto> = {}): RuntimePublicDto {
  return {
    id: "6f0a1b2c-3d4e-4f50-9a1b-2c3d4e5f6071",
    configured: true,
    baseUrl: null,
    reachability: "connector",
    transport: "connector",
    link: {
      connected: true,
      lastSeenAt: "2026-10-24T14:02:00.000Z",
      lastReplacedAt: null,
      hijackSuspectedAt: null,
      rotatedAt: null,
      origin: null,
      originRetired: false,
      relinkCommand: null,
    },
    management: { kind: "host", credentialsWritable: true, oauthWritable: true },
    name: "Acme lab",
    isDefault: true,
    isActive: true,
    tokenConfigured: true,
    botCount: 1,
    selectedProvider: "openai",
    selectedModel: "gpt-test",
    reasoningEffort: null,
    detectedVersion: null,
    capabilities: null,
    lastHealthStatus: "healthy",
    lastHealthError: null,
    lastCheckedAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function reading(dto: RuntimePublicDto | null | undefined, pending = false): RuntimeHealthReading {
  return { runtime: dto, error: null, status: displayedRuntimeHealth(dto), pending };
}

function renderRail(value: RuntimeHealthReading, onOpenSettings: (to: string) => void = () => {}) {
  return render(
    <I18nProvider>
      <TooltipProvider delayDuration={0}>
        <RailRuntimeHealth reading={value} buttonClassName="rail" onOpenSettings={onOpenSettings} />
      </TooltipProvider>
    </I18nProvider>,
  );
}

const button = () => screen.getByRole("button");

beforeEach(() => {
  window.localStorage.setItem("ohb:locale", "en");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  globalThis.fetch = realFetch;
});

describe("rail runtime health", () => {
  test("connected: the tooltip names the runtime and says connected", async () => {
    renderRail(reading(runtime()));
    expect(button().getAttribute("data-rail-runtime-health")).toBe("connected");
    expect(button().getAttribute("aria-label")).toBe("Runtime “Acme lab”: connected");
    fireEvent.pointerMove(button());
    expect((await screen.findByRole("tooltip")).textContent).toContain("Runtime “Acme lab”: connected");
  });

  test("KO: link closed, says since when and what to do", async () => {
    const down = runtime({ link: { ...runtime().link!, connected: false } });
    renderRail(reading(down));
    expect(button().getAttribute("data-rail-runtime-health")).toBe("ko");
    const label = button().getAttribute("aria-label") ?? "";
    expect(label).toContain("Runtime “Acme lab”: KO, connector link closed");
    expect(label).toContain("Last seen:");
    expect(label).toContain("Open the runtime settings to restore it.");
    fireEvent.pointerMove(button());
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toContain("KO, connector link closed");
    expect(tip.textContent).toContain("Last seen:");
  });

  test("KO without a known last sign of life does not invent one", () => {
    renderRail(reading(runtime({ reachability: "direct", transport: "direct", link: null, lastHealthStatus: "unreachable" })));
    const label = button().getAttribute("aria-label") ?? "";
    expect(label).toContain("KO, runtime unreachable");
    expect(label).not.toContain("Last seen");
  });

  test("no runtime configured: neutral, says so", () => {
    renderRail(reading(null));
    expect(button().getAttribute("data-rail-runtime-health")).toBe("none");
    expect(button().getAttribute("aria-label")).toBe(
      "No runtime configured. Open the runtime settings to connect one.",
    );
  });

  test("loading: neutral, never KO", () => {
    renderRail(reading(undefined, true));
    expect(button().getAttribute("data-rail-runtime-health")).toBe("pending");
    expect(button().getAttribute("aria-label")).toBe("Checking the runtime…");
    expect(railRuntimeState({ status: "unreachable", pending: true })).toBe("pending");
  });

  test("reachable but no provider: KO in words, amber state", () => {
    renderRail(reading(runtime({ lastHealthStatus: "no_provider" })));
    expect(button().getAttribute("data-rail-runtime-health")).toBe("degraded");
    expect(button().getAttribute("aria-label")).toContain("KO, no provider");
  });

  test("French copy reads « connecté » and « KO »", () => {
    window.localStorage.setItem("ohb:locale", "fr");
    renderRail(reading(runtime()));
    expect(button().getAttribute("aria-label")).toContain("connecté");
    cleanup();
    renderRail(reading(runtime({ link: { ...runtime().link!, connected: false } })));
    expect(button().getAttribute("aria-label")).toContain("KO, lien connecteur fermé");
  });

  test("a click opens the runtime settings", () => {
    const opened: string[] = [];
    renderRail(reading(runtime()), (to) => opened.push(to));
    fireEvent.click(button());
    expect(opened).toEqual([RUNTIME_SETTINGS_PATH]);
    expect(RUNTIME_SETTINGS_PATH).toBe("/settings/runtime");
  });
});

describe("rail runtime icon", () => {
  const icon = () => button().querySelector("[data-rail-runtime-icon]")?.getAttribute("data-rail-runtime-icon");
  const badge = () => button().querySelector("[data-rail-runtime-badge]");
  const embedded = { kind: "hermes_dashboard", credentialsWritable: true, oauthWritable: true } as const;

  test("maps the runtime kind to the icon the console already uses", () => {
    expect(railRuntimeIcon(runtime())).toBe(IconServer);
    expect(railRuntimeIcon(runtime({ reachability: "direct", transport: "direct", link: null }))).toBe(IconServer);
    expect(railRuntimeIcon(runtime({ management: embedded }))).toBe(IconCloud);
    expect(railRuntimeIcon(null)).toBe(IconServerBolt);
    expect(railRuntimeIcon(runtime({ configured: false }))).toBe(IconServerBolt);
  });

  test("renders the icon of the runtime with the health badge on its corner", () => {
    renderRail(reading(runtime()));
    expect(icon()).toBe("server");
    expect(badge()?.getAttribute("data-rail-runtime-badge")).toBe("connected");
    expect(badge()?.innerHTML).toContain("bg-pos-700");
    expect(badge()?.innerHTML).not.toContain("animate-ping");
  });

  test("KO badge is red and pulses, with reduced motion honoured", () => {
    renderRail(reading(runtime({ link: { ...runtime().link!, connected: false } })));
    expect(badge()?.innerHTML).toContain("bg-destructive");
    expect(badge()?.innerHTML).toContain("animate-ping");
    expect(badge()?.innerHTML).toContain("motion-reduce:animate-none");
  });

  test("degraded is amber, untested and pending are grey", () => {
    renderRail(reading(runtime({ lastHealthStatus: "no_provider" })));
    expect(badge()?.innerHTML).toContain("bg-warn-700");
    cleanup();
    renderRail(reading(runtime({ reachability: "direct", transport: "direct", link: null, lastHealthStatus: "unknown" })));
    expect(badge()?.innerHTML).toContain("bg-muted-foreground/60");
    cleanup();
    renderRail(reading(undefined, true));
    expect(badge()?.innerHTML).toContain("bg-muted-foreground/30");
  });

  test("loading keeps the neutral icon, the embedded runtime shows the cloud", () => {
    renderRail(reading(undefined, true));
    expect(icon()).toBe("server-bolt");
    cleanup();
    renderRail(reading(runtime({ management: embedded })));
    expect(icon()).toBe("cloud");
  });
});

describe("useRuntimeHealth", () => {
  function Probe({ id }: { id: string }) {
    const health = useRuntimeHealth();
    return <span data-testid={id}>{health.pending ? "pending" : health.status}</span>;
  }

  test("two surfaces share one GET /api/runtime read", async () => {
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/runtime")) calls += 1;
      return Response.json({ runtime: runtime(), runtimeMode: "connector" });
    }) as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Probe id="rail" />
        <Probe id="badge" />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("rail").textContent).toBe("pending");
    await waitFor(() => expect(screen.getByTestId("rail").textContent).toBe("healthy"));
    expect(screen.getByTestId("badge").textContent).toBe("healthy");
    expect(calls).toBe(1);
    client.clear();
  });
});
