// Servidor para Render.com: corre las MISMAS funciones de netlify/functions sin cambiarlas.
// - Emula el entorno de Netlify (Netlify.env, Context) y conecta Netlify Blobs por su API con
//   NETLIFY_SITE_ID + NETLIFY_BLOBS_TOKEN: los datos siguen en el mismo almacenamiento de Netlify.
// - Sirve public/ con los mismos encabezados que netlify.toml.
// - Las funciones programadas (cron de Netlify) se disparan desde afuera con /api/cron/<nombre>
//   (GitHub Actions o cron-job.org), protegidas con CRON_SECRET.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { getStore, netlifyBlobsReal, usaSupabase } from "./blobs-supabase.mts";

// ---------- Entorno de Netlify ----------
(globalThis as any).Netlify = { env: { get: (k: string) => process.env[k], has: (k: string) => k in process.env } };
const URL_PUBLICA = (process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, "");
process.env.URL ||= URL_PUBLICA; // lo usa la actualización horaria para llamar a la función de fondo
if (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN && !process.env.NETLIFY_BLOBS_CONTEXT) {
  process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(
    JSON.stringify({ siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_BLOBS_TOKEN }),
  ).toString("base64");
}
if (usaSupabase()) console.log("[render] Datos en Supabase (tabla public.blobs).");
else if (!process.env.NETLIFY_BLOBS_CONTEXT) console.error("[render] Falta configurar el almacenamiento: SUPABASE_URL + SUPABASE_SECRET_KEY.");

/** Todos los almacenes que usa el código (los mismos nombres que en Netlify Blobs). */
const ALMACENES = [
  "newsletter-subscribers", "newsletter-send-log", "briefing", "briefing-work",
  "fotos-prensa", "imagenes-commons", "push-subscribers", "push-config",
];

/** Copia única de Netlify Blobs → Supabase. No borra nada en Netlify; si una clave ya existe en Supabase, la pisa. */
async function migrarDesdeNetlify() {
  const siteID = process.env.NETLIFY_SITE_ID, token = process.env.NETLIFY_BLOBS_TOKEN;
  if (!usaSupabase()) throw new Error("Configurá SUPABASE_URL y SUPABASE_SECRET_KEY antes de migrar.");
  if (!siteID || !token) throw new Error("Para migrar hacen falta NETLIFY_SITE_ID y NETLIFY_BLOBS_TOKEN.");
  const { getStore: getStoreNetlify } = await netlifyBlobsReal();
  const resumen: Record<string, number | string> = {};
  for (const nombre of ALMACENES) {
    try {
      const origen = getStoreNetlify({ name: nombre, siteID, token });
      const destino = getStore(nombre);
      const { blobs } = await Promise.race([
        origen.list() as Promise<{ blobs: { key: string }[] }>,
        new Promise<never>((_, no) => setTimeout(() => no(new Error("Netlify no respondió en 60 s")), 60_000)),
      ]);
      let copiadas = 0;
      for (const { key } of blobs) {
        const valor = await origen.get(key, { type: "text" });
        if (valor != null) {
          await destino.set(key, valor);
          copiadas++;
        }
      }
      resumen[nombre] = copiadas;
    } catch (e) {
      resumen[nombre] = `error: ${(e as Error).message.slice(0, 160)}`;
    }
  }
  return resumen;
}

// ---------- Funciones (las mismas de Netlify) ----------
type Handler = (req: Request, context: any) => Promise<Response | void> | Response | void;
type Mod = { default: Handler; config?: { path?: string | string[]; method?: string | string[]; schedule?: string } };
const FUNCIONES: Record<string, Mod> = {
  briefing: await import("../netlify/functions/briefing.mts"),
  confirm: await import("../netlify/functions/confirm.mts"),
  "newsletter-admin": await import("../netlify/functions/newsletter-admin.mts"),
  push: await import("../netlify/functions/push.mts"),
  subscribe: await import("../netlify/functions/subscribe.mts"),
  unsubscribe: await import("../netlify/functions/unsubscribe.mts"),
  // Programadas en Netlify; acá se disparan por /api/cron/<nombre>
  "briefing-pipeline": await import("../netlify/functions/briefing-pipeline.mts"),
  "send-daily": await import("../netlify/functions/send-daily.mts"),
  "send-weekly": await import("../netlify/functions/send-weekly.mts"),
  // Función de fondo (sufijo -background): responde 202 y sigue trabajando
  "briefing-update-background": await import("../netlify/functions/briefing-update-background.mts"),
};
const lista = (v?: string | string[]) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const RUTAS = Object.values(FUNCIONES).flatMap((m) =>
  lista(m.config?.path).map((p) => ({ path: p, methods: lista(m.config?.method).map((x) => x.toUpperCase()), mod: m })),
);

const contexto = (req: IncomingMessage) => ({
  site: { url: URL_PUBLICA, name: "5mnews" },
  ip: String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim(),
  geo: {},
  requestId: String(req.headers["rndr-id"] ?? ""),
  waitUntil: (p: Promise<unknown>) => void p.catch((e) => console.error(e)),
});

const iguales = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// ---------- Archivos estáticos (public/) con los encabezados de netlify.toml ----------
const PUBLIC = resolve(import.meta.dirname, "../public");
const TIPOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8",
};
const SEGURIDAD = {
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000",
};
async function estatico(pathname: string, res: ServerResponse, soloCabecera: boolean) {
  let ruta = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  if (ruta.endsWith("/")) ruta += "index.html";
  const archivo = join(PUBLIC, ruta);
  if (!archivo.startsWith(PUBLIC)) return false;
  try {
    if (!(await stat(archivo)).isFile()) return false;
  } catch {
    return false;
  }
  const ext = extname(archivo);
  const cache =
    pathname === "/sw.js" ? "no-cache"
    : pathname === "/manifest.webmanifest" ? "public, max-age=3600"
    : pathname.startsWith("/icons/") ? "public, max-age=86400"
    : "public, max-age=0, must-revalidate";
  res.writeHead(200, { ...SEGURIDAD, "content-type": TIPOS[ext] ?? "application/octet-stream", "cache-control": cache, ...(pathname === "/sw.js" ? { "service-worker-allowed": "/" } : {}) });
  res.end(soloCabecera ? undefined : await readFile(archivo));
  return true;
}

// ---------- Adaptador Node http ⇄ Request/Response ----------
async function aRequest(req: IncomingMessage): Promise<Request> {
  const url = new URL(req.url ?? "/", URL_PUBLICA);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  let body: Buffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const partes: Buffer[] = [];
    let total = 0;
    for await (const c of req) {
      total += c.length;
      if (total > 1_000_000) break; // ninguna función necesita más de 1 MB
      partes.push(c as Buffer);
    }
    body = Buffer.concat(partes);
  }
  return new Request(url, { method: req.method, headers, body });
}
async function enviar(r: Response | void, res: ServerResponse, extra: Record<string, string> = {}) {
  if (!r) {
    res.writeHead(204).end();
    return;
  }
  const headers: Record<string, string | string[]> = { ...SEGURIDAD, ...extra };
  r.headers.forEach((v, k) => {
    if (k === "netlify-cdn-cache-control") return; // propio de la CDN de Netlify
    headers[k] = k === "set-cookie" ? r.headers.getSetCookie() : v;
  });
  res.writeHead(r.status, headers);
  res.end(r.body ? Buffer.from(await r.arrayBuffer()) : undefined);
}

// ---------- Cron: equivalentes de los schedule de Netlify ----------
const CRON: Record<string, string> = {
  hourly: "briefing-pipeline", // "0 * * * *"  actualización del briefing cada hora
  daily: "send-daily",         // "0 10 * * 1-5"  email + notificación 7:00 ART, lunes a viernes
  weekly: "send-weekly",       // "30 10 * * 4"  Resumen de los Jueves
};

/**
 * Límites de las tareas programadas, para que llamarlas de más no genere gastos ni envíos repetidos:
 * hourly como máximo cada 50 min; daily sólo lunes a viernes y weekly sólo jueves (hora de Argentina).
 * El envío de cada edición además queda registrado y no se repite en el día (lógica original).
 */
async function cronNoPermitido(cron: string): Promise<string | null> {
  const ahora = new Date();
  const diaART = new Intl.DateTimeFormat("en-US", { timeZone: "America/Argentina/Buenos_Aires", weekday: "short" }).format(ahora);
  if (cron === "daily" && (diaART === "Sat" || diaART === "Sun")) return "El briefing diario sale de lunes a viernes.";
  if (cron === "weekly" && diaART !== "Thu") return "El Resumen de los Jueves sale sólo los jueves.";
  if (cron === "hourly") {
    const control = getStore("cron-control");
    const ultimo = Number((await control.get("hourly")) ?? 0);
    if (ahora.getTime() - ultimo < 50 * 60_000) return "La actualización ya corrió hace menos de 50 minutos.";
    await control.set("hourly", String(ahora.getTime()));
  }
  return null;
}

const server = createServer(async (req, res) => {
  const inicio = Date.now();
  try {
    const url = new URL(req.url ?? "/", URL_PUBLICA);
    const metodo = (req.method ?? "GET").toUpperCase();

    if (url.pathname === "/healthz") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");

    // Migración única de datos: /api/admin/migrar-netlify?key=ADMIN_KEY
    if (url.pathname === "/api/admin/migrar-netlify") {
      const clave = process.env.ADMIN_KEY;
      const dada = String(req.headers["x-admin-key"] ?? url.searchParams.get("key") ?? "");
      if (!clave || !iguales(dada, clave)) return void res.writeHead(401).end("No autorizado");
      try {
        const resumen = await migrarDesdeNetlify();
        return void res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ ok: true, copiadas: resumen }, null, 2));
      } catch (e) {
        return void res.writeHead(400, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
    }

    // /api/cron/<hourly|daily|weekly>: lo llama el programador externo (GitHub Actions / cron-job.org)
    const cron = url.pathname.match(/^\/api\/cron\/([a-z]+)$/)?.[1];
    if (cron) {
      // CRON_SECRET es opcional: si está configurado se exige; si no, valen los límites de abajo
      const secreto = process.env.CRON_SECRET;
      const dado = String(req.headers["x-cron-secret"] ?? url.searchParams.get("key") ?? "");
      if (secreto && !iguales(dado, secreto)) return void res.writeHead(401).end("No autorizado");
      const mod = CRON[cron] && FUNCIONES[CRON[cron]];
      if (!mod) return void res.writeHead(404).end("Tarea desconocida");
      const motivo = await cronNoPermitido(cron);
      if (motivo) return void res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, motivo }));
      // Se responde enseguida y la tarea sigue en segundo plano (como en Netlify)
      res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, tarea: CRON[cron] }));
      Promise.resolve(mod.default(await aRequest(req), contexto(req))).catch((e) => console.error(`[cron ${cron}]`, e));
      return;
    }

    // Función de fondo: responde 202 y sigue (la dispara briefing-pipeline o el admin)
    if (url.pathname === "/.netlify/functions/briefing-update-background") {
      const r = await aRequest(req);
      res.writeHead(202).end();
      Promise.resolve(FUNCIONES["briefing-update-background"].default(r, contexto(req))).catch((e) => console.error("[background]", e));
      return;
    }

    const ruta = RUTAS.find((x) => x.path === url.pathname);
    if (ruta) {
      if (ruta.methods.length && !ruta.methods.includes(metodo) && !(metodo === "HEAD" && ruta.methods.includes("GET"))) {
        return void res.writeHead(405, { allow: ruta.methods.join(", ") }).end("Método no permitido");
      }
      return await enviar(await ruta.mod.default(await aRequest(req), contexto(req)), res);
    }

    if ((metodo === "GET" || metodo === "HEAD") && (await estatico(url.pathname, res, metodo === "HEAD"))) return;
    res.writeHead(404, { ...SEGURIDAD, "content-type": "text/plain; charset=utf-8" }).end("No encontrado");
  } catch (e) {
    console.error("[render]", req.method, req.url, e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Error interno");
  } finally {
    if (!req.url?.startsWith("/healthz")) console.log(`${req.method} ${req.url?.split("?")[0]} ${res.statusCode} ${Date.now() - inicio}ms`);
  }
});

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => console.log(`[render] 5M News escuchando en :${PORT} (${URL_PUBLICA})`));
