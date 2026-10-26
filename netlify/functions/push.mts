import type { Config } from "@netlify/functions";
import { borrarSuscripcion, clavesVapid, enviarA, guardarSuscripcion, leerSuscripcion, validarSuscripcion } from "../lib/push.mts";

/**
 * Notificaciones de la app.
 *   GET  /api/push/clave        → clave pública VAPID (para suscribirse desde el navegador)
 *   POST /api/push/suscribir    → guarda la suscripción y qué quiere recibir ({ subscription, diario, semanal });
 *                                 la primera vez manda un aviso de bienvenida, después sólo actualiza las preferencias
 *   POST /api/push/desuscribir  → la borra
 */
export default async (req: Request) => {
  const accion = new URL(req.url).pathname.split("/").pop();
  if (req.method === "GET" && accion === "clave") {
    return Response.json({ publicKey: (await clavesVapid()).publicKey }, { headers: { "cache-control": "public, max-age=3600" } });
  }
  if (req.method !== "POST") return new Response("Método no permitido", { status: 405 });
  const cuerpo = await req.json().catch(() => null);

  if (accion === "suscribir") {
    const s = validarSuscripcion(cuerpo?.subscription);
    if (!s) return Response.json({ error: "Suscripción inválida." }, { status: 400 });
    s.diario = cuerpo?.diario !== false;
    s.semanal = cuerpo?.semanal !== false;
    if (!s.diario && !s.semanal) {
      await borrarSuscripcion(s.endpoint);
      return Response.json({ ok: true, desactivadas: true });
    }
    const previa = await leerSuscripcion(s.endpoint);
    if (previa) s.creada = previa.creada;
    s.ua = (req.headers.get("user-agent") ?? "").slice(0, 160);
    await guardarSuscripcion(s);
    if (previa) return Response.json({ ok: true, actualizadas: true, diario: s.diario, semanal: s.semanal });
    const que = s.diario && s.semanal
      ? "el briefing de lunes a viernes a las 7:00 AM y el Resumen semanal los jueves a las 7:00 PM"
      : s.diario ? "el briefing de lunes a viernes a las 7:00 AM" : "el Resumen semanal los jueves a las 7:00 PM";
    const r = await enviarA(s, { titulo: "Notificaciones activadas", cuerpo: `Vas a recibir ${que}.`, url: "/?app=1", tag: "bienvenida" }, 600);
    return Response.json({ ok: true, prueba: r, diario: s.diario, semanal: s.semanal });
  }
  if (accion === "desuscribir") {
    const endpoint = String(cuerpo?.endpoint ?? "");
    if (endpoint) await borrarSuscripcion(endpoint);
    return Response.json({ ok: true });
  }
  return new Response("No encontrado", { status: 404 });
};

export const config: Config = { path: ["/api/push/clave", "/api/push/suscribir", "/api/push/desuscribir"] };
