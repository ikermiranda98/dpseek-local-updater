// Modelo listo mientras la app está abierta (añadido por dpseek-local-updater).
//
// Lo lanza arranque.cjs al abrir la app, como proceso aparte. Ollama descarga un
// modelo a los 5 minutos sin uso y el siguiente mensaje tarda en recargarlo; esto:
//   - al abrir la app, carga el modelo por defecto con su contexto recomendado si
//     Ollama no tiene nada cargado;
//   - mientras la app sigue abierta, renueva la permanencia de los modelos de la
//     app (variantes dsh-ctx-) que estén cargados, sin cargar otros;
//   - al cerrarse la app, los descarga y libera la memoria.
// Se aparta mientras se mide el contexto (calibrar.cjs) y si se abre otra copia
// de la app, la nueva toma el relevo.
'use strict'
const { existsSync, readFileSync, writeFileSync, rmSync } = require('node:fs')

const job = JSON.parse(process.env.DSH_CTX_KEEP)
const TICK_MS = 60_000
const KEEP = '10m'
const RENEW_BEFORE_MS = 6 * 60_000
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

async function api(path, body, timeoutMs = 15 * 60_000) {
  const init = body === undefined
    ? { signal: AbortSignal.timeout(10_000) }
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

async function main() {
  // La copia más reciente de la app manda: la anterior lo verá y se retirará
  // sin descargar nada.
  writeFileSync(job.lockFile, `${process.pid}:${job.hostPid}`)
  // Deja arrancar antes al medidor, que tiene prioridad.
  await sleep(20_000)
  for (;;) {
    if (!mine()) return
    if (!alive(job.hostPid)) {
      for (const m of await loaded().catch(() => [])) {
        if (ours(m.name)) await api('/api/generate', { model: m.name, keep_alive: 0 }).catch(() => undefined)
      }
      rmSync(job.lockFile, { force: true })
      return
    }
    if (!existsSync(job.calibrationLock)) {
      try {
        const models = await loaded()
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
    await sleep(TICK_MS)
  }
}

main().catch(() => process.exit(1))
