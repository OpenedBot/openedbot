import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { RuntimeModelDto, RuntimeModelProviderDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../../../src/lib/i18n";
import { BotModelField } from "../../../../src/screens/settings/installation/models/models-bot-model-field";

/**
 * The « Un par bot » model field opens the composer's catalogue: the
 * provider rail, the chosen provider's models, the default model first.
 */

const model = (id: string): RuntimeModelDto => ({ id, fast: false, reasoning: true, isRuntimeDefault: false, freeTier: null });

const provider = (slug: string, name: string, models: string[]): RuntimeModelProviderDto => ({
  slug,
  name,
  isCurrent: false,
  authenticated: true,
  models: models.map(model),
} as RuntimeModelProviderDto);

const providers = [
  provider("anthropic", "Anthropic", ["claude-sonnet-5-5"]),
  provider("xai-oauth", "xAI Grok OAuth", ["grok-4.7", "grok-4.6"]),
];

function renderField(value: string | null) {
  const onValueChange = mock((_value: string | null) => {});
  render(
    <I18nProvider>
      <BotModelField
        id="bot-model-1"
        ariaLabel="Modèle de Atlas"
        providers={providers}
        value={value}
        globalModel="claude-sonnet-5-5"
        disabled={false}
        onValueChange={onValueChange}
      />
    </I18nProvider>,
  );
  return { onValueChange, trigger: screen.getByRole("button", { name: "Modèle de Atlas" }) };
}

afterEach(cleanup);

describe("BotModelField", () => {
  test("names the default model the bot follows", () => {
    const { trigger } = renderField(null);
    expect(trigger.textContent).toContain("claude-sonnet-5-5");
  });

  test("opens on the chosen model's provider and picks another model", () => {
    const { onValueChange, trigger } = renderField("grok-4.7");
    fireEvent.click(trigger);
    const list = screen.getByRole("radiogroup");
    expect(within(list).getByRole("radio", { name: "grok-4.7" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(list).getByRole("radio", { name: "grok-4.6" }));
    expect(onValueChange).toHaveBeenCalledWith("grok-4.6");
  });

  test("going back to the default model sends null; the chosen model again sends nothing", () => {
    const { onValueChange, trigger } = renderField("grok-4.7");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("radio", { name: "grok-4.7" }));
    expect(onValueChange).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("radio", { name: /claude-sonnet-5-5/ }));
    expect(onValueChange).toHaveBeenCalledWith(null);
  });
});
