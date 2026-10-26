import { daysBetween, getBriefing, todayART } from "./briefing.mts";
import { dailyEmail, emailConfigured, sendBatch, weeklyEmail } from "./email.mts";
import { listSubscribers, sendLogStore } from "./subscribers.mts";

export type Edition = "daily" | "weekly";

export interface SendResult {
  edition: Edition;
  skipped?: string;
  recipients: number;
  sent: number;
  errors: string[];
}

/**
 * Envía una edición a todos los suscriptores confirmados que la eligieron.
 * - No reenvía una edición ya enviada (registro en Blobs), salvo `force`.
 * - No envía contenido desactualizado (briefing.json de otro día), salvo `force`.
 */
export async function sendEdition(edition: Edition, siteUrl: string, { force = false } = {}): Promise<SendResult> {
  const result: SendResult = { edition, recipients: 0, sent: 0, errors: [] };
  if (!emailConfigured()) return { ...result, skipped: "Falta configurar el envío de emails (BREVO_API_KEY o RESEND_API_KEY)." };

  const briefing = await getBriefing();
  const today = todayART();
  const age = daysBetween(briefing.edicion, today);
  if (!force && (edition === "daily" ? age !== 0 : age > 6)) {
    return { ...result, skipped: `briefing.json es de ${briefing.edicion}; no se envía contenido desactualizado.` };
  }

  const logKey = `${edition}-${today}`;
  const log = sendLogStore();
  if (!force && (await log.get(logKey))) return { ...result, skipped: `La edición ${logKey} ya se envió.` };

  const subs = (await listSubscribers()).filter((s) => s.confirmed && (edition === "daily" ? s.daily : s.weekly));
  result.recipients = subs.length;
  if (!subs.length) return { ...result, skipped: "No hay suscriptores confirmados para esta edición." };

  const build = edition === "daily" ? dailyEmail : weeklyEmail;
  const { sent, errors } = await sendBatch(subs.map((s) => build(briefing, s, siteUrl)));
  result.sent = sent;
  result.errors = errors;

  await log.setJSON(logKey, { at: new Date().toISOString(), edicion: briefing.edicion, recipients: subs.length, sent, errors });
  return result;
}

/** URL pública del sitio (dominio propio si se configura SITE_URL). */
export const siteUrlFrom = (fallback: string) => (Netlify.env.get("SITE_URL") || fallback).replace(/\/$/, "");
