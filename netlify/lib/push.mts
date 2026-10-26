// Notificaciones push de la app (Web Push): briefing diario a las 7:00 y Resumen de los Jueves.
// Las claves VAPID se generan solas la primera vez y quedan en Blobs (la privada nunca sale de Netlify).
import { getStore } from "@netlify/blobs";
import webpush from "web-push";
import { daysBetween, getBriefing, todayART, type Briefing } from "./briefing.mts";
import type { Edition } from "./send.mts";

export interface SuscripcionPush {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  creada: string;
  ua?: string;
}

const pushStore = () => getStore({ name: "push-subscribers", consistency: "strong" });
const configStore = () => getStore({ name: "push-config", consistency: "strong" });

/** Servicios de push de los navegadores (evita que alguien registre una URL cualquiera para que el servidor la llame). */
const SERVICIOS = /^https:\/\/(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]*push\.apple\.com|[a-z0-9.-]*\.notify\.windows\.com|[a-z0-9.-]*push\.services\.mozilla\.com)\//i;

export function validarSuscripcion(x: any): SuscripcionPush | null {
  const endpoint = String(x?.endpoint ?? "");
  const p256dh = String(x?.keys?.p256dh ?? "");
  const auth = String(x?.keys?.auth ?? "");
  if (endpoint.length > 1000 || !SERVICIOS.test(endpoint)) return null;
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,30}$/.test(auth)) return null;
  return { endpoint, keys: { p256dh, auth }, creada: new Date().toISOString() };
}

const claveDe = async (endpoint: string) => {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return Buffer.from(h).toString("hex");
};

export async function clavesVapid(): Promise<{ publicKey: string; privateKey: string }> {
  const store = configStore();
  const guardadas = (await store.get("vapid", { type: "json" })) as { publicKey: string; privateKey: string } | null;
  if (guardadas) return guardadas;
  const nuevas = webpush.generateVAPIDKeys();
  // onlyIfNew: si dos pedidos llegan a la vez, gana el primero y ambos usan las mismas claves
  await store.setJSON("vapid", nuevas, { onlyIfNew: true });
  return ((await store.get("vapid", { type: "json" })) as typeof nuevas) ?? nuevas;
}

export async function guardarSuscripcion(s: SuscripcionPush) {
  await pushStore().setJSON(await claveDe(s.endpoint), s);
}
export async function borrarSuscripcion(endpoint: string) {
  await pushStore().delete(await claveDe(endpoint));
}
export async function listarSuscripciones(): Promise<SuscripcionPush[]> {
  const store = pushStore();
  const { blobs } = await store.list();
  const todas = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }) as Promise<SuscripcionPush | null>));
  return todas.filter((s): s is SuscripcionPush => !!s);
}

export interface Aviso { titulo: string; cuerpo: string; url: string; tag: string }

/** Envía un aviso a una suscripción. Devuelve "baja" si el navegador la dio de baja (se borra). */
export async function enviarA(s: SuscripcionPush, aviso: Aviso, ttlSeg = 6 * 3600): Promise<"ok" | "baja" | string> {
  const { publicKey, privateKey } = await clavesVapid();
  const sujeto = Netlify.env.get("VAPID_SUBJECT") || "mailto:tiziano.gallorenzi@gmail.com";
  try {
    await webpush.sendNotification(s, JSON.stringify(aviso), {
      TTL: ttlSeg,
      urgency: "normal",
      topic: aviso.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32),
      vapidDetails: { subject: sujeto, publicKey, privateKey },
      timeout: 10_000,
    });
    return "ok";
  } catch (e: any) {
    if (e?.statusCode === 404 || e?.statusCode === 410) {
      await borrarSuscripcion(s.endpoint);
      return "baja";
    }
    return `${e?.statusCode ?? ""} ${String(e?.body || e?.message || e).slice(0, 160)}`.trim();
  }
}

export function avisoDeEdicion(b: Briefing, edition: Edition): Aviso {
  if (edition === "weekly") {
    const temas = b.semanal?.temas ?? [];
    return {
      titulo: "Resumen de los Jueves",
      cuerpo: temas.length ? `${temas[0].titulo}${temas.length > 1 ? ` y ${temas.length - 1} temas más de la semana` : ""}.` : "Los temas que marcaron la semana.",
      url: "/?app=1&n=jueves",
      tag: `semanal-${b.edicion}`,
    };
  }
  const notas = [...b.noticias, ...(b.mercados?.noticias ?? [])];
  const hero = b.noticias.find((n) => n.hero) ?? b.noticias[0];
  const seg = notas.reduce((a, n) => a + n.seg, 0);
  const min = `${Math.floor(seg / 60)}:${String(seg % 60).padStart(2, "0")} min`;
  return {
    titulo: "Tu briefing de hoy",
    cuerpo: `${hero?.titulo ?? "Las noticias del día"}${notas.length > 1 ? ` y ${notas.length - 1} noticias más` : ""} · ${min} de lectura`,
    url: "/?app=1&n=diario",
    tag: `diario-${b.edicion}`,
  };
}

/**
 * Manda la edición por push a todos los dispositivos suscriptos. Independiente del email
 * (si el email falla o no hay suscriptores de email, las notificaciones salen igual).
 */
export async function enviarEdicionPush(edition: Edition, { force = false } = {}) {
  const b = await getBriefing();
  const hoy = todayART();
  const edad = daysBetween(b.edicion, hoy);
  if (!force && (edition === "daily" ? edad !== 0 : edad > 6)) return { skipped: `edición ${b.edicion} desactualizada` };

  const log = getStore({ name: "newsletter-send-log", consistency: "strong" });
  const claveLog = `push-${edition}-${hoy}`;
  if (!force && (await log.get(claveLog))) return { skipped: `${claveLog} ya enviada` };

  const subs = await listarSuscripciones();
  const aviso = avisoDeEdicion(b, edition);
  let enviadas = 0, bajas = 0;
  const errores: string[] = [];
  for (let i = 0; i < subs.length; i += 20) {
    const res = await Promise.all(subs.slice(i, i + 20).map((s) => enviarA(s, aviso)));
    for (const r of res) r === "ok" ? enviadas++ : r === "baja" ? bajas++ : errores.push(r);
  }
  const resultado = { dispositivos: subs.length, enviadas, bajas, errores: errores.slice(0, 10) };
  await log.setJSON(claveLog, { at: new Date().toISOString(), edicion: b.edicion, ...resultado });
  return resultado;
}
