// Compara la traducción con los textos en inglés extraídos de la app.
// Uso: node sistema/traduccion/validar.mjs <en-dump.json> [sistema/es-pack.json]
// Informa de claves que ya no existen, variables {…} distintas y textos sin traducir.
import { readFileSync } from 'node:fs'
const en = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const es = JSON.parse(readFileSync(process.argv[3] ?? new URL('../es-pack.json', import.meta.url), 'utf8'))
const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
let errors = 0, missing = 0
for (const [ns, dict] of Object.entries(es)) {
  for (const [key, text] of Object.entries(dict)) {
    if (!(key in (en[ns] ?? {}))) { console.log(`obsoleta      ${ns} ${key}`); continue }
    if (vars(en[ns][key]) !== vars(text)) { console.log(`VARIABLES     ${ns} ${key}: ${en[ns][key]} | ${text}`); errors++ }
  }
}
for (const [ns, dict] of Object.entries(en)) {
  for (const [key, text] of Object.entries(dict)) {
    if (es[ns]?.[key] === undefined) { console.log(`sin traducir  ${ns} ${key}: ${JSON.stringify(text)}`); missing++ }
  }
}
console.log({ errores: errors, sinTraducir: missing })
process.exit(errors > 0 ? 1 : 0)
