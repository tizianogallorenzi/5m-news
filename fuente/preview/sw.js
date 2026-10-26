// Service worker de 5M News: hace instalable la web, la abre al instante y funciona sin conexión.
// - Página: se muestra la última versión guardada al toque y se actualiza por detrás (así no se ve la
//   pantalla de "despertando" del plan gratuito de Render).
// - briefing.json: red con 2,5 s de espera; si tarda, la última edición guardada, y cuando llega la nueva
//   se avisa a la página para que ofrezca actualizar.
const CACHE = "5m-v3";
const BASE = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASE)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

/** Sólo se guarda la página real de 5M News (no la pantalla de espera de Render ni errores). */
async function esPaginaPropia(res) {
  if (!res || !res.ok || !(res.headers.get("content-type") || "").includes("text/html")) return false;
  return (await res.clone().text()).includes('id="hero"');
}
const esBriefing = (res) => res && res.ok && (res.headers.get("content-type") || "").includes("application/json");

async function guardar(clave, res) {
  const c = await caches.open(CACHE);
  await c.put(clave, res);
}

async function avisarClientes(tipo) {
  for (const cl of await self.clients.matchAll({ type: "window" })) cl.postMessage({ tipo });
}

async function pagina(req) {
  const guardada = await caches.match("/");
  const red = fetch(req)
    .then(async (res) => {
      if (await esPaginaPropia(res)) await guardar("/", res.clone());
      return res;
    })
    .catch(() => null);
  if (guardada) return guardada; // al instante; la red actualiza la copia para la próxima vez
  return (await red) || Response.error();
}

async function briefing(req) {
  const guardado = await caches.match("/briefing.json");
  const red = fetch(req)
    .then(async (res) => {
      if (esBriefing(res)) {
        await guardar("/briefing.json", res.clone());
        return res;
      }
      return null;
    })
    .catch(() => null);
  if (!guardado) return (await red) || Response.error();
  const rapida = await Promise.race([red, new Promise((ok) => setTimeout(() => ok("tarde"), 2500))]);
  if (rapida && rapida !== "tarde") return rapida;
  // La red tardó (servidor despertando): edición guardada ahora y aviso cuando llegue la nueva
  red.then((res) => res && avisarClientes("briefing-nuevo"));
  return guardado;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Sólo GET del propio sitio; nunca la API (suscripciones, confirmaciones, admin)
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/.netlify/")) return;

  if (req.mode === "navigate") return e.respondWith(pagina(req));
  if (url.pathname === "/briefing.json") return e.respondWith(briefing(req));
  if (url.pathname.startsWith("/icons/")) {
    return e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => (res.ok && guardar(req, res.clone()), res))));
  }
  e.respondWith(fetch(req).catch(() => caches.match(req).then((r) => r || Response.error())));
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
