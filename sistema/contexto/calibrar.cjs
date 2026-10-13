// Medición del contexto óptimo y de las capas en la gráfica de cada modelo
// (añadido por dpseek-local-updater).
//
// Lo lanza arranque.cjs en segundo plano cuando un modelo no tiene medición para
// este equipo (modelo, versión de Ollama, tarjeta gráfica y compresión de
// contexto), y el botón «Optimizar» cuando se pide. Para cada tamaño de contexto:
//   - Modelos densos que no caben en la gráfica: Ollama deja más memoria de la
//     gráfica libre de la necesaria y el modelo va varias veces más lento. Se busca
//     el máximo de capas (num_gpu) que caben en la memoria real de la gráfica, con
//     un margen, y se guarda en sus variantes.
//   - Los demás (MoE como Qwen…-A3B, o modelos que caben enteros) se dejan como los
//     reparte Ollama, que ya acierta.
//   - En todos se mide la velocidad de generación real. El recomendado es el mayor
//     tamaño que mantiene al menos el 85 % de la velocidad del más rápido.
// Solo mide con Ollama libre (ningún modelo cargado) y se aparta si alguien lo
// usa mientras mide. El resultado va a <DSH_HOME>/storages/local-contexto.json.
'use strict'
const { readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } = require('node:fs')
const { dirname } = require('node:path')

const job = JSON.parse(process.env.DSH_CTX_JOB)
const lockFile = job.cacheFile.replace(/\.json$/, '.lock')
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
const TOLERANCE = 0.99
const KEEP_SPEED = 0.85
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
  if (!Number.isInteger(pid) || pid <= 0) return false
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

/**
 * Qué modelo se mide y cuánto lleva, para el botón «Optimizar»: cada carga del
 * modelo es un paso; el total se estima al empezar cada modelo.
 */
const stateFile = job.cacheFile.replace(/\.json$/, '.estado.json')
let state = { model: '', inicio: '', hechos: 0, total: 1 }
function writeState() {
  try {
    writeFileSync(stateFile, JSON.stringify(state))
  } catch {
    // El progreso es orientativo: si no se puede escribir, la medición sigue.
  }
}
function stepDone() {
  state.hechos = Math.min(state.hechos + 1, state.total)
  writeState()
}

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

/**
 * Carga el modelo con un contexto (y, si se indica, un número de capas en la
 * gráfica) y devuelve lo que ocupa en total y en la gráfica.
 */
async function measure(model, ctx, layers) {
  if ((await loaded()).length > 0) throw new Busy()
  const options = layers === undefined ? { num_ctx: ctx } : { num_ctx: ctx, num_gpu: layers }
  try {
    await api('/api/generate', { model, keep_alive: '5m', options }, 15 * 60_000)
  } catch (error) {
    // Ollama rechaza cargarlo si no cabe en memoria: esa combinación no sirve.
    if (error instanceof Error && /HTTP 5\d\d/.test(error.message)) return undefined
    throw error
  }
  const models = await loaded()
  const entry = models.find((m) => m.name === model)
  await api('/api/generate', { model, keep_alive: 0 }).catch(() => undefined)
  stepDone()
  if (models.length !== 1 || entry === undefined || entry.context_length !== ctx) throw new Busy()
  return { ctx, ...(layers === undefined ? {} : { capas: layers }), size: entry.size, vram: entry.size_vram }
}

/**
 * Máximo de capas en la gráfica que caben en la memoria real (job.vramLimit)
 * con un contexto, por bisección. Devuelve la medición con esas capas.
 */
async function tuneLayers(model, ctx, total, floor) {
  let best = floor
  let lo = 1
  let hi = total
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const r = await measure(model, ctx, mid)
    if (r !== undefined && r.vram <= job.vramLimit) {
      if (best === undefined || r.vram >= best.vram) best = r
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

const PROMPT = 'Escribe un párrafo de unas 80 palabras sobre la historia de los relojes mecánicos.'

/**
 * Carga el modelo con un contexto (y, si se indica, unas capas en la gráfica) y
 * mide la velocidad de generación: una respuesta corta para calentar y otra para
 * medir, sin recargar.
 */
async function speed(item, ctx, layers) {
  if ((await loaded()).length > 0) throw new Busy()
  const options = layers === undefined ? { num_ctx: ctx } : { num_ctx: ctx, num_gpu: layers }
  const ask = (n) => api('/api/generate', {
    model: item.model,
    prompt: PROMPT,
    stream: false,
    keep_alive: '5m',
    ...(item.thinking ? { think: false } : {}),
    options: { ...options, num_predict: n },
  }, 15 * 60_000)
  let result
  try {
    await ask(8)
    result = await ask(64)
  } catch (error) {
    // Ollama rechaza cargarlo si no cabe en memoria: esa combinación no sirve.
    if (error instanceof Error && /HTTP 5\d\d/.test(error.message)) return undefined
    throw error
  }
  const models = await loaded()
  const entry = models.find((m) => m.name === item.model)
  await api('/api/generate', { model: item.model, keep_alive: 0 }).catch(() => undefined)
  stepDone()
  if (models.length !== 1 || entry === undefined || entry.context_length !== ctx) throw new Busy()
  const tps = result.eval_count > 0 && result.eval_duration > 0 ? result.eval_count / (result.eval_duration / 1e9) : 0
  return {
    ctx, ...(layers === undefined ? {} : { capas: layers }), size: entry.size, vram: entry.size_vram, tps: Math.round(tps * 10) / 10,
  }
}

/**
 * Para cada tamaño de contexto: en los modelos densos que no caben, ajusta las
 * capas en la gráfica; después mide la velocidad real. El recomendado es el mayor
 * tamaño que mantiene al menos el 85 % de la velocidad del más rápido.
 */
async function calibrate(item) {
  const { model, sizes, dense, layers } = item
  const tuning = dense && Number.isInteger(layers) && layers > 0 && Number.isFinite(job.vramLimit)
  const capas = {}
  const medidas = []
  // Pasos por tamaño: denso = reparto de Ollama + bisección de capas + velocidad;
  // los demás, solo la velocidad.
  state.total = sizes.length * (tuning ? 2 + Math.ceil(Math.log2(layers + 1)) : 1)
  state.hechos = 0
  writeState()
  for (const ctx of sizes) {
    let gpuLayers
    if (tuning) {
      const plain = await measure(model, ctx)
      if (plain !== undefined) {
        medidas.push(plain)
        if (plain.vram < plain.size * TOLERANCE) {
          const tuned = await tuneLayers(model, ctx, layers, plain)
          if (tuned !== undefined && tuned.capas !== undefined) {
            capas[ctx] = tuned.capas
            gpuLayers = tuned.capas
          }
        }
      }
    }
    const timed = await speed(item, ctx, gpuLayers)
    if (timed !== undefined) medidas.push(timed)
  }
  const timed = medidas.filter((m) => m.tps > 0)
  if (timed.length === 0) return { optimo: sizes[0], capas, medidas }
  const best = Math.max(...timed.map((m) => m.tps))
  const optimo = Math.max(...timed.filter((m) => m.tps >= best * KEEP_SPEED).map((m) => m.ctx))
  return { optimo, capas, medidas }
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

function variantName(name, label) {
  const i = name.lastIndexOf(':')
  const [base, tag] = i < 0 ? [name, 'latest'] : [name.slice(0, i), name.slice(i + 1)]
  return `${base}:${tag === 'latest' ? '' : tag + '-'}dsh-ctx-${label}`
}

/** Variante con su contexto y, si se ajustaron, sus capas en la gráfica. */
function variant(model, label, ctx, layers) {
  const parameters = layers === undefined ? { num_ctx: ctx } : { num_ctx: ctx, num_gpu: layers }
  return api('/api/create', { model: variantName(model, label), from: model, parameters, stream: false })
}

/** Descarga lo que tenga Ollama cargado (solo cuando el usuario pide optimizar). */
async function unloadAll() {
  for (const m of await loaded()) await api('/api/generate', { model: m.name, keep_alive: 0 }).catch(() => undefined)
}


async function main() {
  if (!takeLock()) return
  try {
    const deadline = Date.now() + MAX_WAIT_MS
    for (const item of job.models) {
      state = { model: item.model, inicio: new Date().toISOString(), hechos: 0, total: 1 }
      writeState()
      // Desde el botón se mide ya; si alguien vuelve a usar Ollama, se espera.
      let force = job.force === true
      for (;;) {
        if (force) {
          await unloadAll()
          force = false
        } else {
          await waitIdle(deadline)
        }
        try {
          const result = await calibrate(item)
          save(item.model, item.digest, result)
          state.hechos = state.total
          writeState()
          // Las capas ajustadas se aplican ya a las variantes de tamaño fijo que
          // existan (mismo contexto, solo cambia el reparto). Las que no existen no
          // se crean: con la limpieza automática se crean al usarlas, ya con estas capas.
          for (const [ctx, layers] of Object.entries(result.capas ?? {})) {
            const exists = await api('/api/show', { model: variantName(item.model, ctx) }).then(() => true, () => false)
            if (exists) await variant(item.model, ctx, Number(ctx), layers).catch(() => undefined)
          }
          // La app declaró `declared` al arrancar y resume la conversación según
          // ese valor: la variante automática solo puede crecer hasta el próximo
          // arranque (si el óptimo es menor, se aplica al volver a abrir la app).
          if (result.optimo >= item.declared) {
            await variant(item.model, 'auto', result.optimo, result.capas?.[result.optimo])
          }
          break
        } catch (error) {
          if (!(error instanceof Busy)) throw error
          // Alguien ha empezado a usar Ollama: se espera y se repite.
        }
      }
    }
  } finally {
    rmSync(stateFile, { force: true })
    rmSync(lockFile, { force: true })
  }
}

main().catch(() => process.exit(1))
