import type { Config, Context } from "@netlify/functions";
import { enviarEdicionPush } from "../lib/push.mts";
import { sendEdition, siteUrlFrom } from "../lib/send.mts";

/** Resumen diario: lunes a viernes 7:00 AM Argentina (UTC-3, sin horario de verano) = 10:00 UTC. */
export default async (_req: Request, context: Context) => {
  const result = await sendEdition("daily", siteUrlFrom(context.site.url ?? ""));
  console.log("[send-daily]", JSON.stringify(result));
  // Notificaciones de la app (independientes del email)
  const push = await enviarEdicionPush("daily").catch((e) => ({ error: (e as Error).message }));
  console.log("[send-daily] push", JSON.stringify(push));
};

export const config: Config = { schedule: "0 10 * * 1-5" };
