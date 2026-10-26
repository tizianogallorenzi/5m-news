import type { Config } from "@netlify/functions";
import { getBriefing } from "../lib/briefing.mts";
import { conImagenes } from "../lib/imagenes.mts";
import { notasConFoto } from "../lib/pipeline.mts";

/** Sirve la edición vigente: la generada automáticamente (Blobs) o la estática del deploy. */
export default async () => {
  // Las ediciones automáticas ya traen sus fotos; esto completa las que falten (y la edición estática)
  const b = await conImagenes(structuredClone(await getBriefing()), 5000, await notasConFoto());
  const { generado, ...publico } = b; // los metadatos internos no se publican
  return Response.json({ ...publico, actualizado: generado?.at }, {
    headers: { "cache-control": "public, max-age=0, must-revalidate", "netlify-cdn-cache-control": "public, max-age=60, stale-while-revalidate=300" },
  });
};

export const config: Config = { path: "/briefing.json", method: "GET" };
