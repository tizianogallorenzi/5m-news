// Fotos de prensa: la foto principal de la nota ORIGINAL que cita cada noticia (la que eligió el medio
// para ese hecho), nunca bancos de imágenes ni búsquedas genéricas. Si no hay foto real, la nota va sin foto.
// Orden: foto que el medio adjunta en el feed RSS → og:image / twitter:image / JSON-LD de la página de la nota.
// El crédito sale de los metadatos de la propia nota (fotógrafo / agencia) y siempre enlaza a la cobertura original.
import { getStore } from "@netlify/blobs";
import type { Briefing, ImagenNoticia, Noticia } from "./briefing.mts";

const UA = "Mozilla/5.0 (compatible; 5MNewsBot/1.0; +https://fivem-news.onrender.com)";
const CACHE_OK_MS = 7 * 86_400_000; // la foto de una nota no cambia: 7 días
const CACHE_VACIO_MS = 3 * 3_600_000; // sin foto: se reintenta a las 3 horas
const MAX_HTML = 900_000; // los metadatos están en el <head>; no hace falta bajar la página entera
const ANCHO_MIN = 600;

/** URLs que delatan una imagen genérica del sitio (logo, placeholder, avatar) y no una foto del hecho. */
const GENERICA = /(logo|placeholder|default[-_.]|fallback|sprite|avatar|icon|favicon|blank|spacer|1x1|pixel|og[-_]?default|share[-_]?default|social[-_]?default|brand|generic|no[-_]?image|sin[-_]?imagen|apple-touch|\.svg(\?|$)|\.gif(\?|$))/i;
/** Bancos de stock: prohibidos aunque el medio los use. */
const STOCK = /(shutterstock|gettyimages\.com\/photos|istockphoto|pexels|unsplash|pixabay|depositphotos|freepik|dreamstime|123rf|adobestock|stock\.adobe)/i;

export const esFotoValida = (url?: string) =>
  !!url && /^https:\/\//i.test(url) && !GENERICA.test(url.split("?")[0]) && !STOCK.test(url);

const cache = () => getStore({ name: "fotos-prensa", consistency: "strong" });

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodificar = (s = "") =>
  s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** <meta property|name="clave" content="..."> con los atributos en cualquier orden. */
function meta(html: string, claves: string[]): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const nombre = tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (nombre && claves.includes(nombre)) {
      const v = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      const valor = decodificar(v?.[1] ?? v?.[2] ?? "");
      if (valor) return valor;
    }
  }
}

/** Crédito y pie de la foto principal declarados en JSON-LD (NewsArticle.image → ImageObject). */
function creditoJsonLd(html: string, urlFoto?: string): { credito?: string; pie?: string; url?: string } {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let datos: any;
    try { datos = JSON.parse(m[1].trim()); } catch { continue; }
    const nodos: any[] = [].concat(datos?.["@graph"] ?? datos);
    for (const nodo of nodos) {
      const imagenes: any[] = [].concat(nodo?.image ?? nodo?.associatedMedia ?? []);
      for (const im of imagenes) {
        if (!im || typeof im !== "object") continue;
        const crudo = [].concat(im.url ?? im.contentUrl ?? [])[0] as any;
        const url = typeof crudo === "string" ? crudo : typeof crudo?.url === "string" ? crudo.url : undefined;
        if (urlFoto && url && !mismaFoto(url, urlFoto)) continue;
        const persona = (x: any) => (typeof x === "string" ? x : x?.name) as string | undefined;
        const credito = im.creditText || persona(im.author) || persona(im.creator) || persona(im.copyrightHolder);
        if (credito || im.caption) return { credito: credito && decodificar(String(credito)), pie: im.caption && decodificar(String(im.caption)), url };
      }
    }
  }
  return {};
}

const mismaFoto = (a: string, b: string) => {
  const nombre = (u: string) => String(u).split("?")[0].split("/").pop()?.replace(/[-_]\d{2,4}x\d{2,4}/, "") ?? u;
  return a === b || nombre(a) === nombre(b);
};

/** Agencia mencionada en el pie o crédito (para mostrarla aunque el medio no separe el campo). */
const AGENCIAS = /\b(Reuters|AP|Associated Press|AFP|EFE|Getty Images|Bloomberg|Europa Press|ANSA|DPA|Xinhua|NA|Noticias Argentinas|Télam|Telam|Prensa Presidencia|EPA)\b/i;

async function descargarHead(url: string, timeoutMs: number) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml", "accept-language": "es-AR,es;q=0.9,en;q=0.8" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const lector = res.body?.getReader();
  if (!lector) return res.text();
  let html = "";
  const dec = new TextDecoder();
  while (html.length < MAX_HTML) {
    const { done, value } = await lector.read();
    if (done) break;
    html += dec.decode(value, { stream: true });
  }
  lector.cancel().catch(() => {});
  return html;
}

/**
 * Foto de prensa de una nota original.
 * @param fuente    medio que publicó la nota (para el crédito "vía …")
 * @param deFeed    foto que el medio adjuntó en el RSS, si la hay
 */
export async function fotoDeNota(urlNota: string, fuente: string, deFeed?: string, timeoutMs = 7000): Promise<ImagenNoticia | null> {
  const clave = encodeURIComponent(urlNota).slice(0, 600);
  const guardada = (await cache().get(clave, { type: "json" }).catch(() => null)) as { at: number; img: ImagenNoticia | null } | null;
  if (guardada && Date.now() - guardada.at < (guardada.img ? CACHE_OK_MS : CACHE_VACIO_MS)) return guardada.img;

  let img: ImagenNoticia | null = null;
  try {
    const html = await descargarHead(urlNota, timeoutMs);
    const og = meta(html, ["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src", "image"]);
    const ancho = Number(meta(html, ["og:image:width"]) ?? 0);
    const alto = Number(meta(html, ["og:image:height"]) ?? 0);
    // og:image suele ser la foto principal en alta; si el medio declara una miniatura chica o genérica, se usa la del feed
    let url = esFotoValida(og) && !(ancho && ancho < ANCHO_MIN) && !(ancho && alto && ancho / alto < 1.1) ? new URL(og!, urlNota).href : undefined;
    if (!url && esFotoValida(deFeed)) url = deFeed;
    if (url) {
      const ld = creditoJsonLd(html, url);
      const alt = meta(html, ["og:image:alt", "twitter:image:alt"]) || ld.pie || meta(html, ["og:title"]) || "";
      const agencia = (ld.credito || ld.pie || alt).match(AGENCIAS)?.[0];
      const autor = ld.credito && ld.credito.length <= 70 ? ld.credito : agencia;
      img = {
        url: url.replace(/^http:/, "https:"),
        alt: alt.slice(0, 220),
        credito: autor ? `${autor} vía ${fuente}` : fuente,
        licencia: "Foto de cobertura",
        enlace: urlNota,
      };
    }
  } catch (e) {
    // Página caída o bloqueada: se usa la foto del feed si existe; si no, sin foto (nunca una genérica)
    const msg = (e as Error).message;
    if (esFotoValida(deFeed)) img = { url: deFeed!, alt: "", credito: fuente, licencia: "Foto de cobertura", enlace: urlNota };
    else if (!/^HTTP 4\d\d/.test(msg)) {
      console.error(`[fotos] ${urlNota}:`, msg);
      return null; // error de red pasajero: no se guarda en caché
    }
    // 401/403/404 (muro de pago o bloqueo a servidores): se recuerda para no reintentar en cada visita
  }
  await cache().setJSON(clave, { at: Date.now(), img }).catch(() => {});
  return img;
}

/** Nota de un feed con la foto que el medio le adjuntó (insumo para cubrir notas de medios que bloquean). */
export interface NotaConFoto { url: string; fuente: string; titulo: string; imagen: string }

const VACIAS = new Set("para pero como este esta estos sobre desde hasta entre tras ante bajo cuando donde porque that this with from after over into their about have will what were been says said than more como también".split(" "));
/** Palabras distintivas (nombres propios, siglas, cifras) para reconocer la cobertura del mismo hecho en otro medio. */
const claves = (t: string) => new Set(
  (t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").match(/[A-Za-z][A-Za-z'-]{3,}|\d[\d.,]*\d|\d{2,}/g) ?? [])
    .map((w) => w.toLowerCase().replace(/[.,]/g, ""))
    .filter((w) => !VACIAS.has(w)),
);

/** Otra nota del feed (con foto) sobre el mismo hecho: comparte al menos 3 palabras distintivas con la noticia. */
function mismaCobertura(n: Noticia, candidatas: NotaConFoto[], usadas: Set<string>): NotaConFoto | undefined {
  const ref = claves(`${n.titulo} ${n.bajada} ${n.que}`);
  let mejor: { c: NotaConFoto; puntos: number } | undefined;
  for (const c of candidatas) {
    if (usadas.has(c.imagen) || !esFotoValida(c.imagen)) continue;
    let puntos = 0;
    for (const w of claves(c.titulo)) if (ref.has(w)) puntos++;
    if (puntos >= 3 && (!mejor || puntos > mejor.puntos)) mejor = { c, puntos };
  }
  return mejor?.c;
}

/**
 * Asigna a cada noticia la foto de cobertura de la primera de sus fuentes que tenga una.
 * Descarta cualquier imagen ilustrativa previa (Wikimedia Commons u otras genéricas).
 * @param notasFeed  notas de los feeds con su foto adjunta (fotos de respaldo del mismo hecho)
 */
export async function conImagenes(b: Briefing, presupuestoMs = 5000, notasFeed: NotaConFoto[] = []): Promise<Briefing> {
  const fotosFeed = new Map(notasFeed.map((x) => [x.url, x.imagen] as [string, string]));
  const notas: Noticia[] = [...b.noticias, ...(b.mercados?.noticias ?? [])];
  for (const n of notas) {
    if (n.imagen && n.imagen.licencia !== "Foto de cobertura") delete n.imagen;
    delete n.imagenBusqueda;
  }
  const pendientes = notas.filter((n) => !n.imagen && n.fuentes?.length);
  if (!pendientes.length) return b;
  const usadas = new Set(notas.map((n) => n.imagen?.url).filter(Boolean));
  const limite = new Promise<void>((r) => setTimeout(r, presupuestoMs));
  await Promise.race([
    Promise.all(pendientes.map(async (n) => {
      for (const f of n.fuentes.slice(0, 3)) {
        const img = await fotoDeNota(f.url, f.nombre, fotosFeed.get(f.url));
        if (img && !usadas.has(img.url)) {
          usadas.add(img.url); // la misma foto no se repite en dos noticias
          n.imagen = img;
          return;
        }
      }
      // Ninguna fuente citada tiene foto accesible: la de otro medio que cubrió el mismo hecho
      const otra = mismaCobertura(n, notasFeed, usadas);
      if (otra) {
        usadas.add(otra.imagen);
        n.imagen = { url: otra.imagen, alt: otra.titulo, credito: otra.fuente, licencia: "Foto de cobertura", enlace: otra.url };
      }
    })),
    limite,
  ]);
  return b;
}
