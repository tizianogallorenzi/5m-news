import type { Config, Context } from "@netlify/functions";
import { sendEdition, siteUrlFrom } from "../lib/send.mts";

/** Resumen de los Jueves por email: jueves 7:00 PM Argentina (UTC-3) = 22:00 UTC, junto con la notificación (send-weekly-push). */
export default async (_req: Request, context: Context) => {
  const result = await sendEdition("weekly", siteUrlFrom(context.site.url ?? ""));
  console.log("[send-weekly]", JSON.stringify(result));
};

export const config: Config = { schedule: "0 22 * * 4" };
