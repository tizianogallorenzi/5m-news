import type { Config } from "@netlify/functions";
import { dispararActualizacion } from "../lib/pipeline.mts";

/**
 * Actualización automática cada hora, todos los días (minuto 0, UTC).
 * Las funciones programadas tienen 30 s de límite, así que sólo disparan la función de fondo
 * briefing-update-background, que recolecta, redacta, busca las fotos y publica (hasta 15 min).
 */
export default async () => {
  const status = await dispararActualizacion();
  (status === 202 ? console.log : console.error)("[briefing-pipeline] función de fondo:", status);
};

export const config: Config = { schedule: "0 * * * *" };
