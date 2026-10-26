// Reemplazo de @netlify/blobs para correr fuera de Netlify: misma interfaz (getStore → get/set/setJSON/delete/list),
// datos en una tabla de Supabase (public.blobs: store, key, value). El build de Render lo inyecta con
// `--alias:@netlify/blobs=./render/blobs-supabase.mts`, así el código de netlify/ no cambia.
// Sin SUPABASE_URL/SUPABASE_SECRET_KEY delega en el Netlify Blobs real (NETLIFY_SITE_ID + NETLIFY_BLOBS_TOKEN).

type Opciones = { name: string; consistency?: "eventual" | "strong"; siteID?: string; token?: string };
type Lectura = { type?: "text" | "json" | "arrayBuffer" | "blob" | "stream"; consistency?: string };
type Escritura = { onlyIfNew?: boolean; onlyIfMatch?: string; metadata?: Record<string, unknown> };

export interface Store {
  get(key: string, opts?: Lectura): Promise<any>;
  set(key: string, value: string | ArrayBuffer | Blob, opts?: Escritura): Promise<{ modified: boolean }>;
  setJSON(key: string, value: unknown, opts?: Escritura): Promise<{ modified: boolean }>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string }): Promise<{ blobs: { key: string; etag: string }[]; directories: string[] }>;
}

const URL_BASE = () => (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const CLAVE = () => process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
export const usaSupabase = () => !!URL_BASE() && !!CLAVE();

/** Las claves nuevas (sb_secret_…) van sólo en `apikey`; las viejas (JWT service_role) también como Bearer. */
const cabeceras = (extra: Record<string, string> = {}) => {
  const k = CLAVE();
  return { apikey: k, ...(k.startsWith("sb_") ? {} : { authorization: `Bearer ${k}` }), ...extra };
};

async function rest(metodo: string, params: Record<string, string>, body?: unknown, prefer?: string) {
  const url = `${URL_BASE()}/rest/v1/${process.env.SUPABASE_TABLE || "blobs"}?${new URLSearchParams(params)}`;
  for (let intento = 1; ; intento++) {
    const res = await fetch(url, {
      method: metodo,
      headers: cabeceras({ ...(body ? { "content-type": "application/json" } : {}), ...(prefer ? { prefer } : {}) }),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    }).catch((e) => e as Error);
    if (res instanceof Response && res.ok) return res;
    // Reintentos ante cortes de red o errores 5xx (igual que la librería de Netlify)
    const reintentable = !(res instanceof Response) || res.status >= 500 || res.status === 429;
    if (!reintentable || intento >= 3) {
      const detalle = res instanceof Response ? `${res.status} ${(await res.text()).slice(0, 200)}` : res.message;
      throw new Error(`Supabase (${metodo} blobs): ${detalle}`);
    }
    await new Promise((r) => setTimeout(r, 300 * intento));
  }
}

const escaparLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function storeSupabase(nombre: string): Store {
  const filtro = (key: string) => ({ store: `eq.${nombre}`, key: `eq.${key}` });
  const set = async (key: string, value: string | ArrayBuffer | Blob, opts: Escritura = {}) => {
    const texto = typeof value === "string" ? value : value instanceof Blob ? await value.text() : new TextDecoder().decode(value);
    const fila = [{ store: nombre, key, value: texto, updated_at: new Date().toISOString() }];
    const res = await rest("POST", { on_conflict: "store,key" }, fila,
      `resolution=${opts.onlyIfNew ? "ignore" : "merge"}-duplicates,return=representation`);
    const filas = (await res.json()) as unknown[];
    return { modified: filas.length > 0 };
  };
  return {
    async get(key, opts = {}) {
      const res = await rest("GET", { select: "value", ...filtro(key), limit: "1" });
      const [fila] = (await res.json()) as { value: string }[];
      if (!fila) return null;
      if (opts.type === "json") return JSON.parse(fila.value);
      if (opts.type === "arrayBuffer") return new TextEncoder().encode(fila.value).buffer;
      if (opts.type === "blob") return new Blob([fila.value]);
      return fila.value;
    },
    set,
    setJSON: (key, value, opts) => set(key, JSON.stringify(value), opts),
    async delete(key) {
      await rest("DELETE", filtro(key), undefined, "return=minimal");
    },
    async list({ prefix = "" } = {}) {
      const claves: string[] = [];
      for (let desde = 0; ; desde += 1000) {
        const params: Record<string, string> = { select: "key", store: `eq.${nombre}`, order: "key", limit: "1000", offset: String(desde) };
        if (prefix) params.key = `like.${escaparLike(prefix)}*`;
        const filas = (await (await rest("GET", params)).json()) as { key: string }[];
        claves.push(...filas.map((f) => f.key));
        if (filas.length < 1000) break;
      }
      return { blobs: claves.map((key) => ({ key, etag: "" })), directories: [] };
    },
  };
}

// Netlify Blobs real (import dinámico para que el alias del build no lo reemplace)
const NETLIFY_BLOBS = ["@netlify", "blobs"].join("/");
let netlifyReal: Promise<any> | undefined;
export const netlifyBlobsReal = () => (netlifyReal ??= import(NETLIFY_BLOBS));

function storeNetlify(opts: Opciones): Store {
  const store = netlifyBlobsReal().then((m) => m.getStore(opts));
  return {
    get: (k, o) => store.then((s) => s.get(k, o)),
    set: (k, v, o) => store.then((s) => s.set(k, v, o)),
    setJSON: (k, v, o) => store.then((s) => s.setJSON(k, v, o)),
    delete: (k) => store.then((s) => s.delete(k)),
    list: (o) => store.then((s) => s.list(o)),
  };
}

export function getStore(opts: string | Opciones): Store {
  const o = typeof opts === "string" ? { name: opts } : opts;
  return usaSupabase() ? storeSupabase(o.name) : storeNetlify(o);
}
