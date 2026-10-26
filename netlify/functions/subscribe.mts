import type { Config, Context } from "@netlify/functions";
import { confirmationEmail, emailConfigured, sendEmail } from "../lib/email.mts";
import { siteUrlFrom } from "../lib/send.mts";
import { EMAIL_RE, getSubscriber, normalizeEmail, saveSubscriber, type Subscriber } from "../lib/subscribers.mts";

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** Alta al newsletter (doble opt-in). Body JSON: { email, diario, semanal, website(honeypot) } */
export default async (req: Request, context: Context) => {
  if (Number(req.headers.get("content-length") ?? 0) > 2048) return json({ error: "Solicitud inválida." }, 413);

  let body: { email?: unknown; diario?: unknown; semanal?: unknown; website?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Solicitud inválida." }, 400);
  }

  // Honeypot: los bots completan el campo oculto. Respondemos OK sin guardar nada.
  if (typeof body.website === "string" && body.website.trim()) return json({ ok: true });

  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  const daily = body.diario === true;
  const weekly = body.semanal === true;
  if (!EMAIL_RE.test(email) || email.length > 254) return json({ error: "Ingresá un email válido." }, 400);
  if (!daily && !weekly) return json({ error: "Elegí al menos una opción: briefing diario o resumen de los jueves." }, 400);

  const existing = await getSubscriber(email);
  if (existing?.confirmed) return json({ error: "Ese email ya está suscripto." }, 409);
  if (existing && !existing.confirmed && Date.now() - Date.parse(existing.updatedAt) < 60_000) {
    return json({ error: "Ya te enviamos el email de confirmación. Esperá un minuto antes de reintentar." }, 429);
  }

  const now = new Date().toISOString();
  const sub: Subscriber = {
    email,
    daily,
    weekly,
    confirmed: false,
    token: existing?.token ?? crypto.randomUUID(),
    segment: "beta-interna",
    createdAt: existing?.createdAt ?? now,
    // updatedAt marca el último email de confirmación enviado: se fija sólo si el envío sale bien.
    updatedAt: new Date(0).toISOString(),
  };
  await saveSubscriber(sub);

  if (!emailConfigured()) {
    // Guardamos el alta, pero avisamos: sin RESEND_API_KEY no sale el email de confirmación.
    console.error("[subscribe] RESEND_API_KEY no configurada: no se pudo enviar la confirmación.");
    return json({ error: "El envío de emails todavía no está activo. Probá de nuevo más tarde." }, 503);
  }
  try {
    await sendEmail(confirmationEmail(sub, siteUrlFrom(new URL(req.url).origin)));
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[subscribe] error enviando confirmación:", msg);
    // Sin dominio verificado, Resend sólo permite enviar al email dueño de la cuenta.
    if (/only send testing emails|verify a domain|sender .*(not valid|not verified)|unauthori[sz]ed sender/i.test(msg)) {
      // El proveedor todavía no permite enviar a cualquier dirección: la suscripción queda guardada
      // en lista de espera y la confirmación se envía cuando se active (admin: action=resend-confirmations).
      return json({ ok: true, enEspera: true }, 202);
    }
    return json({ error: "No pudimos enviarte el email de confirmación. Probá de nuevo en unos minutos." }, 502);
  }
  await saveSubscriber({ ...sub, updatedAt: now });
  return json({ ok: true });
};

export const config: Config = { path: "/api/subscribe", method: "POST" };
