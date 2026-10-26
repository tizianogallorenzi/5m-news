import type { Config } from "@netlify/functions";
import { enviarEdicionPush } from "../lib/push.mts";

/** Notificación del Resumen semanal: jueves 7:00 PM Argentina (UTC-3) = 22:00 UTC, a quienes la eligieron. */
export default async () => {
  const push = await enviarEdicionPush("weekly").catch((e) => ({ error: (e as Error).message }));
  console.log("[send-weekly-push]", JSON.stringify(push));
};

export const config: Config = { schedule: "0 22 * * 4" };
