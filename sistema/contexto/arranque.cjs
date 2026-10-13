// Lista de modelos de Ollama con su contexto (añadido por dpseek-local-updater).
//
// La app lo ejecuta al arrancar, en un proceso Node aparte y síncrono (ver
// runtimeModelsExpression en aplicar-cambios.mjs), y usa lo que escribe en stdout
// como lista de modelos del selector.
//
// Ollama ignora el contexto (num_ctx) que se le pide por su API compatible con
// OpenAI, que es la que usa el harness. Por eso cada tamaño de contexto es una
// variante del modelo con num_ctx fijado (`<modelo>:dsh-ctx-131072`), que no
// ocupa disco: comparte los ficheros del modelo. `dsh-ctx-auto` lleva el óptimo
// medido para este equipo (calibrar.cjs) o, hasta medirlo, el valor por defecto.
//
// También borra las variantes que sobran (de modelos ya borrados o de tamaños que
// ya no se ofrecen) y lanza la precarga (precarga.cjs) que mantiene el modelo
// listo mientras la app está abierta.
//
// Entrada: variables de entorno DSH_CTX (configuración en JSON), DSH_CTX_CALIBRAR
// y DSH_CTX_PRECARGA (código del medidor y de la precarga, que se lanzan aparte).
'use strict'
const { execFileSync, spawn } = require('node:child_process')
const { readFileSync, mkdirSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')

const cfg = JSON.parse(process.env.DSH_CTX)
const MARK = 'dsh-ctx-'
const home = (process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
const cacheFile = join(home, 'storages', 'local-contexto.json')

async function api(path, body) {
  const init = body === undefined
    ? { signal: AbortSignal.timeout(4000) }
    : { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(8000) }
  const response = await fetch(cfg.ollama + path, init)
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
  return response.json()
}

const tagOf = (name) => (name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : 'latest')
const isVariant = (name) => tagOf(name).includes(MARK)
function variantName(name, label) {
  const i = name.lastIndexOf(':')
  const [base, tag] = i < 0 ? [name, 'latest'] : [name.slice(0, i), name.slice(i + 1)]
  return `${base}:${tag === 'latest' ? '' : tag + '-'}${MARK}${label}`
}
const VARIANT = /^(.*):(?:(.+)-)?dsh-ctx-(auto|\d+)$/
/** Modelo del que sale una variante (`m:dsh-ctx-auto` → `m:latest`), o undefined. */
function baseOf(name) {
  const match = VARIANT.exec(name)
  return match === null ? undefined : `${match[1]}:${match[2] === undefined ? 'latest' : match[2]}`
}
const labelOf = (name) => (VARIANT.exec(name) || [])[3]
/** Borra una variante de la app (solo nombres dsh-ctx-; nunca un modelo descargado). */
async function remove(name) {
  if (baseOf(name) === undefined) return
  await fetch(cfg.ollama + '/api/delete', {
    method: 'DELETE', body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(8000),
  }).catch(() => undefined)
}
const kilo = (n) => (n % 1024 === 0 ? `${n / 1024}K` : String(n))
const display = (name) => name.replace(/:latest$/, '')

function gpuSignature() {
  try {
    return execFileSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], {
      encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().replace(/\s+/g, ' ')
  } catch {
    return 'sin-nvidia'
  }
}

function readCache() {
  try {
    return JSON.parse(readFileSync(cacheFile, 'utf8'))
  } catch {
    return {}
  }
}

async function main() {
  const [{ models: tags }, { version }] = await Promise.all([api('/api/tags'), api('/api/version')])
  const existing = new Set(tags.map((m) => m.name))
  // Variantes de modelos que ya no están en Ollama (borrados con `ollama rm`): se
  // quitan, porque mientras existan retienen los ficheros del modelo en disco.
  const bases = new Set(tags.filter((m) => !isVariant(m.name)).map((m) => m.name))
  for (const m of tags) {
    const base = baseOf(m.name)
    if (base !== undefined && !bases.has(base)) {
      await remove(m.name)
      existing.delete(m.name)
    }
  }
  const gpu = gpuSignature()
  const cache = readCache()
  const result = []
  const pending = []
  for (const m of tags) {
    if (isVariant(m.name)) continue
    if (!(m.capabilities || ['completion']).includes('completion')) continue
    let show
    try {
      show = await api('/api/show', { model: m.name })
    } catch {
      continue
    }
    const caps = show.capabilities || m.capabilities || []
    if (!caps.includes('completion')) continue
    const info = show.model_info || {}
    const max = Number(info[`${info['general.architecture']}.context_length`]) || cfg.defaultCtx
    // Tamaños ofrecidos: los de config.json que admite el modelo, más su máximo
    // si alguno de los configurados lo supera.
    const sizes = [...new Set([
      ...cfg.sizes.filter((s) => s <= max),
      ...(cfg.sizes.some((s) => s > max) ? [max] : []),
    ])].sort((a, b) => a - b)
    if (sizes.length === 0) sizes.push(max)
    // Tamaños que ya no se ofrecen (se cambió contexto.tamanos): sus variantes sobran.
    for (const name of [...existing]) {
      const size = Number(labelOf(name))
      if (baseOf(name) === m.name && Number.isInteger(size) && !sizes.includes(size)) {
        await remove(name)
        existing.delete(name)
      }
    }

    const measured = cache[m.name]
    const fresh = measured !== undefined && measured.digest === m.digest
      && measured.ollama === version && measured.gpu === gpu && Number.isInteger(measured.optimo)
    const auto = Math.min(fresh ? measured.optimo : cfg.defaultCtx, max)
    if (!fresh) pending.push({ model: m.name, digest: m.digest, sizes, declared: auto })

    // Variantes: se crean solo si faltan; la automática también si cambió su valor.
    for (const [label, ctx] of [['auto', auto], ...sizes.map((s) => [String(s), s])]) {
      const name = variantName(m.name, label)
      let ready = existing.has(name)
      if (ready && label === 'auto') {
        const current = (await api('/api/show', { model: name })).parameters || ''
        ready = Number((current.match(/num_ctx\s+(\d+)/) || [])[1]) === ctx
      }
      if (!ready) await api('/api/create', { model: name, from: m.name, parameters: { num_ctx: ctx }, stream: false })
    }

    const common = (ctx) => ({
      contextWindow: ctx,
      maxTokens: Math.min(cfg.maxTokens, Math.floor(ctx / 2)),
      input: caps.includes('vision') ? ['text', 'image'] : ['text'],
      reasoningEfforts: caps.includes('thinking') ? cfg.efforts : false,
    })
    result.push({
      id: variantName(m.name, 'auto'),
      name: `${display(m.name)} · Auto ${kilo(auto)}${fresh ? '' : ' (sin medir)'}`,
      ...common(auto),
    })
    for (const s of sizes) result.push({ id: variantName(m.name, String(s)), name: `${display(m.name)} · ${kilo(s)}`, ...common(s) })
  }

  // La medición carga el modelo varias veces: va en segundo plano, en un proceso
  // independiente que sigue aunque se cierre la app.
  if (pending.length > 0 && process.env.DSH_CTX_CALIBRAR) {
    const job = { ollama: cfg.ollama, cacheFile, gpu, version, models: pending }
    const child = spawn(process.execPath, ['-e', process.env.DSH_CTX_CALIBRAR], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_CTX_JOB: JSON.stringify(job), DSH_CTX_CALIBRAR: '', DSH_CTX_PRECARGA: '' },
    })
    child.unref()
  }
  // Modelo listo mientras la app está abierta (precarga.cjs). La app es el proceso
  // que ha lanzado este script: cuando se cierre, la precarga lo verá y lo descargará.
  const preferred = cfg.defaultModel === undefined ? undefined : variantName(cfg.defaultModel, 'auto')
  if (process.env.DSH_CTX_PRECARGA && result.some((r) => r.id === preferred)) {
    mkdirSync(join(home, 'storages'), { recursive: true })
    const keep = {
      ollama: cfg.ollama,
      model: preferred,
      bases: [...bases],
      hostPid: process.ppid,
      lockFile: join(home, 'storages', 'local-precarga.lock'),
      calibrationLock: cacheFile.replace(/\.json$/, '.lock'),
    }
    const child = spawn(process.execPath, ['-e', process.env.DSH_CTX_PRECARGA], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_CTX_KEEP: JSON.stringify(keep), DSH_CTX_CALIBRAR: '', DSH_CTX_PRECARGA: '' },
    })
    child.unref()
  }
  if (result.length === 0) throw new Error('Ollama no tiene modelos de texto')
  process.stdout.write(JSON.stringify(result))
}

main().catch(() => process.exit(1))
