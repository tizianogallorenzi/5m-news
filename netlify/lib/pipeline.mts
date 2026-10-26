// Orquestación del briefing automático: cada hora, recolectar → redactar con Claude → validar →
// fotos de cobertura de las notas originales → publicar en Blobs ("actual" + "edicion-YYYY-MM-DD").
// Si una pasada falla, la de la hora siguiente lo reintenta; la edición publicada sigue en línea.
import { getStore } from "@netlify/blobs";
import { briefingStore, getBriefing, publicarBriefing, todayART, type Briefing } from "./briefing.mts";
import { esJuevesART, generarBriefing, type Insumos, type NotaSemana } from "./generate.mts";
import { conImagenes, type NotaConFoto } from "./imagenes.mts";
import { recolectarMercados, recolectarNoticias } from "./sources.mts";

const MIN_NOTAS = 15;
const workStore = () => getStore({ name: "briefing-work", consistency: "strong" });

export type ResultadoPaso =
  | { estado: "en-curso" }
  | { estado: "sin-cambios"; edicion: string; nuevas: number }
  | { estado: "publicado"; edicion: string; noticias: number; mercados: number; segundos: number; conFoto: number; nuevas: number; duracion: number; avisos: string[]; usage?: unknown }
  | { estado: "error"; paso: "recolectar" | "redactar"; error: string };

export async function recolectarInsumos(): Promise<Insumos> {
  const ahora = new Date();
  const [noticias, mercados] = await Promise.all([recolectarNoticias(ahora), recolectarMercados()]);
  return {
    fecha: todayART(),
    recolectado: ahora.toISOString(),
    items: noticias.items,
    indicadores: mercados.indicadores,
    errores: [...noticias.errores, ...mercados.errores],
  };
}

/** Noticias de las ediciones de esta semana (lunes a hoy), para el análisis del jueves. */
async function notasDeLaSemana(hoy: string): Promise<NotaSemana[]> {
  const store = briefingStore();
  const { blobs } = await store.list({ prefix: "edicion-" });
  const desde = new Date(Date.parse(hoy) - 6 * 86_400_000).toISOString().slice(0, 10);
  const claves = blobs.map((b) => b.key).filter((k) => k.slice(8) >= desde && k.slice(8) < hoy).sort();
  const ediciones = (await Promise.all(claves.map((k) => store.get(k, { type: "json" })))) as (Briefing | null)[];
  const notas: NotaSemana[] = [];
  for (const ed of ediciones) {
    for (const n of [...(ed?.noticias ?? []), ...(ed?.mercados?.noticias ?? [])]) {
      notas.push({ id: `E${notas.length + 1}`, fecha: ed!.edicion, cat: n.cat === "mercados" ? "economia" : n.cat, titulo: n.titulo, que: n.que, fuentes: n.fuentes });
    }
  }
  return notas;
}

const MIN_NUEVAS = 4; // notas nuevas (desde la última publicación) para rehacer el briefing dentro del mismo día
const LOCK_MS = 14 * 60_000; // una actualización en curso bloquea a la siguiente (las funciones de fondo duran hasta 15 min)

/**
 * Actualización horaria (corre en una función de fondo, sin el límite de 30 s):
 * recolecta feeds y mercados, y si hay novedades redacta con Claude, valida, asigna las fotos de cobertura
 * de cada nota original y publica. Sin novedades suficientes, no gasta una llamada al modelo.
 */
export async function actualizarBriefing({ forzar = false } = {}): Promise<ResultadoPaso> {
  const hoy = todayART();
  const work = workStore();
  const lock = Number((await work.get("lock")) ?? 0);
  if (!forzar && Date.now() - lock < LOCK_MS) return { estado: "en-curso" };
  await work.set("lock", String(Date.now()));
  const inicio = Date.now();
  try {
    const insumos = await recolectarInsumos();
    if (insumos.items.length < MIN_NOTAS) {
      return { estado: "error", paso: "recolectar", error: `Sólo ${insumos.items.length} notas (mínimo ${MIN_NOTAS}). ${insumos.errores.join(" | ")}` };
    }
    const previas = (await work.get("ultimas-urls", { type: "json" })) as { edicion: string; urls: string[] } | null;
    const actual = (await briefingStore().get("actual", { type: "json" })) as Briefing | null;
    const vistas = new Set(previas?.urls ?? []);
    const nuevas = insumos.items.filter((it) => !vistas.has(it.url)).length;
    if (!forzar && actual?.edicion === hoy && previas?.edicion === hoy && nuevas < MIN_NUEVAS) {
      return { estado: "sin-cambios", edicion: hoy, nuevas };
    }

    // El análisis semanal se escribe una sola vez por jueves (la primera actualización del día)
    const conSemanal = esJuevesART() && !(await work.get(`semanal-${hoy}`));
    const previo = await getBriefing();
    const { briefing, avisos, usage, semanalNuevo } = await generarBriefing(insumos, {
      semanalPrevio: previo.semanal,
      notasSemana: conSemanal ? await notasDeLaSemana(hoy) : [],
      timeoutMs: 150_000,
      conSemanal,
    });
    if (semanalNuevo) await work.set(`semanal-${hoy}`, "1");

    const notasFeed: NotaConFoto[] = insumos.items.filter((it) => it.imagen).map((it) => ({ url: it.url, fuente: it.fuente, titulo: it.titulo, imagen: it.imagen! }));
    await conImagenes(briefing, 120_000, notasFeed);
    await work.setJSON("notas-con-foto", notasFeed); // respaldo para completar fotos al servir /briefing.json
    await publicarBriefing(briefing);
    await work.setJSON("ultimas-urls", { edicion: hoy, urls: insumos.items.map((it) => it.url) });

    const notas = [...briefing.noticias, ...(briefing.mercados?.noticias ?? [])];
    return {
      estado: "publicado", edicion: hoy, noticias: briefing.noticias.length, mercados: briefing.mercados?.noticias.length ?? 0,
      segundos: notas.reduce((a, n) => a + n.seg, 0), conFoto: notas.filter((n) => n.imagen).length, nuevas,
      duracion: Math.round((Date.now() - inicio) / 1000), avisos, usage,
    };
  } catch (e) {
    return { estado: "error", paso: "redactar", error: (e as Error).message };
  } finally {
    await work.delete("lock");
  }
}

/** Dispara la función de fondo que hace la actualización (responde 202 al instante). */
export async function dispararActualizacion(forzar = false) {
  const base = Netlify.env.get("URL") || "https://5mnews.netlify.app";
  const res = await fetch(`${base}/.netlify/functions/briefing-update-background${forzar ? "?forzar=1" : ""}`, {
    method: "POST",
    headers: { "x-5m-key": Netlify.env.get("ADMIN_KEY") ?? "" },
    signal: AbortSignal.timeout(10_000),
  });
  return res.status;
}

/** Notas de los feeds con foto de la última actualización (para completar fotos al servir el briefing). */
export async function notasConFoto(): Promise<NotaConFoto[]> {
  return ((await workStore().get("notas-con-foto", { type: "json" }).catch(() => null)) as NotaConFoto[] | null) ?? [];
}
