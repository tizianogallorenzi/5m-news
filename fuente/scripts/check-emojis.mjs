// Lista los emojis (pictogramas Unicode) de los archivos indicados. Sale con código 1 si encuentra alguno.
import { readFileSync } from "node:fs";
// ©, ® y ™ son símbolos tipográficos (aviso legal), no emojis.
const re = /(?![©®™])[\p{Extended_Pictographic}\u{FE0F}\u{20E3}]/gu;
let total = 0;
for (const f of process.argv.slice(2)) {
  readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    const m = line.match(re);
    if (m) { total += m.length; console.log(`${f}:${i + 1}: ${[...new Set(m)].join(" ")}  →  ${line.trim().slice(0, 90)}`); }
  });
}
console.log(total ? `${total} emojis encontrados` : "Sin emojis");
process.exit(total ? 1 : 0);
