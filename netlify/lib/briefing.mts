import { getStore } from "@netlify/blobs";
// Edición estática de respaldo (public/briefing.json), incluida en el bundle.
import data from "../../public/briefing.json" with { type: "json" };

export type Categoria = "mundo" | "economia" | "argentina" | "tech" | "mercados";
export interface Fuente { nombre: string; url: string }
export interface DatoClave {
  label: string; valor: string; delta?: string; tendencia?: "sube" | "baja" | "neutral"; detalle?: string;
}
export type Grafico =
  | { tipo: "barras"; titulo: string; unidad?: string; signo?: boolean; puntos: { label: string; valor: number }[]; fuente?: string }
  | { tipo: "linea"; titulo: string; unidad?: string; etiquetas: string[]; series: { nombre: string; valores: number[] }[]; fuente?: string };
export interface ImagenNoticia {
  url: string; alt: string; credito: string; licencia: string; enlace: string;
}
export interface Noticia {
  cat: Categoria; hora: string; seg: number; hero?: boolean; clave?: boolean;
  titulo: string; bajada: string; que: string; quien: string; porque: string; fuentes: Fuente[];
  /** Cifras destacadas (tarjetas expandibles en la web) */
  datos?: DatoClave[];
  /** Mini-visualización con datos de la nota */
  grafico?: Grafico;
  /** Fecha de la noticia (YYYY-MM-DD); si falta, se usa la de la edición */
  fecha?: string;
  /** Obsoleto (búsqueda genérica en Wikimedia Commons): se ignora y se descarta. */
  imagenBusqueda?: string;
  /** Foto de cobertura del hecho, tomada de la nota original que se cita primero */
  imagen?: ImagenNoticia;
}
export interface Indicador {
  grupo: string; nombre: string; valor: string; var: number | null; detalle?: string; hora: string;
}
export interface TemaSemanal { cat: Categoria; titulo: string; resumen: string; mirar: string; fuentes: Fuente[] }
export interface Briefing {
  edicion: string; // YYYY-MM-DD
  noticias: Noticia[];
  semanal: { titulo: string; intro: string; temas: TemaSemanal[] };
  tendencias?: { cat: Categoria; label: string; txt: string }[];
  /** Metadatos de la generación automática (modelo, avisos de validación). */
  generado?: { at: string; modelo: string; notasFuente: number; avisos: string[] };
  mercados?: {
    nota: string;
    indicadores: Indicador[];
    noticias: Noticia[];
    fuentesDatos?: Fuente[];
  };
}

/** Respaldo incluido en el deploy. */
export const briefingEstatico = data as unknown as Briefing;

/** Ediciones generadas automáticamente: "actual" + archivo "edicion-YYYY-MM-DD". */
export const briefingStore = () => getStore({ name: "briefing", consistency: "strong" });

/**
 * Briefing vigente: el generado automáticamente (Blobs) o, si es más nuevo o no existe,
 * el estático del deploy (permite publicar una edición a mano).
 */
export async function getBriefing(): Promise<Briefing> {
  try {
    const generado = (await briefingStore().get("actual", { type: "json" })) as Briefing | null;
    if (generado && generado.edicion >= briefingEstatico.edicion) return generado;
  } catch (e) {
    console.error("[briefing] no se pudo leer Blobs:", (e as Error).message);
  }
  return briefingEstatico;
}

export async function publicarBriefing(b: Briefing) {
  const store = briefingStore();
  await store.setJSON(`edicion-${b.edicion}`, b);
  await store.setJSON("actual", b);
}

/** Fecha de hoy en Buenos Aires, formato YYYY-MM-DD. */
export const todayART = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());

export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
