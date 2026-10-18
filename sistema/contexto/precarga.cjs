// Modelo listo mientras la app está abierta (añadido por dpseek-local-updater).
//
// Lo lanza arranque.cjs al abrir la app, como proceso aparte. Ollama descarga un
// modelo a los 5 minutos sin uso y el siguiente mensaje tarda en recargarlo; esto:
//   - al abrir la app, carga el modelo por defecto con su contexto recomendado si
//     Ollama no tiene nada cargado;
//   - mientras la app sigue abierta, renueva la permanencia de los modelos de la
//     app (variantes dsh-ctx-) que estén cargados, sin cargar otros;
//   - con la ventana cerrada (la app sigue en la bandeja) más de 2 minutos, los
//     descarga y deja de cargarlos: la app en segundo plano no retiene decenas de GB
//     de RAM y de gráfica; al volver a abrir la ventana, carga el modelo enseguida;
//   - al cerrarse la app, los descarga y libera la memoria, y termina enseguida.
// Se aparta mientras se mide el contexto (calibrar.cjs) y si se abre otra copia
// de la app, la nueva toma el relevo.
'use strict'
const { existsSync, readFileSync, writeFileSync, rmSync } = require('node:fs')

const job = JSON.parse(process.env.DSH_CTX_KEEP)
const TICK_MS = 60_000
const KEEP = '10m'
const RENEW_BEFORE_MS = 6 * 60_000
const HOST_CHECK_MS = 1000
const QUICK_MS = 3000
const HIDDEN_GRACE_MS = 2 * 60_000
const STARTED = Date.now()
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

async function api(path, body, timeoutMs = body === undefined ? 10_000 : 15 * 60_000) {
  const init = body === undefined
    ? { signal: AbortSignal.timeout(timeoutMs) }
    : { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }
  const response = await fetch(job.ollama + path, init)
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
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

const mine = () => {
  try {
    return Number(readFileSync(job.lockFile, 'utf8').split(':')[0]) === process.pid
  } catch {
    return false
  }
}
// Modelos de la app: sus variantes y, si Ollama comparte el proceso, el modelo base.
const ours = (name) => /(:|-)dsh-ctx-(auto|\d+)$/.test(name) || job.bases.includes(name)
const loaded = async () => (await api('/api/ps')).models || []

/**
 * Desde cuándo está escondida la ventana (local-window-state.ts la anota), o null si está a
 * la vista. Lo anotado antes de arrancar esta precarga no cuenta (es de otra apertura).
 */
function hiddenSince() {
  if (!job.windowFile) return null
  try {
    const state = JSON.parse(readFileSync(job.windowFile, 'utf8'))
    return state.visible === false && Number(state.at) >= STARTED ? Number(state.at) : null
  } catch {
    return null
  }
}

/** Descarga los modelos de la app. Si hay una respuesta en marcha, Ollama espera a que termine. */
async function release() {
  const models = (await loaded()).filter((m) => ours(m.name))
  await Promise.all(models.map((m) => api('/api/generate', { model: m.name, keep_alive: 0 }, QUICK_MS).catch(() => undefined)))
}

/** Espera la siguiente vuelta, pero se adelanta si se vuelve a abrir la ventana. */
async function pause() {
  const wasHidden = hiddenSince() !== null
  for (let waited = 0; waited < TICK_MS; waited += 1000) {
    await sleep(1000)
    if (wasHidden && hiddenSince() === null) return
  }
}

/**
 * Anota qué variantes y modelos están cargados: con eso la limpieza borra las
 * variantes sin uso en 7 días y el selector marca los modelos sin uso en 30.
 */
function recordUse(models) {
  if (!job.usageFile || models.length === 0) return
  let usage = {}
  try {
    usage = JSON.parse(readFileSync(job.usageFile, 'utf8'))
  } catch {
    // Primer uso anotado.
  }
  const now = new Date().toISOString()
  for (const m of models) usage[m.name] = now
  try {
    writeFileSync(job.usageFile, JSON.stringify(usage))
  } catch {
    // Solo sirve para la limpieza: si no se puede anotar, se sigue.
  }
}

/**
 * Al cerrarse la app: descarga sus modelos y termina en unos segundos. Este proceso
 * es el ejecutable de la app (sin ventana) y el instalador de actualizaciones solo
 * espera unos segundos a que no quede ninguno: si sigue vivo, no actualiza.
 */
let leaving = false
async function leave() {
  if (leaving) return
  leaving = true
  if (mine()) {
    try {
      const models = ((await api('/api/ps', undefined, QUICK_MS)).models || []).filter((m) => ours(m.name))
      await Promise.all(models.map((m) => api('/api/generate', { model: m.name, keep_alive: 0 }, QUICK_MS).catch(() => undefined)))
    } catch {
      // Ollama no responde: no hay nada que descargar a tiempo.
    }
    rmSync(job.lockFile, { force: true })
  }
  process.exit(0)
}

async function main() {
  // La copia más reciente de la app manda: la anterior lo verá y se retirará
  // sin descargar nada.
  writeFileSync(job.lockFile, `${process.pid}:${job.hostPid}`)
  // Vigila la app aparte: las llamadas a Ollama de la vuelta pueden tardar minutos.
  setInterval(() => { if (!alive(job.hostPid)) void leave() }, HOST_CHECK_MS)
  // Deja arrancar antes al medidor, que tiene prioridad.
  await sleep(20_000)
  let released = false
  for (;;) {
    if (!mine()) process.exit(0)
    const hidden = hiddenSince()
    if (hidden !== null) {
      // Ventana cerrada: ni cargar ni renovar; pasado un rato, descargar (una vez).
      if (!released && Date.now() - hidden >= HIDDEN_GRACE_MS) {
        try {
          await release()
          released = true
        } catch {
          // Ollama no responde: se reintenta en la siguiente vuelta.
        }
      }
    } else if (!existsSync(job.calibrationLock)) {
      released = false
      try {
        const models = await loaded()
        recordUse(models.filter((m) => ours(m.name)))
        // Nada cargado (al abrir la app o tras una medición): se carga el modelo por defecto.
        if (models.length === 0) await api('/api/generate', { model: job.model, keep_alive: KEEP })
        for (const m of models) {
          const left = Date.parse(m.expires_at) - Date.now()
          if (ours(m.name) && Number.isFinite(left) && left < RENEW_BEFORE_MS) {
            // Con el mismo contexto que ya tiene cargado, para que Ollama no lo recargue.
            await api('/api/generate', { model: m.name, keep_alive: KEEP, options: { num_ctx: m.context_length } })
          }
        }
      } catch {
        // Ollama apagado o reiniciándose: se reintenta en la siguiente vuelta.
      }
    }
    await pause()
  }
}

main().catch(() => process.exit(1))
