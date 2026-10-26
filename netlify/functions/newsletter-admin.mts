import type { Config } from "@netlify/functions";
import { getBriefing } from "../lib/briefing.mts";
import { dispararActualizacion, recolectarInsumos } from "../lib/pipeline.mts";
import { confirmationEmail, dailyEmail, emailConfigured, proveedorEmail, sendEmail, weeklyEmail } from "../lib/email.mts";
import { sendEdition, siteUrlFrom, type Edition } from "../lib/send.mts";
import { enviarEdicionPush, listarSuscripciones } from "../lib/push.mts";
import { EMAIL_RE, listSubscribers, safeEqual, type Subscriber } from "../lib/subscribers.mts";

/**
 * Panel mínimo para la prueba interna. Requiere ADMIN_KEY (variable de entorno).
 *   ?action=stats                         → cantidad de suscriptores
 *   ?action=preview&type=daily&to=EMAIL   → manda una muestra sólo a EMAIL
 *   ?action=send&type=weekly[&force=1]    → envía la edición a todos los confirmados
 *   ?action=resend-confirmations          → reenvía la confirmación a los pendientes
 *   ?action=html&type=daily               → muestra el email en el navegador (sin enviar)
 *   ?action=fuentes                       → prueba la recolección (feeds + mercados) sin publicar
 *   ?action=generar[&forzar=1]            → dispara ya la actualización horaria (fotos incluidas); ver con ?action=estado
 *   ?action=push&type=daily[&force=1]    → manda la notificación de la edición a todos los dispositivos
 *   ?action=estado                        → edición vigente y avisos de la última generación
 * La clave va en el header "x-admin-key" o en ?key=.
 */
export default async (req: Request) => {
  const url = new URL(req.url);
  const adminKey = Netlify.env.get("ADMIN_KEY");
  const given = req.headers.get("x-admin-key") ?? url.searchParams.get("key") ?? "";
  if (!adminKey || !safeEqual(given, adminKey)) return Response.json({ error: "No autorizado" }, { status: 401 });

  const siteUrl = siteUrlFrom(url.origin);
  const action = url.searchParams.get("action") ?? "stats";
  const briefing = await getBriefing();

  if (action === "fuentes") {
    const ins = await recolectarInsumos();
    const porFuente: Record<string, number> = {};
    for (const it of ins.items) porFuente[it.fuente] = (porFuente[it.fuente] ?? 0) + 1;
    return Response.json({ notas: ins.items.length, porFuente, indicadores: ins.indicadores, errores: ins.errores, muestra: ins.items.slice(0, 5) });
  }
  if (action === "generar") {
    const status = await dispararActualizacion(url.searchParams.get("forzar") === "1");
    return Response.json({ ok: status === 202, status, mensaje: "Actualización en marcha (1 a 3 minutos). Revisá ?action=estado." }, { status: status === 202 ? 202 : 502 });
  }
  if (action === "estado") {
    return Response.json({ edicion: briefing.edicion, generado: briefing.generado ?? "edición estática (no generada automáticamente)", noticias: [...briefing.noticias, ...(briefing.mercados?.noticias ?? [])].map((n) => ({ titulo: n.titulo, foto: n.imagen ? `${n.imagen.credito} · ${n.imagen.url}` : null })) });
  }
  const type: Edition = url.searchParams.get("type") === "weekly" ? "weekly" : "daily";

  if (action === "push") {
    return Response.json(await enviarEdicionPush(type, { force: url.searchParams.get("force") === "1" }));
  }

  if (action === "stats") {
    const subs = await listSubscribers();
    return Response.json({
      emailConfigured: emailConfigured(),
      proveedorEmail: proveedorEmail(),
      briefingEdicion: briefing.edicion,
      total: subs.length,
      confirmados: subs.filter((s) => s.confirmed).length,
      pendientes: subs.filter((s) => !s.confirmed).length,
      diario: subs.filter((s) => s.confirmed && s.daily).length,
      semanal: subs.filter((s) => s.confirmed && s.weekly).length,
      dispositivosConNotificaciones: (await listarSuscripciones()).length,
    });
  }

  const sample: Subscriber = {
    email: url.searchParams.get("to") ?? "preview@example.com",
    daily: true,
    weekly: true,
    confirmed: true,
    token: "preview",
    segment: "beta-interna",
    createdAt: "",
    updatedAt: "",
  };
  const build = type === "daily" ? dailyEmail : weeklyEmail;

  if (action === "html") {
    return new Response(build(briefing, sample, siteUrl).html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (action === "preview") {
    if (!EMAIL_RE.test(sample.email)) return Response.json({ error: "Falta ?to=EMAIL" }, { status: 400 });
    const m = build(briefing, sample, siteUrl);
    await sendEmail({ ...m, subject: `[PRUEBA] ${m.subject}` });
    return Response.json({ ok: true, enviadoA: sample.email, type, proveedor: proveedorEmail() });
  }
  if (action === "send") {
    return Response.json(await sendEdition(type, siteUrl, { force: url.searchParams.get("force") === "1" }));
  }
  if (action === "resend-confirmations") {
    const pending = (await listSubscribers()).filter((s) => !s.confirmed);
    const errores: { email: string; error: string }[] = [];
    let reenviadas = 0;
    for (const s of pending) {
      try {
        await sendEmail(confirmationEmail(s, siteUrl));
        reenviadas++;
      } catch (e) {
        errores.push({ email: s.email, error: (e as Error).message.slice(0, 200) });
      }
    }
    return Response.json({ ok: errores.length === 0, proveedor: proveedorEmail(), pendientes: pending.length, reenviadas, errores });
  }
  return Response.json({ error: "Acción desconocida" }, { status: 400 });
};

export const config: Config = { path: "/api/admin/newsletter", method: ["GET", "POST"] };
