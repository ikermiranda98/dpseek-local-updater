// Regenera sistema/es-pack.ts a partir de sistema/es-pack.json.
// Uso: node sistema/traduccion/generar-es-pack.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const dir = join(dirname(fileURLToPath(import.meta.url)), '..')
const pack = JSON.parse(readFileSync(join(dir, 'es-pack.json'), 'utf8'))
const header = [
  '/**',
  ' * Spanish language pack for the local build: namespace -> key -> text.',
  ' * Generated from dpseek-local-updater/sistema/es-pack.json; missing keys fall back to English.',
  ' */',
].join('\n')
writeFileSync(join(dir, 'es-pack.ts'), `${header}\nexport const esPack: Readonly<Record<string, Readonly<Record<string, string>>>> = ${JSON.stringify(pack, null, 2)}\n`)
console.log(`es-pack.ts: ${Object.keys(pack).length} namespaces`)
