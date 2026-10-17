// Aplica las modificaciones locales (Ollama, sin inicio de sesión, sin telemetría,
// eliminar chats, contexto por chat) sobre una copia del repositorio de DeepSeek Harness.
//
// Uso: node sistema/aplicar-cambios.mjs <ruta-del-repositorio>
//
// Es idempotente: se puede ejecutar varias veces sobre el mismo árbol. Edita los
// ficheros localizando cada fila por el nombre del plugin o su id (no por número
// de línea), así que sobrevive a cambios menores entre versiones.
//   - Si algo imprescindible (Ollama, sin cuenta ni inicio de sesión, instalador,
//     actualizaciones) ya no existe, se detiene con un ERROR que explica qué falta.
//   - Las funciones añadidas se aplican enteras o se omiten con un AVISO, y si la
//     versión oficial ya trae la misma función se queda la oficial (ver
//     «Funciones añadidas: todo o nada, y la oficial manda»).

import { existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = process.argv[2]
if (!repo || !existsSync(join(repo, 'packages', 'bundle'))) {
  fail(`no parece un repositorio de DeepSeek Harness: ${repo ?? '(sin ruta)'}`)
}
const config = JSON.parse(readFileSync(join(here, '..', 'config.json'), 'utf8'))
const MARK = '# local-build'
const warnings = []
const done = []

function fail(message) {
  console.error(`\nERROR: ${message}`)
  process.exit(1)
}
function warn(message) {
  warnings.push(message)
  console.warn(`AVISO: ${message}`)
}
const rel = (file) => relative(repo, file).replaceAll('\\', '/')
const read = (file) => readFileSync(file, 'utf8')
function write(file, text) {
  writeFileSync(file, text.endsWith('\n') ? text : text + '\n')
  touch(file)
}

// Ficheros oficiales que modifica cada función: al compilar se comparan con la
// versión oficial anterior para avisar, antes de instalar, de qué puede cambiar
// (ver sistema/informe-actualizacion.mjs). Lo imprescindible va junto.
const BASE = 'imprescindible'
const touched = new Map()
let applying = BASE
function touch(file) {
  if (!touched.has(applying)) touched.set(applying, new Set())
  touched.get(applying).add(rel(file))
}

// ── Edición de filas YAML de Cordis conservando comentarios ────────────────────

const indentOf = (line) => line.length - line.trimStart().length
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** Delimita la fila que empieza en la línea `- id:` de índice `start`. */
function rowAt(lines, start) {
  const keyIndent = lines[start].indexOf('-') + 2
  let end = start + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line.trim() !== '' && indentOf(line) < keyIndent) break
    end++
  }
  while (end > start + 1 && lines[end - 1].trim() === '') end--
  let anchor = start
  for (let i = start + 1; i < end; i++) {
    if (indentOf(lines[i]) === keyIndent && /^\s*name:/.test(lines[i])) { anchor = i; break }
  }
  return { start, end, keyIndent, anchor }
}

/** Filas cuyo `- id:` coincide con `id`. */
function rowsById(lines, id) {
  const re = new RegExp(`^\\s*- id:\\s*['"]?${escapeRe(id)}['"]?\\s*(#.*)?$`)
  return lines.flatMap((line, i) => (re.test(line) ? [rowAt(lines, i)] : []))
}

/** Filas cuyo `name:` es el paquete `pkg`. */
function rowsByPackage(lines, pkg) {
  const re = new RegExp(`^\\s*name:\\s*['"]?${escapeRe(pkg)}['"]?\\s*(#.*)?$`)
  const rows = []
  lines.forEach((line, i) => {
    if (!re.test(line)) return
    for (let j = i; j >= 0; j--) {
      if (/^\s*- id:/.test(lines[j]) && lines[j].indexOf('-') + 2 === indentOf(line)) { rows.push(rowAt(lines, j)); return }
    }
  })
  return rows
}

/** Marca la fila como desactivada (sustituye un `disabled:` existente). */
function setDisabled(lines, row) {
  const pad = ' '.repeat(row.keyIndent)
  for (let i = row.start + 1; i < row.end; i++) {
    if (indentOf(lines[i]) === row.keyIndent && /^\s*disabled:/.test(lines[i])) {
      lines[i] = `${pad}disabled: true ${MARK}`
      return
    }
  }
  lines.splice(row.anchor + 1, 0, `${pad}disabled: true ${MARK}`)
}

/** Sustituye (o crea) el bloque `config:` completo de la fila. */
function setConfig(lines, row, block) {
  const pad = ' '.repeat(row.keyIndent)
  const body = [`${pad}config: ${MARK}`, ...block.map((l) => (l === '' ? '' : pad + '  ' + l))]
  for (let i = row.start + 1; i < row.end; i++) {
    if (indentOf(lines[i]) === row.keyIndent && /^\s*config:/.test(lines[i])) {
      let j = i + 1
      while (j < row.end && (lines[j].trim() === '' || indentOf(lines[j]) > row.keyIndent)) j++
      lines.splice(i, j - i, ...body)
      return
    }
  }
  let at = row.anchor + 1
  while (at < row.end && indentOf(lines[at]) === row.keyIndent && /^\s*disabled:/.test(lines[at])) at++
  lines.splice(at, 0, ...body)
}

/** Fija `key: value` dentro del `config:` de la fila, creándolo si hace falta. */
function setConfigKey(lines, row, key, value) {
  const pad = ' '.repeat(row.keyIndent)
  for (let i = row.start + 1; i < row.end; i++) {
    if (indentOf(lines[i]) === row.keyIndent && /^\s*config:/.test(lines[i])) {
      const inner = ' '.repeat(indentOf(lines[i + 1] ?? '') > row.keyIndent ? indentOf(lines[i + 1]) : row.keyIndent + 2)
      for (let j = i + 1; j < row.end && (lines[j].trim() === '' || indentOf(lines[j]) > row.keyIndent); j++) {
        if (indentOf(lines[j]) === inner.length && lines[j].trimStart().startsWith(`${key}:`)) {
          lines[j] = `${inner}${key}: ${value} ${MARK}`
          return
        }
      }
      lines.splice(i + 1, 0, `${inner}${key}: ${value} ${MARK}`)
      return
    }
  }
  lines.splice(row.anchor + 1, 0, `${pad}config:`, `${pad}  ${key}: ${value} ${MARK}`)
}

function bundleFiles() {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'lib') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.ya?ml$/.test(entry.name)) out.push(full)
    }
  }
  walk(join(repo, 'packages', 'bundle'))
  return out
}

/** Recorre los YAML de bundles aplicando `edit` a las filas que encuentre `find`. */
function editRows(find, edit) {
  let count = 0
  for (const file of bundleFiles()) {
    const lines = read(file).split(/\r?\n/)
    // Se edita de abajo arriba para que los índices de filas anteriores sigan siendo válidos.
    const rows = find(lines).sort((a, b) => b.start - a.start)
    if (rows.length === 0) continue
    for (const row of rows) edit(lines, row)
    write(file, lines.join('\n').replace(/\n+$/, ''))
    count += rows.length
  }
  return count
}

// ── Funciones añadidas: todo o nada, y la oficial manda ───────────────────────
// Lo imprescindible (Ollama, sin cuenta ni inicio de sesión, instalador y
// actualizaciones) detiene la compilación si no se puede aplicar: así la app se
// queda en la versión anterior en vez de recibir una rota. Las funciones que
// añadimos (idioma, eliminar chats, barra de contexto…) son opcionales:
//   - si falta algo del código oficial que necesitan, se omite esa función entera
//     (ningún fichero a medias) y el resto sigue;
//   - si la versión oficial ya trae la misma función, se queda la oficial y la
//     nuestra se omite.
// Lo omitido se avisa aquí y en las notas del Release.

const omitted = []
const omittedFeatures = []
class Skip extends Error {}
const skip = (reason) => { throw new Skip(reason) }
/** La versión oficial ya trae la función: se omite la nuestra. */
const official = (what) => skip(`la versión oficial ya incluye ${what}; se usa la suya`)

/**
 * Aplica una función añadida en una transacción: las escrituras se preparan y
 * solo llegan al disco si la función entera se puede aplicar.
 * @returns si se aplicó.
 */
function optional(name, apply) {
  const staged = new Map()
  const copies = []
  const tx = {
    read(file) {
      if (staged.has(file)) return staged.get(file)
      if (!existsSync(file)) skip(`no existe ${rel(file)}`)
      return read(file)
    },
    write(file, text) { staged.set(file, text) },
    copy(from, to) {
      if (!existsSync(dirname(to))) skip(`no existe ${rel(dirname(to))}`)
      copies.push([from, to])
    },
    /** Sustituye `from` por `to` salvo que `marker` (por defecto `to`) ya esté. */
    replace(file, from, to, marker = to) {
      const text = tx.read(file)
      if (text.includes(marker)) return
      if (!text.includes(from)) skip(`no se encuentra en ${rel(file)}: ${from.trim().split('\n')[0].slice(0, 80)}`)
      tx.write(file, text.replace(from, () => to))
    },
    /** Añade un fichero propio a la lista `files` de un tsconfig que los enumera. */
    addToTsconfig(tsconfig, file) {
      if (!existsSync(tsconfig)) return
      const parsed = JSON.parse(tx.read(tsconfig))
      if (Array.isArray(parsed.files) && !parsed.files.includes(file)) {
        parsed.files.push(file)
        tx.write(tsconfig, JSON.stringify(parsed, null, 2))
      }
    },
  }
  try {
    apply(tx)
  } catch (error) {
    if (!(error instanceof Skip)) throw error
    omitted.push(`${name}: ${error.message}`)
    omittedFeatures.push({ name, reason: error.message, official: error.message.startsWith('la versión oficial ya incluye') })
    warn(`se omite «${name}»: ${error.message}`)
    return false
  }
  for (const [from, to] of copies) copyFileSync(from, to)
  applying = name
  for (const [file, text] of staged) write(file, text)
  applying = BASE
  done.push(name)
  return true
}

/** Busca `re` en los ficheros fuente (.ts/.tsx) bajo `dir`, sin tests ni compilados ni los nuestros. */
function sourceMatches(dir, re, ownFiles = []) {
  if (!existsSync(dir)) return false
  const own = new Set(ownFiles)
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', 'lib', 'tests', 'test', 'dist'].includes(entry.name)) continue
      const full = join(d, entry.name)
      if (entry.isDirectory()) { if (walk(full)) return true; continue }
      if (!/\.tsx?$/.test(entry.name) || /\.(spec|test)\.tsx?$/.test(entry.name) || own.has(entry.name)) continue
      if (re.test(read(full))) return true
    }
    return false
  }
  return walk(dir)
}

/** Claves de un diccionario de textos que no son nuestras (las nuestras empiezan por `local.`). */
function officialKeys(file) {
  if (!existsSync(file)) return []
  return [...read(file).matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]).filter((key) => !key.startsWith('local.'))
}

// ── Modelos de Ollama y su contexto ───────────────────────────────────────────
// La lista de modelos se resuelve al ARRANCAR la app: una expresión !!js de la
// configuración ejecuta sistema/contexto/arranque.cjs, que pregunta a Ollama qué
// modelos hay y ofrece cada uno con varios tamaños de contexto («Auto» y los de
// config.json → contexto.tamanos). Ollama ignora el contexto pedido por su API
// compatible con OpenAI, así que cada tamaño es una variante del modelo con
// num_ctx fijado (no ocupa disco). «Auto» usa el óptimo que mide
// sistema/contexto/calibrar.cjs en este equipo. Si Ollama no responde, se usan
// los modelos de "modelosManuales" con el contexto por defecto.

const contexto = {
  porDefecto: config.contexto?.porDefecto ?? config.contextoMaximo ?? 65536,
  tamanos: config.contexto?.tamanos ?? [32768, 65536, 131072, 262144],
}
if (!Number.isInteger(contexto.porDefecto) || !contexto.tamanos.every(Number.isInteger)) {
  fail('"contexto" de config.json debe tener "porDefecto" y "tamanos" en números enteros de tokens')
}

const yamlString = (s) => `'${String(s).replaceAll("'", "''")}'`
const EFFORTS = { off: 'none', low: 'low', medium: 'medium', high: 'high' }

/** Variante de un modelo de Ollama con el contexto fijado (debe coincidir con arranque.cjs). */
function variantName(name, label) {
  const i = name.lastIndexOf(':')
  const [base, tag] = i < 0 ? [name, 'latest'] : [name.slice(0, i), name.slice(i + 1)]
  return `${base}:${tag === 'latest' ? '' : tag + '-'}dsh-ctx-${label}`
}

/** Nombre corto (como en arranque.cjs, sin desempatar): sin origen, sin -GGUF ni :latest. */
const fallbackName = (id) => id.replace(/:latest$/, '').split('/').pop().replace(/[-_.]gguf(?=$|:)/i, '').replace(/^(.*?)(:[^:]*)$/, (all, name, tag) => (id.includes('/') ? name : all))

/** Modelo de "modelosManuales" (sin Ollama al arrancar) en el formato de llm-pi-ai. */
const toPiAi = (m) => {
  const ctx = m.contexto ?? contexto.porDefecto
  return {
    id: variantName(m.id, 'auto'),
    // Solo se usa si Ollama no responde al abrir la app: el nombre lo dice.
    name: `${m.nombre ?? config.nombres?.[m.id] ?? fallbackName(m.id)} · Ollama not responding`,
    contextWindow: ctx,
    maxTokens: Math.min(config.maxTokensSalida, Math.floor(ctx / 2)),
    input: m.imagenes ? ['text', 'image'] : ['text'],
    reasoningEfforts: m.razonamiento ? EFFORTS : false,
  }
}

/**
 * Expresión que la app evalúa al arrancar: ejecuta arranque.cjs en un proceso
 * Node síncrono (la configuración no admite esperas) y usa su salida como lista
 * de modelos. Cualquier fallo devuelve los modelos fijos. Deja arranque.cjs y su
 * configuración en <DSH_HOME>/storages (local-arranque.*) para que el Host vuelva
 * a listar Ollama al abrir el selector (local-optimize.ts → localRefreshModels).
 *
 * El Host evalúa la configuración varias veces al arrancar (medido: 9), y cada una
 * lanzaba arranque.cjs en un proceso nuevo y síncrono (~150–200 ms cada uno, unos 3 s
 * en total con el Host bloqueado). Ahora se ejecuta una vez por proceso y las demás
 * evaluaciones reciben una copia del mismo resultado; los cambios posteriores en
 * Ollama llegan igual, por el refresco del selector (local-ollama-live.ts).
 */
function runtimeModelsExpression(fixed) {
  const startup = readFileSync(join(here, 'contexto', 'arranque.cjs'), 'utf8')
  const calibrator = readFileSync(join(here, 'contexto', 'calibrar.cjs'), 'utf8')
  const keeper = readFileSync(join(here, 'contexto', 'precarga.cjs'), 'utf8')
  const settings = {
    ollama: new URL(config.ollamaUrl).origin,
    defaultModel: config.modeloPorDefecto,
    names: config.nombres ?? {},
    sizes: contexto.tamanos,
    defaultCtx: contexto.porDefecto,
    maxTokens: config.maxTokensSalida,
    efforts: EFFORTS,
  }
  return [
    // Una vez por proceso (process es el mismo en todas las evaluaciones); copia para que nadie comparta el array.
    'structuredClone(process.__dshLocalOllamaModels ??=',
    `((fixed, code, settings) => { try {`,
    "const fs = process.getBuiltinModule('node:fs'); const path = process.getBuiltinModule('node:path');",
    "const home = (process.env.DSH_HOME || '').trim() || path.join(process.getBuiltinModule('node:os').homedir(), '.dsh');",
    "try { const dir = path.join(home, 'storages'); fs.mkdirSync(dir, { recursive: true });",
    "fs.writeFileSync(path.join(dir, 'local-arranque.cjs'), code); fs.writeFileSync(path.join(dir, 'local-arranque.json'), settings); } catch (error) {}",
    "const out = process.getBuiltinModule('node:child_process').execFileSync(process.execPath, ['-e', code],",
    `{ env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_CTX: settings, DSH_CTX_CALIBRAR: ${JSON.stringify(calibrator)}, DSH_CTX_PRECARGA: ${JSON.stringify(keeper)} },`,
    "timeout: 30000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });",
    'const models = JSON.parse(out);',
    'return Array.isArray(models) && models.length > 0 ? models : fixed;',
    `} catch (error) { return fixed; } })(${JSON.stringify(fixed)}, ${JSON.stringify(startup)}, ${JSON.stringify(JSON.stringify(settings))}))`,
  ].join(' ')
}

function piAiBlock(models) {
  return [
    '# Ollama local por su API compatible con OpenAI. Ollama ignora el token;',
    '# la cabecera fija evita depender de credenciales guardadas.',
    '# models: cada modelo de Ollama con varios contextos (Auto y fijos), resuelto al',
    '# arrancar por sistema/contexto/arranque.cjs de dpseek-local-updater.',
    'providers:',
    '  ollama:',
    '    displayName: Ollama (local)',
    '    api: openai-completions',
    `    baseURL: ${yamlString(new URL('/v1', config.ollamaUrl).href)}`,
    '    headers:',
    '      Authorization: Bearer ollama',
    '    retryPolicy:',
    '      mode: normal',
    '      maxRetries: 2',
    `    models: !!js ${yamlString(runtimeModelsExpression(models.map(toPiAi)))}`,
  ]
}

// ── 1. Ollama como proveedor y modelo por defecto ─────────────────────────────

const models = config.modelosManuales ?? []
if (!models.some((m) => m.id === config.modeloPorDefecto)) {
  models.unshift({ id: config.modeloPorDefecto })
}
const defaultModelId = variantName(config.modeloPorDefecto, 'auto')

if (editRows((l) => rowsById(l, 'llm-pi-ai'), (l, r) => setConfig(l, r, piAiBlock(models))) === 0) {
  fail('no se encuentra la fila "llm-pi-ai" (adaptador multiproveedor) en packages/bundle; el adaptador ha cambiado de nombre')
}
done.push(`Ollama: los modelos que haya al arrancar, con contexto Auto y ${contexto.tamanos.join('/')} tokens`)

if (editRows((l) => rowsById(l, 'agent-default-model'), (l, r) => setConfig(l, r, ['provider: ollama', `model: ${yamlString(defaultModelId)}`])) === 0) {
  fail('no se encuentra la fila "agent-default-model" en packages/bundle')
}
done.push(`modelo por defecto: ${defaultModelId}`)

// ── 2. Sin cuenta ni modelos online de DeepSeek, telemetría ni analítica ──────
// Los adaptadores de modelos de DeepSeek se desactivan: si en ~/.dsh queda un
// token de la cuenta (de haber usado la versión oficial) o una clave de API, sus
// modelos seguirían apareciendo y gastando saldo de esa cuenta por internet.

for (const [pkg, what] of [
  ['@deepseek-ai/dsh-client-ui-settings-account', 'interfaz de la cuenta de DeepSeek'],
  ['@deepseek-ai/dsh-llm-deepseek-account', 'modelos online de la cuenta de DeepSeek'],
  ['@deepseek-ai/dsh-llm-deepseek-api-key', 'modelos online de la API de DeepSeek'],
  ['@deepseek-ai/dsh-session-telemetry-otel', 'telemetría de sesiones'],
  ['@deepseek-ai/dsh-host-product-telemetry-otel', 'telemetría de producto'],
  ['@deepseek-ai/dsh-client-product-analytics', 'analítica de producto'],
]) {
  const n = editRows((l) => rowsByPackage(l, pkg), setDisabled)
  if (n === 0) warn(`no se encuentra ${pkg} (${what}); puede que se haya renombrado: revísalo a mano`)
  else done.push(`desactivado: ${what} (${n} fila/s)`)
}

// La búsqueda web va por la API de DeepSeek; la lectura de páginas se mantiene.
const toolWeb = editRows((l) => rowsByPackage(l, '@deepseek-ai/dsh-tool-web'), (l, r) => setConfigKey(l, r, 'search', 'false'))
if (toolWeb === 0) warn('no se encuentra @deepseek-ai/dsh-tool-web; la búsqueda web puede seguir visible')
else done.push(`búsqueda web desactivada (${toolWeb} fila/s)`)

// ── 3. App de escritorio: nunca mostrar la bienvenida con inicio de sesión ────

{
  const file = join(repo, 'apps', 'desktop', 'src', 'welcome-api.ts')
  if (!existsSync(file)) fail(`no existe ${rel(file)}`)
  const text = read(file)
  const re = /export function needsWelcome\((\w+): WelcomeAuthentication\): boolean \{\r?\n([^}]*)\}/
  const match = text.match(re)
  if (!match) fail(`no se encuentra la función needsWelcome en ${rel(file)}; el arranque de escritorio ha cambiado`)
  if (!/return false/.test(match[2])) {
    write(file, text.replace(re, [
      'export function needsWelcome(_authentication: WelcomeAuthentication): boolean {',
      '  // Local build: models run on Ollama without an account or API key, so the',
      '  // welcome entry (DeepSeek sign-in or key prompt) is never required.',
      '  return false',
      '}',
    ].join('\n')))
  }
  done.push('ventana de bienvenida e inicio de sesión desactivados')

  const spec = join(repo, 'apps', 'desktop', 'tests', 'welcome-window.spec.ts')
  if (existsSync(spec)) {
    const before = read(spec)
    const after = before.replace(
      'expect(needsWelcome({ loggedIn: false, hasApiKey: false })).toBe(true)',
      'expect(needsWelcome({ loggedIn: false, hasApiKey: false })).toBe(false)',
    )
    if (after !== before) write(spec, after)
  }
}

// ── 5. Instalador sin firmar: sin servidor de actualización obligatoria ───────
// El empaquetado exige un servidor de "actualización obligatoria" de DeepSeek que
// la app consultaría cada 10 minutos. En compilaciones sin firma no se exige ni se
// escribe en la app, y sin esa configuración la app no hace ninguna consulta.
// (Se reconoce la línea original aunque cambie la condición que la rodea.)

{
  const envFile = join(repo, 'apps', 'desktop', 'scripts', 'desktop-package-environment.mjs')
  const builderFile = join(repo, 'apps', 'desktop', 'scripts', 'electron-builder-config.mjs')
  if (!existsSync(envFile) || !existsSync(builderFile)) fail('no se encuentran los scripts de empaquetado de escritorio (apps/desktop/scripts)')

  const envFixed = 'if (!options.unsigned) resolveDesktopPolicyEnvironment(environment)'
  let env = read(envFile)
  if (!env.includes(envFixed)) {
    const re = /^([ \t]*)(?:if \([^\n]*\) )?resolveDesktopPolicyEnvironment\(environment\)\r?\n/m
    if (!re.test(env)) fail(`no se encuentra la validación de la actualización obligatoria en ${rel(envFile)}`)
    env = env.replace(re, (_, pad) => `${pad}// Local build: unsigned installers carry no mandatory-update service.\n${pad}${envFixed}\n`)
    write(envFile, env)
  }

  const builderFixed = `const policy = env.DSH_DESKTOP_UNSIGNED === '1' ? undefined : resolveDesktopPolicyEnvironment(env)`
  let builder = read(builderFile)
  if (!builder.includes(builderFixed)) {
    const re = /^([ \t]*)const policy = [^\n]*resolveDesktopPolicyEnvironment\(env\)\r?\n/m
    if (!re.test(builder)) fail(`no se encuentra la actualización obligatoria en ${rel(builderFile)}`)
    builder = builder.replace(re, (_, pad) => `${pad}// Local build: unsigned installers carry no mandatory-update service.\n${pad}${builderFixed}\n`)
    write(builderFile, builder)
  }
  done.push('instalador sin firma sin servidor de actualización obligatoria')
}

// ── 6. Actualizaciones desde los Releases de GitHub ───────────────────────────
// El servidor de actualizaciones de DeepSeek instalaría la versión oficial (sin
// estos cambios). Las compilaciones sin firma no traen servidor de actualizaciones;
// aquí se les da uno: los Releases del repositorio que compila esta versión. GitHub
// Actions pasa su dirección en DSH_LOCAL_ACTUALIZACIONES (así no queda escrita en
// el repositorio); "actualizaciones" en config.json sirve para fijarla a mano. La
// app usa su sistema de actualizaciones normal: busca nightly.yml allí, descarga el
// instalador nuevo e instala y reinicia.

{
  const builderFile = join(repo, 'apps', 'desktop', 'scripts', 'electron-builder-config.mjs')
  const url = process.env.DSH_LOCAL_ACTUALIZACIONES || config.actualizaciones
  if (!url) {
    warn('sin dirección de actualizaciones (DSH_LOCAL_ACTUALIZACIONES o "actualizaciones" en config.json): la app no buscará actualizaciones')
  } else {
    if (!/^https:\/\/[^\s'"]+$/.test(url)) fail(`"actualizaciones" de config.json no es una URL https válida: ${url}`)
    const feed = `[{ provider: 'generic', url: '${url.replace(/\/+$/, '')}', channel: 'nightly' }]`
    let builder = read(builderFile)
    if (!builder.includes(feed)) {
      // Original: sin firma (update === undefined) no hay publish. Se sustituye ese null
      // (o la URL de una ejecución anterior de este script) por el feed de GitHub.
      const re = /publish: update === undefined \? (?:null|\[\{ provider: 'generic', url: '[^']*', channel: 'nightly' \}\]) :/
      if (!re.test(builder)) fail(`no se encuentra la configuración de publicación en ${rel(builderFile)}`)
      builder = builder.replace(re, `publish: update === undefined ? ${feed} :`)
      write(builderFile, builder)
    }
    done.push(`actualizaciones desde ${url}`)
  }
}

// ── 7. Eliminar chats ─────────────────────────────────────────────────────────
// La versión oficial solo archiva (y al eliminar un espacio de trabajo sus chats
// pasan a «Sin agrupar»). Se añade «Eliminar sesión» al menú de cada chat: el
// Host borra la carpeta del chat y la de sus subagentes (sistema/borrar-chats/
// local-delete.ts) y la interfaz pide confirmación (DeleteSession.tsx).

const hostDir = join(repo, 'packages', 'api', 'session-controller', 'src')
const uiDir = join(repo, 'packages', 'client', 'ui-workspace', 'src', 'client')
const uiIndex = join(uiDir, 'index.ts')
const uiLocales = join(uiDir, 'locales.ts')

/** Añade textos en chino e inglés al final de los dos diccionarios de un fichero de idiomas. */
function addLocaleKeys(tx, file, keyType, zh, en) {
  let text = tx.read(file)
  if (text.includes(`'${Object.keys(en)[0]}'`)) return
  const zhEnd = /^\} satisfies Record<string, string>/m
  const enEnd = new RegExp(`^\\} satisfies Record<${keyType}, string>`, 'm')
  if (!zhEnd.test(text) || !enEnd.test(text)) skip(`no se encuentran los diccionarios zh/en en ${rel(file)}`)
  const lines = (dict) => Object.entries(dict).map(([k, v]) => `  '${k}': ${JSON.stringify(v)},`)
  text = text.replace(zhEnd, [...lines(zh), '} satisfies Record<string, string>'].join('\n'))
  text = text.replace(enEnd, [...lines(en), `} satisfies Record<${keyType}, string>`].join('\n'))
  tx.write(file, text)
}

const deleteApplied = optional('opción «Eliminar sesión» en el menú de cada chat', (tx) => {
  // Si DeepSeek añade el borrado de sesiones, se usa el suyo.
  if (sourceMatches(hostDir, /@Remote\('(delete|deleteSession|removeSession)'\)/)
    || sourceMatches(join(repo, 'packages', 'api', 'workspace-controller', 'src'), /@Remote\('(deleteSession|removeSession)'\)/)
    || officialKeys(uiLocales).some((key) => /deleteSession|session\.delete|menu\.delete(?!Workspace)/i.test(key) && !/workspace/i.test(key))) {
    official('el borrado de sesiones')
  }
  const hostIndex = join(hostDir, 'index.ts')
  const hostTypes = join(hostDir, 'types.ts')

  // Host: método remoto session.deletePermanently y filtro de la lista.
  tx.copy(join(here, 'borrar-chats', 'local-delete.ts'), join(hostDir, 'local-delete.ts'))
  tx.addToTsconfig(join(hostDir, '..', 'tsconfig.host.json'), 'src/local-delete.ts')
  let types = tx.read(hostTypes)
  if (!types.includes('interface SessionRemoveRequest')) {
    types = types.trimEnd() + '\n\n' + [
      '/** Local build: permanently delete one Session and its subagents. */',
      'export interface SessionRemoveRequest {',
      '  readonly sessionId: SessionId',
      '}',
      '',
      '/** Local build: Sessions removed now, and attached ones removed at next start. */',
      'export interface SessionRemoveValue {',
      '  readonly deletedSessionIds: readonly SessionId[]',
      '  readonly pendingSessionIds: readonly SessionId[]',
      '}',
    ].join('\n')
    tx.write(hostTypes, types)
  }
  tx.replace(hostIndex, "import { ApiSessionList } from './list.ts'\n", [
    "import { ApiSessionList } from './list.ts'",
    "import { LocalSessionDeleter } from './local-delete.ts'",
    "import type { SessionRemoveRequest, SessionRemoveValue } from './types.ts'",
    '',
  ].join('\n'), "from './local-delete.ts'")
  let host = tx.read(hostIndex)
  if (!host.includes("@Remote('deletePermanently')")) {
    const at = host.indexOf("  @Remote('list')")
    const doc = at < 0 ? -1 : host.lastIndexOf('  /**', at)
    if (doc < 0) skip(`no se encuentra @Remote('list') en ${rel(hostIndex)}`)
    host = host.slice(0, doc) + [
      '  /** Local build: lazily created permanent-delete helper (see local-delete.ts). */',
      '  private localDeleterInstance: LocalSessionDeleter | undefined',
      '',
      '  private localDeleter(): LocalSessionDeleter {',
      '    this.localDeleterInstance ??= new LocalSessionDeleter(this.ctx)',
      '    return this.localDeleterInstance',
      '  }',
      '',
      '  /**',
      '   * Local build: Session rows without the deleted ones. First removes what the',
      '   * previous run left pending, then hides Sessions whose deletion waits for the',
      '   * next start.',
      '   */',
      '  private async localListed(signal: AbortSignal) {',
      '    const hidden = await this.localDeleter().hidden()',
      '    const items = await this.listState.list(signal)',
      '    return items.filter(item => !hidden.has(item.sessionId))',
      '  }',
      '',
      '  /**',
      '   * Local build: archive (stopping its work) and permanently delete one',
      '   * Session with its subagents. Sessions still attached in this process are',
      '   * hidden and removed at the next start.',
      '   * @param request - Session identity.',
      '   * @returns Sessions removed now and Sessions pending removal.',
      '   */',
      "  @Remote('deletePermanently')",
      '  deletePermanently(request: SessionRemoveRequest): Promise<SessionRemoveValue> {',
      '    return this.localDeleter().delete(request.sessionId)',
      '  }',
      '',
      '',
    ].join('\n') + host.slice(doc)
    tx.write(hostIndex, host)
  }
  // Sin este filtro, un chat borrado con la sesión abierta se vería hasta reiniciar.
  // Solo se cambia la llamada a la lista dentro del método list, así da igual qué
  // haga después la oficial con las filas (0.2.1-alpha.3 filtra por permisos).
  host = tx.read(hostIndex)
  if (!host.includes('this.localListed(signal)')) {
    const method = host.search(/^\s*async list\([^)]*signal[^)]*\)/m)
    const call = method < 0 ? -1 : host.indexOf('this.listState.list(signal)', method)
    const end = method < 0 ? -1 : host.indexOf('\n  }', method)
    if (call < 0 || call > end) skip(`no se encuentra this.listState.list(signal) en el método list de ${rel(hostIndex)}`)
    host = host.slice(0, call) + 'this.localListed(signal)' + host.slice(call + 'this.listState.list(signal)'.length)
    tx.write(hostIndex, host)
  }

  // Interfaz: fila «Eliminar sesión» en el menú del chat y diálogo de confirmación.
  tx.copy(join(here, 'borrar-chats', 'DeleteSession.tsx'), join(uiDir, 'session-actions', 'DeleteSession.tsx'))
  tx.replace(uiIndex, "} from './session-actions/ArchiveSession.tsx'\n", [
    "} from './session-actions/ArchiveSession.tsx'",
    'import {',
    '  SessionDeleteDialog, type SessionDeleteDialogInjected, type SessionDeleteRequest,',
    "} from './session-actions/DeleteSession.tsx'",
    '',
  ].join('\n'), "from './session-actions/DeleteSession.tsx'")
  let ui = tx.read(uiIndex)
  if (!ui.includes("'remote.session'")) {
    const re = /^(export const inject = \[[^\]]*?)'remote',/m
    if (!re.test(ui)) skip(`no se encuentra la lista inject de ${rel(uiIndex)}`)
    ui = ui.replace(re, "$1'remote', 'remote.session',")
  }
  if (!ui.includes("id: 'workspace.session-delete'")) {
    const anchor = ui.match(/^([ \t]*)ctx\.slots\.inject\('conversation\.hero\.workspace'/m)
    if (!anchor) skip(`no se encuentra el final de apply() en ${rel(uiIndex)}`)
    for (const needed of ['uiWorkspace.archiveSession(', 'sessions.list.getSnapshot()', 'createSnapshotStore']) {
      if (!ui.includes(needed)) skip(`${rel(uiIndex)} ya no usa ${needed}`)
    }
    const pad = anchor[1]
    ui = ui.replace(anchor[0], () => [
      '// Local build: permanent delete (selection bar, section 9) and its confirmation dialog.',
      'const localDeleteSession = async (sessionId: SessionId): Promise<void> => {',
      '  // Archiving first stops its work and leaves the view if it is open.',
      '  await uiWorkspace.archiveSession(sessionId, { stopActivity: true })',
      '  const result = await ctx.remote.session.deletePermanently({ sessionId })',
      '  if (!result.ok) throw new Error(result.error.message)',
      '}',
      'const deleteRequest = createSnapshotStore<SessionDeleteRequest | null>(null)',
      'const deleteDialogInjected = (): SessionDeleteDialogInjected => ({',
      '  hooks: { deleteRequest },',
      '  settleSessionDelete: () => { deleteRequest.set(null) },',
      '  deleteSession: async (sessionId) => {',
      '    await localDeleteSession(sessionId)',
      '    await sessions.refresh()',
      '  },',
      '})',
      "ctx.slots.inject('shell.overlay', () => ctx.slots.register(",
      "  { name: 'shell.overlay', id: 'workspace.session-delete', locale: NS, inject: deleteDialogInjected },",
      '  SessionDeleteDialog,',
      '))',
      '// Local build: bulk delete hook (section 9).',
    ].map((line) => (line === '' ? '' : pad + line)).join('\n') + '\n' + anchor[0])
  }
  tx.write(uiIndex, ui)

  addLocaleKeys(tx, uiLocales, 'WorkspaceKey', {
    'local.deleteSession.menu': '删除会话',
    'local.deleteSession.title': '删除此会话？',
    'local.deleteSession.desc': '将永久删除“{title}”：对话、子智能体及其历史记录。工作目录中的文件不受影响。此操作无法撤销。',
    'local.deleteSession.action': '删除',
    'local.deleteSession.pending': '正在删除会话…',
  }, {
    'local.deleteSession.menu': 'Delete session',
    'local.deleteSession.title': 'Delete this session?',
    'local.deleteSession.desc': '“{title}” will be permanently deleted: the conversation, its subagents and its history. Files in the working folder are not touched. This cannot be undone.',
    'local.deleteSession.action': 'Delete',
    'local.deleteSession.pending': 'Deleting session…',
  })
})

// ── 8. Barra de contexto en el selector de modelo ─────────────────────────────
// El selector muestra una entrada por modelo y, debajo de «Modelo», una barra con
// los tamaños de contexto (sistema/contexto/ContextSlider.tsx); «Recomendado» es
// el óptimo medido para el equipo (variante automática). Sin la barra, el
// selector sigue funcionando: muestra cada tamaño como una entrada aparte.

optional('barra de contexto en el selector de modelo', (tx) => {
  const dir = join(repo, 'packages', 'client', 'ui-model-selection', 'src', 'client')
  const select = join(dir, 'ModelSelect.tsx')
  const locales = join(dir, 'locales.ts')
  // Si DeepSeek añade su propio control de contexto, se usa el suyo.
  if (officialKeys(locales).some((key) => /context/i.test(key))
    || sourceMatches(join(repo, 'packages'), /\bnum_ctx\b/,
      ['ContextSlider.tsx', 'local-ollama.ts', 'local-optimize.ts', 'LocalOptimizeButton.tsx'])) {
    official('un control del contexto')
  }
  tx.copy(join(here, 'contexto', 'ContextSlider.tsx'), join(dir, 'ContextSlider.tsx'))
  tx.copy(join(here, 'contexto', 'ContextSlider.module.css'), join(dir, 'ContextSlider.module.css'))

  tx.replace(select, "import { orderModelProviders } from './provider-order.ts'\n",
    "import { orderModelProviders } from './provider-order.ts'\n"
      + "import { ContextSlider, contextListModels, contextTriggerName, sameContextModel } from './ContextSlider.tsx'\n",
    "from './ContextSlider.tsx'")
  tx.replace(select, "models: rankByName(group.models, showSearch ? query.trim() : ''),",
    "models: rankByName(contextListModels(group.models), showSearch ? query.trim() : ''),")
  tx.replace(select, ': currentChoice?.model.name\n', ': contextTriggerName(currentChoice?.model.name)\n')
  tx.replace(select, 'const selected = state.current?.provider === group.id && state.current.model === model.id',
    'const selected = state.current?.provider === group.id && sameContextModel(state.current.model, model.id)')
  let text = tx.read(select)
  if (!text.includes('<ContextSlider')) {
    const re = /(<span className=\{css\.cellLabel\}>\{t\('menu\.model'\)\}<\/span>[\s\S]*?<\/button>\r?\n)/
    if (!re.test(text)) skip(`no se encuentra la fila «Modelo» del menú en ${rel(select)}`)
    text = text.replace(re, (row) => row + [
      '              {/* Local build: context-size bar (see ContextSlider.tsx). */}',
      '              <ContextSlider',
      '                models={groups.find(group => group.id === state.current?.provider)?.models ?? []}',
      '                current={state.current?.model}',
      '                disabled={busy}',
      '                onSelect={(modelId) => {',
      '                  if (state.current === null) return',
      '                  const { provider, reasoningEffort } = state.current',
      '                  choose({ provider, model: modelId, ...reasoningEffort === undefined ? {} : { reasoningEffort } })',
      '                }}',
      '                t={t}',
      '              />',
      '',
    ].join('\n'))
    tx.write(select, text)
  }
  addLocaleKeys(tx, locales, 'ModelKey', {
    'local.context.label': '上下文',
    'local.context.faster': '更快',
    'local.context.more': '更多上下文',
    'local.context.recommended': '推荐',
  }, {
    'local.context.label': 'Context',
    'local.context.faster': 'Faster',
    'local.context.more': 'More context',
    'local.context.recommended': 'Recommended',
  })
})

// ── 9. Seleccionar chats como en el Explorador, borrarlos y moverlos ──────────
// Ctrl+clic, Mayús+clic y recuadro arrastrando desde un hueco de la barra lateral;
// los seleccionados se pintan con el azul del tema. Una barra con «Move to
// project» (chats de «Ungrouped», a un proyecto de su misma carpeta o a uno nuevo
// para ella) y «Delete»; Supr borra y Esc limpia. Los de «Ungrouped» también se
// arrastran sobre un proyecto (sistema/borrar-chats/LocalSelection.tsx). Usa el
// borrado de la sección 7.

optional('seleccionar chats como en el Explorador (borrar y mover a un proyecto)', (tx) => {
  // Si DeepSeek añade la selección múltiple, se usa la suya.
  if (officialKeys(uiLocales).some((key) => /select(ed|ion)|bulk|batch|multi/i.test(key) && !key.startsWith('local.'))) {
    official('la selección de varios chats')
  }
  if (!deleteApplied) skip('necesita «Eliminar sesión», que no se ha aplicado')

  // Host: meter un chat de «Ungrouped» en un proyecto. attachSession comprueba que
  // la carpeta del chat es la del proyecto (si no, la lectura de archivos fallaría).
  const wsDir = join(repo, 'packages', 'api', 'workspace-controller', 'src')
  const wsIndex = join(wsDir, 'index.ts')
  tx.replace(wsIndex, "import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'\n",
    "import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'\n"
      + "import { WorkspaceId as toWorkspaceId } from '@deepseek-ai/dsh-workspace'\n",
    "import { WorkspaceId as toWorkspaceId }")
  let ws = tx.read(wsIndex)
  if (!ws.includes("@Remote('localAttachSession')")) {
    const at = ws.indexOf("  @Remote('insertSessionBefore')")
    const doc = at < 0 ? -1 : ws.lastIndexOf('  /**', at)
    if (doc < 0) skip(`no se encuentra @Remote('insertSessionBefore') en ${rel(wsIndex)}`)
    if (!ws.includes('workspaceView(')) skip(`${rel(wsIndex)} ya no usa workspaceView`)
    ws = ws.slice(0, doc) + [
      '  /**',
      '   * Local build: put one ungrouped Session into a Workspace. Only Sessions no',
      '   * Workspace accounts for; attachSession refuses one whose cwd is not the',
      "   * Workspace's directory, so its files keep resolving.",
      '   * @param request - Workspace and Session identities.',
      '   * @returns the updated Workspace projection.',
      '   */',
      "  @Remote('localAttachSession')",
      '  async localAttachSession(request: WorkspaceInsertSessionBeforeRequest): Promise<WorkspaceValue> {',
      '    const registry = this.ctx.workspaceRegistry',
      '    const details = { workspaceId: request.workspaceId, sessionId: request.sessionId }',
      '    if (registry.list().some(workspace => workspace.sessionIds.includes(request.sessionId))) {',
      "      throw new RemoteError('workspace/move-invalid', `session '${request.sessionId}' already belongs to a workspace`, details)",
      '    }',
      '    const workspace = registry.get(toWorkspaceId(request.workspaceId))',
      "    if (workspace === undefined) throw new RemoteError('workspace/move-invalid', `workspace '${request.workspaceId}' not found`, details)",
      '    try {',
      '      await workspace.attachSession(request.sessionId)',
      '    } catch (error) {',
      "      throw new RemoteError('workspace/move-invalid', error instanceof Error ? error.message : String(error), details)",
      '    }',
      '    return { workspace: workspaceView(workspace) }',
      '  }',
      '',
      '',
    ].join('\n') + ws.slice(doc)
    tx.write(wsIndex, ws)
  }
  // El test oficial simula todo el espacio remoto «workspace»: se le añade el
  // método nuevo para que siga compilando (si el test cambia, no se toca).
  const wsTest = join(repo, 'packages', 'api', 'workspace-controller', 'tests', 'model.client.spec.ts')
  const fakeAnchor = "    this.record('insertSessionBefore', request)\n    return this.onInsertSessionBefore(request)\n  }\n"
  if (existsSync(wsTest)) {
    const test = tx.read(wsTest)
    if (!test.includes('localAttachSession(') && test.includes(fakeAnchor)) {
      tx.write(wsTest, test.replace(fakeAnchor, () => fakeAnchor + [
        '',
        '  localAttachSession(request: WorkspaceInsertSessionBeforeRequest): Promise<RemoteResult<WorkspaceValue>> {',
        "    this.record('localAttachSession', request)",
        '    return this.onInsertSessionBefore(request)',
        '  }',
        '',
      ].join('\n')))
    }
  }

  // Interfaz.
  tx.copy(join(here, 'borrar-chats', 'LocalSelection.tsx'), join(uiDir, 'session-actions', 'LocalSelection.tsx'))
  tx.copy(join(here, 'borrar-chats', 'LocalSelection.module.css'), join(uiDir, 'session-actions', 'LocalSelection.module.css'))
  tx.replace(uiIndex, "} from './session-actions/DeleteSession.tsx'\n", [
    "} from './session-actions/DeleteSession.tsx'",
    "import { LocalSelection, type LocalMoveOptions, type LocalSelectionInjected } from './session-actions/LocalSelection.tsx'",
    '',
  ].join('\n'), "from './session-actions/LocalSelection.tsx'")
  let ui = tx.read(uiIndex)
  if (!ui.includes("'remote.workspace'")) {
    const re = /^(export const inject = \[[^\]]*?)'remote',/m
    if (!re.test(ui)) skip(`no se encuentra la lista inject de ${rel(uiIndex)}`)
    ui = ui.replace(re, "$1'remote', 'remote.workspace',")
  }
  if (!ui.includes("id: 'workspace.local-selection'")) {
    const anchor = ui.match(/^([ \t]*)\/\/ Local build: bulk delete hook \(section 9\)\.\r?\n/m)
    if (!anchor) skip(`no se encuentra el punto de enganche de la sección 7 en ${rel(uiIndex)}`)
    for (const needed of ['workspaces.list.getSnapshot()', 'const requestSessionRename', 'const forkInjected', 'const sessionIdInjected', 'const archiveInjected']) {
      if (!ui.includes(needed)) skip(`${rel(uiIndex)} ya no tiene ${needed}`)
    }
    const pad = anchor[1]
    ui = ui.replace(anchor[0], () => [
      '// Local build: select sessions like the Windows Explorer, delete or move them.',
      'const localSelection = createSnapshotStore<readonly SessionId[]>([])',
      'const titleOf = (id: SessionId): string => sessions.list.getSnapshot().byId[id]?.displayTitle ?? id',
      "const samePath = (a: string, b: string): boolean => a.replace(/[\\\\/]+$/, '').toLowerCase() === b.replace(/[\\\\/]+$/, '').toLowerCase()",
      'const ungroupedFolder = (id: SessionId): string | null => {',
      '  if (workspaces.list.getSnapshot().items.some(item => item.sessionIds.includes(id))) return null',
      '  return sessions.list.getSnapshot().byId[id]?.cwd ?? null',
      '}',
      'const localSelectionInjected = (): LocalSelectionInjected => ({',
      '  hooks: { selection: localSelection },',
      '  setSelection: (ids) => { localSelection.set(ids) },',
      '  isSelectable: (id) => {',
      '    const row = sessions.list.getSnapshot().byId[id]',
      "    return row !== undefined && row.parentId === undefined && row.origin !== 'subagent' && !row.blank",
      '  },',
      '  titlesOf: ids => ids.map(titleOf),',
      '  openSession: (id) => { uiWorkspace.openSession(id) },',
      '  // Las acciones del menú «⋯» oficial, tal cual (diálogos, avisos y deshacer incluidos).',
      "  renameSession: (id) => { requestSessionRename(id, sessions.list.getSnapshot().byId[id]?.title ?? '') },",
      '  forkSession: (id) => { forkInjected().forkSession(id) },',
      '  copySessionId: (id) => { void sessionIdInjected().copySessionId(id) },',
      '  archiveOne: (id) => { archiveInjected().archiveSession(id) },',
      '  isPinned: id => workspaces.list.getSnapshot().pinnedSessionIds.includes(id),',
      '  pinMany: async (ids, pinned) => {',
      '    const failed: SessionId[] = []',
      '    for (const id of ids) {',
      '      try { await (pinned ? uiWorkspace.pinSession(id) : uiWorkspace.unpinSession(id)) } catch { failed.push(id) }',
      '    }',
      '    return failed.map(titleOf)',
      '  },',
      '  archiveMany: async (ids) => {',
      '    const failed: SessionId[] = []',
      '    // Sin parar el trabajo: un chat que está respondiendo no se archiva.',
      '    for (const id of ids) {',
      '      try { await uiWorkspace.archiveSession(id) } catch { failed.push(id) }',
      '    }',
      '    return failed.map(titleOf)',
      '  },',
      '  deleteMany: async (ids, progress) => {',
      '    const failed: SessionId[] = []',
      '    let done = 0',
      '    for (const id of ids) {',
      '      try { await localDeleteSession(id) } catch { failed.push(id) }',
      '      progress(++done)',
      '    }',
      '    await sessions.refresh()',
      '    // Quedan seleccionados los que no se pudieron borrar.',
      '    localSelection.set(failed)',
      '    return failed.map(titleOf)',
      '  },',
      '  moveOptions: (ids): LocalMoveOptions | null => {',
      '    const folders = ids.map(ungroupedFolder)',
      '    if (folders.length === 0 || folders.some(folder => folder === null)) return null',
      '    const first = folders[0] as string',
      '    const shared = folders.every(folder => samePath(folder as string, first)) ? first : undefined',
      '    const targets = workspaces.list.getSnapshot().items',
      '      .filter(item => folders.every(folder => samePath(item.path, folder as string)))',
      '      .map(item => ({ workspaceId: item.workspaceId as string, title: item.title }))',
      '    return { targets, ...(shared !== undefined && targets.length === 0 ? { newFolder: shared } : {}) }',
      '  },',
      '  moveMany: async (ids, target) => {',
      "    const workspaceId = 'workspaceId' in target",
      '      ? target.workspaceId as WorkspaceId',
      '      : (await workspaces.create({ path: target.newFolder })).workspaceId',
      '    const failed: SessionId[] = []',
      '    for (const id of ids) {',
      '      const result = await ctx.remote.workspace.localAttachSession({ workspaceId, sessionId: id })',
      '      if (!result.ok) failed.push(id)',
      '    }',
      '    await sessions.refresh()',
      '    return failed.map(titleOf)',
      '  },',
      '})',
      "ctx.slots.inject('shell.overlay', () => ctx.slots.register(",
      "  { name: 'shell.overlay', id: 'workspace.local-selection', locale: NS, inject: localSelectionInjected },",
      '  LocalSelection,',
      '))',
    ].map((line) => (line === '' ? '' : pad + line)).join('\n') + '\n')
    tx.write(uiIndex, ui)
  }
  addLocaleKeys(tx, uiLocales, 'WorkspaceKey', {
    'local.bulk.count': '已选择 {n} 个',
    'local.bulk.title': '删除 {n} 个会话？',
    'local.bulk.desc': '将永久删除它们及其子智能体和历史记录。工作目录中的文件不受影响。此操作无法撤销。',
    'local.bulk.confirm': '删除 {n} 个',
    'local.bulk.more': '以及另外 {n} 个',
    'local.bulk.progress': '已删除 {done}/{n}…',
    'local.bulk.failed': '无法删除：{titles}',
    'local.sel.move': '移动到项目',
    'local.sel.newProject': '为 {folder} 新建项目',
    'local.sel.noTarget': '没有使用同一文件夹的项目',
    'local.sel.moveFailed': '无法移动：{titles}',
    'local.sel.clear': '清除选择 (Esc)',
    'local.sel.open': '打开',
    'local.sel.rename': '重命名',
    'local.sel.pin': '置顶',
    'local.sel.unpin': '取消置顶',
    'local.sel.archive': '归档',
    'local.sel.archiveMany': '归档 {n} 个会话',
    'local.sel.deleteMany': '删除 {n} 个会话',
    'local.sel.actionFailed': '无法完成：{titles}',
    'local.sel.fork': '创建分支',
    'local.sel.copyId': '复制会话 ID',
  }, {
    'local.bulk.count': '{n} selected',
    'local.bulk.title': 'Delete {n} sessions?',
    'local.bulk.desc': 'They will be permanently deleted, with their subagents and history. Files in the working folders are not touched. This cannot be undone.',
    'local.bulk.confirm': 'Delete {n}',
    'local.bulk.more': 'and {n} more',
    'local.bulk.progress': 'Deleted {done}/{n}…',
    'local.bulk.failed': 'Could not delete: {titles}',
    'local.sel.move': 'Move to project',
    'local.sel.newProject': 'New project for {folder}',
    'local.sel.noTarget': 'No project uses the same folder',
    'local.sel.moveFailed': 'Could not move: {titles}',
    'local.sel.clear': 'Clear selection (Esc)',
    'local.sel.open': 'Open',
    'local.sel.rename': 'Rename',
    'local.sel.pin': 'Pin',
    'local.sel.unpin': 'Unpin',
    'local.sel.archive': 'Archive',
    'local.sel.archiveMany': 'Archive {n} sessions',
    'local.sel.deleteMany': 'Delete {n} sessions',
    'local.sel.actionFailed': 'Could not complete: {titles}',
    'local.sel.fork': 'Branch',
    'local.sel.copyId': 'Copy session ID',
  })
})

// ── 10. Chats antiguos al contexto recomendado ────────────────────────────────
// Los chats anteriores al contexto por chat guardaron el modelo sin variante
// (`Qwen…:latest`), que ya no está en el catálogo. Al leerlos se traducen a la
// variante recomendada (sistema/contexto/local-ollama.ts), sin tocar su registro.

optional('chats antiguos pasan solos al contexto recomendado', (tx) => {
  const agent = join(hostDir, 'agent.ts')
  const projection = join(hostDir, 'model-selection-projection.ts')
  const defaultsDir = join(repo, 'packages', 'core', 'agent-default-model', 'src')
  const defaults = join(defaultsDir, 'index.ts')
  tx.copy(join(here, 'contexto', 'local-ollama.ts'), join(hostDir, 'local-ollama.ts'))
  tx.copy(join(here, 'contexto', 'local-ollama.ts'), join(defaultsDir, 'local-ollama.ts'))
  tx.addToTsconfig(join(hostDir, '..', 'tsconfig.host.json'), 'src/local-ollama.ts')
  tx.addToTsconfig(join(defaultsDir, '..', 'tsconfig.json'), 'src/local-ollama.ts')
  const importLine = "import { localOllamaSelection } from './local-ollama.ts'\n"
  for (const file of [agent, projection, defaults]) {
    let text = tx.read(file)
    if (text.includes(importLine)) continue
    const lastImport = [...text.matchAll(/^import [^\n]*\n|^} from '[^']+'\n/gm)].pop()
    if (lastImport === undefined) skip(`no se encuentran los imports de ${rel(file)}`)
    const at = lastImport.index + lastImport[0].length
    text = text.slice(0, at) + importLine + text.slice(at)
    tx.write(file, text)
  }
  // Selección guardada en el chat (elegida o la de su última petición).
  tx.replace(agent, 'function agentModelSelection(selection: ModelSelection): AgentModelSelection {\n',
    'function agentModelSelection(stored: ModelSelection): AgentModelSelection {\n  // Local build: pre-context Ollama ids map to the recommended variant.\n  const selection = localOllamaSelection(stored)\n',
    'localOllamaSelection(stored)')
  tx.replace(agent, 'const logged = loggedHeader.config\n', 'const logged = localOllamaSelection(loggedHeader.config)\n')
  // Modelo predeterminado guardado antes del cambio (el último elegido): los chats
  // nuevos empiezan con él.
  tx.replace(defaults, 'provider: this.config.provider.get(), model: this.config.model.get(),',
    'provider: this.config.provider.get(),\n      // Local build: pre-context Ollama ids map to the recommended variant.\n'
      + '      model: localOllamaSelection({ provider: this.config.provider.get(), model: this.config.model.get() }).model,',
    'localOllamaSelection({ provider: this.config.provider.get()')
  // Lo que ve el selector de modelo del chat.
  tx.replace(projection, 'view: state => ({ lastUsed: state.lastUsed, next: state.pending ?? state.lastUsed }),',
    'view: state => ({ lastUsed: localOllamaSelection(state.lastUsed), next: localOllamaSelection(state.pending ?? state.lastUsed) }),')
})

// ── 12. Aviso de Windows al terminar una respuesta ────────────────────────────
// Si la ventana no tiene el foco cuando un chat termina, sale una notificación con
// su título; al pulsarla se abre (sistema/avisos/local-reply-notifications.ts).

optional('aviso de Windows al terminar una respuesta en segundo plano', (tx) => {
  // Si DeepSeek añade sus propios avisos en la interfaz, se usan los suyos.
  // Nuestros propios avisos (este y el de los subchats) no cuentan como oficiales.
  if (sourceMatches(join(repo, 'packages', 'client'), /new Notification\(/, ['local-reply-notifications.ts', 'local-subchat-rows.tsx'])) {
    official('avisos de respuesta terminada')
  }
  tx.copy(join(here, 'avisos', 'local-reply-notifications.ts'), join(uiDir, 'local-reply-notifications.ts'))
  tx.replace(uiIndex, "import { WorkspacePicker } from './WorkspacePicker.tsx'\n",
    "import { WorkspacePicker } from './WorkspacePicker.tsx'\nimport { installLocalReplyNotifications } from './local-reply-notifications.ts'\n",
    "from './local-reply-notifications.ts'")
  let ui = tx.read(uiIndex)
  if (!ui.includes('installLocalReplyNotifications(sessions')) {
    const anchor = ui.match(/^([ \t]*)ctx\.slots\.inject\('conversation\.hero\.workspace'/m)
    if (!anchor) skip(`no se encuentra el final de apply() en ${rel(uiIndex)}`)
    const pad = anchor[1]
    ui = ui.replace(anchor[0], () => [
      '// Local build: Windows notification when a reply finishes in the background.',
      'ctx.effect(() => installLocalReplyNotifications(sessions, (sessionId) => { uiWorkspace.openSession(sessionId) }),',
      "  'ui-workspace: local reply notifications')",
    ].map((line) => pad + line).join('\n') + '\n' + anchor[0])
    tx.write(uiIndex, ui)
  }
})

// ── 13. No volver a ofrecer una versión retirada ──────────────────────────────
// sistema/volver-a-version-anterior.ps1 instala un Release anterior y anota la
// versión retirada; la app no la vuelve a ofrecer, pero sí la siguiente.

const skipApplied = optional('no volver a ofrecer una versión retirada', (tx) => {
  const src = join(repo, 'apps', 'desktop', 'src')
  const coordinator = join(src, 'update-coordinator.ts')
  tx.copy(join(here, 'escritorio', 'local-skip-version.ts'), join(src, 'local-skip-version.ts'))
  let text = tx.read(coordinator)
  if (!text.includes("from './local-skip-version.ts'")) {
    const lastImport = [...text.matchAll(/^import [^\n]*\n|^} from '[^']+'\n/gm)].pop()
    if (lastImport === undefined) skip(`no se encuentran los imports de ${rel(coordinator)}`)
    const at = lastImport.index + lastImport[0].length
    text = text.slice(0, at) + "import { localSkippedVersion } from './local-skip-version.ts'\n" + text.slice(at)
    tx.write(coordinator, text)
  }
  tx.replace(coordinator,
    'this.candidate = result.isUpdateAvailable && gt(version, this.currentVersion()) ? version : undefined',
    '// Local build: a version rolled back with volver-a-version-anterior.ps1 is not offered again.\n'
      + '      this.candidate = result.isUpdateAvailable && gt(version, this.currentVersion()) && !localSkippedVersion(version) ? version : undefined')
})

// ── 14. Herramientas de modelos en el selector ────────────────────────────────
// Junto a cada modelo de la lista: «Optimizar» (vuelve a medirlo en este equipo
// con sistema/contexto/calibrar.cjs, con un anillo de progreso) y, si lleva 30
// días sin usarse, lo que ocupa y un botón para borrarlo del disco. En el menú, el
// interruptor «Limpieza automática de variantes»: en Ollama solo queda la variante
// recomendada; las demás se crean al usarlas (antes de cada mensaje) y se borran
// tras 7 días sin uso. Host: sistema/contexto/local-optimize.ts. Interfaz:
// LocalOptimizeButton.tsx.

const toolsApplied = optional('herramientas de modelos en el selector (optimizar, limpieza y modelos sin usar)', (tx) => {
  const selectionDir = join(repo, 'packages', 'client', 'ui-model-selection', 'src', 'client')
  const select = join(selectionDir, 'ModelSelect.tsx')
  const selectionIndex = join(selectionDir, 'index.ts')
  const selectionLocales = join(selectionDir, 'locales.ts')
  const hostIndex = join(hostDir, 'index.ts')
  const hostTypes = join(hostDir, 'types.ts')
  const commands = join(hostDir, 'commands.ts')
  // Si DeepSeek añade su propia gestión de modelos, se usa la suya.
  if (officialKeys(selectionLocales).some((key) => /optimi[sz]e|tune|benchmark|cleanup|unused/i.test(key))) {
    official('la gestión de modelos en el selector')
  }

  // Host: llamadas remotas.
  tx.copy(join(here, 'contexto', 'local-optimize.ts'), join(hostDir, 'local-optimize.ts'))
  tx.addToTsconfig(join(hostDir, '..', 'tsconfig.host.json'), 'src/local-optimize.ts')
  // Lista de Ollama al día: la publica localRefreshModels; la usa llm-pi-ai (sección 15).
  tx.copy(join(here, 'contexto', 'local-ollama-live.ts'), join(hostDir, 'local-ollama-live.ts'))
  tx.addToTsconfig(join(hostDir, '..', 'tsconfig.host.json'), 'src/local-ollama-live.ts')
  let types = tx.read(hostTypes)
  if (!types.includes('interface SessionOptimizeModelRequest')) {
    types = types.trimEnd() + '\n\n' + [
      '/** Local build: re-measure one Ollama model on this machine. */',
      'export interface SessionOptimizeModelRequest {',
      '  readonly model: string',
      '}',
      '',
      '/** Local build: whether the measurement started and which model is being measured. */',
      'export interface SessionOptimizeModelValue {',
      '  readonly started: boolean',
      '  readonly running: string | null',
      '}',
      '',
      '/** Local build: request without required fields. */',
      'export interface SessionLocalEmptyRequest {',
      '  readonly model?: string',
      '}',
      '',
      '/** Local build: measurement in progress (model, progress 0-1) and whether variant cleanup is on. */',
      'export interface SessionOptimizeStatusValue {',
      '  readonly running: string | null',
      '  readonly progress: number | null',
      '  readonly cleanup: boolean',
      '}',
      '',
      '/** Local build: turn automatic variant cleanup on or off. */',
      'export interface SessionLocalCleanupRequest {',
      '  readonly enabled: boolean',
      '}',
      '',
      '/** Local build: whether automatic variant cleanup is on. */',
      'export interface SessionLocalCleanupValue {',
      '  readonly cleanup: boolean',
      '}',
      '',
      '/** Local build: one Ollama model with its size and idle time. */',
      'export interface SessionLocalModelInfo {',
      '  readonly id: string',
      '  readonly sizeBytes: number',
      '  readonly lastUsed: string | null',
      '  readonly idleDays: number',
      '  readonly unused: boolean',
      '}',
      '',
      '/** Local build: Ollama models with their size and idle time. */',
      'export interface SessionLocalModelsValue {',
      '  readonly models: readonly SessionLocalModelInfo[]',
      '}',
      '',
      '/** Local build: delete one Ollama model (and its context variants) from disk. */',
      'export interface SessionLocalDeleteModelRequest {',
      '  readonly model: string',
      '}',
      '',
      '/** Local build: names removed from Ollama. */',
      'export interface SessionLocalDeleteModelValue {',
      '  readonly deleted: readonly string[]',
      '}',
      '',
      '/** Local build: how many models the selector offers after listing Ollama again (0 if it could not). */',
      'export interface SessionLocalRefreshValue {',
      '  readonly models: number',
      '}',
    ].join('\n')
    tx.write(hostTypes, types)
  }
  tx.replace(hostIndex, "import { ApiSessionList } from './list.ts'\n", [
    "import { ApiSessionList } from './list.ts'",
    'import {',
    '  localDeleteModel, localModelsInfo, localOptimizeModel as runLocalOptimize,',
    '  localOptimizeStatus as readLocalOptimizeStatus, localRefreshModels, localSetCleanup,',
    "} from './local-optimize.ts'",
    'import type {',
    '  SessionLocalCleanupRequest, SessionLocalCleanupValue, SessionLocalDeleteModelRequest,',
    '  SessionLocalDeleteModelValue, SessionLocalEmptyRequest, SessionLocalModelsValue, SessionLocalRefreshValue,',
    '  SessionOptimizeModelRequest, SessionOptimizeModelValue, SessionOptimizeStatusValue,',
    "} from './types.ts'",
    '',
  ].join('\n'), "from './local-optimize.ts'")
  let host = tx.read(hostIndex)
  if (!host.includes("@Remote('optimizeLocalModel')")) {
    const at = host.indexOf("  @Remote('list')")
    const doc = at < 0 ? -1 : host.lastIndexOf('  /**', at)
    if (doc < 0) skip(`no se encuentra @Remote('list') en ${rel(hostIndex)}`)
    host = host.slice(0, doc) + [
      '  /**',
      '   * Local build: re-measure one Ollama model on this machine in the background',
      '   * (recommended context and GPU layers; see local-optimize.ts).',
      '   * @param request - model id or one of its context variants.',
      '   * @returns whether it started and which model is being measured.',
      '   */',
      "  @Remote('optimizeLocalModel')",
      '  async optimizeLocalModel(request: SessionOptimizeModelRequest): Promise<SessionOptimizeModelValue> {',
      '    return runLocalOptimize(request.model)',
      '  }',
      '',
      '  /**',
      '   * Local build: model being re-measured, progress and variant-cleanup setting.',
      '   * @param _request - no fields are required.',
      '   * @returns the current state.',
      '   */',
      "  @Remote('localOptimizeStatus')",
      '  async localOptimizeStatus(_request: SessionLocalEmptyRequest): Promise<SessionOptimizeStatusValue> {',
      '    return readLocalOptimizeStatus()',
      '  }',
      '',
      '  /**',
      '   * Local build: turn automatic cleanup of unused context variants on or off.',
      '   * @param request - the new setting.',
      '   * @returns the stored setting.',
      '   */',
      "  @Remote('localSetCleanup')",
      '  async localSetCleanup(request: SessionLocalCleanupRequest): Promise<SessionLocalCleanupValue> {',
      '    return localSetCleanup(request.enabled)',
      '  }',
      '',
      '  /**',
      '   * Local build: Ollama models with their size and idle time.',
      '   * @param _request - no fields are required.',
      '   * @returns one row per Ollama model (without context variants).',
      '   */',
      "  @Remote('localModelsInfo')",
      '  async localModelsInfo(_request: SessionLocalEmptyRequest): Promise<SessionLocalModelsValue> {',
      '    return localModelsInfo()',
      '  }',
      '',
      '  /**',
      '   * Local build: delete one Ollama model and its context variants from disk.',
      '   * @param request - model id or one of its context variants.',
      '   * @returns the names removed from Ollama.',
      '   */',
      "  @Remote('localDeleteModel')",
      '  async localDeleteModel(request: SessionLocalDeleteModelRequest): Promise<SessionLocalDeleteModelValue> {',
      '    return localDeleteModel(request.model)',
      '  }',
      '',
      '  /**',
      '   * Local build: list the Ollama models again (after deleting or pulling one)',
      '   * without restarting; the model selector calls it when it opens.',
      '   * @param _request - no fields are required.',
      '   * @returns how many models the selector offers now.',
      '   */',
      "  @Remote('localRefreshModels')",
      '  async localRefreshModels(_request: SessionLocalEmptyRequest): Promise<SessionLocalRefreshValue> {',
      '    return localRefreshModels()',
      '  }',
      '',
      '',
    ].join('\n') + host.slice(doc)
    tx.write(hostIndex, host)
  }
  // Antes de cada mensaje: la variante del chat tiene que existir en Ollama (con
  // la limpieza activada, las que no se usan se borran).
  tx.replace(commands, "} from './agent.ts'\n", "} from './agent.ts'\nimport { ensureLocalVariant } from './local-optimize.ts'\n",
    "import { ensureLocalVariant }")
  tx.replace(commands,
    '    const agent = await this.resolveAgent(request.sessionId)\n    if (hasPromptRequest(agent, request.requestId)) return { accepted: true }\n',
    '    const agent = await this.resolveAgent(request.sessionId)\n    if (hasPromptRequest(agent, request.requestId)) return { accepted: true }\n'
      + '    // Local build: recreate the context variant if automatic cleanup removed it.\n'
      + '    await ensureLocalVariant(this.agents.selectionFor(agent).current).catch(() => undefined)\n',
    'await ensureLocalVariant(')

  // Interfaz.
  tx.copy(join(here, 'contexto', 'LocalOptimizeButton.tsx'), join(selectionDir, 'LocalOptimizeButton.tsx'))
  tx.copy(join(here, 'contexto', 'LocalOptimizeButton.module.css'), join(selectionDir, 'LocalOptimizeButton.module.css'))
  tx.replace(select, "import css from './ModelSelect.module.css'\n",
    "import css from './ModelSelect.module.css'\n"
      + "import { LocalCleanupSwitch, LocalModelExtras } from './LocalOptimizeButton.tsx'\n"
      + "import localOptimizeCss from './LocalOptimizeButton.module.css'\n",
    "from './LocalOptimizeButton.tsx'")
  let text = tx.read(select)
  if (!text.includes('<LocalModelExtras')) {
    const open = /return \(\n(\s*)<button\n(\s*)ref=\{itemRef\(\)\}\n\s*type="button"\n\s*role="menuitemradio"\n/
    const close = /(<\/button>\n)(\s*)\)\n(\s*)\}\)\}/
    if (!open.test(text) || !close.test(text)) skip(`no se encuentran las filas de la lista de modelos en ${rel(select)}`)
    text = text.replace(open, (all, pad, inner) => `return (\n${pad}<div className={localOptimizeCss.row} key={model.id}>\n${pad}<button\n${inner}ref={itemRef()}\n${inner}type="button"\n${inner}role="menuitemradio"\n`)
    text = text.replace(close, (all, end, pad, pad2) => `${end}${pad}  {/* Local build: model tools (LocalOptimizeButton.tsx). */}\n${pad}  <LocalModelExtras model={model.id} t={t} />\n${pad}</div>\n${pad})\n${pad2}})}`)
  }
  if (!text.includes('<LocalCleanupSwitch')) {
    const effort = /^(\s*)\{reasoning !== undefined && \(\n/m
    if (!effort.test(text)) skip(`no se encuentra la fila de razonamiento del menú en ${rel(select)}`)
    text = text.replace(effort, (row, pad) => `${pad}{/* Local build: automatic variant cleanup switch. */}\n${pad}<LocalCleanupSwitch t={t} />\n${row}`)
  }
  tx.write(select, text)
  tx.replace(selectionIndex, 'ctx.plugin(ModelDirectoryResolver)\n', [
    'ctx.plugin(ModelDirectoryResolver)',
    '  // Local build: model tools in the selector (LocalOptimizeButton.tsx).',
    '  ctx.effect(() => {',
    '    const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {',
    '      if (!result.ok) throw new Error(result.error.message)',
    '      return result.value',
    '    }',
    '    setLocalOptimizer({',
    '      optimize: async model => unwrap(await ctx.remote.session.optimizeLocalModel({ model })),',
    '      status: async () => unwrap(await ctx.remote.session.localOptimizeStatus({})),',
    '      setCleanup: async enabled => unwrap(await ctx.remote.session.localSetCleanup({ enabled })),',
    '      models: async () => unwrap(await ctx.remote.session.localModelsInfo({})),',
    '      deleteModel: async model => unwrap(await ctx.remote.session.localDeleteModel({ model })),',
    '      refresh: async () => unwrap(await ctx.remote.session.localRefreshModels({})),',
    '    })',
    '    return () => { setLocalOptimizer(undefined) }',
    "  }, 'ui-model-selection: local model tools')",
    '',
  ].join('\n'), 'setLocalOptimizer({')
  tx.replace(selectionIndex, "import { ModelSelect } from './ModelSelect.tsx'\n",
    "import { ModelSelect } from './ModelSelect.tsx'\nimport { setLocalOptimizer } from './LocalOptimizeButton.tsx'\n",
    "import { setLocalOptimizer }")
  addLocaleKeys(tx, selectionLocales, 'ModelKey', {
    'local.optimize.title': '针对本机优化：测量推荐上下文和可放入显卡的层数（会多次加载模型，约需几分钟）',
    'local.optimize.running': '正在优化此模型：{percent}（后台进行；重新打开应用后可看到新的推荐值）',
    'local.optimize.done': '已优化：新的层数已生效；重新打开应用后可看到新的推荐上下文',
    'local.optimize.other': '正在优化另一个模型，请稍候',
    'local.cleanup.label': '自动清理模型变体',
    'local.cleanup.hint': '在 Ollama 中只保留每个模型的推荐变体；其他上下文大小在使用时创建，7 天未使用后删除（变体几乎不占磁盘空间）',
    'local.unused.badge': '未使用 · {size}',
    'local.unused.title': '已 {days} 天未使用，占用 {size}',
    'local.delete.title': '从磁盘删除（{size}）',
    'local.delete.confirm': '删除 {size}？',
    'local.delete.done': '已删除',
  }, {
    'local.optimize.title': 'Optimize for this computer: measures the recommended context and how many layers fit on the GPU (loads the model several times, takes a few minutes)',
    'local.optimize.running': 'Optimizing this model: {percent} (in the background; reopen the app to see the new recommended value)',
    'local.optimize.done': 'Optimized: the new GPU layers are already in use; reopen the app to see the new recommended context',
    'local.optimize.other': 'Another model is being optimized; please wait',
    'local.cleanup.label': 'Automatic variant cleanup',
    'local.cleanup.hint': 'Keeps only the recommended variant of each model in Ollama; other context sizes are created when used and deleted after 7 days without use (variants take almost no disk space)',
    'local.unused.badge': 'Unused · {size}',
    'local.unused.title': 'Unused for {days} days · takes {size}',
    'local.delete.title': 'Delete from disk ({size})',
    'local.delete.confirm': 'Delete {size}?',
    'local.delete.done': 'Deleted',
  })
})

// ── 15. Lista de Ollama al día al abrir el selector ───────────────────────────
// La lista de modelos se fija al arrancar (arranque.cjs desde la configuración).
// Al abrir el selector, el Host la vuelve a pedir (sección 14: localRefreshModels)
// y la publica en local-ollama-live.ts; aquí el adaptador llm-pi-ai la usa en vez
// de la de arranque y vuelve a registrar sus rutas, lo que avisa a la interfaz
// (`llm/adapters-updated`) para que recargue la lista: los modelos borrados o
// descargados se ven sin reiniciar la app.

optional('lista de Ollama al día al abrir el selector de modelos', (tx) => {
  if (!toolsApplied) skip('necesita las herramientas de modelos del selector, que no se han aplicado')
  const piAiDir = join(repo, 'packages', 'llm', 'llm-pi-ai', 'src')
  const piAiIndex = join(piAiDir, 'index.ts')
  tx.copy(join(here, 'contexto', 'local-ollama-live.ts'), join(piAiDir, 'local-ollama-live.ts'))
  tx.replace(piAiIndex, "import { PiAiAdapter } from './adapter.ts'\n",
    "import { PiAiAdapter } from './adapter.ts'\nimport { onLiveOllama, withLiveOllama } from './local-ollama-live.ts'\n",
    "from './local-ollama-live.ts'")
  // Los perfiles se memorizan por identidad de la configuración: withLiveOllama
  // devuelve el mismo objeto mientras no cambie la lista.
  tx.replace(piAiIndex, '    const raw = config.providers.get()\n',
    '    // Local build: the Ollama list refreshed when the model selector opens.\n'
      + '    const raw = withLiveOllama(config.providers.get())\n',
    'withLiveOllama(config.providers.get())')
  // Volver a registrar las mismas rutas publica llm/adapters-updated.
  tx.replace(piAiIndex, '  ensureRegistrationFacts()\n\n',
    '  ensureRegistrationFacts()\n'
      + '  // Local build: a refreshed Ollama list re-announces the routes so the selector reloads.\n'
      + '  ctx.effect(() => onLiveOllama(() => { registration?.replace([...profiles().keys()]) }))\n\n',
    'onLiveOllama(')
})

// ── 16. Editar tus mensajes y regenerar respuestas, con versiones ──────────────
// Como en Hermes Agent Desktop: clic en tu mensaje para editarlo en el sitio
// (Enter envía, Esc cancela) e icono «Regenerate» bajo cada respuesta. El registro
// de un chat no se puede recortar, así que se copia el chat hasta antes de ese
// turno, se envía el mensaje y se archiva el original; «‹ 1/2 ›» bajo tu mensaje
// cambia de versión y, al seguir escribiendo en una, las demás se borran
// (deletePermanently de la sección 7). Código: sistema/regenerar/.

optional('editar tus mensajes y regenerar respuestas (con versiones)', (tx) => {
  if (!deleteApplied) skip('necesita «Eliminar sesión», que no se ha aplicado')
  const chatDir = join(repo, 'packages', 'client', 'ui-chat', 'src', 'client')
  const chatLocale = join(chatDir, 'locale.ts')
  // Si DeepSeek añade la edición de mensajes o regenerar, se usan los suyos.
  if (officialKeys(chatLocale).some((key) => /regenerat|editMessage|message\.edit|rerun/i.test(key))) {
    official('editar mensajes y regenerar respuestas')
  }
  tx.copy(join(here, 'regenerar', 'local-regenerate.tsx'), join(chatDir, 'chat', 'local-regenerate.tsx'))
  tx.copy(join(here, 'regenerar', 'local-regenerate.module.css'), join(chatDir, 'chat', 'local-regenerate.module.css'))

  // Host: copiar el chat justo antes de un turno con el historial completo (el
  // cliente solo tiene cargada una parte; si se quedaba corto, la copia salía mal).
  const hostIndex = join(hostDir, 'index.ts')
  const hostTypes = join(hostDir, 'types.ts')
  let types = tx.read(hostTypes)
  if (!types.includes('interface SessionLocalForkBeforeRequest')) {
    types = types.trimEnd() + '\n\n' + [
      '/** Local build: fork one Session right before one turn, to run that turn again. */',
      'export interface SessionLocalForkBeforeRequest {',
      '  readonly sessionId: SessionId',
      '  /** Seq of the turn/start event of the turn to run again. */',
      '  readonly beforeSeq: number',
      '}',
      '',
      '/** Local build: the new Session and the inclusive seq it was cut at. */',
      'export interface SessionLocalForkBeforeValue {',
      '  readonly sessionId: SessionId',
      '  readonly atSeq: number',
      '}',
    ].join('\n')
    tx.write(hostTypes, types)
  }
  tx.replace(hostIndex, "import { ApiSessionList } from './list.ts'\n",
    "import { ApiSessionList } from './list.ts'\n"
      + "import type { SessionLocalForkBeforeRequest, SessionLocalForkBeforeValue } from './types.ts'\n",
    'SessionLocalForkBeforeRequest, SessionLocalForkBeforeValue }')
  let host = tx.read(hostIndex)
  if (!host.includes("@Remote('localForkBefore')")) {
    const at = host.indexOf("  @Remote('list')")
    const doc = at < 0 ? -1 : host.lastIndexOf('  /**', at)
    if (doc < 0) skip(`no se encuentra @Remote('list') en ${rel(hostIndex)}`)
    host = host.slice(0, doc) + [
      '  /**',
      '   * Local build: fork this Session right before one turn so it can run again',
      '   * (edit and regenerate). The cut is the last event before the turn that is not',
      '   * the queued copy of its prompt (agent/inbox/spliced), read from the whole log:',
      '   * a queued copy in the child would run on its own next to the resent prompt.',
      '   * @param request - Session identity and the seq of the turn/start event.',
      '   * @returns the new Session (same Workspace and current model) and the cut.',
      '   */',
      "  @Remote('localForkBefore')",
      '  async localForkBefore(request: SessionLocalForkBeforeRequest): Promise<SessionLocalForkBeforeValue> {',
      '    let cut: number | undefined',
      '    {',
      '      using observation = await this.ctx.sessionQuery.observeSession(request.sessionId)',
      '      for (const event of observation.events) {',
      '        if (event.seq >= request.beforeSeq) break',
      "        if (event.type !== 'agent/inbox/spliced') cut = event.seq",
      '      }',
      '    }',
      '    if (cut === undefined) {',
      "      throw new RemoteError('session/fork-unavailable',",
      '        `nothing to keep before event ${String(request.beforeSeq)} in session "${request.sessionId}"`,',
      '        { sessionId: request.sessionId })',
      '    }',
      '    const forked = await this.commands.fork({ sessionId: request.sessionId, atSeq: cut })',
      '    return { sessionId: forked.sessionId, atSeq: cut }',
      '  }',
      '',
      '',
    ].join('\n') + host.slice(doc)
    tx.write(hostIndex, host)
  }

  // El módulo necesita el contexto del chat (sesiones, espacios de trabajo, Host).
  const apply = join(chatDir, 'apply.ts')
  tx.replace(apply, "import { ChatView } from './chat/ChatView.tsx'\n",
    "import { ChatView } from './chat/ChatView.tsx'\nimport { setLocalChat } from './chat/local-regenerate.tsx'\n",
    "import { setLocalChat }")
  tx.replace(apply, 'export function apply(ctx: Context): void {\n',
    'export function apply(ctx: Context): void {\n'
      + '  // Local build: edit and regenerate (local-regenerate.tsx).\n'
      + '  setLocalChat(ctx)\n'
      + "  ctx.effect(() => () => { setLocalChat(undefined) }, 'ui-chat: local edit and regenerate')\n",
    'setLocalChat(ctx)')

  // El chat da su sesión y su lector a los mensajes.
  const view = join(chatDir, 'chat', 'ChatView.tsx')
  tx.replace(view, "import css from './ChatView.module.css'\n",
    "import css from './ChatView.module.css'\nimport { LocalChatProvider } from './local-regenerate.tsx'\n",
    'import { LocalChatProvider }')
  tx.replace(view, '            <MarkdownDelegateProvider openFile={requestOpenFile} openExternalLink={openExternalLink} fileImages={fileImages}>\n',
    '            <LocalChatProvider sessionId={sessionId} useChat={useChat}>\n'
      + '            <MarkdownDelegateProvider openFile={requestOpenFile} openExternalLink={openExternalLink} fileImages={fileImages}>\n',
    '<LocalChatProvider sessionId={sessionId}')
  tx.replace(view, '            </MarkdownDelegateProvider>\n',
    '            </MarkdownDelegateProvider>\n            </LocalChatProvider>\n',
    '</LocalChatProvider>')

  // Tu mensaje: clic para editar y barra de versiones.
  const message = join(chatDir, 'chat', 'MessageItem.tsx')
  tx.replace(message, "import { MessageIconActions } from './MessageIconActions.tsx'\n",
    "import { MessageIconActions } from './MessageIconActions.tsx'\nimport { LocalUserMessage } from './local-regenerate.tsx'\n",
    'import { LocalUserMessage }')
  tx.replace(message, '  const data = node.data\n  return (\n    <UserStyleBubble\n      content={data.content}\n      interactive\n',
    '  const data = node.data\n  return (\n    <LocalUserMessage node={node} t={t}>\n    <UserStyleBubble\n      content={data.content}\n      interactive\n',
    '<LocalUserMessage node={node}')
  tx.replace(message, '      )}\n    />\n  )\n})\n\n/** Injected-context keyed Chat renderer. */',
    '      )}\n    />\n    </LocalUserMessage>\n  )\n})\n\n/** Injected-context keyed Chat renderer. */',
    '</LocalUserMessage>')

  // Pie de cada respuesta: icono «Regenerate» junto a copiar y bifurcar.
  const tail = join(chatDir, 'chat', 'TurnTailNodeView.tsx')
  tx.replace(tail, "import { MessageIconActions } from './MessageIconActions.tsx'\n",
    "import { MessageIconActions } from './MessageIconActions.tsx'\nimport { LocalRegenerateButton } from './local-regenerate.tsx'\n",
    'import { LocalRegenerateButton }')
  tx.replace(tail, '        extraActions={assistantActions}\n',
    '        extraActions={<>{assistantActions}<LocalRegenerateButton turn={turn} useChat={useChat} t={t} /></>}\n',
    '<LocalRegenerateButton')

  addLocaleKeys(tx, chatLocale, 'ChatKey', {
    'local.regen.button': '重新生成回复',
    'local.edit.hint': '点击编辑消息',
    'local.edit.send': '发送修改后的消息',
    'local.edit.files': '附加的文件不会重新发送',
    'local.versions.previous': '上一个版本',
    'local.versions.next': '下一个版本',
    'local.versions.count': '{n}/{total}',
    'local.versions.warn': '在此继续将删除其他版本',
    'local.versions.warnLater': '在此继续将删除其他版本（其中一个还有 {n} 轮对话）',
  }, {
    'local.regen.button': 'Regenerate response',
    'local.edit.hint': 'Click to edit message',
    'local.edit.send': 'Send edited message',
    'local.edit.files': 'Attached files are not resent',
    'local.versions.previous': 'Previous version',
    'local.versions.next': 'Next version',
    'local.versions.count': '{n}/{total}',
    'local.versions.warn': 'Continuing here deletes the other versions',
    'local.versions.warnLater': 'Continuing here deletes the other versions (one has {n} more turns)',
  })
})

// ── 17. Al pasar por un chat, solo los tres puntos ──────────────────────────────
// La oficial muestra «Archive» y «Pin» como botones al pasar el ratón por un chat;
// los dos ya están en el menú «⋯» y en el del botón derecho (sección 9), así que
// la fila queda limpia, como en el Explorador.

optional('al pasar por un chat, solo el menú «⋯»', (tx) => {
  tx.replace(uiIndex,
    "  ctx.slots.inject('sidebar.workspaces.session.row.action', function* () {\n"
      + "    yield ctx.slots.register({ name: 'sidebar.workspaces.session.row.action', id: 'archive', order: 100, locale: NS, inject: archiveInjected }, ArchiveSessionRowButton)\n"
      + "    yield ctx.slots.register({ name: 'sidebar.workspaces.session.row.action', id: 'pin', order: 200, locale: NS, inject: pinInjected }, PinSessionRowButton)\n"
      + '  })\n',
    "  // Local build: no hover buttons; Archive and Pin live in the row menus.\n",
    'Local build: no hover buttons')
  // Sus componentes dejan de usarse: fuera de las importaciones (noUnusedLocals).
  tx.replace(uiIndex, 'ArchiveSessionMenuItem, ArchiveSessionRowButton, SessionArchiveConfirmDialog',
    'ArchiveSessionMenuItem, SessionArchiveConfirmDialog', 'ArchiveSessionMenuItem, SessionArchiveConfirmDialog }')
  tx.replace(uiIndex, 'import { PinSessionMenuItem, PinSessionRowButton } from', 'import { PinSessionMenuItem } from',
    'import { PinSessionMenuItem } from')
})

// ── 18. Aviso antes de instalar una actualización ─────────────────────────────
// Cada Release lleva local-update-info.json (sistema/informe-actualizacion.mjs): lo
// que la versión nueva cambia para nuestras funciones. La confirmación de «Install
// and Restart» lo enseña como un semáforo, con los detalles y «Skip this version»
// (que la deja de ofrecer, igual que volver-a-version-anterior.ps1).

optional('aviso antes de instalar una actualización (semáforo y saltar versión)', (tx) => {
  if (!skipApplied) skip('necesita «no volver a ofrecer una versión retirada»')
  const src = join(repo, 'apps', 'desktop', 'src')
  const main = join(src, 'main.ts')
  const coordinator = join(src, 'update-coordinator.ts')
  if (!tx.read(join(src, 'update-dialog.ts')).includes('readonly technicalDetails?: string')) {
    skip('la confirmación de actualizaciones ya no admite detalles desplegables')
  }
  tx.copy(join(here, 'escritorio', 'local-update-notice.ts'), join(src, 'local-update-notice.ts'))
  let text = tx.read(main)
  if (!text.includes("from './local-update-notice.ts'")) {
    const lastImport = [...text.matchAll(/^import [^\n]*\n|^} from '[^']+'\n/gm)].pop()
    if (lastImport === undefined) skip(`no se encuentran los imports de ${rel(main)}`)
    const at = lastImport.index + lastImport[0].length
    text = text.slice(0, at)
      + "import { LOCAL_SKIP_RESPONSE, localSkipVersion, localUpdateConfirmation, localUpdateReport } from './local-update-notice.ts'\n"
      + text.slice(at)
    tx.write(main, text)
  }
  tx.replace(main,
    '      const confirmation: Electron.MessageBoxOptions = {\n',
    '      // Local build: what this version changes for the local features (see local-update-notice.ts).\n'
      + "      const localReport = await localUpdateReport(updates.state.version ?? '')\n"
      + '      const confirmation: Electron.MessageBoxOptions = {\n',
    'const localReport = await localUpdateReport')
  tx.replace(main,
    '        const result = await updateDialog.show(parent, confirmation)\n'
      + '        if (result.response !== 0 || isMandatory()) return false\n',
    '        const result = await updateDialog.show(parent, localUpdateConfirmation(confirmation, localReport, locale.messages.updateLater))\n'
      + "        if (result.response === LOCAL_SKIP_RESPONSE) localSkipVersion(updates.state.version ?? '')\n"
      + '        if (result.response !== 0 || isMandatory()) return false\n')
  tx.replace(coordinator,
    "        if (!await this.beforeRestart()) return this.setState({ phase: 'ready', version })\n",
    '        // Local build: a version skipped from the confirmation stops being offered.\n'
      + "        if (!await this.beforeRestart()) return this.setState(localSkippedVersion(version) ? { phase: 'idle' } : { phase: 'ready', version })\n")
})

// ── 19. Código en vivo en el panel derecho y deshacer por fichero ─────────────
// Como VS Code con Claude: la pestaña «Live code» del panel derecho enseña lo que
// el modelo escribe (write/edit), con una pestaña por fichero; en tiempo real si el
// proveedor lo envía por trozos (Ollama lo da entero al terminar). No se abre sola:
// «View code» en la línea de estado del turno del chat. En la revisión de cambios del turno, cada
// fichero tiene «Undo», que lo deja como estaba al empezar el turno (si nadie lo
// ha tocado después). Código: sistema/codigo-vivo/.

optional('código en vivo en el panel derecho y deshacer por fichero', (tx) => {
  const live = join(here, 'codigo-vivo')
  const chatDir = join(repo, 'packages', 'client', 'ui-chat', 'src', 'client')
  const deliverablesDir = join(repo, 'packages', 'client', 'ui-deliverables', 'src', 'client')
  const deliverablesIndex = join(deliverablesDir, 'index.ts')
  const review = join(deliverablesDir, 'ReviewTab.tsx')
  // Si DeepSeek añade algo parecido (seguir lo que se escribe o deshacer), se usa lo suyo.
  if (/undo|revert|live ?code|follow/i.test(tx.read(join(deliverablesDir, 'locales.ts')))) {
    official('ver el código en vivo o deshacer cambios del turno')
  }

  // Chat: publica lo que el modelo va escribiendo y pone «View code» en la línea
  // de estado del turno («Deep diving…» mientras trabaja, «Completed in…» al acabar).
  tx.copy(join(live, 'local-live-store.ts'), join(chatDir, 'chat', 'local-live-store.ts'))
  tx.copy(join(live, 'local-live-watch.tsx'), join(chatDir, 'chat', 'local-live-watch.tsx'))
  tx.copy(join(live, 'local-live-watch.module.css'), join(chatDir, 'chat', 'local-live-watch.module.css'))
  const chatView = join(chatDir, 'chat', 'ChatView.tsx')
  tx.replace(chatView, "import css from './ChatView.module.css'\n",
    "import css from './ChatView.module.css'\nimport { LocalLiveSession, LocalLiveWatcher } from './local-live-watch.tsx'\n",
    "import { LocalLiveSession, LocalLiveWatcher } from './local-live-watch.tsx'")
  tx.replace(chatView, '            <MarkdownDelegateProvider openFile={requestOpenFile}',
    '            <LocalLiveWatcher sessionId={sessionId} useChat={useChat} />\n'
      + '            <LocalLiveSession sessionId={sessionId}>\n'
      + '            <MarkdownDelegateProvider openFile={requestOpenFile}',
    '<LocalLiveSession sessionId={sessionId}>')
  tx.replace(chatView, '            </MarkdownDelegateProvider>\n',
    '            </MarkdownDelegateProvider>\n            </LocalLiveSession>\n',
    '</LocalLiveSession>')
  const running = join(chatDir, 'chat', 'RunningStatus.tsx')
  tx.replace(running, "import { RunningWhaleTail } from './RunningWhaleTail.tsx'\n",
    "import { RunningWhaleTail } from './RunningWhaleTail.tsx'\nimport { LocalLiveCodeButton } from './local-live-watch.tsx'\n",
    "import { LocalLiveCodeButton } from './local-live-watch.tsx'")
  tx.replace(running, '        <TextShimmer active className={css.runningText}>{label}</TextShimmer>\n',
    '        <TextShimmer active className={css.runningText}>{label}</TextShimmer>\n'
      + '        <LocalLiveCodeButton placement="running" />\n',
    '<LocalLiveCodeButton placement="running" />')
  const processView = join(chatDir, 'chat', 'TurnProcessNodeView.tsx')
  tx.replace(processView, "import css from './TurnProcessNodeView.module.css'\n",
    "import css from './TurnProcessNodeView.module.css'\nimport { LocalLiveCodeButton } from './local-live-watch.tsx'\n",
    "import { LocalLiveCodeButton } from './local-live-watch.tsx'")
  tx.replace(processView, '  return (\n    <>\n      <span className={a11yCss.visuallyHidden}',
    "  return (\n    <div style={{ position: 'relative' }}>\n      <span className={a11yCss.visuallyHidden}",
    "<div style={{ position: 'relative' }}>")
  tx.replace(processView, '      </button>\n    </>\n  )\n',
    '      </button>\n      <LocalLiveCodeButton turn={node.data.turn} placement="process" />\n    </div>\n  )\n',
    '<LocalLiveCodeButton turn={node.data.turn} placement="process" />')

  // Panel derecho: la pestaña y el botón «Undo» de la revisión.
  tx.copy(join(live, 'local-live-store.ts'), join(deliverablesDir, 'local-live-store.ts'))
  tx.copy(join(live, 'local-live-code.tsx'), join(deliverablesDir, 'local-live-code.tsx'))
  tx.copy(join(live, 'local-live-code.module.css'), join(deliverablesDir, 'local-live-code.module.css'))
  tx.replace(deliverablesIndex, "import { ReviewTab, type ReviewInjected } from './ReviewTab.tsx'\n",
    "import { ReviewTab, type ReviewInjected } from './ReviewTab.tsx'\nimport { setLocalLive } from './local-live-code.tsx'\n",
    "import { setLocalLive } from './local-live-code.tsx'")
  tx.replace(deliverablesIndex,
    "  ctx.effect(() => ctx.sidebarRightTabs.register(changesReviewDefinition(t)), 'ui-deliverables: changes-review type')\n",
    "  ctx.effect(() => ctx.sidebarRightTabs.register(changesReviewDefinition(t)), 'ui-deliverables: changes-review type')\n"
      + '  // Local build: «Live code» tab and per-file undo (local-live-code.tsx).\n'
      + '  setLocalLive(ctx)\n')
  tx.replace(review, "import { FileDiff } from './FileDiff.tsx'\n",
    "import { FileDiff } from './FileDiff.tsx'\nimport { LocalUndoButton } from './local-live-code.tsx'\n",
    "import { LocalUndoButton } from './local-live-code.tsx'")
  tx.replace(review, "          {file !== undefined && <Tooltip label={t('review.openFile')}",
    '          {file !== undefined && <LocalUndoButton sessionId={sessionId} seq={seq} index={index} file={file} />}\n'
      + "          {file !== undefined && <Tooltip label={t('review.openFile')}",
    '<LocalUndoButton sessionId={sessionId}')

  // Host: deshacer un fichero con la comparación que guarda workspace-changes.
  const hostIndex = join(hostDir, 'index.ts')
  const hostTypes = join(hostDir, 'types.ts')
  tx.copy(join(live, 'local-undo.ts'), join(hostDir, 'local-undo.ts'))
  tx.addToTsconfig(join(hostDir, '..', 'tsconfig.host.json'), 'src/local-undo.ts')
  let types = tx.read(hostTypes)
  if (!types.includes('interface SessionLocalUndoRequest')) {
    types = types.trimEnd() + '\n\n' + [
      "/** Local build: put one file of a turn's changes back as it was when the turn started. */",
      'export interface SessionLocalUndoRequest {',
      '  readonly sessionId: SessionId',
      '  /** Seq of the turn\'s workspace/changes event. */',
      '  readonly seq: number',
      '  /** Index of the file in that summary. */',
      '  readonly index: number',
      '}',
      '',
      '/** Local build: what undoing did to the file. */',
      'export interface SessionLocalUndoValue {',
      "  readonly outcome: 'restored' | 'deleted' | 'recreated'",
      '}',
      '',
      "declare module '@deepseek-ai/dsh-typert-protocol' {",
      '  interface RemoteErrorDetailsMap {',
      "    'session/local-undo-unavailable': { readonly sessionId: SessionId }",
      "    'session/local-undo-failed': { readonly sessionId: SessionId }",
      '  }',
      '}',
    ].join('\n')
    tx.write(hostTypes, types)
  }
  tx.replace(hostIndex, "import { ApiSessionList } from './list.ts'\n",
    "import { ApiSessionList } from './list.ts'\n"
      + "import { localUndoTurnFile, type LocalWorkspaceChanges } from './local-undo.ts'\n"
      + "import type { SessionLocalUndoRequest, SessionLocalUndoValue } from './types.ts'\n",
    'SessionLocalUndoRequest, SessionLocalUndoValue }')
  let host = tx.read(hostIndex)
  if (!host.includes("@Remote('localUndoTurnFile')")) {
    const at = host.indexOf("  @Remote('list')")
    const doc = at < 0 ? -1 : host.lastIndexOf('  /**', at)
    if (doc < 0) skip(`no se encuentra @Remote('list') en ${rel(hostIndex)}`)
    host = host.slice(0, doc) + [
      '  /**',
      "   * Local build: put one file of a turn's changes back as it was when the turn",
      '   * started, from the comparison workspace-changes keeps. A file changed since',
      '   * the turn ended is left alone.',
      '   * @param request - Session, workspace/changes seq and file index.',
      '   * @param signal - cancels the comparison read.',
      '   * @returns what was done to the file.',
      '   */',
      "  @Remote('localUndoTurnFile')",
      '  async localUndoTurnFile(request: SessionLocalUndoRequest, signal: AbortSignal): Promise<SessionLocalUndoValue> {',
      "    const changes = (this.ctx as unknown as { get(name: string): unknown }).get('workspaceChanges') as LocalWorkspaceChanges | undefined",
      '    if (changes === undefined) {',
      "      throw new RemoteError('session/local-undo-unavailable', 'turn changes are not recorded in this app', { sessionId: request.sessionId })",
      '    }',
      '    try {',
      '      return { outcome: await localUndoTurnFile(changes, request.sessionId, request.seq, request.index, signal) }',
      '    } catch (error) {',
      "      throw new RemoteError('session/local-undo-failed', error instanceof Error ? error.message : String(error),",
      '        { sessionId: request.sessionId })',
      '    }',
      '  }',
      '',
    ].join('\n') + host.slice(doc)
    tx.write(hostIndex, host)
  }
})

// ── 20. Subchats ──────────────────────────────────────────────────────────────
// «Open in subchat» bajo cada respuesta: un subagente «fork» oficial lanzado desde
// la app, que empieza con toda la conversación, trabaja con esfuerzo alto (y con
// subagentes si le hacen falta) en el mismo modelo y contexto que el chat, y
// devuelve al chat principal solo su respuesta final. Se abre a la derecha y queda
// anidado bajo su chat en la barra lateral, con un punto de estado. Código:
// sistema/subchats/.

optional('subchats', (tx) => {
  const sub = join(here, 'subchats')
  const chatDir = join(repo, 'packages', 'client', 'ui-chat', 'src', 'client')
  const workspaceDir = join(repo, 'packages', 'client', 'ui-workspace', 'src', 'client')
  // Si DeepSeek añade subchats propios, se usan los suyos.
  if (officialKeys(join(chatDir, 'locale.ts')).some((key) => /subchat|sub-chat/i.test(key))) official('subchats')
  if (!tx.read(join(repo, 'packages', 'bundle', 'base', 'cordis.patch.yml')).includes('dsh-subagent-fork-in-process')) {
    skip('la versión oficial ya no trae los subagentes «fork»')
  }

  // Chat: el botón y el cuadro para escribir la tarea.
  for (const file of ['local-subchat-store.ts', 'local-subchat-start.ts', 'local-subchat-button.tsx', 'local-subchat-button.module.css',
    'local-subchat-view.tsx', 'local-subchat-view.module.css']) {
    tx.copy(join(sub, file), join(chatDir, 'chat', file))
  }
  const apply = join(chatDir, 'apply.ts')
  tx.replace(apply, "import { ChatView } from './chat/ChatView.tsx'\n",
    "import { ChatView } from './chat/ChatView.tsx'\nimport { setLocalSubchat } from './chat/local-subchat-button.tsx'\n",
    "import { setLocalSubchat } from './chat/local-subchat-button.tsx'")
  tx.replace(apply, '  const quotaNotice = createSnapshotStore<QuotaNoticeState | null>(null)\n',
    '  // Local build: subchats (local-subchat-button.tsx).\n'
      + '  setLocalSubchat(ctx)\n'
      + "  ctx.effect(() => () => { setLocalSubchat(undefined) }, 'ui-chat: local subchats')\n"
      + '  const quotaNotice = createSnapshotStore<QuotaNoticeState | null>(null)\n',
    '  setLocalSubchat(ctx)\n')
  const chatView = join(chatDir, 'chat', 'ChatView.tsx')
  tx.replace(chatView, "import css from './ChatView.module.css'\n",
    "import css from './ChatView.module.css'\nimport { LocalSubchatSession } from './local-subchat-button.tsx'\n",
    "import { LocalSubchatSession } from './local-subchat-button.tsx'")
  tx.replace(chatView, '            <MarkdownDelegateProvider openFile={requestOpenFile}',
    '            <LocalSubchatSession sessionId={sessionId}>\n'
      + '            <MarkdownDelegateProvider openFile={requestOpenFile}',
    '<LocalSubchatSession sessionId={sessionId}>')
  tx.replace(chatView, '            </MarkdownDelegateProvider>\n',
    '            </MarkdownDelegateProvider>\n            </LocalSubchatSession>\n',
    '</LocalSubchatSession>')
  const tail = join(chatDir, 'chat', 'TurnTailNodeView.tsx')
  tx.replace(tail, "import css from './TurnTailNodeView.module.css'\n",
    "import css from './TurnTailNodeView.module.css'\nimport { LocalSubchatButton } from './local-subchat-button.tsx'\n",
    "import { LocalSubchatButton } from './local-subchat-button.tsx'")
  // Junto a «Regenerate» si está (sección 16); si no, solo.
  const tailText = tx.read(tail)
  if (!tailText.includes('<LocalSubchatButton replyText=')) {
    if (tailText.includes('<LocalRegenerateButton turn={turn} useChat={useChat} t={t} /></>}')) {
      tx.replace(tail, '<LocalRegenerateButton turn={turn} useChat={useChat} t={t} /></>}',
        '<LocalRegenerateButton turn={turn} useChat={useChat} t={t} /><LocalSubchatButton replyText={assistantText(closing.blocks)} /></>}')
    } else {
      tx.replace(tail, 'extraActions={assistantActions}',
        'extraActions={<>{assistantActions}<LocalSubchatButton replyText={assistantText(closing.blocks)} /></>}')
    }
  }

  // Ventana del subchat: empieza en la tarea (lo copiado del chat principal se oculta,
  // con una línea para verlo) y sin las instrucciones que la acompañan.
  const flow = join(chatDir, 'chat', 'ChatFlow.tsx')
  tx.replace(flow, "import { memo } from 'react'\n",
    "import { memo, useState } from 'react'\nimport { LocalSubchatSeedLine, localSubchatSeed } from './local-subchat-view.tsx'\n",
    "import { LocalSubchatSeedLine, localSubchatSeed }")
  tx.replace(flow, '  const rows = entries.map((entry) => {\n',
    '  // Local build: a subchat starts at its task; the copied main-chat turns stay hidden.\n'
      + '  const [localShowSeed, setLocalShowSeed] = useState(false)\n'
      + '  const localSeed = localSubchatSeed(entries, nodeStore)\n'
      + '  const shownEntries = localSeed === undefined || localShowSeed ? entries : entries.slice(localSeed.index)\n'
      + '  const rows = shownEntries.map((entry) => {\n',
    '  const rows = shownEntries.map((entry) => {\n')
  tx.replace(flow, '  return [...rows, ...pendingRows, ...running ?',
    '  const localSeedRow = localSeed === undefined ? [] : [<LocalSubchatSeedLine key="local-subchat-seed" messages={localSeed.messages}\n'
      + '    shown={localShowSeed} onToggle={() => { setLocalShowSeed(value => !value) }} />]\n'
      + '  return [...localSeedRow, ...rows, ...pendingRows, ...running ?',
    'return [...localSeedRow, ...rows')
  const messageItem = join(chatDir, 'chat', 'MessageItem.tsx')
  tx.replace(messageItem, "import css from './MessageItem.module.css'\n",
    "import css from './MessageItem.module.css'\nimport { localVisibleContent } from './local-subchat-view.tsx'\n",
    "import { localVisibleContent } from './local-subchat-view.tsx'")
  tx.replace(messageItem, '      content={data.content}\n      interactive\n',
    '      content={localVisibleContent(data.content)}\n      interactive\n')
  // Chat principal: la respuesta de un subchat como su tarjeta (los demás avisos, como siempre).
  const trigger = join(chatDir, 'chat', 'TurnTriggerNodeView.tsx')
  tx.replace(trigger, "import css from './TurnTriggerNodeView.module.css'\n",
    "import css from './TurnTriggerNodeView.module.css'\nimport { LocalSubchatResultCard, localSubchatNotice } from './local-subchat-view.tsx'\n",
    "import { LocalSubchatResultCard, localSubchatNotice }")
  tx.replace(trigger, "export function TurnTriggerNodeView({ node, t }: Pick<ChatNodeViewProps<'turn-trigger'>, 'node' | 't'>) {\n",
    "function OfficialTurnTriggerNodeView({ node, t }: Pick<ChatNodeViewProps<'turn-trigger'>, 'node' | 't'>) {\n",
    'function OfficialTurnTriggerNodeView(')
  let triggerText = tx.read(trigger)
  if (!triggerText.includes('export function TurnTriggerNodeView(')) {
    triggerText = triggerText.trimEnd() + '\n\n' + [
      '/** Local build: a subchat result gets its own card; every other trigger keeps the official notice. */',
      "export function TurnTriggerNodeView({ node, t }: Pick<ChatNodeViewProps<'turn-trigger'>, 'node' | 't'>) {",
      '  const subchat = localSubchatNotice(node.data.source)',
      '  return subchat === undefined',
      '    ? <OfficialTurnTriggerNodeView node={node} t={t} />',
      '    : <LocalSubchatResultCard notice={subchat} content={node.data.content} time={formatMessageClock(node.data.time, t)} />',
      '}',
    ].join('\n')
    tx.write(trigger, triggerText)
  }

  // Junto al medidor de contexto: con el chat ya lleno, sugerir un subchat con las cifras
  // (lo lanza ui-chat, que tiene acceso al Host, a través de local-subchat-store.ts).
  const conversationDir = join(repo, 'packages', 'client', 'ui-conversation', 'src', 'client')
  for (const file of ['local-subchat-store.ts', 'local-subchat-hint.tsx', 'local-subchat-hint.module.css']) {
    tx.copy(join(sub, file), join(conversationDir, 'skeleton', file))
  }
  const inputBar = join(conversationDir, 'skeleton', 'InputBar.tsx')
  tx.replace(inputBar, "import { ContextMeter } from './ContextMeter.tsx'\n",
    "import { ContextMeter } from './ContextMeter.tsx'\nimport { LocalSubchatHint } from './local-subchat-hint.tsx'\n",
    "import { LocalSubchatHint } from './local-subchat-hint.tsx'")
  tx.replace(inputBar, '        {activity ? null : <ContextMeter useProjection={useProjection} t={t} />}\n',
    '        {activity ? null : <>\n'
      + '          <LocalSubchatHint sessionId={sessionId} useProjection={useProjection} draft={draft} subagent={subagent !== null}\n'
      + "            clearDraft={() => { inputActions?.setDraft('') }} />\n"
      + '          <ContextMeter useProjection={useProjection} t={t} />\n'
      + '        </>}\n',
    '<LocalSubchatHint sessionId={sessionId}')

  // Barra lateral: los subchats bajo su chat.
  for (const file of ['local-subchat-store.ts', 'local-subchat-start.ts', 'local-subchat-rows.tsx', 'local-subchat-rows.module.css']) {
    tx.copy(join(sub, file), join(workspaceDir, 'rows', file))
  }
  const rows = join(workspaceDir, 'rows', 'Rows.tsx')
  tx.replace(rows, "import css from './Rows.module.css'\n",
    "import css from './Rows.module.css'\nimport { LocalSubchatRows } from './local-subchat-rows.tsx'\n",
    "import { LocalSubchatRows } from './local-subchat-rows.tsx'")
  tx.replace(rows, '  return (\n    <HoverCard\n      anchor={ownRow}\n      content={<SessionHoverContent node={node}',
    '  return (\n    <>\n    <HoverCard\n      anchor={ownRow}\n      content={<SessionHoverContent node={node}',
    '  return (\n    <>\n    <HoverCard\n      anchor={ownRow}\n      content={<SessionHoverContent node={node}')
  tx.replace(rows, "      disabled={menuOpen || drag?.active === true}\n"
      + "      copyText={row.blank || row.title === '' ? undefined : row.title}\n"
      + "      copyLabel={t('copy')}\n"
      + "      copiedLabel={t('hover.copied')}\n"
      + '    />\n  )\n}\n',
    "      disabled={menuOpen || drag?.active === true}\n"
      + "      copyText={row.blank || row.title === '' ? undefined : row.title}\n"
      + "      copyLabel={t('copy')}\n"
      + "      copiedLabel={t('hover.copied')}\n"
      + '    />\n    <LocalSubchatRows parentId={node.id} currentId={currentId} />\n    </>\n  )\n}\n',
    '<LocalSubchatRows parentId={node.id} currentId={currentId} />')
  const workspaceIndex = join(workspaceDir, 'index.ts')
  tx.replace(workspaceIndex, "import { createWorkspaceViewStore",
    "import { setLocalSubchats } from './rows/local-subchat-rows.tsx'\nimport { createWorkspaceViewStore",
    "import { setLocalSubchats } from './rows/local-subchat-rows.tsx'")
  tx.replace(workspaceIndex,
    '  const uiWorkspace = new UiWorkspaceService(\n'
      + '    ctx, ctx.remote.directoryPicker, workspaces, sessions, viewInstance.actions, notify,\n'
      + '  )\n',
    '  const uiWorkspace = new UiWorkspaceService(\n'
      + '    ctx, ctx.remote.directoryPicker, workspaces, sessions, viewInstance.actions, notify,\n'
      + '  )\n'
      + '  // Local build: subchats nested under their chat (local-subchat-rows.tsx).\n'
      + "  ctx.effect(() => setLocalSubchats(ctx, sessions, (target) => { uiWorkspace.openSession(target) }), 'ui-workspace: local subchats')\n",
    '  ctx.effect(() => setLocalSubchats(ctx,')

  // Host: lanzar el subagente «fork», entregar su resultado al chat principal y pararlo.
  const hostIndex = join(hostDir, 'index.ts')
  const hostTypes = join(hostDir, 'types.ts')
  tx.copy(join(sub, 'local-subchat.ts'), join(hostDir, 'local-subchat.ts'))
  tx.addToTsconfig(join(hostDir, '..', 'tsconfig.host.json'), 'src/local-subchat.ts')
  let types = tx.read(hostTypes)
  if (!types.includes('interface SessionLocalSubchatRequest')) {
    types = types.trimEnd() + '\n\n' + [
      '/** Local build: open a subchat (a fork subagent) from one Session. */',
      'export interface SessionLocalSubchatRequest {',
      '  readonly sessionId: SessionId',
      '  /** What the subchat should do. */',
      '  readonly task: string',
      '  /** Short name shown for the subchat. */',
      '  readonly label: string',
      '  /** Keep the result in the subchat until the user sends it back. */',
      '  readonly review?: boolean',
      '}',
      '',
      '/** Local build: the subchat Session. */',
      'export interface SessionLocalSubchatValue {',
      '  readonly childSessionId: SessionId',
      '}',
      '',
      "/** Local build: send a subchat's reply (or its latest one) back to its main chat. */",
      'export interface SessionLocalSubchatDeliverRequest {',
      '  readonly sessionId: SessionId',
      '  readonly childSessionId: SessionId',
      '  readonly label: string',
      '  readonly text?: string',
      '}',
      '',
      '/** Local build: stop a running subchat. */',
      'export interface SessionLocalSubchatStopRequest {',
      '  readonly sessionId: SessionId',
      '  readonly childSessionId: SessionId',
      '}',
      '',
      '/** Local build: whether the action was done. */',
      'export interface SessionLocalSubchatDoneValue {',
      '  readonly done: boolean',
      '}',
      '',
      "declare module '@deepseek-ai/dsh-typert-protocol' {",
      '  interface RemoteErrorDetailsMap {',
      "    'session/local-subchat-failed': { readonly sessionId: SessionId }",
      '  }',
      '}',
    ].join('\n')
    tx.write(hostTypes, types)
  }
  tx.replace(hostIndex, "import { ApiSessionList } from './list.ts'\n",
    "import { ApiSessionList } from './list.ts'\n"
      + 'import {\n'
      + '  localClosingText, localDeliverNotice, localStartSubchat, localSubchatNotice, type LocalParentAgent, type LocalSubagents,\n'
      + "} from './local-subchat.ts'\n"
      + 'import type {\n'
      + '  SessionLocalSubchatDeliverRequest, SessionLocalSubchatDoneValue, SessionLocalSubchatRequest,\n'
      + '  SessionLocalSubchatStopRequest, SessionLocalSubchatValue,\n'
      + "} from './types.ts'\n",
    'SessionLocalSubchatDeliverRequest, SessionLocalSubchatDoneValue, SessionLocalSubchatRequest,')
  let host = tx.read(hostIndex)
  if (!host.includes("@Remote('localStartSubchat')")) {
    const at = host.indexOf("  @Remote('list')")
    const doc = at < 0 ? -1 : host.lastIndexOf('  /**', at)
    if (doc < 0) skip(`no se encuentra @Remote('list') en ${rel(hostIndex)}`)
    host = host.slice(0, doc) + [
      '  /** Local build: the subagent service, when this app composes it. */',
      '  private localSubagents(sessionId: SessionId): LocalSubagents {',
      "    const subagents = (this.ctx as unknown as { get(name: string): unknown }).get('subagents') as LocalSubagents | undefined",
      "    if (subagents === undefined) throw new RemoteError('session/local-subchat-failed', 'subagents are not available in this app', { sessionId })",
      '    return subagents',
      '  }',
      '',
      '  /** Local build: hand a subchat result to its main chat (loading it if needed). */',
      '  private async localDeliverSubchat(parentId: SessionId, childId: string, label: string, text: string, durationMs?: number): Promise<void> {',
      '    const found = await this.agents.resolveAgent(parentId)',
      "    if ('error' in found) throw found.error",
      '    localDeliverNotice(found.agent as unknown as LocalParentAgent, localSubchatNotice(childId, label, text, durationMs))',
      '  }',
      '',
      '  /**',
      '   * Local build: open a subchat, a fork subagent of this Session started by the',
      '   * user: it begins with the completed conversation, works with high effort and its',
      '   * final answer returns once to this Session (unless the user reviews it first).',
      '   * @param request - Session, task, label and review choice.',
      '   * @param signal - cancels only the start.',
      '   * @returns the subchat Session.',
      '   */',
      "  @Remote('localStartSubchat')",
      '  async localStartSubchat(request: SessionLocalSubchatRequest, signal: AbortSignal): Promise<SessionLocalSubchatValue> {',
      '    const subagents = this.localSubagents(request.sessionId)',
      '    const found = await this.agents.resolveAgent(request.sessionId)',
      "    if ('error' in found) throw found.error",
      '    try {',
      '      const startedAt = Date.now()',
      '      const started = await localStartSubchat(subagents, found.agent, request.task, request.label, signal)',
      '      if (request.review !== true) {',
      '        void started.result',
      '          .then(result => result.completed',
      '            ? this.localDeliverSubchat(request.sessionId, started.childId, request.label, result.text, Date.now() - startedAt)',
      '            : undefined)',
      "          .catch((error: unknown) => { console.warn('local subchat ' + started.childId + ': result not delivered', error) })",
      '      }',
      '      return { childSessionId: started.childId as SessionId }',
      '    } catch (error) {',
      "      throw new RemoteError('session/local-subchat-failed', error instanceof Error ? error.message : String(error),",
      '        { sessionId: request.sessionId })',
      '    }',
      '  }',
      '',
      '  /**',
      "   * Local build: send a subchat's reply back to its main chat, or its latest reply",
      '   * when no text is given (read from the subchat log).',
      '   * @param request - main chat, subchat, label and optional text.',
      '   * @returns whether it was delivered.',
      '   */',
      "  @Remote('localSubchatDeliver')",
      '  async localSubchatDeliver(request: SessionLocalSubchatDeliverRequest): Promise<SessionLocalSubchatDoneValue> {',
      '    let text = request.text',
      '    if (text === undefined) {',
      '      using observation = await this.ctx.sessionQuery.observeSession(request.childSessionId)',
      '      for (const event of observation.events) {',
      "        if (event.type !== 'assistant/message') continue",
      '        const content = (event.data as { message?: { content?: readonly { type: string; text?: string }[] } }).message?.content ?? []',
      '        const closing = localClosingText(content)',
      "        if (closing !== '') text = closing",
      '      }',
      '    }',
      "    await this.localDeliverSubchat(request.sessionId, request.childSessionId, request.label, text ?? '')",
      '    return { done: true }',
      '  }',
      '',
      '  /**',
      '   * Local build: stop a running subchat.',
      '   * @param request - main chat and subchat.',
      '   * @returns whether the stop was accepted.',
      '   */',
      "  @Remote('localSubchatStop')",
      '  localSubchatStop(request: SessionLocalSubchatStopRequest): SessionLocalSubchatDoneValue {',
      "    this.localSubagents(request.sessionId).interrupt(request.childSessionId, { kind: 'user', parentSessionId: request.sessionId })",
      '    return { done: true }',
      '  }',
      '',
    ].join('\n') + host.slice(doc)
    tx.write(hostIndex, host)
  }
})

// ── 21. Actualizar Ollama desde la app ────────────────────────────────────────
// Cuando hay una versión nueva de Ollama, el aviso de actualizaciones de abajo a la
// izquierda (el de la app) aparece y abre un panel con una fila por actualización;
// la de Ollama la instala desde la app como lo hace el propio Ollama
// (OllamaSetup.exe en silencio): espera a las respuestas en marcha, vuelve a abrir
// Ollama y mide el modelo por defecto para la versión nueva. Código:
// sistema/contexto/local-ollama-update.ts, local-ollama-bridge.ts y LocalUpdatesIndicator.tsx.

const ollamaUpdateApplied = optional('actualizar Ollama desde la app', (tx) => {
  if (!toolsApplied) skip('necesita «herramientas de modelos en el selector»')
  const selectionDir = join(repo, 'packages', 'client', 'ui-model-selection', 'src', 'client')
  const selectionIndex = join(selectionDir, 'index.ts')
  const hostIndex = join(hostDir, 'index.ts')
  const hostTypes = join(hostDir, 'types.ts')

  // Host.
  tx.copy(join(here, 'contexto', 'local-ollama-update.ts'), join(hostDir, 'local-ollama-update.ts'))
  tx.addToTsconfig(join(hostDir, '..', 'tsconfig.host.json'), 'src/local-ollama-update.ts')
  let types = tx.read(hostTypes)
  if (!types.includes('interface SessionLocalOllamaUpdateInfo')) {
    types = types.trimEnd() + '\n\n' + [
      '/** Local build: check for a new Ollama version (force: ask GitHub now). */',
      'export interface SessionLocalOllamaInfoRequest {',
      '  readonly force?: boolean',
      '}',
      '',
      '/** Local build: progress of an Ollama update started from the app. */',
      'export interface SessionLocalOllamaUpdateState {',
      "  readonly phase: 'idle' | 'waiting' | 'downloading' | 'installing' | 'starting' | 'done' | 'error'",
      '  readonly percent?: number',
      '  readonly waitingFor?: number',
      '  readonly message?: string',
      '  readonly version?: string',
      '}',
      '',
      '/** Local build: installed and latest Ollama, its highlights and the update in progress. */',
      'export interface SessionLocalOllamaUpdateInfo {',
      '  readonly installed: string | null',
      '  readonly latest: string | null',
      '  readonly available: boolean',
      '  readonly highlights: readonly string[]',
      '  readonly url: string | null',
      '  readonly state: SessionLocalOllamaUpdateState',
      '}',
      '',
      '/** Local build: whether the Ollama update started. */',
      'export interface SessionLocalOllamaUpdateValue {',
      '  readonly started: boolean',
      '}',
      '',
      '/** Local build: what a new app version changes for the local features. */',
      'export interface SessionLocalAppNotesRequest {',
      '  readonly version: string',
      '}',
      '',
      '/** Local build: the traffic light and summary published with the new version. */',
      'export interface SessionLocalAppNotes {',
      '  readonly notes: {',
      '    readonly version: string',
      "    readonly level: 'green' | 'amber' | 'red'",
      '    readonly headline: string',
      '    readonly detail: string',
      '  } | null',
      '}',
    ].join('\n')
    tx.write(hostTypes, types)
  }
  tx.replace(hostIndex, "import { ApiSessionList } from './list.ts'\n",
    "import { ApiSessionList } from './list.ts'\n"
      + "import { localAppUpdateNotes, localOllamaUpdateInfo, localOllamaUpdateStart } from './local-ollama-update.ts'\n"
      + 'import type {\n'
      + '  SessionLocalAppNotes, SessionLocalAppNotesRequest,\n'
      + '  SessionLocalOllamaInfoRequest, SessionLocalOllamaUpdateInfo, SessionLocalOllamaUpdateValue,\n'
      + "} from './types.ts'\n",
    'SessionLocalOllamaInfoRequest, SessionLocalOllamaUpdateInfo, SessionLocalOllamaUpdateValue,')
  let host = tx.read(hostIndex)
  if (!host.includes("@Remote('localOllamaUpdateInfo')")) {
    if (!host.includes('SessionLocalEmptyRequest')) skip('falta SessionLocalEmptyRequest (sección 14)')
    const at = host.indexOf("  @Remote('list')")
    const doc = at < 0 ? -1 : host.lastIndexOf('  /**', at)
    if (doc < 0) skip(`no se encuentra @Remote('list') en ${rel(hostIndex)}`)
    host = host.slice(0, doc) + [
      '  /**',
      '   * Local build: installed and latest Ollama, highlights and update progress.',
      '   * @param request - force asks GitHub now instead of the cached answer.',
      '   * @returns versions, highlights and the update state.',
      '   */',
      "  @Remote('localOllamaUpdateInfo')",
      '  async localOllamaUpdateInfo(request: SessionLocalOllamaInfoRequest): Promise<SessionLocalOllamaUpdateInfo> {',
      '    return localOllamaUpdateInfo(request.force === true)',
      '  }',
      '',
      '  /**',
      '   * Local build: install the latest Ollama in the background, after the replies',
      '   * in progress finish (the installer closes Ollama).',
      '   * @param _request - no fields are required.',
      '   * @returns whether it started.',
      '   */',
      "  @Remote('localOllamaUpdate')",
      '  localOllamaUpdate(_request: SessionLocalEmptyRequest): SessionLocalOllamaUpdateValue {',
      "    return localOllamaUpdateStart(() => this.ctx.agents.list().filter((agent) => agent.status === 'running').length)",
      '  }',
      '',
      '  /**',
      '   * Local build: what a new app version changes for the local features, from',
      '   * the local-update-info.json published with it.',
      '   * @param request - the new version.',
      '   * @returns its traffic light and summary, or null when it cannot be read.',
      '   */',
      "  @Remote('localAppUpdateNotes')",
      '  async localAppUpdateNotes(request: SessionLocalAppNotesRequest): Promise<SessionLocalAppNotes> {',
      '    return { notes: await localAppUpdateNotes(request.version) }',
      '  }',
      '',
    ].join('\n') + host.slice(doc)
    tx.write(hostIndex, host)
  }

  // El selector de modelos tiene acceso al Host: publica las llamadas en el puente.
  tx.copy(join(here, 'contexto', 'local-ollama-bridge.ts'), join(selectionDir, 'local-ollama-bridge.ts'))
  tx.replace(selectionIndex, "import { setLocalOptimizer } from './LocalOptimizeButton.tsx'\n",
    "import { setLocalOptimizer } from './LocalOptimizeButton.tsx'\nimport { setOllamaUpdater } from './local-ollama-bridge.ts'\n",
    "import { setOllamaUpdater }")
  tx.replace(selectionIndex, "  }, 'ui-model-selection: local model tools')\n",
    "  }, 'ui-model-selection: local model tools')\n"
      + '  // Local build: Ollama update calls for the updates notice (local-ollama-bridge.ts).\n'
      + '  ctx.effect(() => {\n'
      + '    const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {\n'
      + '      if (!result.ok) throw new Error(result.error.message)\n'
      + '      return result.value\n'
      + '    }\n'
      + '    setOllamaUpdater({\n'
      + '      info: async force => unwrap(await ctx.remote.session.localOllamaUpdateInfo({ force })),\n'
      + '      start: async () => unwrap(await ctx.remote.session.localOllamaUpdate({})),\n'
      + '      appNotes: async version => unwrap(await ctx.remote.session.localAppUpdateNotes({ version })).notes,\n'
      + '    })\n'
      + '    return () => { setOllamaUpdater(undefined) }\n'
      + "  }, 'ui-model-selection: local Ollama update')\n",
    'setOllamaUpdater({')

  // Abajo a la izquierda: el aviso de actualizaciones de la app, ahora también con Ollama.
  const settingsDir = join(repo, 'packages', 'client', 'ui-settings-general', 'src', 'client')
  const indicator = join(settingsDir, 'DesktopUpdateIndicator.tsx')
  const root = join(settingsDir, 'SettingsRoot.tsx')
  for (const file of ['local-ollama-bridge.ts', 'LocalUpdatesIndicator.tsx', 'LocalUpdatesIndicator.module.css']) {
    tx.copy(join(here, 'contexto', file), join(settingsDir, file))
  }
  tx.replace(indicator, 'function updateCopy(state: DesktopUpdatePresentation, t: SettingsTranslate)',
    'export function updateCopy(state: DesktopUpdatePresentation, t: SettingsTranslate)')
  tx.replace(root, "import { DesktopUpdateIndicator } from './DesktopUpdateIndicator.tsx'\n",
    "import { LocalUpdatesIndicator } from './LocalUpdatesIndicator.tsx'\n")
  tx.replace(root, '        <DesktopUpdateIndicator wide={wide}', '        <LocalUpdatesIndicator wide={wide}')
})

// ── 22. Cursor normal, como en Windows ────────────────────────────────────────
// La oficial pone la mano de los enlaces en casi todo lo que se pulsa (botones,
// filas, pestañas, diálogos…). En Windows la mano es solo para los enlaces: aquí
// se cambia por la flecha en todos los estilos de la interfaz, salvo en las reglas
// de enlaces (su nombre lleva link, href, url, mention o anchor) y en los <a href>,
// que tienen la mano del navegador.

const LINK_RULE = /link|href|url|mention|anchor/i
optional('cursor normal (flecha) salvo en los enlaces', (tx) => {
  const roots = [join(repo, 'packages', 'client'), join(repo, 'packages', 'extensions'), join(repo, 'apps', 'desktop', 'renderer')]
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'lib', 'tests', 'test', 'dist', '.desktop-build'].includes(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.css')) files.push(full)
    }
  }
  for (const root of roots) if (existsSync(root)) walk(root)
  for (const file of files) {
    const text = tx.read(file)
    if (!/cursor:\s*pointer/.test(text)) continue
    // Bloque a bloque (los de dentro de @media y los anidados también): el selector decide.
    const next = text.replace(/([^{}]*)\{([^{}]*)\}/g, (rule, selector) =>
      LINK_RULE.test(selector.replace(/\/\*[\s\S]*?\*\//g, '')) ? rule : rule.replace(/cursor:\s*pointer/g, 'cursor: default'))
    if (next !== text) tx.write(file, next)
  }
})

// ── 23. El subchat se abre al 40 % de la zona de chat ─────────────────────────
// Al abrir un subchat a la derecha, el panel ocupa el 40 % de la zona de chat (la
// ventana menos la barra lateral); luego se redimensiona a mano como siempre.
// ui-layout guarda ese ancho y no lo expone: se añade al controlador un método que
// mide la barra lateral en pantalla y usa la acción oficial setRightbar (sin tocar
// el almacén, cuyos tests oficiales enumeran sus acciones). El subchat lo usa si
// está (local-subchat-start.ts); sin él, se abre con el ancho de siempre.

optional('el subchat se abre al 40 % de la zona de chat', (tx) => {
  const service = join(repo, 'packages', 'client', 'ui-layout', 'src', 'client', 'service.ts')
  if (!tx.read(service).includes('this.panels.openRightbar(track, fullscreen)')) skip('el controlador de ui-layout ha cambiado')
  tx.replace(service, '  /** Report the right panel as hidden: no track, no handle. */\n  closeRightbar(): void {\n',
    '  /**\n'
      + '   * Local build: set the right panel width as a share of the chat area (frame\n'
      + '   * minus sidebar, measured on screen); it stays resizable by hand as always.\n'
      + '   * @param share - fraction of the chat area, e.g. 0.4.\n'
      + '   */\n'
      + '  localSetRightbarShare(share: number): void {\n'
      + "    const frame = document.querySelector('[data-rightbar-col]')?.parentElement\n"
      + '    if (frame === null || frame === undefined) return\n'
      + '    const sidebar = Number.parseFloat(getComputedStyle(frame).gridTemplateColumns.split(\' \')[0] ?? \'0\') || 0\n'
      + '    this.panels.setRightbar(Math.round((frame.getBoundingClientRect().width - sidebar) * share))\n'
      + '  }\n'
      + '\n'
      + '  /** Report the right panel as hidden: no track, no handle. */\n  closeRightbar(): void {\n',
    '  localSetRightbarShare(share: number): void {\n')
})

// ── 24. Mejorar un mensaje antes de enviarlo ──────────────────────────────────
// Botón «Improve message» en la barra del cuadro de texto, junto al «+» y con su
// mismo aspecto: el modelo del chat (en su misma variante de contexto, así Ollama no
// lo recarga) reescribe el mensaje, o convierte un documento (PDF, DOCX o texto) en
// un prompt, con los ficheros del proyecto a la vista para no inventar nombres y
// preguntando si falta algo. La sugerencia sale editable encima del cuadro; «Use» la
// pone en el cuadro, sin enviarla. Código: sistema/mejorar/.

optional('mejorar un mensaje antes de enviarlo', (tx) => {
  const better = join(here, 'mejorar')
  const chatDir = join(repo, 'packages', 'client', 'ui-chat', 'src', 'client')
  const conversationDir = join(repo, 'packages', 'client', 'ui-conversation', 'src', 'client')
  const previewDir = join(repo, 'packages', 'client', 'ui-sidebar-documentpreview', 'src', 'client')
  const hostIndex = join(hostDir, 'index.ts')
  const hostTypes = join(hostDir, 'types.ts')

  // Host: la sugerencia, con los últimos mensajes del chat y los ficheros del proyecto como contexto.
  tx.copy(join(better, 'local-improve.ts'), join(hostDir, 'local-improve.ts'))
  tx.addToTsconfig(join(hostDir, '..', 'tsconfig.host.json'), 'src/local-improve.ts')
  let types = tx.read(hostTypes)
  if (!types.includes('interface SessionLocalImproveRequest')) {
    types = types.trimEnd() + '\n\n' + [
      '/** Local build: rewrite a draft, or turn a document into a prompt, so the assistant understands it better. */',
      'export interface SessionLocalImproveRequest {',
      '  readonly sessionId: SessionId',
      '  readonly draft: string',
      "  /** Ollama model to use; the chat's own model when omitted. */",
      '  readonly model?: string',
      '  /** A document already turned into text (PDF pages marked «[p. N]»). */',
      '  readonly document?: { readonly name: string; readonly text: string; readonly pages?: number }',
      '  /** Answers to the questions of the previous suggestion. */',
      '  readonly answers?: readonly { readonly question: string; readonly answer: string }[]',
      '  /** Another version: shorter, more detailed or as steps. */',
      "  readonly style?: 'short' | 'detailed' | 'steps'",
      "  /** With the model's reasoning (slower). */",
      '  readonly think?: boolean',
      '  /** Id chosen by the caller to follow (localImproveProgress) and cancel (localImproveCancel) this request. */',
      '  readonly jobId?: string',
      '}',
      '',
      '/** Local build: one improve request, by the id its caller chose. */',
      'export interface SessionLocalImproveJobRequest {',
      '  readonly jobId: string',
      '}',
      '',
      '/** Local build: what an improve request has written so far (empty phase once finished or unknown). */',
      'export interface SessionLocalImproveProgressValue {',
      '  readonly phase: string',
      '  readonly text: string',
      '}',
      '',
      '/** Local build: whether an improve request was running and has been stopped. */',
      'export interface SessionLocalImproveCancelValue {',
      '  readonly cancelled: boolean',
      '}',
      '',
      '/** Local build: the suggested prompt, questions when something is missing, a note and how long it took. */',
      'export interface SessionLocalImproveValue {',
      '  readonly text: string',
      '  readonly questions: readonly string[]',
      '  readonly note?: string',
      '  readonly ms: number',
      '}',
      '',
      "declare module '@deepseek-ai/dsh-typert-protocol' {",
      '  interface RemoteErrorDetailsMap {',
      "    'session/local-improve-failed': { readonly sessionId: SessionId }",
      '  }',
      '}',
    ].join('\n')
    tx.write(hostTypes, types)
  }
  tx.replace(hostIndex, "import { ApiSessionList } from './list.ts'\n",
    "import { ApiSessionList } from './list.ts'\n"
      + 'import {\n'
      + '  localImproveJob, localImproveJobCancel, localImproveJobProgress, localImprovePrompt, localProjectFiles, localRecentTurns,\n'
      + "} from './local-improve.ts'\n"
      + 'import type {\n'
      + '  SessionLocalImproveCancelValue, SessionLocalImproveJobRequest, SessionLocalImproveProgressValue,\n'
      + '  SessionLocalImproveRequest, SessionLocalImproveValue,\n'
      + "} from './types.ts'\n",
    'SessionLocalImproveCancelValue, SessionLocalImproveJobRequest')
  let host = tx.read(hostIndex)
  if (!host.includes("@Remote('localImprovePrompt')")) {
    const at = host.indexOf("  @Remote('list')")
    const doc = at < 0 ? -1 : host.lastIndexOf('  /**', at)
    if (doc < 0) skip(`no se encuentra @Remote('list') en ${rel(hostIndex)}`)
    host = host.slice(0, doc) + [
      '  /**',
      '   * Local build: rewrite a draft, or turn a document into a prompt, so the assistant',
      "   * understands it better, with the Session's last messages and project files as",
      "   * context. By default the chat's own model, in its context variant, so Ollama",
      '   * does not reload it.',
      '   * @param request - Session, draft, optional document, answers and model.',
      '   * @param signal - cancels the request.',
      '   * @returns the suggested prompt, questions, a note and how long it took.',
      '   */',
      "  @Remote('localImprovePrompt')",
      '  async localImprovePrompt(request: SessionLocalImproveRequest, signal: AbortSignal): Promise<SessionLocalImproveValue> {',
      '    const started = Date.now()',
      '    try {',
      '      let events: { type: string; data: unknown }[] = []',
      '      let cwd: string | undefined',
      '      {',
      '        using observation = await this.ctx.sessionQuery.observeSession(request.sessionId)',
      '        events = [...observation.events] as { type: string; data: unknown }[]',
      '        cwd = observation.header.cwd',
      '      }',
      '      const found = await this.agents.resolveAgent(request.sessionId)',
      "      if ('error' in found) throw found.error",
      '      const selection = this.agents.selectionFor(found.agent).current as { provider?: string; model?: string }',
      "      const chat = selection.provider === 'ollama' && typeof selection.model === 'string' ? selection.model : undefined",
      '      const model = request.model ?? chat',
      "      if (model === undefined) throw new Error('this chat does not use an Ollama model')",
      '      const result = await localImproveJob(request.jobId, signal, (jobSignal, progress) => localImprovePrompt(model, {',
      '        draft: request.draft,',
      '        recent: localRecentTurns(events),',
      '        files: localProjectFiles(cwd),',
      '        ...request.document === undefined ? {} : { document: request.document },',
      '        ...request.answers === undefined ? {} : { answers: request.answers },',
      '        ...request.style === undefined ? {} : { style: request.style },',
      '        ...request.think === undefined ? {} : { think: request.think },',
      '      }, jobSignal, progress))',
      '      return { ...result, ms: Date.now() - started }',
      '    } catch (error) {',
      "      throw new RemoteError('session/local-improve-failed', error instanceof Error ? error.message : String(error), { sessionId: request.sessionId })",
      '    }',
      '  }',
      '',
      '  /**',
      '   * Local build: what an improve request has written so far, to show it while it arrives.',
      '   * @param request - the id its caller chose.',
      '   * @returns its phase and text (an empty phase when it has finished or is unknown).',
      '   */',
      "  @Remote('localImproveProgress')",
      '  localImproveProgress(request: SessionLocalImproveJobRequest): SessionLocalImproveProgressValue {',
      "    return localImproveJobProgress(request.jobId) ?? { phase: '', text: '' }",
      '  }',
      '',
      '  /**',
      '   * Local build: stop an improve request, including the generation in Ollama.',
      '   * @param request - the id its caller chose.',
      '   * @returns whether it was running.',
      '   */',
      "  @Remote('localImproveCancel')",
      '  localImproveCancel(request: SessionLocalImproveJobRequest): SessionLocalImproveCancelValue {',
      '    return { cancelled: localImproveJobCancel(request.jobId) }',
      '  }',
      '',
    ].join('\n') + host.slice(doc)
    tx.write(hostIndex, host)
  }

  // ui-chat publica la llamada para el botón (ui-conversation no tiene acceso al Host).
  tx.copy(join(better, 'local-improve-bridge.ts'), join(chatDir, 'chat', 'local-improve-bridge.ts'))
  const apply = join(chatDir, 'apply.ts')
  tx.replace(apply, "import { ChatView } from './chat/ChatView.tsx'\n",
    "import { ChatView } from './chat/ChatView.tsx'\nimport { setImprover } from './chat/local-improve-bridge.ts'\n",
    "import { setImprover } from './chat/local-improve-bridge.ts'")
  tx.replace(apply, '  const quotaNotice = createSnapshotStore<QuotaNoticeState | null>(null)\n',
    '  // Local build: «Improve message» in the composer (local-improve-bridge.ts).\n'
      + '  ctx.effect(() => {\n'
      + '    setImprover({\n'
      + '      improve: async (sessionId, draft, options) => {\n'
      + '        const result = await ctx.remote.session.localImprovePrompt({\n'
      + '          sessionId: sessionId as SessionId, draft,\n'
      + '          ...options?.document === undefined ? {} : { document: options.document },\n'
      + '          ...options?.answers === undefined ? {} : { answers: options.answers },\n'
      + '          ...options?.style === undefined ? {} : { style: options.style },\n'
      + '          ...options?.think === undefined ? {} : { think: options.think },\n'
      + '          ...options?.jobId === undefined ? {} : { jobId: options.jobId },\n'
      + '        })\n'
      + '        if (!result.ok) throw new Error(result.error.message)\n'
      + '        return result.value\n'
      + '      },\n'
      + '      progress: async (jobId) => {\n'
      + '        const result = await ctx.remote.session.localImproveProgress({ jobId })\n'
      + "        return result.ok ? result.value : { phase: '', text: '' }\n"
      + '      },\n'
      + '      cancel: async (jobId) => {\n'
      + '        await ctx.remote.session.localImproveCancel({ jobId })\n'
      + '      },\n'
      + '    })\n'
      + '    return () => { setImprover(undefined) }\n'
      + "  }, 'ui-chat: local improve')\n"
      + '  const quotaNotice = createSnapshotStore<QuotaNoticeState | null>(null)\n',
    '    setImprover({\n')

  // Las vistas previas ya traen el lector de PDF: lo publican para el botón (cargado solo al usarlo).
  tx.copy(join(better, 'local-pdf-bridge.ts'), join(previewDir, 'pdf', 'local-pdf-bridge.ts'))
  tx.copy(join(better, 'local-pdf-text.ts'), join(previewDir, 'pdf', 'local-pdf-text.ts'))
  // En el trozo diferido de la vista previa: uno propio no lo sabría cargar la app.
  const pdfBody = join(previewDir, 'pdf', 'pdf.tsx')
  let body = tx.read(pdfBody)
  if (!body.includes('local-pdf-text.ts')) {
    body = body.trimEnd() + "\n\n// Local build: PDF text for «Improve message», in this deferred chunk (local-pdf-bridge.ts).\n"
      + "export { localPdfText } from './local-pdf-text.ts'\n"
    tx.write(pdfBody, body)
  }
  const previewIndex = join(previewDir, 'index.ts')
  let preview = tx.read(previewIndex)
  if (!preview.includes('setLocalPdfText')) {
    const anchor = '  ctx.effect(() => disposePreviews)\n'
    if (!preview.includes(anchor)) skip(`no se encuentra disposePreviews en ${rel(previewIndex)}`)
    // Antes del primer import (los hay de varias líneas: no se puede insertar entre ellos a ciegas).
    const first = preview.search(/^import /m)
    if (first < 0) skip(`no se encuentran los import de ${rel(previewIndex)}`)
    preview = preview.slice(0, first) + "import { setLocalPdfText } from './pdf/local-pdf-bridge.ts'\n" + preview.slice(first)
    preview = preview.replace(anchor, anchor
      + "  // Local build: PDF text for «Improve message» (pdf/local-pdf-bridge.ts).\n"
      + "  ctx.effect(() => setLocalPdfText(), 'ui-sidebar-documentpreview: local pdf text')\n")
    tx.write(previewIndex, preview)
  }

  // ui-conversation: el botón, en la barra del cuadro junto al «+» y con su mismo estilo.
  for (const file of ['local-improve-bridge.ts', 'local-improve-diff.ts', 'local-document-text.ts', 'LocalImprove.tsx', 'LocalImprove.module.css']) {
    tx.copy(join(better, file), join(conversationDir, 'skeleton', file))
  }
  const inputBar = join(conversationDir, 'skeleton', 'InputBar.tsx')
  tx.replace(inputBar, "import { ContextMeter } from './ContextMeter.tsx'\n",
    "import { ContextMeter } from './ContextMeter.tsx'\nimport { LocalImprove } from './LocalImprove.tsx'\n",
    "import { LocalImprove } from './LocalImprove.tsx'")
  tx.replace(inputBar, '                <IconPlusOutlineMedium size={14} />\n              </button>\n            </Tooltip>\n',
    '                <IconPlusOutlineMedium size={14} />\n              </button>\n            </Tooltip>\n'
      + '            {/* Local build: «Improve message» (LocalImprove.tsx). */}\n'
      + '            <LocalImprove sessionId={sessionId} draft={draft} subagent={subagent !== null} className={css.add}\n'
      + "              disabled={locked} setDraft={(text) => { inputActions?.setDraft(text) }} />\n",
    '<LocalImprove sessionId={sessionId}')
})

// ── 25. Chat más ligero: scroll fluido y mensajes antiguos sin pulsar ───────────
// Medido con un chat de prueba de 400 turnos (sistema/rendimiento/README.md): con todo el
// historial cargado, cada frame del scroll volvía a maquetar ~37 000 elementos (hasta
// 110 ms por frame) y llegar al principio costaba 27 clics en «Load earlier».
// - Cada bloque del chat lleva content-visibility: auto, así el navegador no maqueta ni
//   pinta lo que no se ve. Como eso recorta lo que se sale del bloque, el bloque se
//   ensancha (margen negativo y el mismo relleno) hasta el ancho que usan las tablas
//   anchas (100cqw del contenedor del chat): el contenido queda exactamente igual.
// - «Load earlier» pide la página siguiente solo, al subir cerca de lo cargado
//   (LocalOlderButton.tsx), salvo mientras se sigue el final del chat.
// - Las páginas de mensajes antiguos traen al menos 6 turnos (antes 2); la primera
//   carga de un chat no cambia.

optional('chat más ligero (scroll fluido y mensajes antiguos sin pulsar)', (tx) => {
  const chatDir = join(repo, 'packages', 'client', 'ui-chat', 'src', 'client', 'chat')
  const css = join(chatDir, 'ChatView.module.css')
  let styles = tx.read(css)
  if (!styles.includes('content-visibility: auto')) {
    if (!/^\.flowItem \{/m.test(styles)) skip(`no se encuentra .flowItem en ${rel(css)}`)
    styles = styles.trimEnd() + '\n\n' + [
      '/* Local build (dpseek-local-updater): the browser skips layout and paint of',
      '   Chat blocks out of view. Paint containment clips overflow, so each block',
      '   spans the breakout width that wide tables use (100cqw of the Chat scroll',
      '   container) with equal padding: its content box, and the layout, stay the same. */',
      '.flowItem {',
      '  content-visibility: auto;',
      '  contain-intrinsic-size: auto 120px;',
      '  margin-inline: calc((100% - 100cqw) / 2);',
      '  padding-inline: calc((100cqw - 100%) / 2);',
      '}',
    ].join('\n') + '\n'
    tx.write(css, styles)
  }

  tx.copy(join(here, 'rendimiento', 'LocalOlderButton.tsx'), join(chatDir, 'LocalOlderButton.tsx'))
  const view = join(chatDir, 'ChatView.tsx')
  tx.replace(view, "import css from './ChatView.module.css'\n",
    "import css from './ChatView.module.css'\nimport { LocalOlderButton } from './LocalOlderButton.tsx'\n",
    "import { LocalOlderButton } from './LocalOlderButton.tsx'")
  tx.replace(view,
    '                <button type="button" disabled={loadingOlder} onClick={scroll.loadEarlier}>\n'
      + "                  {loadingOlder ? t('loading') : t('chat.loadOlder')}\n"
      + '                </button>\n',
    '                {/* Local build: also loads by itself near the top (LocalOlderButton.tsx). */}\n'
      + '                <LocalOlderButton loading={loadingOlder} followingTail={scroll.followingTail} onLoad={scroll.loadEarlier}>\n'
      + "                  {loadingOlder ? t('loading') : t('chat.loadOlder')}\n"
      + '                </LocalOlderButton>\n',
    '<LocalOlderButton loading={loadingOlder}')

  const session = join(repo, 'packages', 'api', 'session-controller', 'src', 'client', 'sessions', 'session.ts')
  tx.replace(session,
    'const HISTORY_PAGE_OPTIONS = { maxMessages: 500, turnWindow: { minMessages: PAGE_MESSAGES, minTurns: 2 } }\n',
    'const HISTORY_PAGE_OPTIONS = { maxMessages: 500, turnWindow: { minMessages: PAGE_MESSAGES, minTurns: 2 } }\n'
      + '/** Local build: older pages bring at least 6 Turns (fewer round trips while scrolling up); the first page is unchanged. */\n'
      + 'const LOCAL_OLDER_PAGE_OPTIONS = { maxMessages: 500, turnWindow: { minMessages: 150, minTurns: 6 } }\n',
    'const LOCAL_OLDER_PAGE_OPTIONS')
  tx.replace(session,
    '        beforeSeq: this.baseSeq,\n        ...HISTORY_PAGE_OPTIONS,\n',
    '        beforeSeq: this.baseSeq,\n        ...LOCAL_OLDER_PAGE_OPTIONS,\n',
    '...LOCAL_OLDER_PAGE_OPTIONS,\n')
})

// ── 26. Arranque: la interfaz se ve desde el primer momento ─────────────────────
// La ventana aparece a los ~0,2 s, pero hasta que el Host responde (~2,5 s) solo había
// la pantalla de carga sobre fondo blanco, y con tema oscuro un destello al cambiar.
// Ahora index.html trae un esqueleto de la interfaz (barra lateral, panel y cuadro de
// texto) con el tema de la última vez desde el primer frame; la pantalla de carga oficial
// sigue encima (con su progreso y, si algo falla, su informe) y el esqueleto se retira
// en cuanto la app monta la interfaz. Código: sistema/esqueleto/.

optional('la interfaz se ve desde el primer momento al arrancar', (tx) => {
  const index = join(repo, 'apps', 'web', 'index.html')
  let html = tx.read(index)
  if (html.includes('dsk-side')) return
  const skeleton = join(here, 'esqueleto')
  const style = readFileSync(join(skeleton, 'esqueleto.css'), 'utf8').trim()
  const markup = readFileSync(join(skeleton, 'esqueleto.html'), 'utf8').trim()
  const script = readFileSync(join(skeleton, 'esqueleto.js'), 'utf8').trim()
  if (!html.includes('<div id="root"></div>') || !html.includes('</head>')) skip(`no se encuentra #root o </head> en ${rel(index)}`)
  html = html.replace('</head>', `    <style id="dsh-local-skeleton-style">\n${style}\n    </style>\n  </head>`)
  // Fuera de #root: React lo hidrata esperando solo la pantalla de carga oficial.
  html = html.replace('<div id="root"></div>', `${markup}\n    <div id="root"></div>\n    <script>\n${script}\n    </script>`)
  tx.write(index, html)
})

// ── 27. Aviso claro si Ollama no responde ───────────────────────────────────────
// Sin Ollama la IA no contesta, y solo se notaba en el nombre del modelo («Ollama not
// responding») o al enviar. Encima del cuadro de texto sale un aviso con «Open Ollama»
// (abre su aplicación) y «Check again». Una comprobación compartida cada 15 s, por el
// puente de la sección 21. Código: sistema/contexto/LocalOllamaBanner.tsx.

optional('aviso claro si Ollama no responde', (tx) => {
  if (!ollamaUpdateApplied) skip('necesita «actualizar Ollama desde la app»')
  const hostIndex = join(hostDir, 'index.ts')
  const hostTypes = join(hostDir, 'types.ts')
  let types = tx.read(hostTypes)
  if (!types.includes('interface SessionLocalOllamaStatus')) {
    types = types.trimEnd() + '\n\n' + [
      '/** Local build: whether Ollama answers and whether its app is installed. */',
      'export interface SessionLocalOllamaStatus {',
      '  readonly running: boolean',
      '  readonly installed: boolean',
      '}',
      '',
      '/** Local build: whether the Ollama app was launched. */',
      'export interface SessionLocalOllamaOpenValue {',
      '  readonly opened: boolean',
      '}',
    ].join('\n')
    tx.write(hostTypes, types)
  }
  tx.replace(hostIndex, "import { ApiSessionList } from './list.ts'\n",
    "import { ApiSessionList } from './list.ts'\n"
      + "import { localOllamaOpen, localOllamaStatus } from './local-ollama-update.ts'\n"
      + "import type { SessionLocalOllamaOpenValue, SessionLocalOllamaStatus } from './types.ts'\n",
    'SessionLocalOllamaOpenValue, SessionLocalOllamaStatus }')
  let host = tx.read(hostIndex)
  if (!host.includes("@Remote('localOllamaStatus')")) {
    const at = host.indexOf("  @Remote('list')")
    const doc = at < 0 ? -1 : host.lastIndexOf('  /**', at)
    if (doc < 0) skip(`no se encuentra @Remote('list') en ${rel(hostIndex)}`)
    host = host.slice(0, doc) + [
      '  /**',
      '   * Local build: whether Ollama answers now and whether its app can be opened from here.',
      '   * @param _request - no fields are required.',
      '   * @returns running and installed.',
      '   */',
      "  @Remote('localOllamaStatus')",
      '  async localOllamaStatus(_request: SessionLocalEmptyRequest): Promise<SessionLocalOllamaStatus> {',
      '    return localOllamaStatus()',
      '  }',
      '',
      '  /**',
      '   * Local build: launch the Ollama app (it keeps starting on its own).',
      '   * @param _request - no fields are required.',
      '   * @returns whether it was launched.',
      '   */',
      "  @Remote('localOllamaOpen')",
      '  localOllamaOpen(_request: SessionLocalEmptyRequest): SessionLocalOllamaOpenValue {',
      '    return localOllamaOpen()',
      '  }',
      '',
    ].join('\n') + host.slice(doc)
    tx.write(hostIndex, host)
  }

  // El selector de modelos (con acceso al Host) añade las dos llamadas al puente.
  const selectionIndex = join(repo, 'packages', 'client', 'ui-model-selection', 'src', 'client', 'index.ts')
  let selection = tx.read(selectionIndex)
  if (!selection.includes('localOllamaStatus({})')) {
    const anchor = '      appNotes: async version => unwrap(await ctx.remote.session.localAppUpdateNotes({ version })).notes,\n'
    if (!selection.includes(anchor)) skip(`no se encuentra el puente de Ollama en ${rel(selectionIndex)}`)
    selection = selection.replace(anchor, anchor
      + '      status: async () => unwrap(await ctx.remote.session.localOllamaStatus({})),\n'
      + '      open: async () => unwrap(await ctx.remote.session.localOllamaOpen({})),\n')
    tx.write(selectionIndex, selection)
  }

  // ui-conversation: el aviso encima del cuadro de texto.
  const skeletonDir = join(repo, 'packages', 'client', 'ui-conversation', 'src', 'client', 'skeleton')
  for (const file of ['local-ollama-bridge.ts', 'LocalOllamaBanner.tsx', 'LocalOllamaBanner.module.css']) {
    tx.copy(join(here, 'contexto', file), join(skeletonDir, file))
  }
  const inputBar = join(skeletonDir, 'InputBar.tsx')
  tx.replace(inputBar, "import { ContextMeter } from './ContextMeter.tsx'\n",
    "import { ContextMeter } from './ContextMeter.tsx'\nimport { LocalOllamaBanner } from './LocalOllamaBanner.tsx'\n",
    "import { LocalOllamaBanner } from './LocalOllamaBanner.tsx'")
  tx.replace(inputBar, '      {/* Trigger clicks land on the card, not the editor: the toolbar row\'s\n',
    '      {/* Local build: «Ollama isn\'t running» notice (LocalOllamaBanner.tsx). */}\n'
      + '      <LocalOllamaBanner />\n'
      + '      {/* Trigger clicks land on the card, not the editor: the toolbar row\'s\n',
    '<LocalOllamaBanner />')
})

// ── 28. «Show N more sessions» despliega todos los chats ─────────────────────────
// Cada proyecto enseña sus 5 chats más recientes y el botón añadía solo 5 más por clic:
// con 40 chats, 7 clics para llegar a uno antiguo. Ahora despliega todos de una vez (el
// texto ya dice cuántos) y «Show less» los vuelve a recoger, como antes.

optional('«Show N more sessions» despliega todos los chats', (tx) => {
  const browser = join(repo, 'packages', 'client', 'ui-workspace', 'src', 'client', 'rows', 'WorkspaceBrowser.tsx')
  tx.replace(browser,
    '                [group.key]: visible.hiddenCount <= SESSION_WATERMARK_BASE ? Infinity : watermark + SESSION_WATERMARK_BASE,\n',
    '                // Local build: all of them at once (the label already says how many).\n'
      + '                [group.key]: Infinity,\n',
    '// Local build: all of them at once')
})

console.log('\nCambios aplicados:')
for (const line of done) console.log(`  - ${line}`)
if (omitted.length > 0) {
  console.log('\nFunciones omitidas en esta versión:')
  for (const line of omitted) console.log(`  - ${line}`)
}
// GitHub Actions las añade a las notas del Release.
if (process.env.DSH_LOCAL_OMITIDOS) writeFileSync(process.env.DSH_LOCAL_OMITIDOS, omitted.map((line) => `- ${line}\n`).join(''))
if (process.env.DSH_LOCAL_TOCADOS) {
  writeFileSync(process.env.DSH_LOCAL_TOCADOS, JSON.stringify({
    applied: [...touched].map(([name, files]) => ({ name, files: [...files].sort() })),
    omitted: omittedFeatures,
  }, null, 2) + '\n')
}
if (warnings.length > 0) {
  console.log(`\n${warnings.length} aviso(s); revisa los mensajes AVISO de arriba.`)
}
