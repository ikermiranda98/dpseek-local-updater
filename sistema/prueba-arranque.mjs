// Prueba de arranque del instalador antes de publicarlo (dpseek-local-updater).
//
// Abre la app compilada (carpeta win-unpacked) con datos temporales, espera a que
// cargue la interfaz y falla si no lo hace: así una versión que compila pero no
// arranca no llega a publicarse ni a instalarse sola. De paso cuenta los textos
// de la app que aún no tienen traducción en sistema/es-pack.json.
//
// Uso: node sistema/prueba-arranque.mjs <ruta del .exe> [informe.md]
// Sale con código 1 si la app no arranca en 4 minutos.

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [exe, report] = process.argv.slice(2)
if (!exe) {
  console.error('Uso: node sistema/prueba-arranque.mjs <ruta del .exe> [informe.md]')
  process.exit(2)
}
const here = dirname(fileURLToPath(import.meta.url))
const PORT = 9393
const LIMIT_MS = 4 * 60_000
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

// Datos aparte (DSH_HOME y --user-data-dir): no toca los de una app instalada ni
// choca con ella si está abierta (la app solo admite una ventana por carpeta de datos).
const scratch = mkdtempSync(join(tmpdir(), 'dsh-prueba-'))
const child = spawn(exe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${join(scratch, 'user-data')}`], {
  env: {
    ...process.env,
    DSH_HOME: join(scratch, 'home'),
    DSH_DESKTOP_OPEN_DEVTOOLS: '0',
    // Sin medición de contexto, precarga ni arranque de Ollama: es solo una comprobación.
    DSH_LOCAL_SIN_AYUDANTES: '1',
  },
  stdio: 'ignore',
  windowsHide: true,
})
let exited = false
child.on('exit', () => { exited = true })

async function page() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  return targets.find((t) => t.type === 'page' && t.url.startsWith('dsh-app://app'))
}

/** Conexión CDP mínima con la página de la app. */
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  const send = (method, params = {}) => new Promise((resolve) => {
    const i = ++id
    pending.set(i, resolve)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value
  return { ws, send, evaluate }
}

/** La interfaz está lista: sin «Loading plugins» y con el botón de sesión nueva. */
const READY = `(() => {
  const text = document.body?.innerText ?? ''
  return !text.includes('Loading plugins') && /New Session|Nueva sesión|新会话|新建会话/.test(text)
})()`

async function waitReady(cdp, deadline) {
  while (Date.now() < deadline) {
    if (exited) throw new Error('la app se ha cerrado sola durante el arranque')
    if (await cdp.evaluate(READY).catch(() => false)) return
    await sleep(2000)
  }
  throw new Error('la interfaz no ha terminado de cargar a tiempo')
}

/** Engancha el registro de idiomas para capturar los diccionarios en inglés al recargar. */
const HOOK = `(() => {
  const tag = new WeakMap(); const dump = {}; window.__enDump = dump
  const orig = Map.prototype.set
  Map.prototype.set = function (k, v) {
    if (typeof k === 'string' && v instanceof Map) tag.set(v, k)
    else if (k === 'en' && v && typeof v === 'object' && tag.has(this)) {
      const vals = Object.values(v)
      if (vals.length && vals.every(x => typeof x === 'string')) dump[tag.get(this)] = { ...v }
    }
    return orig.call(this, k, v)
  }
})()`

function missingTranslations(english) {
  const es = JSON.parse(readFileSync(join(here, 'es-pack.json'), 'utf8'))
  const missing = []
  for (const [ns, dict] of Object.entries(english)) {
    for (const [key, text] of Object.entries(dict)) {
      if (es[ns]?.[key] === undefined) missing.push({ ns, key, text })
    }
  }
  return missing
}

let failure
try {
  const deadline = Date.now() + LIMIT_MS
  let target
  while (!target && Date.now() < deadline) {
    if (exited) throw new Error('la app se ha cerrado sola al abrirse')
    target = await page().catch(() => undefined)
    if (!target) await sleep(2000)
  }
  if (!target) throw new Error('la ventana de la app no ha aparecido')
  const cdp = await connect(target)
  await waitReady(cdp, deadline)
  console.log('La app arranca y carga la interfaz.')

  // Textos sin traducir: se recarga la página con el gancho puesto.
  await cdp.send('Page.enable')
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK })
  await cdp.send('Page.reload', { ignoreCache: true })
  await sleep(3000)
  await waitReady(cdp, Date.now() + LIMIT_MS)
  await sleep(5000)
  const english = JSON.parse(await cdp.evaluate('JSON.stringify(window.__enDump ?? {})') ?? '{}')
  const missing = missingTranslations(english)
  const total = Object.values(english).reduce((n, dict) => n + Object.keys(dict).length, 0)
  console.log(`Textos de la app: ${total}; sin traducir al español: ${missing.length}`)
  if (report) {
    const lines = missing.length === 0
      ? ['Todos los textos de la app tienen traducción al español.']
      : [
        `**${missing.length} textos nuevos sin traducir** (salen en inglés hasta añadirlos a \`sistema/es-pack.json\`):`,
        '',
        ...missing.slice(0, 40).map((m) => `- \`${m.ns}\` · \`${m.key}\`: ${m.text.replace(/\s+/g, ' ').slice(0, 90)}`),
        ...(missing.length > 40 ? [`- … y ${missing.length - 40} más`] : []),
      ]
    writeFileSync(report, lines.join('\n') + '\n')
    writeFileSync(report.replace(/\.md$/, '') + '.json', JSON.stringify(missing, null, 1))
  }
  cdp.ws.close()
} catch (error) {
  failure = error
} finally {
  // Cierra la app con todos sus procesos (ventana, servidor interno, ayudantes).
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill()
  await sleep(3000)
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  } catch {
    // Algún proceso aún suelta sus ficheros: es una carpeta temporal.
  }
}
if (failure) {
  console.error(`ERROR: la prueba de arranque ha fallado: ${failure.message}`)
  process.exit(1)
}
