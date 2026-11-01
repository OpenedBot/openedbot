/**
 * La console n'est plus une PWA (2026-10-27) : plus de manifeste ni de
 * service worker. Les navigateurs qui avaient inscrit l'ancien `/sw.js`
 * gardent cette inscription tant que rien ne la retire ; on la retire ici,
 * et `public/sw.js` fait de même côté worker (caches vidés, désinscription).
 */
export function retireLegacyServiceWorker(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  void navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
    .catch(() => undefined);
}
