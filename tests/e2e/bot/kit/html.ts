/**
 * Renders a RunReport to one HTML page styled with Tailwind (compiled inline
 * by tailwind.ts). Every value is escaped: error messages and API bodies are
 * untrusted text. Status is always a label plus a colour, never colour alone.
 */
import type { Detail, RunReport, ScenarioResult, StepStatus, Bench } from "./report";
import type { PurgeOutcome } from "./bots";
import { tailwindCss } from "./tailwind";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return "n/a";
  if (Math.abs(value) < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1, minimumFractionDigits: 1 })} s`;
}

const STATUS: Record<StepStatus, { label: string; badge: string; dot: string }> = {
  pass: { label: "OK", badge: "bg-emerald-50 text-emerald-800 ring-emerald-600/20", dot: "bg-emerald-500" },
  fail: { label: "Échec", badge: "bg-rose-50 text-rose-800 ring-rose-600/20", dot: "bg-rose-500" },
  warn: { label: "Réserve", badge: "bg-amber-50 text-amber-800 ring-amber-600/20", dot: "bg-amber-500" },
  skip: { label: "Non joué", badge: "bg-slate-100 text-slate-600 ring-slate-500/20", dot: "bg-slate-400" },
};

/** One hue, light to dark, in timeline order (validated as an ordinal ramp). */
const TIMELINE_DOTS = ["bg-sky-500", "bg-sky-600", "bg-sky-700", "bg-sky-900"];

const badge = (status: StepStatus) =>
  `<span class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS[status].badge}"><span class="size-1.5 rounded-full ${STATUS[status].dot}"></span>${STATUS[status].label}</span>`;

const isMsKey = (key: string) => key.endsWith("Ms");
const cell = (key: string, value: unknown) =>
  typeof value === "number" && isMsKey(key) ? formatMs(value) : escapeHtml(value === null || value === undefined ? "n/a" : value);

function details(detail: Detail): string {
  const entries = Object.entries(detail);
  if (!entries.length) return "";
  return `<div class="mt-1 flex flex-wrap gap-1">${entries
    .map(([key, value]) => `<span class="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600"><span class="text-slate-500">${escapeHtml(key)}</span> ${cell(key, value)}</span>`)
    .join("")}</div>`;
}

function stepsTable(scenario: ScenarioResult): string {
  const rows = scenario.steps.map((step) => `
    <tr class="align-top">
      <td class="py-2 pr-3">${badge(step.status)}</td>
      <td class="py-2 pr-3">
        <div class="font-medium text-slate-900">${escapeHtml(step.name)}</div>
        ${step.note ? `<p class="mt-0.5 text-sm ${step.status === "fail" ? "text-rose-700" : "text-slate-600"}">${escapeHtml(step.note)}</p>` : ""}
        ${details(step.detail)}
      </td>
      <td class="py-2 text-right text-sm tabular-nums text-slate-500">${formatMs(step.ms)}</td>
    </tr>`).join("");
  return `<table class="w-full text-left text-sm">
    <thead><tr class="border-b border-slate-200 text-xs text-slate-500"><th class="py-2 pr-3 font-medium">Statut</th><th class="py-2 pr-3 font-medium">Étape</th><th class="py-2 text-right font-medium">Durée</th></tr></thead>
    <tbody class="divide-y divide-slate-100">${rows}</tbody>
  </table>`;
}

function timeline(bench: Bench): string {
  if (!bench.timeline) return "";
  const keys = bench.timeline.keys;
  const last = keys[keys.length - 1]!.key;
  const max = Math.max(1, ...bench.rows.map((row) => (typeof row[last] === "number" ? (row[last] as number) : 0)));
  const legend = keys.map((entry, index) =>
    `<span class="inline-flex items-center gap-1.5"><span class="size-2.5 rounded-full ${TIMELINE_DOTS[index] ?? "bg-sky-900"}"></span>${escapeHtml(entry.label)}</span>`).join("");
  const rows = bench.rows.map((row, rowIndex) => {
    const end = typeof row[last] === "number" ? (row[last] as number) : null;
    const dots = keys.map((entry, index) => {
      const value = row[entry.key];
      if (typeof value !== "number") return "";
      return `<span title="${escapeHtml(`${entry.label} : ${formatMs(value)}`)}" class="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white ${TIMELINE_DOTS[index] ?? "bg-sky-900"}" style="left:${((value / max) * 100).toFixed(2)}%"></span>`;
    }).join("");
    return `<div class="grid grid-cols-[3rem_1fr_4.5rem] items-center gap-3">
      <span class="text-xs tabular-nums text-slate-500">#${rowIndex + 1}</span>
      <div class="relative h-4"><div class="absolute inset-y-[7px] left-0 rounded-full bg-slate-200" style="width:${end === null ? 100 : ((end / max) * 100).toFixed(2)}%"></div>${dots}</div>
      <span class="text-right text-xs tabular-nums text-slate-700">${formatMs(end)}</span>
    </div>`;
  }).join("");
  return `<figure class="mt-5">
    <figcaption class="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
      <span class="font-medium text-slate-900">Chronologie par échantillon (0 à ${formatMs(max)})</span>
      <span class="flex flex-wrap gap-3">${legend}</span>
    </figcaption>
    <div class="mt-3 space-y-1.5">${rows}</div>
  </figure>`;
}

function benchBlock(bench: Bench): string {
  const stats = bench.stats.map((stat) => `
    <tr><td class="py-1.5 pr-3 text-slate-700">${escapeHtml(stat.label)}</td>
      <td class="py-1.5 pr-3 text-right tabular-nums font-medium text-slate-900">${formatMs(stat.p50)}</td>
      <td class="py-1.5 pr-3 text-right tabular-nums text-slate-700">${formatMs(stat.p95)}</td>
      <td class="py-1.5 pr-3 text-right tabular-nums text-slate-700">${formatMs(stat.max)}</td>
      <td class="py-1.5 text-right tabular-nums text-slate-500">${stat.n}${stat.missing ? ` (${stat.missing} manquant${stat.missing > 1 ? "s" : ""})` : ""}</td></tr>`).join("");
  const head = bench.columns.map((column) => `<th class="px-2 py-2 font-medium ${column.key === "sample" || column.key === "message" ? "" : "text-right"}">${escapeHtml(column.label)}</th>`).join("");
  const body = bench.rows.map((row) => `<tr>${bench.columns.map((column) =>
    `<td class="px-2 py-1.5 tabular-nums ${typeof row[column.key] === "number" && column.key !== "sample" && column.key !== "message" ? "text-right" : ""}">${cell(column.key, row[column.key])}</td>`).join("")}</tr>`).join("");
  return `<div class="mt-6 border-t border-slate-200 pt-5">
    <h3 class="text-sm font-semibold text-slate-900">Mesures</h3>
    <table class="mt-2 w-full max-w-2xl text-left text-sm">
      <thead><tr class="border-b border-slate-200 text-xs text-slate-500"><th class="py-1.5 pr-3 font-medium">Repère</th><th class="py-1.5 pr-3 text-right font-medium">Médiane</th><th class="py-1.5 pr-3 text-right font-medium">p95</th><th class="py-1.5 pr-3 text-right font-medium">Max</th><th class="py-1.5 text-right font-medium">n</th></tr></thead>
      <tbody class="divide-y divide-slate-100">${stats}</tbody>
    </table>
    ${timeline(bench)}
    <details class="mt-5">
      <summary class="cursor-pointer text-sm font-medium text-slate-700">Tous les échantillons (${bench.rows.length})</summary>
      <div class="mt-2 overflow-x-auto"><table class="w-full text-left text-xs">
        <thead><tr class="border-b border-slate-200 text-slate-500">${head}</tr></thead>
        <tbody class="divide-y divide-slate-100 text-slate-700">${body}</tbody>
      </table></div>
    </details>
  </div>`;
}

function scenarioSection(scenario: ScenarioResult): string {
  return `<section id="${escapeHtml(scenario.id)}" class="rounded-lg bg-white p-6 shadow-sm ring-1 ring-slate-200">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold text-slate-900">${escapeHtml(scenario.title)}</h2>
        <p class="mt-1 max-w-3xl text-sm text-slate-600">${escapeHtml(scenario.summary)}</p>
      </div>
      <div class="flex items-center gap-3 text-sm tabular-nums text-slate-500">${formatMs(scenario.ms)} ${badge(scenario.status)}</div>
    </div>
    ${scenario.error ? `<p class="mt-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">${escapeHtml(scenario.error)}</p>` : ""}
    <div class="mt-4">${stepsTable(scenario)}</div>
    ${scenario.bench ? benchBlock(scenario.bench) : ""}
  </section>`;
}

function cleanupSection(cleanup: PurgeOutcome[]): string {
  if (!cleanup.length) return "";
  const rows = cleanup.map((entry) => `<tr>
    <td class="py-1.5 pr-3">${badge(entry.cleanup === "succeeded" || entry.cleanup === "none" ? "pass" : "fail")}</td>
    <td class="py-1.5 pr-3 text-slate-900">${escapeHtml(entry.name)}</td>
    <td class="py-1.5 pr-3 text-slate-600">${escapeHtml(entry.cleanup)}</td>
    <td class="py-1.5 pr-3 text-right tabular-nums text-slate-600">${escapeHtml(entry.verifyPasses ?? "n/a")}</td>
    <td class="py-1.5 pr-3 text-right tabular-nums text-slate-600">${formatMs(entry.deleteMs)}</td>
    <td class="py-1.5 text-right tabular-nums text-slate-600">${formatMs(entry.durationMs)}</td></tr>`).join("");
  return `<section class="rounded-lg bg-white p-6 shadow-sm ring-1 ring-slate-200">
    <h2 class="text-lg font-semibold text-slate-900">Nettoyage du runtime</h2>
    <p class="mt-1 text-sm text-slate-600">Chaque bot créé est purgé. Le nettoyage hôte ne compte qu'une fois réussi : il a relu le runtime et n'y trouve plus ni les sessions du bot ni son profil.</p>
    <table class="mt-4 w-full text-left text-sm">
      <thead><tr class="border-b border-slate-200 text-xs text-slate-500"><th class="py-1.5 pr-3 font-medium">Statut</th><th class="py-1.5 pr-3 font-medium">Bot</th><th class="py-1.5 pr-3 font-medium">Nettoyage</th><th class="py-1.5 pr-3 text-right font-medium">Revérifications</th><th class="py-1.5 pr-3 text-right font-medium">DELETE</th><th class="py-1.5 text-right font-medium">Jusqu'au nettoyage</th></tr></thead>
      <tbody class="divide-y divide-slate-100">${rows}</tbody>
    </table>
  </section>`;
}

export function renderBody(report: RunReport): string {
  const started = new Date(report.startedAt);
  const duration = report.finishedAt ? Date.parse(report.finishedAt) - started.getTime() : null;
  const meta: Array<[string, string]> = [
    ["Étiquette", report.label],
    ["Démarré", started.toLocaleString("fr-FR")],
    ["Durée", formatMs(duration)],
    ["Runtime", report.runtime?.name ?? "n/a"],
    ["Modèle", report.model ? `${report.model.provider} / ${report.model.model}${report.model.reasoningEffort ? ` (${report.model.reasoningEffort})` : ""}` : "n/a"],
    ["API", report.apiUrl],
    ["Commit", report.gitSha ?? "n/a"],
    ["Options", Object.entries(report.options).map(([key, value]) => `${key}=${value}`).join(" ")],
  ];
  const nav = report.scenarios.map((scenario) =>
    `<a href="#${escapeHtml(scenario.id)}" class="inline-flex items-center gap-2 rounded-md bg-white px-3 py-1.5 text-sm text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"><span class="size-2 rounded-full ${STATUS[scenario.status].dot}"></span>${escapeHtml(scenario.title)}</a>`).join("");
  return `<main class="mx-auto max-w-6xl space-y-6 px-6 py-10">
    <header class="space-y-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h1 class="text-2xl font-semibold tracking-tight text-slate-900">Rapport e2e des bots</h1>
        <span class="text-base">${badge(report.status)}</span>
      </div>
      ${report.error ? `<p class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">${escapeHtml(report.error)}</p>` : ""}
      <dl class="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
        ${meta.map(([key, value]) => `<div><dt class="text-xs text-slate-500">${escapeHtml(key)}</dt><dd class="truncate text-slate-900" title="${escapeHtml(value)}">${escapeHtml(value)}</dd></div>`).join("")}
      </dl>
      <nav class="flex flex-wrap gap-2">${nav}</nav>
    </header>
    ${report.scenarios.map(scenarioSection).join("")}
    ${cleanupSection(report.cleanup)}
    <footer class="pt-2 text-xs text-slate-500">Produit par tests/e2e/bot/run.ts. Aucun contenu de réponse n'est vérifié : seulement qu'une réponse non vide existe.</footer>
  </main>`;
}

export async function renderReport(report: RunReport): Promise<string> {
  const body = renderBody(report);
  const page = `<body class="bg-slate-50 font-sans text-slate-900 antialiased">${body}</body>`;
  const css = await tailwindCss(page);
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`e2e bots ${report.label} : ${STATUS[report.status].label}`)}</title>
<style>${css}</style>
</head>
${page}
</html>
`;
}
