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

/**
 * Nombre que se muestra de cada modelo. Los de Hugging Face
 * (`hf.co/autor/Modelo-GGUF:Q4_K_M`) se quedan en `Modelo`: sin origen, sin
 * `-GGUF` y sin la etiqueta (suele ser la cuantización). Los de la biblioteca de
 * Ollama conservan su etiqueta (`qwen3:8b`) salvo `:latest`. Si dos coinciden se
 * añade lo justo para distinguirlos: la etiqueta, luego el autor y, como último
 * recurso, el nombre completo. config.json → "nombres" fija cualquiera a mano.
 */
function shortNames(ids, overrides) {
  const items = ids.map((id) => {
    const i = id.lastIndexOf(':')
    const [path, tag] = i < 0 ? [id, 'latest'] : [id.slice(0, i), id.slice(i + 1)]
    const parts = path.split('/')
    const model = parts.pop().replace(/[-_.]gguf$/i, '')
    return { id, model, tag, owner: parts.at(-1) ?? '', hub: parts.length > 0 }
  })
  const label = (it, level) => {
    if (level >= 3) return it.id
    let text = it.model
    const showTag = it.tag !== 'latest' && (!it.hub || level >= 1)
    if (showTag) text += it.hub ? ` ${it.tag}` : `:${it.tag}`
    if (level >= 2 && it.owner) text = `${it.owner}/${text}`
    return text
  }
  const names = {}
  for (const it of items) {
    let level = 0
    while (level < 3 && items.some((other) => other !== it && label(other, level) === label(it, level))) level++
    names[it.id] = (overrides && overrides[it.id]) || label(it, level)
  }
  return names
}

function gpuSignature() {
  let gpu
  try {
    gpu = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], {
      encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().replace(/\s+/g, ' ')
  } catch {
    gpu = 'sin-nvidia'
  }
  // La compresión de la memoria de contexto de Ollama cambia cuánto cabe en la
  // gráfica: si se activa, se vuelve a medir.
  const fa = process.env.OLLAMA_FLASH_ATTENTION
  const kv = process.env.OLLAMA_KV_CACHE_TYPE
  return gpu + (fa ? ` fa=${fa}` : '') + (kv ? ` kv=${kv}` : '')
}

function readCache() {
  try {
    return JSON.parse(readFileSync(cacheFile, 'utf8'))
  } catch {
    return {}
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** Partes de un fichero de bloqueo «pid» o «pid:pidDeLaApp» (0 si no hay). */
function lockParts(file) {
  try {
    const [pid, host] = readFileSync(file, 'utf8').trim().split(':').map(Number)
    return { pid: pid || 0, host: host || 0 }
  } catch {
    return { pid: 0, host: 0 }
  }
}

/**
 * Lanza un proceso que sigue por su cuenta y no hereda nada de la app. En
 * Windows, un proceso lanzado de la forma normal hereda las conexiones abiertas
 * de la app (su salida), y quien espere a que se cierren (el empaquetado al probar
 * la app, por ejemplo) se queda esperando mientras ese proceso viva.
 * Start-Process (ShellExecute) no hereda ninguna.
 */
function launchDetached(file, args, env) {
  if (process.platform === 'win32') {
    const quote = (text) => `'${String(text).replaceAll("'", "''")}'`
    const list = args.length === 0 ? '' : ` -ArgumentList ${args.map((arg) => quote(`"${arg}"`)).join(',')}`
    const command = `Start-Process -FilePath ${quote(file)}${list} -WindowStyle Hidden`
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command], {
      env, stdio: 'ignore', windowsHide: true,
    })
    ps.on('error', () => undefined)
    return
  }
  const child = spawn(file, args, { env, detached: true, stdio: 'ignore' })
  child.on('error', () => undefined)
  child.unref()
}

/** Guarda el código de un ayudante en storages y lo lanza con el Node de la app. */
function launchHelper(name, code, extraEnv) {
  const file = join(home, 'storages', `local-${name}.cjs`)
  require('node:fs').writeFileSync(file, code)
  launchDetached(process.execPath, [file], {
    ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_CTX_CALIBRAR: '', DSH_CTX_PRECARGA: '', ...extraEnv,
  })
}

/**
 * Si Ollama (local) no responde, lo arranca: la aplicación de Ollama («ollama
 * app.exe», que deja el servidor en marcha y su icono junto al reloj) o, si no
 * está, `ollama serve`. Espera hasta 12 s a que conteste.
 */
async function ensureOllama() {
  const ready = () => api('/api/version').then(() => true, () => false)
  if (await ready()) return
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(cfg.ollama)) return
  // La app evalúa su configuración varias veces al abrirse: se intenta una sola
  // vez por minuto, para no esperar 12 s en cada evaluación si no se puede.
  const attempt = join(home, 'storages', 'local-ollama-arranque.txt')
  const { existsSync, statSync, writeFileSync } = require('node:fs')
  if (existsSync(attempt) && Date.now() - statSync(attempt).mtimeMs < 60_000) return
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(attempt, new Date().toISOString())
  const tray = join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama app.exe')
  const [command, args] = existsSync(tray) ? [tray, []] : ['ollama', ['serve']]
  try {
    launchDetached(command, args, process.env)
  } catch {
    return
  }
  for (let waited = 0; waited < 12_000; waited += 500) {
    await sleep(500)
    if (await ready()) return
  }
}

async function main() {
  await ensureOllama()
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
  const names = shortNames([...bases], cfg.names)
  const display = (name) => names[name] || name
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
  mkdirSync(join(home, 'storages'), { recursive: true })
  const calibrationLock = cacheFile.replace(/.json$/, '.lock')
  if (pending.length > 0 && process.env.DSH_CTX_CALIBRAR && !alive(lockParts(calibrationLock).pid)) {
    const job = { ollama: cfg.ollama, cacheFile, gpu, version, models: pending }
    launchHelper('calibrar', process.env.DSH_CTX_CALIBRAR, { DSH_CTX_JOB: JSON.stringify(job) })
  }
  // Modelo listo mientras la app está abierta (precarga.cjs). La app es el proceso
  // que ha lanzado este script: cuando se cierre, la precarga lo verá y lo descargará.
  const preferred = cfg.defaultModel === undefined ? undefined : variantName(cfg.defaultModel, 'auto')
  const keepLock = join(home, 'storages', 'local-precarga.lock')
  const keeping = lockParts(keepLock)
  // La app evalúa su configuración varias veces: basta una precarga por apertura.
  const running = alive(keeping.pid) && keeping.host === process.ppid
  if (process.env.DSH_CTX_PRECARGA && !running && result.some((r) => r.id === preferred)) {
    const keep = {
      ollama: cfg.ollama,
      model: preferred,
      bases: [...bases],
      hostPid: process.ppid,
      lockFile: keepLock,
      calibrationLock,
    }
    launchHelper('precarga', process.env.DSH_CTX_PRECARGA, { DSH_CTX_KEEP: JSON.stringify(keep) })
  }
  if (result.length === 0) throw new Error('Ollama no tiene modelos de texto')
  process.stdout.write(JSON.stringify(result))
}

main().catch(() => process.exit(1))
