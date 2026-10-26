# 5M News en Render.com (plan gratuito, sin Netlify)

El código de las funciones (`netlify/functions`, `netlify/lib`) **no cambia**. `render/server.mts` las carga tal cual,
sirve `public/` y reemplaza lo que en Netlify hacía la plataforma:

| En Netlify | En Render |
|---|---|
| Funciones con `config.path` | Mismas rutas (`/api/subscribe`, `/api/confirm`, `/api/unsubscribe`, `/api/admin/newsletter`, `/api/push/*`, `/briefing.json`) |
| Función de fondo `briefing-update-background` | Misma URL, responde 202 y sigue trabajando |
| Funciones programadas (`schedule`) | `POST /api/cron/hourly`, `/api/cron/daily`, `/api/cron/weekly`, disparados por GitHub Actions (`.github/workflows/cron.yml`). Límites del servidor: hourly cada 50 min como mínimo, daily lunes a viernes, weekly jueves |
| Netlify Blobs | Tabla `public.blobs` en Supabase (proyecto `5m-news`). `render/blobs-supabase.mts` tiene la misma interfaz y el build lo usa en lugar de `@netlify/blobs` |
| AI Gateway (clave de Claude automática) | `GEMINI_API_KEY` gratuita (Google AI Studio); `ANTHROPIC_API_KEY` queda como alternativa paga |
| Encabezados de `netlify.toml` | Los mismos, aplicados por el servidor |

## Variables de entorno

| Variable | Valor |
|---|---|
| `SUPABASE_URL` | `https://mhizyxhuhtjnctcfikdv.supabase.co` (ya está en `render.yaml`) |
| `SUPABASE_SECRET_KEY` | Supabase → proyecto 5m-news → Project Settings → API Keys → Secret keys (`sb_secret_…`) |
| `GEMINI_API_KEY` | aistudio.google.com → Get API key (gratis, empieza con `AIza`) |
| `ANTHROPIC_API_KEY` | Opcional, pago: sólo se usa si no hay `GEMINI_API_KEY` |
| `BREVO_API_KEY`, `BREVO_SENDER`, `RESEND_API_KEY`, `ADMIN_KEY` | Los mismos que en Netlify |
| `SITE_URL` | Opcional: sólo con dominio propio (si no, se usa la URL de Render) |
| `CRON_SECRET` | Opcional: si se define, cargalo también como secret del repo |
| `NETLIFY_SITE_ID`, `NETLIFY_BLOBS_TOKEN` | Sólo para copiar una vez los datos viejos (ver abajo); después se pueden borrar |
| Opcionales | `FMP_API_KEY`, `BRIEFING_MODEL`, `VAPID_SUBJECT`, `EMAIL_FROM` |

## Copiar los datos que quedaron en Netlify (una vez)

`GET /api/admin/migrar-netlify?key=ADMIN_KEY` copia suscriptores, ediciones, fotos y registros de envío de Netlify Blobs
a Supabase (no borra nada en Netlify). Necesita `NETLIFY_BLOBS_TOKEN` (token personal: Netlify → User settings →
Applications → Personal access tokens). Si Netlify bloquea el acceso por la cuenta pausada, la respuesta lo dice
y los suscriptores pueden volver a anotarse.

## Comandos

- Build: `npm ci && npm run build` (empaqueta `render/server.mts` en `dist/server.mjs`)
- Start: `npm start` · Salud: `GET /healthz`

## Editar el sitio

El diseño se edita en `fuente/preview/index.html` (y `fuente/preview/sw.js`, `manifest.webmanifest`, `icons/`).
Para regenerar `public/` con el CSS de Tailwind incluido: `python3 fuente/scripts/build-netlify.py` (requiere `npx tailwindcss`).
