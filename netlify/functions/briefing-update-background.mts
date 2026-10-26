import { actualizarBriefing } from "../lib/pipeline.mts";
import { safeEqual } from "../lib/subscribers.mts";

/**
 * Función de fondo (sufijo -background: responde 202 y sigue trabajando hasta 15 minutos).
 * La dispara el cron horario o el endpoint admin; exige la clave de administración.
 */
export default async (req: Request) => {
  const clave = Netlify.env.get("ADMIN_KEY");
  if (!clave || !safeEqual(req.headers.get("x-5m-key") ?? "", clave)) {
    console.error("[briefing-update] pedido sin clave válida");
    return;
  }
  const forzar = new URL(req.url).searchParams.get("forzar") === "1";
  const resultado = await actualizarBriefing({ forzar });
  (resultado.estado === "error" ? console.error : console.log)("[briefing-update]", JSON.stringify(resultado));
};
