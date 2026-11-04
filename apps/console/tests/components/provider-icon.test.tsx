import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { BRAND_MARKS } from "../../src/components/brand-marks";
import { ProviderIcon } from "../../src/components/provider-icon";

afterEach(cleanup);

test("anthropic rend le tracé de marque et l'aria-label Anthropic", () => {
  const { container } = render(<ProviderIcon provider="anthropic" />);
  expect(screen.getByLabelText("Anthropic")).toBeTruthy();
  expect(container.querySelector("svg path")?.getAttribute("d")).toBe(BRAND_MARKS.anthropic.path);
});

test("openai-codex et openai-api partagent le tracé OpenAI avec des labels distincts", () => {
  const { container: codex } = render(<ProviderIcon provider="openai-codex" />);
  const { container: api } = render(<ProviderIcon provider="openai-api" />);
  expect(screen.getByLabelText("OpenAI Codex")).toBeTruthy();
  expect(screen.getByLabelText("OpenAI API")).toBeTruthy();
  expect(codex.querySelector("svg path")?.getAttribute("d")).toBe(BRAND_MARKS.openai.path);
  expect(api.querySelector("svg path")?.getAttribute("d")).toBe(BRAND_MARKS.openai.path);
});

test("un slug inconnu affiche le repli typographique sans svg", () => {
  const { container } = render(<ProviderIcon provider="nebius-token-factory" />);
  expect(container.querySelector("svg")).toBeNull();
  expect(screen.getByText("NT")).toBeTruthy();
});

test("className s'applique sur le span", () => {
  render(<ProviderIcon provider="anthropic" className="mt-2" />);
  expect(screen.getByLabelText("Anthropic").className).toContain("mt-2");
});

test("le repli lit le nom donné par Hermes plutôt que le slug technique", () => {
  render(<ProviderIcon provider="moa" name="Mixture of Agents" />);
  const pill = screen.getByLabelText("Mixture of Agents");
  expect(pill.textContent).toBe("MO");
});

test("les slugs OAuth du runtime gardent la marque de leur fournisseur", () => {
  const { container: xai } = render(<ProviderIcon provider="xai-oauth" />);
  const { container: minimax } = render(<ProviderIcon provider="minimax-oauth" />);
  // SuperGrok / Premium+ : la marque Grok, pas celle de X.
  expect(xai.querySelector("svg path")?.getAttribute("d")).toBe(BRAND_MARKS.grok.path);
  expect(minimax.querySelector("svg path")?.getAttribute("d")).toBe(BRAND_MARKS.minimax.path);
});

test("une pastille décorative se tait pour le lecteur d'écran", () => {
  const { container } = render(<ProviderIcon provider="anthropic" decorative />);
  const pill = container.firstElementChild;
  expect(pill?.getAttribute("aria-hidden")).toBe("true");
  expect(pill?.getAttribute("aria-label")).toBeNull();
});
