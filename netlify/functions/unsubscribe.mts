import type { Config } from "@netlify/functions";
import { deleteSubscriber, verifyLink } from "../lib/subscribers.mts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * GET  → página con botón "Confirmar baja" (evita bajas accidentales por antivirus que abren enlaces).
 * POST → da de baja. También atiende el "one-click" de Gmail/Outlook (List-Unsubscribe-Post).
 */
export default async (req: Request) => {
  const url = new URL(req.url);
  const sub = await verifyLink(url);

  if (req.method === "POST") {
    if (sub) await deleteSubscriber(sub.email);
    const oneClick = (await req.text()).includes("List-Unsubscribe=One-Click");
    if (oneClick) return new Response("OK");
    return Response.redirect(new URL(sub ? "/?suscripcion=baja" : "/?suscripcion=invalida", url), 303);
  }

  if (!sub) return Response.redirect(new URL("/?suscripcion=invalida", url), 302);

  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Darte de baja · 5M News</title><meta name="robots" content="noindex"></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#FFFFFF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111214">
<main style="max-width:420px;margin:24px;padding:32px;background:#fff;border:1px solid #E5E7EB;border-radius:16px;text-align:center">
  <p style="margin:0 0 16px"><span style="background:#E5372A;color:#fff;font:700 18px Georgia,serif;padding:8px 7px;border-radius:8px">5M</span></p>
  <h1 style="font:700 24px/1.25 Georgia,serif;margin:0 0 8px">¿Querés darte de baja?</h1>
  <p style="margin:0 0 24px;color:#5B606B;line-height:1.5">Vas a dejar de recibir todos los emails de 5M News en <b>${esc(sub.email)}</b>.</p>
  <form method="POST" action="${esc(url.pathname + url.search)}">
    <button style="background:#E5372A;color:#fff;border:0;border-radius:999px;padding:12px 24px;font-weight:600;font-size:15px;cursor:pointer">Confirmar baja</button>
  </form>
  <p style="margin:20px 0 0"><a href="/" style="color:#5B606B">Volver a 5M News</a></p>
</main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" } });
};

export const config: Config = { path: "/api/unsubscribe", method: ["GET", "POST"] };
