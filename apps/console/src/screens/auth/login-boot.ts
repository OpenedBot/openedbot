/**
 * The mascot of `/login` while the JS loads (`#openedbot-boot-login`,
 * `index.html`): the login screen takes it over and flies it into its logo,
 * then removes it. `main.tsx` drops it when the router lands anywhere else, so
 * it never stays over another screen.
 */

export const LOGIN_BOOT_ID = "openedbot-boot-login";
const LOGIN_BOOT_ATTR = "data-openedbot-boot-login";

/** The flight to the logo, and the breath settling at the same time. */
const FLIGHT_MS = 560;
const SETTLE_MS = 220;

let pendingDrop: number | undefined;

/** Set on the mascot while it flies: the login screen owns it from then on. */
const TAKEN_ATTR = "data-taken";

function bootElement(): HTMLElement | null {
  if (!document.documentElement.hasAttribute(LOGIN_BOOT_ATTR)) return null;
  const boot = document.getElementById(LOGIN_BOOT_ID);
  return boot && !boot.hasAttribute(TAKEN_ATTR) ? boot : null;
}

/** True while the boot mascot is on screen, waiting for the login screen (not once it flies). */
export function hasLoginBoot(): boolean {
  return bootElement() !== null;
}

export function dropLoginBoot(): void {
  window.clearTimeout(pendingDrop);
  pendingDrop = undefined;
  document.getElementById(LOGIN_BOOT_ID)?.remove();
  document.documentElement.removeAttribute(LOGIN_BOOT_ATTR);
}

/**
 * Flies the boot mascot onto `target` (the logo's mark), calls `onLanded`
 * (which must paint the logo's own mark synchronously) and only then removes
 * the mascot. Returns the cleanup: it cancels the flight and drops the mascot
 * on the next task, unless a new flight starts first (React's StrictMode
 * runs an effect, its cleanup, then the effect again). Returns `null` when
 * there is no flight (no mascot, nothing to aim at, reduced motion): the
 * mascot is gone and the caller shows its mark itself.
 */
export function flyLoginBoot(target: HTMLElement, onLanded: () => void): (() => void) | null {
  window.clearTimeout(pendingDrop);
  pendingDrop = undefined;
  const boot = bootElement();
  const mascot = boot?.querySelector<HTMLElement>(".mascot");
  const image = mascot?.querySelector<HTMLElement>("img");
  const from = mascot?.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!boot || !mascot || !image || !from || from.width === 0 || to.width === 0 || reduced) {
    dropLoginBoot();
    return null;
  }

  boot.setAttribute(TAKEN_ATTR, "");
  // The breath stops where it is and eases back to rest during the flight.
  const breath = getComputedStyle(image);
  const settle = image.animate(
    [{ transform: breath.transform === "none" ? "scale(1)" : breath.transform, opacity: breath.opacity }, { transform: "scale(1)", opacity: 1 }],
    { duration: SETTLE_MS, easing: "ease-out", fill: "forwards" },
  );

  // The logo is aimed at every frame, not measured once: the card grows when
  // the sign-in providers answer and, centred, moves its logo up meanwhile.
  const start = performance.now();
  let frame = 0;
  let landed = false;
  const land = () => {
    if (landed) return;
    landed = true;
    window.cancelAnimationFrame(frame);
    window.clearTimeout(deadline);
    onLanded();
    dropLoginBoot();
  };
  const step = (now: number) => {
    const progress = Math.min(1, (now - start) / FLIGHT_MS);
    const eased = easeOut(progress);
    const to = target.getBoundingClientRect();
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const scale = 1 + (to.width / from.width - 1) * eased;
    mascot.style.transform = `translate(${dx * eased}px, ${dy * eased}px) scale(${scale})`;
    if (progress < 1) frame = window.requestAnimationFrame(step);
    else land();
  };
  frame = window.requestAnimationFrame(step);
  // No frame in a hidden window: land on time anyway.
  const deadline = window.setTimeout(land, FLIGHT_MS + 400);

  return () => {
    if (landed) return;
    window.cancelAnimationFrame(frame);
    window.clearTimeout(deadline);
    settle.cancel();
    mascot.style.transform = "";
    boot.removeAttribute(TAKEN_ATTR);
    pendingDrop = window.setTimeout(dropLoginBoot, 0);
  };
}

/** Quick start, long soft landing (close to cubic-bezier(0.22, 1, 0.36, 1)). */
function easeOut(progress: number): number {
  return 1 - (1 - progress) ** 4;
}

/**
 * Dev only (`DevReplayEntrance`): puts the boot mascot back as `index.html`
 * draws it, so « Rejouer l'entrée » replays the whole launch.
 */
export function devRestoreLoginBoot(): void {
  if (import.meta.env.DEV !== true) return;
  dropLoginBoot();
  const boot = document.createElement("div");
  boot.id = LOGIN_BOOT_ID;
  boot.setAttribute("role", "status");
  boot.setAttribute("aria-busy", "true");
  boot.setAttribute("aria-label", "Chargement");
  boot.innerHTML = '<div class="mascot"><img src="/brand/openedbot-icon.webp" alt="" width="64" height="64"></div>';
  document.body.insertBefore(boot, document.getElementById("root"));
  document.documentElement.setAttribute(LOGIN_BOOT_ATTR, "");
}
