/**
 * The console is no longer a PWA (2026-10-27): no manifest and no
 * service worker. Browsers that had registered the old `/sw.js`
 * keep that registration until something removes it; we remove it here,
 * and `public/sw.js` does the same on the worker side (caches emptied, unregistration).
 */
export function retireLegacyServiceWorker(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  void navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
    .catch(() => undefined);
}
