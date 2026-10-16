// Banco de pruebas de rendimiento de DeepSeek Harness (dpseek-local-updater).
//
// Arranca el ejecutable indicado con una copia del home de prueba ya «caliente» (154
// chats con sus cachés, uno de 400 turnos) y mide, con el reloj de este proceso:
//   arranque   ventana, lista de chats y cuadro de texto listos
//   abrir      chat largo, mediano y corto (hasta ver su último mensaje) y volver al largo
//   pantallas  Ajustes y Plugins
//   antiguos   «Load earlier» hasta el primer mensaje del chat largo
//   scroll     rueda arriba y abajo por el chat largo: frames y tareas largas
// Repite N veces y da la mediana (y el mínimo y máximo).
//
// Uso: node bench.mjs <exe> <etiqueta> [repeticiones]
import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect, waitFor } from './cdp.mjs'

const [exe, label, runsArg] = process.argv.slice(2)
const RUNS = Number(runsArg ?? 5)
const HERE = import.meta.dirname
const BASE = join(HERE, 'base-caliente')
const PORT = 9566
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })

const T = (s) => JSON.stringify(s)
/** Clic en el título de la barra lateral (desplegando «Show N more» hasta encontrarlo). */
const openChat = (title) => `(async () => {
  for (let i = 0; i < 80; i++) {
    const el = [...document.querySelectorAll('span[class*="_title"]')].find((e) => e.textContent === ${T(title)})
    if (el) { el.scrollIntoView({ block: 'center' }); el.click(); return true }
    const more = [...document.querySelectorAll('button')].find((b) => /^Show \\d+ more/.test(b.textContent.trim()))
    if (!more) return false
    more.click(); await new Promise((r) => setTimeout(r, 30))
  }
  return false
})()`
/** Despliega toda la lista antes de medir los clics (desplegar no forma parte de abrir un chat). */
const expandAll = `(async () => { for (let i = 0; i < 80; i++) { const more = [...document.querySelectorAll('button')].find((b) => /^Show \\d+ more/.test(b.textContent.trim())); if (!more) return i; more.click(); await new Promise((r) => setTimeout(r, 20)) } return -1 })()`
const visible = (text) => `(() => { const s = document.querySelector('[data-conversation-scroll]'); return !!s && s.textContent.includes(${T(text)}) })()`

async function measureRun(index) {
  const run = join(HERE, `run-${label}`)
  rmSync(run, { recursive: true, force: true })
  cpSync(BASE, run, { recursive: true })
  const started = performance.now()
  const child = spawn(exe, [`--remote-debugging-port=${String(PORT)}`, `--user-data-dir=${join(run, 'ud')}`], {
    env: { ...process.env, DSH_HOME: join(run, 'home'), DSH_DESKTOP_OPEN_DEVTOOLS: '0', DSH_LOCAL_SIN_AYUDANTES: '1' },
    stdio: 'ignore',
  })
  const r = {}
  try {
    const c = await connect(PORT, { timeoutMs: 90_000 })
    r.ventana = performance.now() - started
    await waitFor(c, `!!document.querySelector('span[class*="_title"]') && [...document.querySelectorAll('span[class*="_title"]')].some((e) => e.textContent.startsWith('BENCH'))`, { timeoutMs: 90_000, everyMs: 10 })
    r.lista = performance.now() - started
    await waitFor(c, `!!document.querySelector('[contenteditable="true"]')`, { timeoutMs: 90_000, everyMs: 10 })
    r.cuadro = performance.now() - started
    // Prueba de una regla CSS sin recompilar (BENCH_CSS).
    if (process.env.BENCH_CSS) await c.evaluate(`(() => { const s = document.createElement('style'); s.textContent = ${T(process.env.BENCH_CSS)}; document.head.append(s) })()`)
    await sleep(1500)
    await c.evaluate(expandAll)
    await sleep(300)

    const open = async (title, marker) => {
      const t0 = performance.now()
      if (!await c.evaluate(openChat(title))) throw new Error(`sin fila ${title}`)
      await waitFor(c, visible(marker), { timeoutMs: 60_000, everyMs: 5 })
      return performance.now() - t0
    }
    r.abrirLargo = await open('BENCH chat largo', 'FIN-DEL-CHAT-LARGO')
    await sleep(500)
    r.abrirMediano = await open('BENCH chat mediano 1', 'FIN-DEL-CHAT-MEDIANO-1')
    await sleep(500)
    r.abrirCorto = await open('BENCH chat corto 7', 'FIN-DEL-CHAT-CORTO-7')
    await sleep(500)
    r.volverLargo = await open('BENCH chat largo', 'FIN-DEL-CHAT-LARGO')
    await sleep(500)

    // Mensajes antiguos: «Load earlier» (o lo que lo sustituya) hasta el primer mensaje.
    await c.evaluate(`window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration) }).observe({ type: 'longtask' })`)
    const box = await c.evaluate(`(() => { const b = document.querySelector('[data-conversation-scroll]').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } })()`)
    const t0 = performance.now()
    let clicks = 0
    while (!await c.evaluate(visible('INICIO-DEL-CHAT-LARGO'))) {
      if (performance.now() - t0 > 120_000) throw new Error('antiguos: tiempo agotado')
      // BENCH_SOLO_RUEDA: como alguien que solo sube con la rueda, sin pulsar «Load earlier».
      const clicked = process.env.BENCH_SOLO_RUEDA ? false : await c.evaluate(`(() => { const b = [...document.querySelectorAll('[data-conversation-scroll] button')].find((x) => x.textContent.trim() === 'Load earlier'); if (!b) return false; b.click(); return true })()`)
      if (clicked) clicks++
      else await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: -1200 })
      await sleep(5)
    }
    r.antiguos = performance.now() - t0
    r.antiguosClics = clicks
    r.antiguosLargas = await c.evaluate('Math.round(window.__long.reduce((a, b) => a + b, 0))')

    // Scroll por todo el chat (ya cargado entero): abajo y arriba con la rueda.
    await c.evaluate(`(() => { window.__frames = []; let last = performance.now(); window.__stop = false; const tick = (t) => { window.__frames.push(t - last); last = t; if (!window.__stop) requestAnimationFrame(tick) }; requestAnimationFrame(tick); window.__long = [] })()`)
    for (const delta of [400, -400]) {
      for (let i = 0; i < 150; i++) {
        await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: delta })
        await sleep(16)
      }
    }
    const scroll = await c.evaluate(`(() => { window.__stop = true; const f = window.__frames.slice(2).sort((a, b) => a - b); const p = (q) => f[Math.min(f.length - 1, Math.floor(f.length * q))]; return { p50: p(0.5), p95: p(0.95), p99: p(0.99), lentos: f.filter((x) => x > 34).length, frames: f.length, largas: Math.round(window.__long.reduce((a, b) => a + b, 0)) } })()`)
    r.scrollP95 = scroll.p95
    r.scrollP99 = scroll.p99
    r.scrollLentos = scroll.lentos
    r.scrollLargas = scroll.largas
    // Segunda pasada por lo ya visto.
    await c.evaluate(`(() => { window.__frames = []; let last = performance.now(); window.__stop = false; const tick = (t) => { window.__frames.push(t - last); last = t; if (!window.__stop) requestAnimationFrame(tick) }; requestAnimationFrame(tick); window.__long = [] })()`)
    for (const delta of [400, -400]) {
      for (let i = 0; i < 150; i++) {
        await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: delta })
        await sleep(16)
      }
    }
    const scroll2 = await c.evaluate(`(() => { window.__stop = true; const f = window.__frames.slice(2).sort((a, b) => a - b); const p = (q) => f[Math.min(f.length - 1, Math.floor(f.length * q))]; return { p99: p(0.99), lentos: f.filter((x) => x > 34).length, largas: Math.round(window.__long.reduce((a, b) => a + b, 0)) } })()`)
    r.scroll2P99 = scroll2.p99
    r.scroll2Lentos = scroll2.lentos
    r.scroll2Largas = scroll2.largas
    r.nodos = await c.evaluate(`document.querySelectorAll('*').length`)
    r.heapMB = await c.evaluate('Math.round(performance.memory.usedJSHeapSize / 1e6)')

    // Pantallas: Ajustes y Plugins (hasta ver su contenido).
    const screen = async (button, ready) => {
      const t1 = performance.now()
      const ok = await c.evaluate(`(() => { const b = [...document.querySelectorAll('button, a, [role=button]')].find((x) => x.textContent.trim() === ${T(button)}); if (!b) return false; b.click(); return true })()`)
      if (!ok) return NaN
      await waitFor(c, ready, { timeoutMs: 30_000, everyMs: 5 })
      return performance.now() - t1
    }
    r.ajustes = await screen('Settings', `document.body.innerText.includes('General') && !!document.querySelector('[role=dialog], [data-settings-root], main')`)
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(500)
    r.plugins = await screen('Plugins', `/Installed|Marketplace|plugins/i.test(document.body.innerText) && document.title.toLowerCase().includes('plugin') || [...document.querySelectorAll('h1,h2')].some((h) => /plugin/i.test(h.textContent))`)
    c.close()
  } finally {
    child.kill()
    await sleep(1500)
    spawn('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'run-${label}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' })
    await sleep(2500)
  }
  console.log(`run ${String(index + 1)}:`, Object.entries(r).map(([k, v]) => `${k}=${typeof v === 'number' ? Math.round(v * 10) / 10 : v}`).join(' '))
  return r
}

const results = []
for (let i = 0; i < RUNS; i++) {
  try { results.push(await measureRun(i)) } catch (error) { console.log(`run ${String(i + 1)} falló:`, error.message) }
}
const keys = Object.keys(results[0] ?? {})
const summary = {}
for (const k of keys) {
  const v = results.map((x) => x[k]).filter((x) => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b)
  summary[k] = { med: v[Math.floor(v.length / 2)], min: v[0], max: v[v.length - 1] }
}
mkdirSync(join(HERE, 'resultados'), { recursive: true })
writeFileSync(join(HERE, 'resultados', `${label}.json`), JSON.stringify({ label, exe, runs: results.length, summary, results }, null, 1))
console.log(`\n== ${label} (${String(results.length)} repeticiones, mediana [mín–máx])`)
for (const [k, s] of Object.entries(summary)) console.log(`${k.padEnd(16)} ${String(Math.round(s.med * 10) / 10).padStart(8)}  [${String(Math.round(s.min * 10) / 10)}–${String(Math.round(s.max * 10) / 10)}]`)
