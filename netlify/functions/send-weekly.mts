import type { Config, Context } from "@netlify/functions";
import { enviarEdicionPush } from "../lib/push.mts";
import { sendEdition, siteUrlFrom } from "../lib/send.mts";

/** Análisis semanal: jueves 7:30 AM Argentina (UTC-3) = 10:30 UTC. Media hora después del diario. */
export default async (_req: Request, context: Context) => {
  const result = await sendEdition("weekly", siteUrlFrom(context.site.url ?? ""));
  console.log("[send-weekly]", JSON.stringify(result));
  // Notificaciones de la app (independientes del email)
  const push = await enviarEdicionPush("weekly").catch((e) => ({ error: (e as Error).message }));
  console.log("[send-weekly] push", JSON.stringify(push));
};

export const config: Config = { schedule: "30 10 * * 4" };
