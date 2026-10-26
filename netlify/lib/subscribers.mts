import { getStore } from "@netlify/blobs";

export interface Subscriber {
  email: string;
  /** Resumen diario, lunes a viernes 7:00 AM (ART) */
  daily: boolean;
  /** Análisis compilado, jueves */
  weekly: boolean;
  confirmed: boolean;
  /** Token secreto para confirmar y darse de baja */
  token: string;
  segment: "beta-interna";
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Suscriptores (site-wide, consistencia fuerte para leer lo recién escrito). */
export const subscribersStore = () => getStore({ name: "newsletter-subscribers", consistency: "strong" });
/** Registro de envíos, para no mandar dos veces la misma edición. */
export const sendLogStore = () => getStore({ name: "newsletter-send-log", consistency: "strong" });

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
const keyFor = (email: string) => encodeURIComponent(normalizeEmail(email));

export async function getSubscriber(email: string): Promise<Subscriber | null> {
  return (await subscribersStore().get(keyFor(email), { type: "json" })) as Subscriber | null;
}

export async function saveSubscriber(sub: Subscriber) {
  await subscribersStore().setJSON(keyFor(sub.email), sub);
}

export async function deleteSubscriber(email: string) {
  await subscribersStore().delete(keyFor(email));
}

export async function listSubscribers(): Promise<Subscriber[]> {
  const store = subscribersStore();
  const { blobs } = await store.list();
  const subs = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }) as Promise<Subscriber | null>));
  return subs.filter((s): s is Subscriber => s !== null);
}

/** Compara tokens en tiempo constante. */
export function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Busca y valida email + token de un enlace (confirmación / baja). */
export async function verifyLink(url: URL) {
  const email = url.searchParams.get("email") ?? "";
  const token = url.searchParams.get("token") ?? "";
  if (!EMAIL_RE.test(email) || !token) return null;
  const sub = await getSubscriber(email);
  return sub && safeEqual(sub.token, token) ? sub : null;
}
