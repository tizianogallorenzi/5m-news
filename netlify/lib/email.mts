import type { Briefing, Categoria, Fuente } from "./briefing.mts";
import type { Subscriber } from "./subscribers.mts";

// ---------- Envío ----------
// Proveedor: Brevo si BREVO_API_KEY está cargada (permite enviar a cualquier destinatario con un
// remitente verificado, ej. un Gmail); si no, Resend (en modo prueba sólo envía al dueño de la cuenta).

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

// *_API_BASE sólo se usan en pruebas locales (servidor falso).
const resendApi = () => Netlify.env.get("RESEND_API_BASE") || "https://api.resend.com";
const brevoApi = () => Netlify.env.get("BREVO_API_BASE") || "https://api.brevo.com";

/** Clave de Brevo válida (formato xkeysib-…). Un valor vacío o de prueba se ignora para no cortar los envíos. */
const claveBrevo = () => {
  const k = (Netlify.env.get("BREVO_API_KEY") || "").trim();
  return /^xkeysib-[a-z0-9-]{20,}$/i.test(k) ? k : "";
};
export const proveedorEmail = () => (claveBrevo() ? "brevo" : Netlify.env.get("RESEND_API_KEY") ? "resend" : null);
export const emailConfigured = () => proveedorEmail() !== null;

const fromAddress = () => Netlify.env.get("EMAIL_FROM") || "5M News <onboarding@resend.dev>";

/** "5M News <yo@gmail.com>" → { name, email } */
function remitenteBrevo() {
  const raw = Netlify.env.get("BREVO_SENDER") || "";
  const m = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  const email = (m ? m[2] : raw).trim();
  if (!email) throw new Error("Falta la variable de entorno BREVO_SENDER (ej. 5M News <tu@gmail.com>)");
  return { name: (m && m[1]) || "5M News", email };
}

async function brevo(m: OutgoingEmail) {
  const res = await fetch(brevoApi() + "/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": claveBrevo(), "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: remitenteBrevo(),
      to: [{ email: m.to }],
      subject: m.subject,
      htmlContent: m.html,
      textContent: m.text,
      ...(m.headers ? { headers: m.headers } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${await res.text()}`);
  return res.json();
}

async function resend(path: string, body: unknown) {
  const key = Netlify.env.get("RESEND_API_KEY");
  if (!key) throw new Error("Falta la variable de entorno RESEND_API_KEY");
  const res = await fetch(resendApi() + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return res.json();
}

const toResend = (m: OutgoingEmail) => ({
  from: fromAddress(),
  to: [m.to],
  subject: m.subject,
  html: m.html,
  text: m.text,
  headers: m.headers,
});

/** Si Brevo rechaza la clave o la cuenta (401/403), se reintenta por Resend para no perder el envío. */
async function brevoConRespaldo(m: OutgoingEmail) {
  try {
    return await brevo(m);
  } catch (e) {
    const msg = (e as Error).message;
    if (/^Brevo (401|403)/.test(msg) && Netlify.env.get("RESEND_API_KEY")) {
      console.error("[email] Brevo rechazó el envío, se usa Resend:", msg);
      return resend("/emails", toResend(m));
    }
    throw e;
  }
}

export async function sendEmail(m: OutgoingEmail) {
  if (proveedorEmail() === "brevo") return brevoConRespaldo(m);
  return resend("/emails", toResend(m));
}

/** Envía todos los mensajes. Devuelve cuántos se aceptaron y los errores. */
export async function sendBatch(messages: OutgoingEmail[]) {
  let sent = 0;
  const errors: string[] = [];
  if (proveedorEmail() === "brevo") {
    // Brevo: un pedido por destinatario, de a 5 en paralelo (cada email lleva su enlace de baja)
    for (let i = 0; i < messages.length; i += 5) {
      const lote = await Promise.allSettled(messages.slice(i, i + 5).map(brevoConRespaldo));
      for (const r of lote) r.status === "fulfilled" ? sent++ : errors.push((r.reason as Error).message);
    }
    return { sent, errors };
  }
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      await resend("/emails/batch", chunk.map(toResend));
      sent += chunk.length;
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return { sent, errors };
}

// ---------- Plantillas ----------

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const C = {
  ink: "#111214",
  paper: "#FFFFFF",
  line: "#E5E7EB",
  muted: "#5B606B",
  pulse: "#E5372A",
  timer: "#F2A93B",
  soft: "#FFFFFF",
};
const CATS: Record<Categoria, { label: string; color: string }> = {
  mundo: { label: "Mundo", color: "#2563EB" },
  economia: { label: "Economía", color: "#0F9D6B" },
  argentina: { label: "Argentina", color: "#4A9FD8" },
  tech: { label: "Tech", color: "#7C3AED" },
  mercados: { label: "Mercados", color: "#B45309" },
};
const SERIF = "Georgia,'Times New Roman',serif";
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const fmtSeg = (s: number) => (s < 60 ? `${s} seg` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} min`);
const fechaLarga = (iso: string) => {
  const f = new Intl.DateTimeFormat("es-AR", { timeZone: "UTC", dateStyle: "full" }).format(new Date(iso + "T12:00:00Z"));
  return f.charAt(0).toUpperCase() + f.slice(1);
};

const kicker = (cat: Categoria) =>
  `<span style="font:700 11px/1 ${SANS};letter-spacing:.12em;text-transform:uppercase;color:${CATS[cat].color}">● ${CATS[cat].label}</span>`;

const fuentesHtml = (f: Fuente[]) =>
  `<p style="margin:12px 0 0;font:12px/1.5 ${SANS};color:${C.muted}"><b style="color:${C.ink}">Fuentes:</b> ${f
    .map((x) => `<a href="${esc(x.url)}" target="_blank" style="color:${C.muted};text-decoration:underline">${esc(x.nombre)}</a>`)
    .join(" | ")}</p>`;

interface LinkSet {
  site: string;
  unsubscribe: string;
}

export function linksFor(siteUrl: string, sub: Pick<Subscriber, "email" | "token">): LinkSet {
  const q = `email=${encodeURIComponent(sub.email)}&token=${encodeURIComponent(sub.token)}`;
  return { site: siteUrl, unsubscribe: `${siteUrl}/api/unsubscribe?${q}` };
}

/** Encabezados para que Gmail/Outlook muestren el botón nativo "Cancelar suscripción". */
export const unsubscribeHeaders = (url: string) => ({
  "List-Unsubscribe": `<${url}>`,
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
});

function layout(opts: { preheader: string; body: string; footer: string; siteUrl: string }) {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>5M News</title></head>
<body style="margin:0;padding:0;background:${C.paper}">
<span style="display:none!important;opacity:0;color:transparent;height:0;width:0;overflow:hidden">${esc(opts.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.paper}">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
  <tr><td style="padding:0 4px 16px">
    <a href="${esc(opts.siteUrl)}" style="text-decoration:none">
      <span style="display:inline-block;background:${C.pulse};color:#fff;font:700 18px/1 ${SERIF};padding:9px 8px;border-radius:8px">5M</span>
      <span style="font:700 22px/1 ${SERIF};color:${C.ink};vertical-align:middle;margin-left:6px">5M <span style="color:${C.pulse}">News</span></span>
    </a>
  </td></tr>
  ${opts.body}
  <tr><td style="padding:24px 4px 0;font:12px/1.6 ${SANS};color:${C.muted}">${opts.footer}</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

const card = (inner: string, pad = 24) =>
  `<tr><td style="padding:0 0 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid ${C.line};border-radius:16px"><tr><td style="padding:${pad}px">${inner}</td></tr></table></td></tr>`;

const button = (href: string, label: string) =>
  `<a href="${esc(href)}" style="display:inline-block;background:${C.pulse};color:#fff;font:600 15px/1 ${SANS};padding:14px 24px;border-radius:999px;text-decoration:none">${esc(label)}</a>`;

const prefsLine = (sub: Pick<Subscriber, "daily" | "weekly">) =>
  [sub.daily && "briefing diario (7:00 AM)", sub.weekly && "resumen de los jueves (7:00 PM)"].filter(Boolean).join(" y ");

function footer(sub: Pick<Subscriber, "daily" | "weekly">, links: LinkSet) {
  return `Recibís este email porque te suscribiste a 5M News (etapa de prueba interna): ${prefsLine(sub)}.<br>
<a href="${esc(links.unsubscribe)}" style="color:${C.muted}">Darte de baja</a> · <a href="${esc(links.site)}" style="color:${C.muted}">5M News</a>`;
}

// --- Confirmación (doble opt-in)

export function confirmationEmail(sub: Subscriber, siteUrl: string): OutgoingEmail {
  const confirmUrl = `${siteUrl}/api/confirm?email=${encodeURIComponent(sub.email)}&token=${encodeURIComponent(sub.token)}`;
  const body = card(`
    <h1 style="margin:0 0 12px;font:700 26px/1.25 ${SERIF};color:${C.ink}">Confirmá tu suscripción</h1>
    <p style="margin:0 0 20px;font:16px/1.6 ${SANS};color:${C.ink}">Un clic y quedás adentro. Vas a recibir: <b>${prefsLine(sub)}</b>.</p>
    ${button(confirmUrl, "Confirmar suscripción")}
    <p style="margin:20px 0 0;font:13px/1.6 ${SANS};color:${C.muted}">Si no fuiste vos, ignorá este email: no te vamos a escribir de nuevo.</p>`);
  return {
    to: sub.email,
    subject: "Confirmá tu suscripción a 5M News",
    html: layout({
      preheader: "Un clic para empezar a recibir tu briefing.",
      body,
      siteUrl,
      footer: "5M News · El mundo, informado en menos de 5 minutos.",
    }),
    text: `Confirmá tu suscripción a 5M News (${prefsLine(sub)}):\n${confirmUrl}\n\nSi no fuiste vos, ignorá este email.`,
  };
}

// --- Bloque "Mercados" (dentro del resumen diario)

function marketsBlock(m: NonNullable<Briefing["mercados"]>) {
  const pct = (v: number) => `${v > 0 ? "▲" : v < 0 ? "▼" : "■"} ${Math.abs(v).toFixed(2).replace(".", ",")}%`;
  const filas = m.indicadores
    .map((ind) => {
      const color = ind.var == null ? C.muted : ind.var > 0 ? "#047857" : ind.var < 0 ? "#DC2626" : C.muted;
      const cambio = ind.var == null ? esc(ind.detalle ?? "") : pct(ind.var);
      return `<tr>
        <td style="padding:8px 0;border-bottom:1px solid ${C.line};font:14px/1.3 ${SANS};color:${C.ink}">${esc(ind.nombre)}<br><span style="font:11px ${SANS};color:${C.muted}">${esc(ind.grupo)} · ${esc(ind.hora)}</span></td>
        <td align="right" style="padding:8px 0;border-bottom:1px solid ${C.line};font:700 14px/1.3 ${SANS};color:${C.ink}">${esc(ind.valor)}<br><span style="font:600 12px ${SANS};color:${color}">${cambio}</span></td>
      </tr>`;
    })
    .join("");
  const tabla = card(`
    <p style="margin:0 0 6px;font:700 11px/1 ${SANS};letter-spacing:.12em;text-transform:uppercase;color:${CATS.mercados.color}">📈 Mercados</p>
    <p style="margin:0 0 10px;font:12px/1.5 ${SANS};color:${C.muted}">${esc(m.nota)}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${filas}</table>
    ${m.fuentesDatos ? fuentesHtml(m.fuentesDatos).replace("Fuentes:", "Datos:") : ""}`);
  const notas = m.noticias
    .map((n) =>
      card(`
        ${kicker(n.cat)} <span style="font:600 11px/1 ${SANS};color:${C.muted}">· ⏱️ ${fmtSeg(n.seg)}</span>
        <h2 style="margin:10px 0 6px;font:700 18px/1.25 ${SERIF};color:${C.ink}">${esc(n.titulo)}</h2>
        <p style="margin:0 0 10px;font:14px/1.55 ${SANS};color:${C.ink}"><b>📍 ¿Qué pasó?</b> ${esc(n.que)}</p>
        <p style="margin:0;font:14px/1.55 ${SANS};color:${C.ink}"><b>⚡ ¿Por qué importa?</b> ${esc(n.porque)}</p>
        ${fuentesHtml(n.fuentes)}`, 20),
    )
    .join("");
  return tabla + notas;
}

// --- Resumen diario

export function dailyEmail(b: Briefing, sub: Subscriber, siteUrl: string): OutgoingEmail {
  const links = linksFor(siteUrl, sub);
  const ordenadas = [...b.noticias].sort((x, y) => Number(!!y.hero) - Number(!!x.hero));
  const mercados = b.mercados;
  const todas = [...b.noticias, ...(mercados?.noticias ?? [])];
  const total = todas.reduce((a, n) => a + n.seg, 0);

  const intro = `
<tr><td style="padding:0 4px 16px">
  <p style="margin:0;font:700 11px/1 ${SANS};letter-spacing:.12em;text-transform:uppercase;color:${C.muted}">${esc(fechaLarga(b.edicion))}</p>
  <h1 style="margin:8px 0 8px;font:700 30px/1.15 ${SERIF};color:${C.ink}">Buen día. Esto es lo que tenés que saber.</h1>
  <span style="display:inline-block;background:#FFFFFF;border:1px solid #FCD34D;color:#92400E;font:600 12px/1 ${SANS};padding:6px 10px;border-radius:999px">⏱️ ${todas.length} noticias · ${fmtSeg(total)} de lectura</span>
</td></tr>`;

  const items = ordenadas
    .map((n, i) => {
      const puntos = [
        ["📍", "¿Qué pasó?", n.que],
        ["👥", "¿A quién afecta?", n.quien],
        ["⚡", "¿Por qué importa hoy?", n.porque],
      ]
        .map(
          ([e, t, d]) =>
            `<p style="margin:0 0 8px;font:14px/1.55 ${SANS};color:${C.ink}"><b>${e} ${t}</b> ${esc(d)}</p>`,
        )
        .join("");
      return card(`
        ${i === 0 ? `<p style="margin:0 0 10px;font:700 11px/1 ${SANS};letter-spacing:.12em;text-transform:uppercase;color:${C.pulse}">El Brief de Hoy</p>` : ""}
        ${kicker(n.cat)} <span style="font:600 11px/1 ${SANS};color:${C.muted}">· ⏱️ ${fmtSeg(n.seg)}</span>
        <h2 style="margin:10px 0 6px;font:700 ${i === 0 ? 24 : 20}px/1.25 ${SERIF};color:${C.ink}">${esc(n.titulo)}</h2>
        <p style="margin:0 0 14px;font:15px/1.55 ${SANS};color:${C.muted}">${esc(n.bajada)}</p>
        <div style="background:${C.soft};border:1px solid ${C.line};border-radius:12px;padding:14px 14px 6px">${puntos}</div>
        ${fuentesHtml(n.fuentes)}`);
    })
    .join("");

  const mercadosHtml = mercados ? marketsBlock(mercados) : "";

  const cta = `<tr><td align="center" style="padding:8px 0 0">${button(siteUrl, "Ver el briefing en la web")}</td></tr>`;

  const text = [
    `5M News — ${fechaLarga(b.edicion)}`,
    `${todas.length} noticias · ${fmtSeg(total)} de lectura`,
    "",
    ...ordenadas.map(
      (n) =>
        `■ [${CATS[n.cat].label}] ${n.titulo}\n${n.bajada}\n📍 ¿Qué pasó? ${n.que}\n👥 ¿A quién afecta? ${n.quien}\n⚡ ¿Por qué importa hoy? ${n.porque}\nFuentes: ${n.fuentes.map((f) => `${f.nombre} (${f.url})`).join(" | ")}\n`,
    ),
    ...(mercados
      ? [
          "📈 MERCADOS",
          mercados.nota,
          ...mercados.indicadores.map((m) => `${m.nombre}: ${m.valor}${m.var != null ? ` (${m.var > 0 ? "+" : ""}${m.var}%)` : ""} · ${m.hora}`),
          "",
          ...mercados.noticias.map((n) => `■ ${n.titulo}\n${n.que}\n⚡ ${n.porque}\n`),
        ]
      : []),
    `Web: ${siteUrl}`,
    `Darte de baja: ${links.unsubscribe}`,
  ].join("\n");

  const hero = ordenadas[0];
  return {
    to: sub.email,
    subject: `☕ ${hero.titulo}`,
    html: layout({ preheader: hero.bajada, body: intro + items + mercadosHtml + cta, siteUrl, footer: footer(sub, links) }),
    text,
    headers: unsubscribeHeaders(links.unsubscribe),
  };
}

// --- Análisis semanal (jueves)

export function weeklyEmail(b: Briefing, sub: Subscriber, siteUrl: string): OutgoingEmail {
  const links = linksFor(siteUrl, sub);
  const s = b.semanal;

  const intro = card(`
    <p style="margin:0 0 10px;font:700 11px/1 ${SANS};letter-spacing:.12em;text-transform:uppercase;color:${C.pulse}">Resumen de los Jueves</p>
    <h1 style="margin:0 0 12px;font:700 28px/1.2 ${SERIF};color:${C.ink}">${esc(s.titulo)}</h1>
    <p style="margin:0;font:16px/1.6 ${SANS};color:${C.ink}">${esc(s.intro)}</p>`);

  const temas = s.temas
    .map((t, i) =>
      card(`
        <span style="font:700 13px/1 ${SANS};color:${C.muted}">${String(i + 1).padStart(2, "0")}</span>&nbsp; ${kicker(t.cat)}
        <h2 style="margin:10px 0 8px;font:700 20px/1.25 ${SERIF};color:${C.ink}">${esc(t.titulo)}</h2>
        <p style="margin:0 0 12px;font:15px/1.6 ${SANS};color:${C.ink}">${esc(t.resumen)}</p>
        <p style="margin:0;background:${C.soft};border:1px solid ${C.line};border-radius:10px;padding:10px 12px;font:14px/1.5 ${SANS};color:${C.ink}"><b>👀 Qué mirar:</b> ${esc(t.mirar)}</p>
        ${fuentesHtml(t.fuentes)}`),
    )
    .join("");

  const text = [
    `5M News — Resumen de los Jueves`,
    s.titulo,
    "",
    s.intro,
    "",
    ...s.temas.map(
      (t, i) =>
        `${i + 1}. [${CATS[t.cat].label}] ${t.titulo}\n${t.resumen}\nQué mirar: ${t.mirar}\nFuentes: ${t.fuentes.map((f) => `${f.nombre} (${f.url})`).join(" | ")}\n`,
    ),
    `Web: ${siteUrl}`,
    `Darte de baja: ${links.unsubscribe}`,
  ].join("\n");

  return {
    to: sub.email,
    subject: `📊 ${s.titulo}`,
    html: layout({
      preheader: s.intro,
      body: intro + temas + `<tr><td align="center" style="padding:8px 0 0">${button(siteUrl, "Ir a 5M News")}</td></tr>`,
      siteUrl,
      footer: footer(sub, links),
    }),
    text,
    headers: unsubscribeHeaders(links.unsubscribe),
  };
}
