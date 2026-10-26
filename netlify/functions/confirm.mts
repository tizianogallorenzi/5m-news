import type { Config } from "@netlify/functions";
import { saveSubscriber, verifyLink } from "../lib/subscribers.mts";

/** Enlace del email de confirmación → marca al suscriptor como confirmado. */
export default async (req: Request) => {
  const url = new URL(req.url);
  const sub = await verifyLink(url);
  if (!sub) return Response.redirect(new URL("/?suscripcion=invalida", url), 302);

  if (!sub.confirmed) {
    const now = new Date().toISOString();
    await saveSubscriber({ ...sub, confirmed: true, confirmedAt: now, updatedAt: now });
  }
  return Response.redirect(new URL("/?suscripcion=confirmada", url), 302);
};

export const config: Config = { path: "/api/confirm", method: "GET" };
