import { expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThemeProvider, useTheme } from "@openedbot/browser-ui-kit/theme";

test("an occluded WebView paints a theme change without a rejected View Transition", () => {
  const visibility = Object.getOwnPropertyDescriptor(
    document,
    "visibilityState",
  );
  const transition = Object.getOwnPropertyDescriptor(
    document,
    "startViewTransition",
  );
  const theme = localStorage.getItem("openedbot:theme");
  let transitions = 0;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: () => {
      transitions++;
      throw new Error("Cannot animate an occluded document");
    },
  });
  localStorage.setItem(
    "openedbot:theme",
    JSON.stringify({ mode: "light", accent: "blue" }),
  );
  function ChangeTheme() {
    const { setMode } = useTheme();
    return <button onClick={() => setMode("dark")}>Dark test theme</button>;
  }
  try {
    render(
      <ThemeProvider>
        <ChangeTheme />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dark test theme" }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(transitions).toBe(0);
  } finally {
    cleanup();
    for (const [key, descriptor] of [
      ["visibilityState", visibility],
      ["startViewTransition", transition],
    ] as const) {
      if (descriptor) Object.defineProperty(document, key, descriptor);
      else Reflect.deleteProperty(document, key);
    }
    if (theme === null) localStorage.removeItem("openedbot:theme");
    else localStorage.setItem("openedbot:theme", theme);
    document.documentElement.classList.remove("dark");
  }
});
