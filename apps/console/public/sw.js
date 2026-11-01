// Retrait du service worker de l'ancienne PWA (2026-10-27).
// La console n'est plus une PWA : ce script remplace l'ancien /sw.js chez les
// navigateurs qui l'avaient installé, vide ses caches, se désinscrit puis
// recharge les onglets qu'il contrôlait pour qu'ils repartent du réseau.
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
