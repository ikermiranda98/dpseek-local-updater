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
// Entrada: variables de entorno DSH_CTX (configuración en JSON) y
// DSH_CTX_CALIBRAR (código del medidor, que se lanza en segundo plano).
'use strict'
const { execFileSync, spawn } = require('node:child_process')
const { readFileSync } = require('node:fs')
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
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_CTX_JOB: JSON.stringify(job), DSH_CTX_CALIBRAR: '' },
    })
    child.unref()
  }
  if (result.length === 0) throw new Error('Ollama no tiene modelos de texto')
  process.stdout.write(JSON.stringify(result))
}

main().catch(() => process.exit(1))
