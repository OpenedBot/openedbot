import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";

const FOCUS_CLASSES = ["ring-2", "ring-primary", "ring-offset-2"];

/** Lands a palette hit after the destination timeline has mounted. */
export function GlobalSearchFocus() {
  const targetId = useRouterState({
    select: (state) => {
      const value = (state.location.search as Record<string, unknown>).focus;
      return typeof value === "string" ? value : null;
    },
  });

  useEffect(() => {
    if (!targetId) return;
    let cancelled = false;
    let attempts = 0;
    let timer: number | null = null;
    let target: HTMLElement | null = null;
    const find = () => [...document.querySelectorAll<HTMLElement>("[data-thread-find-target]")]
      .find((element) => element.dataset.threadFindTarget === targetId) ?? null;
    const focus = () => {
      if (cancelled) return;
      target = find();
      if (!target) {
        if (attempts++ < 30) timer = window.setTimeout(focus, 100);
        return;
      }
      const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      target.scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" });
      target.focus({ preventScroll: true });
      target.classList.add(...FOCUS_CLASSES);
    };
    focus();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      target?.classList.remove(...FOCUS_CLASSES);
    };
  }, [targetId]);

  return null;
}
