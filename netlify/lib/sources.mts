// Recolección de insumos para el briefing: feeds RSS de las fuentes priorizadas y datos de mercado.
import type { Indicador } from "./briefing.mts";

export interface FeedItem {
  /** ID corto ("F12") con el que el modelo cita la nota; el enlace real lo ponemos nosotros. */
  id: string;
  fuente: string;
  seccion: "mundo" | "economia" | "argentina" | "tech";
  titulo: string;
  resumen: string;
  url: string;
  fecha?: string;
  /** Foto que el propio medio adjunta a la nota en el feed (media:content, enclosure o <img>). */
  imagen?: string;
}

/** Fuentes priorizadas por la línea editorial (las que publican RSS abierto). */
export const FEEDS: { fuente: string; seccion: FeedItem["seccion"]; url: string }[] = [
  // Internacional / geopolítica
  { fuente: "BBC Mundo", seccion: "mundo", url: "https://feeds.bbci.co.uk/mundo/rss.xml" },
  { fuente: "El País", seccion: "mundo", url: "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/internacional/portada" },
  { fuente: "The Guardian", seccion: "mundo", url: "https://www.theguardian.com/world/rss" },
  { fuente: "NYT", seccion: "mundo", url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml" },
  // Economía / finanzas
  { fuente: "NYT", seccion: "economia", url: "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml" },
  { fuente: "Wall Street Journal", seccion: "economia", url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml" },
  { fuente: "Bloomberg", seccion: "economia", url: "https://feeds.bloomberg.com/markets/news.rss" },
  { fuente: "Financial Times", seccion: "economia", url: "https://www.ft.com/rss/home" },
  { fuente: "Ámbito", seccion: "economia", url: "https://www.ambito.com/rss/pages/economia.xml" },
  { fuente: "El Cronista", seccion: "economia", url: "https://www.cronista.com/arc/outboundfeeds/rss/?outputType=xml" },
  // Argentina
  { fuente: "Infobae", seccion: "argentina", url: "https://www.infobae.com/arc/outboundfeeds/rss/" },
  { fuente: "La Nación", seccion: "argentina", url: "https://www.lanacion.com.ar/arc/outboundfeeds/rss/?outputType=xml" },
  { fuente: "Clarín", seccion: "argentina", url: "https://www.clarin.com/rss/lo-ultimo/" },
  { fuente: "Perfil", seccion: "argentina", url: "https://www.perfil.com/feed" },
  // Tecnología
  { fuente: "NYT", seccion: "tech", url: "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml" },
  { fuente: "The Guardian", seccion: "tech", url: "https://www.theguardian.com/technology/rss" },
];

const MAX_POR_FEED = 10;
const VENTANA_HORAS = 36;

// ---------- RSS / Atom ----------

const ENTIDADES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

const decodificar = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTIDADES[n.toLowerCase()] ?? m);

export function limpiarTexto(s: string) {
  // Muchos feeds traen el HTML escapado (&lt;p&gt;): se decodifica y se vuelven a quitar las etiquetas.
  const sinCdata = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ");
  return decodificar(sinCdata).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

const etiqueta = (xml: string, nombres: string[]) => {
  for (const n of nombres) {
    const m = xml.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, "i"));
    if (m) return m[1];
  }
  return "";
};

const atributo = (tag: string, nombre: string) => tag.match(new RegExp(`\\s${nombre}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1];

/** Foto de la nota según el feed: media:content / media:thumbnail / enclosure de tipo imagen / primer <img> del cuerpo. */
export function imagenDeItem(b: string): string | undefined {
  const candidatas: { url: string; ancho: number }[] = [];
  for (const tag of b.match(/<media:(?:content|thumbnail)\b[^>]*>/gi) ?? []) {
    const url = atributo(tag, "url");
    const medio = atributo(tag, "medium") ?? atributo(tag, "type") ?? "image";
    if (url && /image/i.test(medio)) candidatas.push({ url, ancho: Number(atributo(tag, "width") ?? 0) });
  }
  for (const tag of b.match(/<enclosure\b[^>]*>/gi) ?? []) {
    const url = atributo(tag, "url");
    if (url && /^image\//i.test(atributo(tag, "type") ?? "")) candidatas.push({ url, ancho: 0 });
  }
  if (!candidatas.length) {
    const cuerpo = decodificar(etiqueta(b, ["content:encoded", "description", "content", "summary"]).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
    const img = cuerpo.match(/<img\b[^>]*>/i)?.[0];
    const url = img && atributo(img, "src");
    if (url) candidatas.push({ url, ancho: Number(atributo(img!, "width") ?? 0) });
  }
  // La de mayor ancho declarado (los feeds suelen listar varias resoluciones)
  const mejor = candidatas.sort((a, b) => b.ancho - a.ancho)[0]?.url;
  return mejor ? decodificar(mejor).trim() : undefined;
}

/** Parser mínimo de RSS 2.0 y Atom (sin dependencias). */
export function parseFeed(xml: string): { titulo: string; url: string; resumen: string; fecha?: string; imagen?: string }[] {
  const bloques = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  return bloques.map((b) => {
    let url = limpiarTexto(etiqueta(b, ["link"]));
    if (!url) url = b.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? "";
    if (!url) url = limpiarTexto(etiqueta(b, ["guid"]));
    return {
      titulo: limpiarTexto(etiqueta(b, ["title"])),
      url: url.trim(),
      resumen: limpiarTexto(etiqueta(b, ["description", "summary", "content:encoded", "content"])).slice(0, 320),
      fecha: limpiarTexto(etiqueta(b, ["pubDate", "published", "updated", "dc:date"])) || undefined,
      imagen: imagenDeItem(b),
    };
  });
}

async function fetchTexto(url: string, ms = 8000) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(ms),
    headers: { "user-agent": "5MNewsBot/1.0 (+https://fivem-news.onrender.com)", accept: "application/rss+xml, application/xml, text/xml, */*" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Descarga todos los feeds en paralelo. Un feed caído no frena al resto. */
export async function recolectarNoticias(ahora = new Date()) {
  const desde = ahora.getTime() - VENTANA_HORAS * 3_600_000;
  const resultados = await Promise.allSettled(FEEDS.map((f) => fetchTexto(f.url).then(parseFeed)));
  const items: FeedItem[] = [];
  const errores: string[] = [];
  const vistos = new Set<string>();

  resultados.forEach((r, i) => {
    const feed = FEEDS[i];
    if (r.status === "rejected") {
      errores.push(`${feed.fuente} (${feed.seccion}): ${(r.reason as Error)?.message ?? r.reason}`);
      return;
    }
    r.value
      .filter((it) => it.titulo && /^https?:\/\//.test(it.url))
      .filter((it) => {
        const t = it.fecha ? Date.parse(it.fecha) : NaN;
        return Number.isNaN(t) || t >= desde; // sin fecha: se acepta (algunos feeds no la publican)
      })
      .slice(0, MAX_POR_FEED)
      .forEach((it) => {
        if (vistos.has(it.url)) return;
        vistos.add(it.url);
        items.push({ id: `F${items.length + 1}`, fuente: feed.fuente, seccion: feed.seccion, ...it });
      });
  });
  return { items, errores };
}

// ---------- Mercados (los números salen de APIs, nunca del modelo) ----------

const nf = (n: number, dec = 0) =>
  new Intl.NumberFormat("es-AR", { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(n);

async function fetchJson<T>(url: string, ms = 6000): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

const FMP_SIMBOLOS: [string, string, string, (p: number) => string][] = [
  ["^GSPC", "Wall Street", "S&P 500", (p) => nf(p)],
  ["^IXIC", "Wall Street", "Nasdaq", (p) => nf(p)],
  ["^DJI", "Wall Street", "Dow Jones", (p) => nf(p)],
  ["BZUSD", "Commodities", "Petróleo Brent", (p) => `US$${nf(p, 2)}`],
  ["GCUSD", "Commodities", "Oro (onza)", (p) => `US$${nf(p)}`],
];

export async function recolectarMercados() {
  const indicadores: Indicador[] = [];
  const errores: string[] = [];
  const fmpKey = Netlify.env.get("FMP_API_KEY");

  const tareas: Promise<void>[] = [];

  // Wall Street y commodities (Financial Modeling Prep)
  if (fmpKey) {
    for (const [sym, grupo, nombre, fmt] of FMP_SIMBOLOS) {
      tareas.push(
        fetchJson<{ price: number; change: number }[]>(
          `https://financialmodelingprep.com/stable/quote-short?symbol=${encodeURIComponent(sym)}&apikey=${fmpKey}`,
        )
          .then(([q]) => {
            if (!q) throw new Error("sin datos");
            const previo = q.price - q.change;
            indicadores.push({ grupo, nombre, valor: fmt(q.price), var: previo ? Math.round((q.change / previo) * 10000) / 100 : null, hora: "Último" });
          })
          .catch((e) => void errores.push(`FMP ${sym}: ${e.message}`)),
      );
    }
  } else {
    errores.push("FMP_API_KEY no configurada: se omiten Wall Street y commodities.");
  }

  // Dólar (dolarapi.com, sin clave)
  tareas.push(
    fetchJson<{ casa: string; venta: number; fechaActualizacion: string }[]>("https://dolarapi.com/v1/dolares")
      .then((data) => {
        for (const [casa, nombre] of [["oficial", "Oficial"], ["blue", "Blue"], ["bolsa", "MEP"], ["contadoconliqui", "Contado con liqui"]] as const) {
          const d = data.find((x) => x.casa === casa);
          if (d) indicadores.push({ grupo: "Dólar", nombre, valor: `$${nf(d.venta, d.venta % 1 ? 2 : 0)}`, var: null, detalle: "venta", hora: "Último" });
        }
      })
      .catch((e) => void errores.push(`dolarapi: ${e.message}`)),
  );

  // Riesgo país (ArgentinaDatos, sin clave)
  tareas.push(
    fetchJson<{ valor: number; fecha: string }>("https://api.argentinadatos.com/v1/finanzas/indices/riesgo-pais/ultimo")
      .then((r) => {
        const [, m, d] = r.fecha.slice(0, 10).split("-");
        indicadores.push({ grupo: "Argentina", nombre: "Riesgo país", valor: `${nf(r.valor)} pb`, var: null, hora: `${d}/${m}` });
      })
      .catch((e) => void errores.push(`riesgo país: ${e.message}`)),
  );

  await Promise.all(tareas);
  const orden = ["Wall Street", "Commodities", "Argentina", "Dólar"];
  indicadores.sort((a, b) => orden.indexOf(a.grupo) - orden.indexOf(b.grupo));
  return { indicadores, errores };
}
