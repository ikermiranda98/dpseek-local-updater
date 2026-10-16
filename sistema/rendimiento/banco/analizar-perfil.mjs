// Analiza un .cpuprofile: CPU propia por paquete y función, y línea de tiempo por tramos.
// Uso: node analizar-perfil.mjs <perfil> [hasta_ms]
import { readFileSync } from 'node:fs'
const [file, untilArg] = process.argv.slice(2)
const p = JSON.parse(readFileSync(file, 'utf8'))
const until = Number(untilArg ?? 1e9)
const byId = new Map(p.nodes.map((n) => [n.id, n]))
const parent = new Map()
for (const n of p.nodes) for (const ch of n.children ?? []) parent.set(ch, n.id)
const pkgOf = (url) => {
  if (!url) return ''
  const m = /node_modules[\\/](@[^\\/]+[\\/][^\\/]+|[^\\/]+)/.exec(url.replace(/.*node_modules[\\/].pnpm[\\/][^\\/]+[\\/]/, 'node_modules/'))
  if (m) return m[1]
  const s = /packages[\\/]([^\\/]+[\\/][^\\/]+)/.exec(url)
  if (s) return s[1]
  return url.replace(/^.*[\\/]/, '').slice(0, 40)
}
// Primer paquete «propio» (no node:internal ni vacío) subiendo por la pila: a quién atribuir el tiempo.
const owner = (id) => {
  let cur = id
  while (cur !== undefined) {
    const u = byId.get(cur).callFrame.url
    if (u && !u.startsWith('node:')) return pkgOf(u)
    cur = parent.get(cur)
  }
  const fn = byId.get(id).callFrame.functionName
  return `(${fn || 'nativo'})`
}
let t = 0
const buckets = new Map()
const selfFn = new Map()
const selfPkg = new Map()
const BUCKET = 250
for (let i = 0; i < p.samples.length; i++) {
  t += (p.timeDeltas[i] ?? 0) / 1000
  if (t > until) break
  const id = p.samples[i]
  const cf = byId.get(id).callFrame
  if (cf.functionName === '(idle)') continue
  const dt = (p.timeDeltas[i + 1] ?? p.timeDeltas[i] ?? 0) / 1000
  const pkg = owner(id)
  const fn = `${cf.functionName || '(anónima)'} ${pkgOf(cf.url) || cf.url.slice(0, 30)}:${String(cf.lineNumber)}`
  selfFn.set(fn, (selfFn.get(fn) ?? 0) + dt)
  selfPkg.set(pkg, (selfPkg.get(pkg) ?? 0) + dt)
  const b = Math.floor(t / BUCKET)
  if (!buckets.has(b)) buckets.set(b, new Map())
  const m = buckets.get(b)
  m.set(pkg, (m.get(pkg) ?? 0) + dt)
}
console.log(`duración ${String(Math.round((p.endTime - p.startTime) / 1000))} ms`)
console.log('\nCPU por paquete (ms):')
for (const [k, v] of [...selfPkg].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${String(Math.round(v)).padStart(6)}  ${k}`)
console.log('\nCPU propia por función (ms):')
for (const [k, v] of [...selfFn].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${String(Math.round(v)).padStart(6)}  ${k}`)
console.log(`\nLínea de tiempo (tramos de ${String(BUCKET)} ms; ocupado y los 3 paquetes que más):`)
for (const [b, m] of [...buckets].sort((a, c) => a[0] - c[0])) {
  const busy = [...m.values()].reduce((a, c) => a + c, 0)
  console.log(`  ${String(b * BUCKET).padStart(6)}  ${String(Math.round(busy)).padStart(4)} ms  ${[...m].sort((a, c) => c[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${String(Math.round(v))}`).join(' · ')}`)
}
