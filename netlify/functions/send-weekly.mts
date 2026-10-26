import type { Config, Context } from "@netlify/functions";
import { sendEdition, siteUrlFrom } from "../lib/send.mts";

/** Análisis semanal por email: jueves 7:30 AM Argentina (UTC-3) = 10:30 UTC. La notificación sale a las 19:00 (send-weekly-push). */
export default async (_req: Request, context: Context) => {
  const result = await sendEdition("weekly", siteUrlFrom(context.site.url ?? ""));
  console.log("[send-weekly]", JSON.stringify(result));
};

export const config: Config = { schedule: "30 10 * * 4" };
