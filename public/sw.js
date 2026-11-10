// public/sw.js : service worker de Coach
// 1) Pages toujours chargées depuis le réseau (fin des soucis de cache iOS),
//    avec une copie de secours si pas de réseau.
// 2) Réception et affichage des notifications push.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.mode !== "navigate") return; // seules les pages passent par ici, l'API n'est pas touchée
  e.respondWith(
    fetch(req, { cache: "no-store" })
      .then((res) => {
        const copy = res.clone();
        caches.open("coach-pages").then((c) => c.put("/", copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match("/"))
  );
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(
    self.registration.showNotification(d.title || "Coach", {
      body: d.body || "",
      tag: d.tag || undefined,
      data: { url: d.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          c.postMessage({ type: "open", url });
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
