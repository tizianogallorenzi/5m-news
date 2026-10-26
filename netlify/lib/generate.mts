// Redacción del briefing con Claude (vía Netlify AI Gateway) y validación editorial.
import Anthropic from "@anthropic-ai/sdk";
import type { Briefing, Categoria, DatoClave, Fuente, Grafico, Indicador, Noticia, TemaSemanal } from "./briefing.mts";
import type { FeedItem } from "./sources.mts";

export interface Insumos {
  fecha: string; // YYYY-MM-DD (ART)
  recolectado: string; // ISO
  items: FeedItem[];
  indicadores: Indicador[];
  errores: string[];
}

/** Noticias de ediciones anteriores de la semana (insumo del análisis de los jueves). */
export interface NotaSemana {
  id: string; // "E3"
  fecha: string;
  cat: Categoria;
  titulo: string;
  que: string;
  fuentes: Fuente[];
}

const MODELO_DEFAULT = "claude-haiku-5-5";
const MAX_SEGUNDOS = 295; // la promesa: todo en menos de 5 minutos
const CATS_NOTICIA = ["mundo", "economia", "argentina", "tech"] as const;

// ---------- Prompt ----------

const SISTEMA = `Sos el editor de 5M News, un portal argentino de noticias hiper-resumidas para leer en menos de 5 minutos antes de salir de casa.
Reglas obligatorias:
- Escribí en español rioplatense neutro, claro y directo, sin opinión ni adjetivos innecesarios.
- Usá SOLO hechos que aparezcan en las notas provistas. No agregues datos, cifras, nombres ni fechas que no estén ahí. Si una cifra no está en las notas o en los indicadores, no la uses.
- Citá las notas que usaste por su ID (ej. "F12"), poniendo primero la nota que cubre el hecho de forma más directa (de ella sale la foto de la noticia). Priorizá noticias cubiertas por 2 o más medios distintos (fuentes contrastadas).
- Titular: directo, máximo 12 palabras. Bajada: una sola oración.
- "que" (¿Qué pasó?): 2 o 3 oraciones con los hechos. "quien" (¿A quién afecta?): 1 o 2 oraciones. "porque" (¿Por qué importa hoy?): 1 o 2 oraciones, con foco en el lector argentino.
- Cada bloque de texto debe ser breve: el briefing completo tiene que leerse en menos de 5 minutos.
- No uses emojis ni símbolos decorativos en ningún texto.
- "datos": hasta 3 cifras clave por noticia (valor corto, ej. "704 pb", "US$61 M"), copiadas de las notas o indicadores. "detalle": una oración de contexto.
- "grafico": sólo si la nota trae 3 o más cifras comparables (misma unidad). "barras" para comparar valores; "linea" para la evolución en el tiempo. Nunca inventes ni estimes valores.`;

function promptDiario(ins: Insumos) {
  const notas = ins.items
    .map((it) => `[${it.id}]${it.imagen ? "[foto]" : ""} (${it.fuente} · ${it.seccion}${it.fecha ? " · " + it.fecha : ""}) ${it.titulo}${it.resumen ? " — " + it.resumen : ""}`)
    .join("\n");
  const indicadores = ins.indicadores.length
    ? ins.indicadores.map((i) => `- ${i.grupo} · ${i.nombre}: ${i.valor}${i.var != null ? ` (${i.var > 0 ? "+" : ""}${i.var}%)` : ""}`).join("\n")
    : "(sin indicadores disponibles)";
  return `Fecha de la edición: ${ins.fecha} (Argentina).

Armá el briefing del día con estas notas publicadas en las últimas horas:
${notas}

Indicadores de mercado (fuente: APIs; podés mencionarlos tal cual):
${indicadores}

Seleccioná:
- 1 noticia "hero": la más importante del día para un lector argentino.
- 4 noticias "clave": las más urgentes, mezclando mundo, economía, Argentina y tecnología (al menos 1 de Argentina y 1 de tecnología si hay material).
- 2 noticias "feed": relevantes pero secundarias.
- 2 notas de "mercados": exclusivamente bursátiles o financieras (índices, acciones, CEDEARs, bonos, dólar, tasas, commodities).
- 5 "tendencias" de una línea (máximo 20 palabras cada una) sobre temas distintos de los anteriores.
Fotos: las notas marcadas [foto] traen la foto de cobertura del medio. En cada noticia incluí entre sus fuentes, si existe, una nota [foto] sobre ese MISMO hecho (de cualquier medio) y ponela primera: así cada noticia lleva una foto real del hecho.
No repitas el mismo tema en dos lugares. Publicá el resultado con la herramienta publicar_briefing.`;
}

function promptSemanal(notas: NotaSemana[], ins: Insumos) {
  const previas = notas.map((n) => `[${n.id}] (${n.fecha} · ${n.cat}) ${n.titulo} — ${n.que}`).join("\n");
  const hoy = ins.items.slice(0, 60).map((it) => `[${it.id}] (${it.fuente} · ${it.seccion}) ${it.titulo}`).join("\n");
  return `Hoy es jueves ${ins.fecha}. Escribí el "análisis semanal" de 5M News: los 5 temas que marcaron la semana y qué mirar en los próximos días.

Noticias publicadas en ediciones anteriores de esta semana:
${previas || "(no hay ediciones anteriores)"}

Titulares de hoy:
${hoy}

Para cada tema: título (máx. 12 palabras), resumen de 2 o 3 oraciones, "mirar" (1 oración sobre lo que viene) y los IDs que usaste (E… o F…).
Usá solo hechos presentes en ese material. Publicá con la herramienta publicar_semanal.`;
}

// ---------- Esquemas de las herramientas (salida estructurada) ----------

const textoNoticia = {
  titulo: { type: "string", description: "Máximo 12 palabras" },
  bajada: { type: "string", description: "Una sola oración" },
  que: { type: "string" },
  quien: { type: "string" },
  porque: { type: "string" },
  fuentes: { type: "array", items: { type: "string" }, description: 'IDs de las notas usadas, ej. ["F3","F17"]' },
  datos: {
    type: "array",
    maxItems: 3,
    items: {
      type: "object",
      required: ["label", "valor"],
      properties: {
        label: { type: "string", description: "2 a 4 palabras" },
        valor: { type: "string", description: 'Cifra corta, ej. "704 pb"' },
        delta: { type: "string", description: 'Variación, ej. "+4,5%"' },
        tendencia: { type: "string", enum: ["sube", "baja", "neutral"] },
        detalle: { type: "string", description: "Una oración de contexto" },
      },
    },
  },
  grafico: {
    type: "object",
    description: "Opcional. Sólo con cifras presentes en las notas.",
    required: ["tipo", "titulo"],
    properties: {
      tipo: { type: "string", enum: ["barras", "linea"] },
      titulo: { type: "string" },
      unidad: { type: "string", description: 'Ej. "%"' },
      puntos: { type: "array", items: { type: "object", required: ["label", "valor"], properties: { label: { type: "string" }, valor: { type: "number" } } } },
      etiquetas: { type: "array", items: { type: "string" } },
      series: { type: "array", items: { type: "object", required: ["nombre", "valores"], properties: { nombre: { type: "string" }, valores: { type: "array", items: { type: "number" } } } } },
    },
  },
};

const TOOL_DIARIO: Anthropic.Tool = {
  name: "publicar_briefing",
  description: "Publica el briefing diario de 5M News.",
  input_schema: {
    type: "object",
    required: ["noticias", "mercados", "tendencias"],
    properties: {
      noticias: {
        type: "array",
        items: {
          type: "object",
          required: ["rol", "cat", "titulo", "bajada", "que", "quien", "porque", "fuentes"],
          properties: { rol: { type: "string", enum: ["hero", "clave", "feed"] }, cat: { type: "string", enum: [...CATS_NOTICIA] }, ...textoNoticia },
        },
      },
      mercados: {
        type: "array",
        items: { type: "object", required: ["titulo", "bajada", "que", "quien", "porque", "fuentes"], properties: textoNoticia },
      },
      tendencias: {
        type: "array",
        items: {
          type: "object",
          required: ["cat", "label", "txt"],
          properties: { cat: { type: "string", enum: [...CATS_NOTICIA] }, label: { type: "string", description: "1 a 3 palabras" }, txt: { type: "string" } },
        },
      },
    },
  },
};

const TOOL_SEMANAL: Anthropic.Tool = {
  name: "publicar_semanal",
  description: "Publica el análisis semanal de 5M News.",
  input_schema: {
    type: "object",
    required: ["titulo", "intro", "temas"],
    properties: {
      titulo: { type: "string" },
      intro: { type: "string", description: "2 oraciones" },
      temas: {
        type: "array",
        items: {
          type: "object",
          required: ["cat", "titulo", "resumen", "mirar", "fuentes"],
          properties: {
            cat: { type: "string", enum: [...CATS_NOTICIA] },
            titulo: { type: "string" },
            resumen: { type: "string" },
            mirar: { type: "string" },
            fuentes: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
};

// ---------- Gemini (alternativa gratuita): se usa si hay GEMINI_API_KEY ----------

const GEMINI_DEFAULT = "gemini-flash-latest";
const usaGemini = () => !!Netlify.env.get("GEMINI_API_KEY");
/** Modelo que redacta (queda registrado en `generado.modelo`). */
const modeloActual = () =>
  usaGemini() ? Netlify.env.get("GEMINI_MODEL") || GEMINI_DEFAULT : Netlify.env.get("BRIEFING_MODEL") || MODELO_DEFAULT;

/** JSON Schema de la herramienta → esquema de Gemini (tipos en mayúscula, sólo las claves que acepta). */
function esquemaGemini(s: any): any {
  if (!s || typeof s !== "object") return s;
  const out: any = {};
  if (s.type) out.type = String(s.type).toUpperCase();
  for (const k of ["description", "enum", "format", "nullable", "maxItems", "minItems", "minimum", "maximum"]) if (s[k] !== undefined) out[k] = s[k];
  if (s.items) out.items = esquemaGemini(s.items);
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, esquemaGemini(v)]));
  if (s.required) out.required = s.required;
  return out;
}

/** Modelos a probar en orden: el configurado y, si está saturado o no existe, alternativas gratuitas. */
const modelosGemini = () => [...new Set([modeloActual(), "gemini-flash-lite-latest", "gemini-2.5-flash", "gemini-flash-latest"])];

async function llamarGemini(tool: Anthropic.Tool, prompt: string, timeoutMs: number, maxTokens: number) {
  const fin = Date.now() + timeoutMs;
  const errores: string[] = [];
  for (const modelo of modelosGemini()) {
    for (let intento = 1; intento <= 2; intento++) {
      const restante = fin - Date.now();
      if (restante < 5_000) break;
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": Netlify.env.get("GEMINI_API_KEY")! },
        signal: AbortSignal.timeout(Math.min(restante, 90_000)), // un modelo lento no se come todo el tiempo
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SISTEMA }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          tools: [{ functionDeclarations: [{ name: tool.name, description: tool.description, parameters: esquemaGemini(tool.input_schema) }] }],
          toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [tool.name] } },
          // Margen amplio: los modelos Flash "piensan" antes de responder y eso también cuenta como salida
          generationConfig: { temperature: 0.4, maxOutputTokens: Math.max(maxTokens * 3, 16_000) },
        }),
      }).catch((e) => e as Error);
      if (res instanceof Error) {
        errores.push(`${modelo}: ${res.message}`);
        break; // tardó demasiado: probar el siguiente modelo
      }
      const data = (await res.json().catch(() => ({}))) as any;
      if (res.ok) {
        const cand = data?.candidates?.[0];
        const llamada = (cand?.content?.parts ?? []).find((p: any) => p.functionCall)?.functionCall;
        if (llamada) {
          const u = data?.usageMetadata ?? {};
          return { input: llamada.args as any, usage: { input_tokens: u.promptTokenCount, output_tokens: u.candidatesTokenCount, modelo } as any };
        }
        errores.push(`${modelo}: no devolvió ${tool.name} (finishReason: ${cand?.finishReason ?? "?"})`);
        continue;
      }
      const msg = `${modelo} ${res.status}: ${String(data?.error?.message ?? "").slice(0, 160)}`;
      // Clave inválida o pedido mal formado: no tiene sentido probar otro modelo
      if (res.status === 400 && /api key/i.test(msg)) throw new Error(`Gemini ${msg}`);
      errores.push(msg);
      if (res.status === 404) break; // el modelo no existe: pasar al siguiente
      if (res.status === 429 || res.status >= 500) await new Promise((r) => setTimeout(r, 4_000 * intento)); // saturado: esperar y reintentar
    }
  }
  throw new Error(`Gemini no respondió: ${errores.join(" | ")}`);
}

async function llamarClaude(tool: Anthropic.Tool, prompt: string, timeoutMs: number, maxTokens: number) {
  if (usaGemini()) return llamarGemini(tool, prompt, timeoutMs, maxTokens);
  // Sin argumentos de credenciales: el AI Gateway inyecta ANTHROPIC_API_KEY y ANTHROPIC_BASE_URL.
  const client = new Anthropic({ timeout: timeoutMs, maxRetries: 0 });
  const res = await client.messages.create({
    model: Netlify.env.get("BRIEFING_MODEL") || MODELO_DEFAULT,
    max_tokens: maxTokens,
    system: SISTEMA,
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
    messages: [{ role: "user", content: prompt }],
  });
  const uso = res.content.find((c) => c.type === "tool_use");
  if (!uso || uso.type !== "tool_use") throw new Error(`El modelo no devolvió ${tool.name} (stop_reason: ${res.stop_reason})`);
  return { input: uso.input as any, usage: res.usage };
}

// ---------- Validación editorial ----------

/** Quita emojis y símbolos pictográficos (la web no los usa). */
export const sinEmojis = (s: string) =>
  s.replace(/(?![©®™])[\p{Extended_Pictographic}\u{FE0F}\u{20E3}\u{200D}]/gu, "").replace(/\s{2,}/g, " ").trim();
const limpio = (v: unknown) => sinEmojis(String(v ?? ""));

const palabras = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const primeraOracion = (s: string) => (s.trim().match(/^.+?[.!?](?=\s|$)/)?.[0] ?? s.trim());
const segundosLectura = (n: Pick<Noticia, "titulo" | "bajada" | "que" | "quien" | "porque">) =>
  Math.max(15, Math.round(((palabras([n.titulo, n.bajada, n.que, n.quien, n.porque].join(" ")) / 230) * 60) / 5) * 5);

function resolverFuentes(ids: unknown, mapa: Map<string, Fuente>): Fuente[] {
  const vistos = new Set<string>();
  const out: Fuente[] = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const f = mapa.get(String(id).trim().toUpperCase());
    if (f && !vistos.has(f.url)) {
      vistos.add(f.url);
      out.push(f);
    }
  }
  return out;
}

const medios = (f: Fuente[]) => new Set(f.map((x) => x.nombre)).size;
const textoValido = (n: any) =>
  ["titulo", "bajada", "que", "quien", "porque"].every((k) => typeof n?.[k] === "string" && n[k].trim().length > 0) &&
  palabras(n.titulo) <= 12;

const horaART = (d: Date) =>
  new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);

export const esJuevesART = (d = new Date()) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/Argentina/Buenos_Aires", weekday: "short" }).format(d) === "Thu";

// ---------- Cifras verificables ----------

/** Todos los números que aparecen en un texto (acepta 1.234,5 y 1,234.5). */
export function numerosEn(texto: string): Set<number> {
  const out = new Set<number>();
  for (const m of texto.matchAll(/\d[\d.,]*/g)) {
    const t = m[0].replace(/[.,]$/, "");
    const candidatos = [
      t.replace(/\./g, "").replace(",", "."), // formato es-AR
      t.replace(/,/g, ""), // formato en-US
    ];
    for (const c of candidatos) {
      const v = Number(c);
      if (Number.isFinite(v)) out.add(Math.round(v * 1000) / 1000);
    }
  }
  return out;
}
/** ¿Cada número de `texto` está en `disponibles`? */
const cifrasVerificadas = (texto: string, disponibles: Set<number>) => [...numerosEn(texto)].every((n) => disponibles.has(n));

function validarDatos(raw: unknown, disponibles: Set<number>, avisos: string[], titulo: string): DatoClave[] | undefined {
  const out: DatoClave[] = [];
  for (const d of Array.isArray(raw) ? raw.slice(0, 3) : []) {
    const label = limpio((d as any)?.label), valor = limpio((d as any)?.valor), delta = limpio((d as any)?.delta);
    if (!label || !valor || valor.length > 24) continue;
    if (!cifrasVerificadas(`${valor} ${delta}`, disponibles)) {
      avisos.push(`Dato descartado (cifra no verificable en las fuentes) en "${titulo}": ${label} ${valor}`);
      continue;
    }
    const tendencia = ["sube", "baja", "neutral"].includes((d as any)?.tendencia) ? (d as any).tendencia : "neutral";
    out.push({ label, valor, ...(delta ? { delta } : {}), tendencia, ...((d as any)?.detalle ? { detalle: limpio((d as any).detalle) } : {}) });
  }
  return out.length ? out : undefined;
}

function validarGrafico(g: any, disponibles: Set<number>, avisos: string[], titulo: string, fuentes: Fuente[]): Grafico | undefined {
  if (!g || typeof g !== "object") return undefined;
  const ok = (v: unknown) => typeof v === "number" && Number.isFinite(v) && disponibles.has(Math.round(Math.abs(v) * 1000) / 1000);
  const fuente = [...new Set(fuentes.map((f) => f.nombre))].join(" y ");
  if (g.tipo === "barras" && Array.isArray(g.puntos)) {
    const puntos = g.puntos.filter((p: any) => p?.label && typeof p.valor === "number").slice(0, 6).map((p: any) => ({ label: limpio(p.label), valor: p.valor }));
    if (puntos.length < 2 || !puntos.every((p: any) => ok(p.valor))) {
      avisos.push(`Gráfico descartado (cifras no verificables) en "${titulo}"`);
      return undefined;
    }
    return { tipo: "barras", titulo: limpio(g.titulo), unidad: limpio(g.unidad), signo: puntos.some((p: any) => p.valor < 0), puntos, fuente };
  }
  if (g.tipo === "linea" && Array.isArray(g.etiquetas) && Array.isArray(g.series)) {
    const n = g.etiquetas.length;
    const series = g.series.slice(0, 2).filter((s: any) => s?.nombre && Array.isArray(s.valores) && s.valores.length === n);
    if (n < 3 || !series.length || !series.every((s: any) => s.valores.every(ok))) {
      avisos.push(`Gráfico descartado (serie incompleta o no verificable) en "${titulo}"`);
      return undefined;
    }
    return { tipo: "linea", titulo: limpio(g.titulo), unidad: limpio(g.unidad), etiquetas: g.etiquetas.map(limpio), series: series.map((s: any) => ({ nombre: limpio(s.nombre), valores: s.valores })), fuente };
  }
  return undefined;
}

/** Convierte la salida del modelo en un Briefing válido o lanza un error explicando por qué no. */
export function armarBriefing(salida: any, ins: Insumos, semanal: Briefing["semanal"], ahora = new Date()): { briefing: Briefing; avisos: string[] } {
  const avisos: string[] = [];
  const mapa = new Map(ins.items.map((it) => [it.id, { nombre: it.fuente, url: it.url } as Fuente]));
  // Números disponibles por nota (las cifras de una noticia sólo pueden salir de SUS fuentes o de los indicadores)
  const textoPorUrl = new Map(ins.items.map((it) => [it.url, `${it.titulo} ${it.resumen}`]));
  const numsIndicadores = numerosEn(ins.indicadores.map((i) => `${i.valor} ${i.var ?? ""}`).join(" "));
  const disponiblesDe = (fuentes: Fuente[], extra: string) => {
    const set = numerosEn(fuentes.map((f) => textoPorUrl.get(f.url) ?? "").join(" ") + " " + extra);
    numsIndicadores.forEach((n) => set.add(n));
    return set;
  };

  type Cand = Omit<Noticia, "hora" | "seg"> & { rol: string };
  const candidatas: Cand[] = [];
  for (const n of Array.isArray(salida?.noticias) ? salida.noticias : []) {
    if (!textoValido(n) || !CATS_NOTICIA.includes(n.cat)) {
      avisos.push(`Descartada (formato/titular): ${n?.titulo}`);
      continue;
    }
    const fuentes = resolverFuentes(n.fuentes, mapa);
    if (!fuentes.length) {
      avisos.push(`Descartada (sin fuentes válidas): ${n.titulo}`);
      continue;
    }
    let rol = n.rol;
    if (rol !== "feed" && medios(fuentes) < 2) {
      avisos.push(`Pasa a "feed" (una sola fuente): ${n.titulo}`);
      rol = "feed";
    }
    const base = { rol, cat: n.cat, titulo: limpio(n.titulo), bajada: primeraOracion(limpio(n.bajada)), que: limpio(n.que), quien: limpio(n.quien), porque: limpio(n.porque), fuentes };
    const disp = disponiblesDe(fuentes, "");
    const datos = validarDatos(n.datos, disp, avisos, base.titulo);
    const grafico = validarGrafico(n.grafico, disp, avisos, base.titulo, fuentes);
    candidatas.push({ ...base, ...(datos ? { datos } : {}), ...(grafico ? { grafico } : {}) });
  }

  // Hero + 4 clave (completando con feed de 2+ fuentes si faltan) + feed
  const pool = [...candidatas];
  const tomar = (pred: (c: Cand) => boolean) => {
    const i = pool.findIndex(pred);
    return i >= 0 ? pool.splice(i, 1)[0] : undefined;
  };
  const hero = tomar((c) => c.rol === "hero") ?? tomar((c) => c.rol === "clave");
  const clave: Cand[] = [];
  while (clave.length < 4) {
    const c = tomar((x) => x.rol === "clave") ?? tomar((x) => medios(x.fuentes) >= 2);
    if (!c) break;
    clave.push(c);
  }
  // Días con poca cobertura cruzada (fines de semana, madrugada): antes que dejar el día sin edición,
  // se completan las 3 claves mínimas con notas de un solo medio (siguen siendo hechos citados y verificados).
  while (clave.length < 3 && pool.length) {
    const c = pool.shift()!;
    avisos.push(`Clave con una sola fuente (no había más cobertura cruzada): ${c.titulo}`);
    clave.push(c);
  }
  const feed = pool;
  if (!hero || clave.length < 3) throw new Error(`Material insuficiente: hero=${!!hero}, clave=${clave.length}. ${avisos.join(" | ")}`);

  const mercadosNotas: Noticia[] = [];
  for (const n of Array.isArray(salida?.mercados) ? salida.mercados : []) {
    const fuentes = textoValido(n) ? resolverFuentes(n.fuentes, mapa) : [];
    if (!fuentes.length) {
      avisos.push(`Nota de mercados descartada: ${n?.titulo}`);
      continue;
    }
    const disp = disponiblesDe(fuentes, "");
    const titulo = limpio(n.titulo);
    const datos = validarDatos(n.datos, disp, avisos, titulo);
    const grafico = validarGrafico(n.grafico, disp, avisos, titulo, fuentes);
    mercadosNotas.push({ cat: "mercados", hora: "", seg: 0, titulo, bajada: primeraOracion(limpio(n.bajada)), que: limpio(n.que), quien: limpio(n.quien), porque: limpio(n.porque), fuentes, ...(datos ? { datos } : {}), ...(grafico ? { grafico } : {}) });
  }

  // Horario de publicación y tiempos de lectura
  let minuto = 0;
  const conTiempos = (c: Omit<Noticia, "hora" | "seg">, extra: Partial<Noticia> = {}): Noticia => {
    const n: Noticia = { ...c, ...extra, fecha: ins.fecha, hora: horaART(new Date(ahora.getTime() - minuto * 60_000)), seg: segundosLectura(c) };
    minuto += 4;
    return n;
  };
  const sinRol = ({ rol, ...c }: Cand) => c;
  const noticias: Noticia[] = [conTiempos(sinRol(hero), { hero: true }), ...clave.map((c) => conTiempos(sinRol(c), { clave: true })), ...feed.map((c) => conTiempos(sinRol(c)))];
  let notasMercado = mercadosNotas.slice(0, 2).map((n) => conTiempos(n));

  // Menos de 5 minutos: primero se recorta el feed, después las notas de mercado
  const total = () => [...noticias, ...notasMercado].reduce((a, n) => a + n.seg, 0);
  while (total() > MAX_SEGUNDOS && noticias.length > 1 + clave.length) noticias.pop();
  while (total() > MAX_SEGUNDOS && notasMercado.length > 1) notasMercado = notasMercado.slice(0, -1);
  if (total() > MAX_SEGUNDOS) avisos.push(`Lectura total ${total()}s supera el objetivo de ${MAX_SEGUNDOS}s.`);

  const tendencias = (Array.isArray(salida?.tendencias) ? salida.tendencias : [])
    .filter((t: any) => t?.label && t?.txt && CATS_NOTICIA.includes(t.cat))
    .slice(0, 5)
    .map((t: any) => ({ cat: t.cat, label: limpio(t.label), txt: limpio(t.txt) }));

  const fuentesDatos: Fuente[] = [];
  const grupos = new Set(ins.indicadores.map((i) => i.grupo));
  if (grupos.has("Wall Street") || grupos.has("Commodities")) fuentesDatos.push({ nombre: "Financial Modeling Prep", url: "https://financialmodelingprep.com" });
  if (grupos.has("Dólar")) fuentesDatos.push({ nombre: "DolarApi", url: "https://dolarapi.com" });
  if (grupos.has("Argentina")) fuentesDatos.push({ nombre: "ArgentinaDatos", url: "https://argentinadatos.com" });

  const briefing: Briefing = {
    edicion: ins.fecha,
    noticias,
    mercados: {
      nota: `Valores al momento de la edición (${horaART(new Date(ins.recolectado))} hs, hora argentina). El riesgo país corresponde al último cierre publicado.`,
      indicadores: ins.indicadores,
      noticias: notasMercado,
      fuentesDatos,
    },
    tendencias,
    semanal,
    generado: { at: ahora.toISOString(), modelo: modeloActual(), notasFuente: ins.items.length, avisos },
  };
  return { briefing, avisos };
}

function armarSemanal(salida: any, notas: NotaSemana[], ins: Insumos): Briefing["semanal"] {
  const mapa = new Map<string, Fuente>(ins.items.map((it) => [it.id, { nombre: it.fuente, url: it.url }]));
  const multiples = new Map(notas.map((n) => [n.id, n.fuentes]));
  const temas: TemaSemanal[] = [];
  for (const t of Array.isArray(salida?.temas) ? salida.temas : []) {
    if (!t?.titulo || !t?.resumen || palabras(t.titulo) > 12 || !CATS_NOTICIA.includes(t.cat)) continue;
    const fuentes: Fuente[] = [];
    for (const id of Array.isArray(t.fuentes) ? t.fuentes : []) {
      const k = String(id).trim().toUpperCase();
      fuentes.push(...(multiples.get(k) ?? (mapa.get(k) ? [mapa.get(k)!] : [])));
    }
    const unicas = [...new Map(fuentes.map((f) => [f.url, f])).values()].slice(0, 3);
    if (unicas.length) temas.push({ cat: t.cat, titulo: limpio(t.titulo), resumen: limpio(t.resumen), mirar: limpio(t.mirar), fuentes: unicas });
  }
  if (temas.length < 3) throw new Error(`Análisis semanal con pocos temas válidos (${temas.length}).`);
  return { titulo: limpio(salida.titulo) || "La semana en 5 claves", intro: limpio(salida.intro), temas: temas.slice(0, 5) };
}

const TOOL_ACORTAR: Anthropic.Tool = {
  name: "acortar_titulares",
  description: "Devuelve los titulares reescritos con 12 palabras o menos.",
  input_schema: {
    type: "object",
    required: ["titulares"],
    properties: { titulares: { type: "array", items: { type: "object", required: ["id", "titulo"], properties: { id: { type: "integer" }, titulo: { type: "string" } } } } },
  },
};

/** Reescribe en el lugar los titulares de más de 12 palabras (noticias y mercados). Devuelve cuántos corrigió. */
async function acortarTitulares(salida: any, timeoutMs: number): Promise<number> {
  const notas: any[] = [...(Array.isArray(salida?.noticias) ? salida.noticias : []), ...(Array.isArray(salida?.mercados) ? salida.mercados : [])];
  const largas = notas.map((n, id) => ({ n, id })).filter(({ n }) => typeof n?.titulo === "string" && palabras(n.titulo) > 12);
  if (!largas.length) return 0;
  const lista = largas.map(({ n, id }) => `${id}. ${n.titulo}`).join("\n");
  const { input } = await llamarClaude(TOOL_ACORTAR,
    `Reescribí cada titular con 12 palabras como máximo (contá las palabras), sin cambiar los hechos ni agregar datos. Mantené el id.\n${lista}`,
    Math.min(timeoutMs, 30_000), 800);
  let corregidos = 0;
  for (const t of Array.isArray(input?.titulares) ? input.titulares : []) {
    const nota = notas[Number(t?.id)];
    const nuevo = limpio(t?.titulo);
    if (nota && largas.some((l) => l.n === nota) && nuevo && palabras(nuevo) <= 12) {
      nota.titulo = nuevo;
      corregidos++;
    }
  }
  return corregidos;
}

/** Genera el briefing del día (y el análisis semanal si es jueves) en llamadas paralelas al modelo. */
export async function generarBriefing(
  ins: Insumos,
  opts: { semanalPrevio: Briefing["semanal"]; notasSemana: NotaSemana[]; timeoutMs: number; forzarSemanal?: boolean; conSemanal?: boolean },
) {
  const conSemanal = opts.forzarSemanal || (opts.conSemanal ?? esJuevesART());
  const [diario, semanal] = await Promise.all([
    llamarClaude(TOOL_DIARIO, promptDiario(ins), opts.timeoutMs, 6500),
    conSemanal ? llamarClaude(TOOL_SEMANAL, promptSemanal(opts.notasSemana, ins), opts.timeoutMs, 2500).catch((e) => e as Error) : Promise.resolve(null),
  ]);

  const avisosExtra: string[] = [];
  // Titulares de más de 12 palabras: se piden acortados en una llamada chica en vez de descartar la noticia
  // (descartarlos dejaba el briefing sin material suficiente y la edición no se publicaba).
  try {
    const n = await acortarTitulares(diario.input, opts.timeoutMs);
    if (n) avisosExtra.push(`Titulares acortados a 12 palabras: ${n}`);
  } catch (e) {
    avisosExtra.push(`No se pudieron acortar titulares: ${(e as Error).message}`);
  }

  let semanalFinal = opts.semanalPrevio;
  if (semanal instanceof Error) avisosExtra.push(`Semanal no generado: ${semanal.message}`);
  else if (semanal) {
    try {
      semanalFinal = armarSemanal(semanal.input, opts.notasSemana, ins);
    } catch (e) {
      avisosExtra.push((e as Error).message);
    }
  }

  const { briefing, avisos } = armarBriefing(diario.input, ins, semanalFinal);
  return { briefing, avisos: [...avisos, ...avisosExtra], usage: diario.usage, semanalNuevo: semanalFinal !== opts.semanalPrevio };
}
