// Service worker de 5M News: hace instalable la web y la abre aunque no haya conexión.
// Red primero (las noticias se actualizan cada hora); si no hay red, la última edición guardada.
const CACHE = "5m-v2";
const BASE = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Sólo GET del propio sitio; nunca la API (suscripciones, confirmaciones, admin)
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/.netlify/")) return;

  const esPagina = req.mode === "navigate";
  const clave = esPagina ? "/" : url.pathname === "/briefing.json" ? "/briefing.json" : req;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (esPagina || url.pathname === "/briefing.json" || url.pathname.startsWith("/icons/"))) {
          const copia = res.clone();
          caches.open(CACHE).then((c) => c.put(clave, copia));
        }
        return res;
      })
      .catch(() => caches.match(clave).then((r) => r || Response.error())),
  );
});

// ---------- Notificaciones (briefing de las 7:00 y Resumen de los Jueves) ----------
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { cuerpo: e.data && e.data.text() }; }
  e.waitUntil(
    self.registration.showNotification(d.titulo || "5M News", {
      body: d.cuerpo || "Las noticias del día, en menos de 5 minutos.",
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      tag: d.tag || "5m",
      renotify: false,
      lang: "es-AR",
      data: { url: d.url || "/?app=1" },
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const destino = new URL((e.notification.data && e.notification.data.url) || "/?app=1", self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((ventanas) => {
      const abierta = ventanas.find((v) => new URL(v.url).origin === self.location.origin);
      if (abierta) return abierta.navigate(destino).then((v) => (v || abierta).focus());
      return self.clients.openWindow(destino);
    }),
  );
});

const claveBytes = (b64) => {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

// El navegador renovó la suscripción: se registra la nueva para no perder las notificaciones
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil((async () => {
    const { publicKey } = await (await fetch("/api/push/clave")).json();
    const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: claveBytes(publicKey) });
    await fetch("/api/push/suscribir", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: sub }) });
  })());
});
