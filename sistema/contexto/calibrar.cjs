// Medición del contexto óptimo de cada modelo (añadido por dpseek-local-updater).
//
// Lo lanza arranque.cjs en segundo plano cuando un modelo no tiene medición para
// este equipo (modelo, versión de Ollama y tarjeta gráfica). Carga el modelo con
// varios tamaños de contexto y mira en /api/ps cuánto queda en la gráfica:
//   - si con el tamaño menor el modelo cabe entero en la gráfica, el óptimo es el
//     mayor tamaño con el que sigue cabiendo entero;
//   - si no cabe (parte va a la CPU), el óptimo es el mayor tamaño con el que la
//     parte en la gráfica no se reduce: a partir de ahí Ollama saca capas de la
//     gráfica para hacer sitio al contexto y el modelo va más lento.
// Solo mide con Ollama libre (ningún modelo cargado) y se aparta si alguien lo
// usa mientras mide. El resultado va a <DSH_HOME>/storages/local-contexto.json.
'use strict'
const { readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } = require('node:fs')
const { dirname } = require('node:path')

const job = JSON.parse(process.env.DSH_CTX_JOB)
const lockFile = job.cacheFile.replace(/\.json$/, '.lock')
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
const TOLERANCE = 0.99
const MAX_WAIT_MS = 3 * 60 * 60 * 1000

async function api(path, body, timeoutMs = 10000) {
  const init = body === undefined
    ? { signal: AbortSignal.timeout(timeoutMs) }
    : { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }
  const response = await fetch(job.ollama + path, init)
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`)
  return response.json()
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Una sola medición a la vez en el equipo. */
function takeLock() {
  mkdirSync(dirname(lockFile), { recursive: true })
  try {
    writeFileSync(lockFile, String(process.pid), { flag: 'wx' })
    return true
  } catch {
    const holder = Number(readFileSync(lockFile, 'utf8'))
    if (Number.isInteger(holder) && holder > 0 && alive(holder)) return false
    writeFileSync(lockFile, String(process.pid))
    return true
  }
}

class Busy extends Error {}

async function loaded() {
  return (await api('/api/ps')).models || []
}

/** Espera a que Ollama no tenga ningún modelo cargado. */
async function waitIdle(deadline) {
  for (;;) {
    if ((await loaded()).length === 0) return
    if (Date.now() > deadline) throw new Error('Ollama no ha quedado libre')
    await sleep(60_000)
  }
}

/** Carga el modelo con un contexto y devuelve lo que ocupa en total y en la gráfica. */
async function measure(model, ctx) {
  if ((await loaded()).length > 0) throw new Busy()
  try {
    await api('/api/generate', { model, keep_alive: '5m', options: { num_ctx: ctx } }, 15 * 60_000)
  } catch (error) {
    // Ollama rechaza cargarlo si no cabe en memoria: ese tamaño no sirve.
    if (error instanceof Error && /HTTP 5\d\d/.test(error.message)) return undefined
    throw error
  }
  const models = await loaded()
  const entry = models.find((m) => m.name === model)
  await api('/api/generate', { model, keep_alive: 0 }).catch(() => undefined)
  if (models.length !== 1 || entry === undefined || entry.context_length !== ctx) throw new Busy()
  return { ctx, size: entry.size, vram: entry.size_vram }
}

async function calibrate(model, sizes) {
  const base = await measure(model, sizes[0])
  if (base === undefined) return { optimo: sizes[0], medidas: [] }
  const whole = base.vram >= base.size * TOLERANCE
  const fits = (r) => r !== undefined && (whole ? r.vram >= r.size * TOLERANCE : r.vram >= base.vram * TOLERANCE)
  const medidas = [base]
  for (const ctx of [...sizes].reverse()) {
    if (ctx === sizes[0]) break
    const r = await measure(model, ctx)
    if (r !== undefined) medidas.push(r)
    if (fits(r)) return { optimo: ctx, medidas }
  }
  return { optimo: sizes[0], medidas }
}

function save(model, digest, result) {
  let cache = {}
  try {
    cache = JSON.parse(readFileSync(job.cacheFile, 'utf8'))
  } catch {
    // Primera medición.
  }
  cache[model] = { digest, ollama: job.version, gpu: job.gpu, ...result, fecha: new Date().toISOString() }
  const tmp = `${job.cacheFile}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(cache, null, 2))
  renameSync(tmp, job.cacheFile)
}

async function main() {
  if (!takeLock()) return
  try {
    const deadline = Date.now() + MAX_WAIT_MS
    for (const { model, digest, sizes, declared } of job.models) {
      for (;;) {
        await waitIdle(deadline)
        try {
          const result = await calibrate(model, sizes)
          save(model, digest, result)
          // La app declaró `declared` al arrancar y resume la conversación según
          // ese valor: la variante automática solo puede crecer hasta el próximo
          // arranque (si el óptimo es menor, se aplica al volver a abrir la app).
          if (result.optimo >= declared) {
            const name = autoName(model)
            await api('/api/create', { model: name, from: model, parameters: { num_ctx: result.optimo }, stream: false })
          }
          break
        } catch (error) {
          if (!(error instanceof Busy)) throw error
          // Alguien ha empezado a usar Ollama: se espera y se repite.
        }
      }
    }
  } finally {
    rmSync(lockFile, { force: true })
  }
}

function autoName(name) {
  const i = name.lastIndexOf(':')
  const [base, tag] = i < 0 ? [name, 'latest'] : [name.slice(0, i), name.slice(i + 1)]
  return `${base}:${tag === 'latest' ? '' : tag + '-'}dsh-ctx-auto`
}

main().catch(() => process.exit(1))
