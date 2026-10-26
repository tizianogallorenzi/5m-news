"""Genera public/ (raíz del repo) (index.html con el CSS de Tailwind inline + briefing.json) a partir de preview/.
Uso: python3 scripts/build-netlify.py   (desde la raíz del proyecto)
Después: deploy de la carpeta netlify-site/ (incluye las funciones de newsletter).
"""
import pathlib, re, shutil, subprocess, tempfile

root = pathlib.Path(__file__).resolve().parent.parent
src = (root / "preview/index.html").read_text()
out_dir = root.parent / "public"  # en el repo: fuente/ → public/ de la raíz
out_dir.mkdir(parents=True, exist_ok=True)

# 1. Quitar Tailwind CDN + config
html, n = re.subn(r'\s*<!-- Tailwind CDN.*?</script>\s*<script>\s*if \(window\.tailwind\).*?</script>',
                  '\n  <link rel="stylesheet" href="__CSS__">', src, flags=re.S)
assert n == 1, "No se encontró el bloque del CDN de Tailwind"

# 2. Favicon + Open Graph
html = html.replace('<link rel="preconnect" href="https://fonts.googleapis.com">', '''<meta name="theme-color" content="#E5372A">
  <meta property="og:type" content="website">
  <meta property="og:title" content="5M News — El mundo, informado en menos de 5 minutos">
  <meta property="og:description" content="Las noticias más importantes de Argentina y el mundo resumidas para leer antes de salir de casa.">
  <meta property="og:locale" content="es_AR">
  <meta name="twitter:card" content="summary">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23E5372A'/%3E%3Ctext x='32' y='43' font-family='Georgia,serif' font-size='30' font-weight='700' fill='white' text-anchor='middle'%3E5M%3C/text%3E%3C/svg%3E">
  <link rel="preconnect" href="https://fonts.googleapis.com">''', 1)
(out_dir / "index.html").write_text(html)

# 3. Compilar CSS e insertarlo inline
with tempfile.TemporaryDirectory() as tmp:
    inp, css = pathlib.Path(tmp, "in.css"), pathlib.Path(tmp, "out.css")
    inp.write_text("@tailwind base;\n@tailwind components;\n@tailwind utilities;\n")
    tw = [shutil.which("tailwindcss")] if shutil.which("tailwindcss") else ["npx", "-y", "tailwindcss@3.4.19"]
    subprocess.run([*tw, "-c", str(root / "scripts/tailwind.static.config.js"),
                    "-i", str(inp), "-o", str(css), "--minify"], check=True, cwd=root)
    html = html.replace('<link rel="stylesheet" href="__CSS__">', "<style>" + css.read_text() + "</style>")
(out_dir / "index.html").write_text(html)

# 4. Datos del briefing (los usa la web y las funciones de email)
shutil.copy(root / "preview/briefing.json", out_dir / "briefing.json")

# 5. App instalable: manifiesto, service worker e íconos
for f in ("manifest.webmanifest", "sw.js"):
    shutil.copy(root / "preview" / f, out_dir / f)
shutil.copytree(root / "preview/icons", out_dir / "icons", dirs_exist_ok=True)
print("OK → netlify-site/public/index.html + briefing.json + app (manifest, sw.js, icons/)")
