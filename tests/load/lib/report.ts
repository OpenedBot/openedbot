/** The bench report: gates first, then 7-bit ASCII tables for a terminal. */
import type { Summary } from "./stats";

export type Gate = { name: string; pass: boolean; detail: string };

export function table(headers: string[], rows: Array<Array<string | number>>): string {
  const cells = [headers, ...rows.map((row) => row.map(String))];
  const widths = headers.map((_, column) => Math.max(...cells.map((row) => (row[column] ?? "").length)));
  const line = `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
  const render = (row: string[]) => `|${row.map((cell, column) => ` ${cell.padEnd(widths[column]!)} `).join("|")}|`;
  return [line, render(cells[0]!), line, ...cells.slice(1).map(render), line].join("\n");
}

export function ms(summary: Summary): string {
  return summary.count === 0 ? "n/a" : `${summary.p50} / ${summary.p95} / ${summary.max}`;
}

export function gateLines(gates: Gate[]): string {
  return table(["Gate", "Verdict", "Detail"], gates.map((gate) => [gate.name, gate.pass ? "PASS" : "FAIL", gate.detail]));
}
