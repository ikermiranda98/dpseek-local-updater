// Con la app de exploración (9555) en el chat largo: carga todo el historial y graba una
// traza del scroll; resume el tiempo por tipo de trabajo (estilos, layout, pintado, JS…).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect, waitFor } from './cdp.mjs'
const label = process.argv[2] ?? 'base'
const c = await connect(Number(process.env.PORT ?? 9555))
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
const visible = (t) => `document.querySelector('[data-conversation-scroll]').innerText.includes(${JSON.stringify(t)})`
const box = await c.evaluate(`(() => { const b = document.querySelector('[data-conversation-scroll]').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } })()`)
for (let i = 0; i < 200 && !await c.evaluate(visible('INICIO-DEL-CHAT-LARGO')); i++) {
  const clicked = await c.evaluate(`(() => { const b = [...document.querySelectorAll('[data-conversation-scroll] button')].find((x) => x.textContent.trim() === 'Load earlier'); if (!b) return false; b.click(); return true })()`)
  if (!clicked) await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: -1200 })
  await sleep(150)
}
await sleep(1000)
const events = []
c.on('Tracing.dataCollected', (p) => { events.push(...p.value) })
const done = new Promise((r) => { c.on('Tracing.tracingComplete', r) })
await c.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink,cc', transferMode: 'ReportEvents' })
for (const delta of [400, -400]) {
  for (let i = 0; i < 80; i++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: delta })
    await sleep(16)
  }
}
await c.send('Tracing.end')
await done
writeFileSync(join(import.meta.dirname, `traza-scroll-${label}.json`), JSON.stringify(events))
// Duración total por nombre de evento (solo el hilo principal del renderer: el que más tiempo suma).
const byThread = new Map()
for (const e of events) if (e.ph === 'X' && e.dur) byThread.set(`${e.pid}:${e.tid}`, (byThread.get(`${e.pid}:${e.tid}`) ?? 0) + e.dur)
const names = new Map()
for (const e of events) if (e.ph === 'X' && e.name === 'ThreadName') names.set(`${e.pid}:${e.tid}`, e.args?.name)
for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args?.name)
const main = [...byThread].find(([k]) => names.get(k) === 'CrRendererMain')?.[0]
const sum = new Map()
const longest = new Map()
for (const e of events) {
  if (e.ph !== 'X' || !e.dur || `${e.pid}:${e.tid}` !== main) continue
  sum.set(e.name, (sum.get(e.name) ?? 0) + e.dur)
  longest.set(e.name, Math.max(longest.get(e.name) ?? 0, e.dur))
}
console.log(`hilo principal ${String(main)}; eventos ${String(events.length)}`)
for (const [n, us] of [...sum].sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log(`  ${String(Math.round(us / 1000)).padStart(6)} ms  (máx ${String(Math.round(longest.get(n) / 1000)).padStart(4)} ms)  ${n}`)
console.log('nodos', await c.evaluate(`document.querySelectorAll('*').length`))
c.close()
