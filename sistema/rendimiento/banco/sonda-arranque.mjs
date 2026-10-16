// Desglosa el arranque: cuándo navega la página, cuándo cargan los scripts, y cuánto tarda
// una recarga de la página (solo la parte del navegador, con el Host ya en marcha), con
// perfil de CPU de esa recarga.
// Uso: node sonda-arranque.mjs <exe> <etiqueta>
import { spawn } from 'node:child_process'
import { cpSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect, waitFor } from './cdp.mjs'

const [exe, label] = process.argv.slice(2)
const HERE = import.meta.dirname
const run = join(HERE, `run-sonda-${label}`)
rmSync(run, { recursive: true, force: true })
cpSync(join(HERE, 'base-caliente'), run, { recursive: true })
const PORT = 9577
const spawnedAt = Date.now()
const child = spawn(exe, [`--remote-debugging-port=${String(PORT)}`, `--user-data-dir=${join(run, 'ud')}`], {
  env: { ...process.env, DSH_HOME: join(run, 'home'), DSH_DESKTOP_OPEN_DEVTOOLS: '0', DSH_LOCAL_SIN_AYUDANTES: '1' }, stdio: 'ignore',
})
const ready = `[...document.querySelectorAll('span[class*="_title"]')].some((e) => e.textContent.startsWith('BENCH')) && !!document.querySelector('[contenteditable="true"]')`
try {
  const c = await connect(PORT, { timeoutMs: 90_000 })
  const connectedAt = Date.now()
  await waitFor(c, ready, { timeoutMs: 90_000, everyMs: 10 })
  const readyAt = Date.now()
  const t = await c.evaluate(`(() => {
    const nav = performance.getEntriesByType('navigation')[0]
    const res = performance.getEntriesByType('resource').map((r) => ({ name: r.name.replace(/^.*\\//, '').slice(0, 60), start: Math.round(r.startTime), end: Math.round(r.responseEnd), size: r.transferSize || r.encodedBodySize, type: r.initiatorType }))
    const paints = performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)])
    const marks = performance.getEntriesByType('mark').map((m) => [m.name, Math.round(m.startTime)])
    const measures = performance.getEntriesByType('measure').map((m) => [m.name, Math.round(m.startTime), Math.round(m.duration)])
    return { timeOrigin: performance.timeOrigin, dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), res, paints, marks, measures }
  })()`)
  const origin = t.timeOrigin - spawnedAt
  console.log(`arranque ${label}: navegación empieza a +${Math.round(origin)} ms del lanzamiento; CDP +${connectedAt - spawnedAt}; listo +${readyAt - spawnedAt}`)
  console.log(`  DOMContentLoaded +${Math.round(origin + t.dcl)}  load +${Math.round(origin + t.load)}  pinturas ${JSON.stringify(t.paints.map(([n, s]) => [n, Math.round(origin + s)]))}`)
  console.log(`  recursos: ${String(t.res.length)}; los 15 que más tardan en llegar:`)
  for (const r of [...t.res].sort((a, b) => b.end - a.end).slice(0, 15)) console.log(`    +${Math.round(origin + r.start)}→+${Math.round(origin + r.end)}  ${String(r.size).padStart(9)}  ${r.type.padEnd(8)} ${r.name}`)
  if (t.marks.length > 0) console.log('  marcas:', JSON.stringify(t.marks.slice(0, 30)))
  if (t.measures.length > 0) console.log('  medidas:', JSON.stringify(t.measures.slice(0, 30)))

  // Recarga de la página con perfil de CPU (el Host sigue en marcha).
  await c.send('Profiler.enable')
  await c.send('Profiler.setSamplingInterval', { interval: 200 })
  await c.send('Profiler.start')
  const r0 = Date.now()
  await c.send('Page.reload', { ignoreCache: false })
  await new Promise((r) => { setTimeout(r, 300) })
  const c2 = await connect(PORT)
  await waitFor(c2, ready, { timeoutMs: 60_000, everyMs: 10 })
  const reloadMs = Date.now() - r0
  const profile = (await c.send('Profiler.stop')).result?.profile
  console.log(`recarga de la página hasta listo: ${String(reloadMs)} ms`)
  if (profile !== undefined) {
    writeFileSync(join(HERE, `perfil-recarga-${label}.cpuprofile`), JSON.stringify(profile))
    // Tiempo propio por función y por fichero.
    const byId = new Map(profile.nodes.map((n) => [n.id, n]))
    const self = new Map()
    const dt = profile.timeDeltas
    for (let i = 0; i < profile.samples.length; i++) self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + (dt[i] ?? 0))
    const byFn = new Map()
    const byUrl = new Map()
    for (const [id, us] of self) {
      const n = byId.get(id)
      const cf = n.callFrame
      const fn = `${cf.functionName || '(anónima)'} ${cf.url.replace(/^.*\//, '').slice(0, 50)}:${String(cf.lineNumber)}`
      byFn.set(fn, (byFn.get(fn) ?? 0) + us)
      const url = cf.url === '' ? `(${cf.functionName})` : cf.url.replace(/\?.*$/, '').replace(/^.*\//, '').slice(0, 70)
      byUrl.set(url, (byUrl.get(url) ?? 0) + us)
    }
    console.log('  por fichero (ms de CPU propia):')
    for (const [u, us] of [...byUrl].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`    ${String(Math.round(us / 1000)).padStart(6)}  ${u}`)
    console.log('  por función:')
    for (const [f, us] of [...byFn].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`    ${String(Math.round(us / 1000)).padStart(6)}  ${f}`)
  }
  c2.close()
  c.close()
} finally {
  child.kill()
  spawn('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'run-sonda-${label}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' })
}
