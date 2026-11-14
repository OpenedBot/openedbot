import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { I18nProvider } from "../../../src/lib/i18n";
import { TITLEBAR_ANCHOR_ATTRIBUTE } from "../../../src/lib/platform/native-titlebar";
import { StepShell } from "../../../src/screens/onboarding/components/step-shell";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute(TITLEBAR_ANCHOR_ATTRIBUTE);
});

test("onboarding puts the macOS traffic lights back on its own title bar row", () => {
  // Left by the app's rail frame: the lights in its card's head row.
  document.documentElement.setAttribute(TITLEBAR_ANCHOR_ATTRIBUTE, "card");
  render(
    <I18nProvider>
      <StepShell currentStep="workspace">
        <p>étape</p>
      </StepShell>
    </I18nProvider>,
  );
  expect(document.documentElement.getAttribute(TITLEBAR_ANCHOR_ATTRIBUTE)).toBe("bar");
});
