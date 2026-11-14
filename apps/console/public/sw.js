// Removal of the legacy PWA service worker (2026-10-27).
// The console is no longer a PWA: this script replaces the old /sw.js for
// browsers that had installed it, clears its caches, unregisters itself, then
// reloads the tabs it controlled so they start again from the network.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: "window" });
    for (const client of clients) client.navigate(client.url);
  })());
});
