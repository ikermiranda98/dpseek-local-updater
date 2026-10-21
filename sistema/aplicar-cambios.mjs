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
    '    # Esfuerzo de razonamiento de un chat que no ha elegido otro: medio, el «Pensar» del cerebro (solo en modelos que razonan).',
    '    reasoning: medium',
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

// ── 8. Contexto en el selector de modelo ──────────────────────────────────────
// El selector muestra una entrada por modelo y, al abrirlo, una tarjeta con el
// nombre del modelo (abre la lista) y un botón por tamaño de contexto
// (sistema/contexto/ContextSlider.tsx); un punto marca el recomendado, el óptimo
// medido para el equipo (variante automática). Sin esto, el selector sigue
// funcionando: muestra cada tamaño como una entrada aparte.

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
      + "import { ContextSlider, contextListModels, contextModelName, contextTriggerName, sameContextModel } from './ContextSlider.tsx'\n",
    "from './ContextSlider.tsx'")
  tx.replace(select, "models: rankByName(group.models, showSearch ? query.trim() : ''),",
    "models: rankByName(contextListModels(group.models), showSearch ? query.trim() : ''),")
  tx.replace(select, ': currentChoice?.model.name\n', ': contextTriggerName(currentChoice?.model.name)\n')
  tx.replace(select, 'const selected = state.current?.provider === group.id && state.current.model === model.id',
    'const selected = state.current?.provider === group.id && sameContextModel(state.current.model, model.id)')
  tx.replace(select, "import css from './ModelSelect.module.css'\n",
    "import css from './ModelSelect.module.css'\nimport contextCss from './ContextSlider.module.css'\n",
    'import contextCss')
  let text = tx.read(select)
  if (!text.includes('<ContextSlider')) {
    // La fila «Modelo» entera (del <button> a su cierre): pasa a ser la cabecera de una tarjeta con el contexto
    // debajo; sin la etiqueta «Model», solo el nombre del modelo y la flecha que abre la lista.
    const label = text.indexOf("<span className={css.cellLabel}>{t('menu.model')}</span>")
    const start = label < 0 ? -1 : text.lastIndexOf('\n', text.lastIndexOf('<button', label)) + 1
    const end = label < 0 ? -1 : text.indexOf('</button>', label)
    if (start <= 0 || end < 0) skip(`no se encuentra la fila «Modelo» del menú en ${rel(select)}`)
    const stop = text.indexOf('\n', end) + 1
    const row = text.slice(start, stop)
      .replace('className={css.cell}', 'className={clsx(css.cell, contextCss.cardModel)}')
      .replace(/[ \t]*<span className=\{css\.cellLabel\}>\{t\('menu\.model'\)\}<\/span>\r?\n/, '')
      .replace("renderModelLabel(currentChoice.group.provider, currentChoice.model, 'menu', true)",
        "renderModelLabel(currentChoice.group.provider, { ...currentChoice.model, name: contextModelName(currentChoice.model.name) }, 'menu', true)")
    const pad = /^[ \t]*/.exec(row)?.[0] ?? ''
    text = text.slice(0, start) + [
      `${pad}{/* Local build: the model and its context sizes in one card (see ContextSlider.tsx). */}`,
      `${pad}<div className={contextCss.card}>`,
      row.replace(/^/gm, '  ').replace(/ {2}$/, '').trimEnd(),
      `${pad}  <ContextSlider`,
      `${pad}    models={groups.find(group => group.id === state.current?.provider)?.models ?? []}`,
      `${pad}    current={state.current?.model}`,
      `${pad}    disabled={busy}`,
      `${pad}    onSelect={(modelId) => {`,
      `${pad}      if (state.current === null) return`,
      `${pad}      const { provider, reasoningEffort } = state.current`,
      `${pad}      choose({ provider, model: modelId, ...reasoningEffort === undefined ? {} : { reasoningEffort } })`,
      `${pad}    }}`,
      `${pad}    t={t}`,
      `${pad}  />`,
      `${pad}</div>`,
      '',
    ].join('\n') + text.slice(stop)
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
  addLocaleKeys(tx, locales, 'ModelKey', {
    'local.context.only': '此模型只支持这一种大小',
  }, {
    'local.context.only': 'The only size this model allows',
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
      '    // Las copias de «editar y reenviar» también tienen padre (parentId) y son chats normales: solo se',
      '    // excluyen los subagentes (los subchats tienen su propio menú).',
      "    return row !== undefined && row.origin !== 'subagent' && !row.blank",
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
// días sin usarse, lo que ocupa y un botón para borrarlo del disco. Al final de la
// lista, el interruptor «Limpieza automática de variantes»: en Ollama solo queda la variante
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
    // Al final de la lista de modelos: se configura una vez, así que no ocupa sitio en la tarjeta principal.
    const empty = /^([ \t]*)\{state\.status === 'ready' && filteredGroups\.length === 0 && \([\s\S]*?\n\1\)\}\n/m
    if (!empty.test(text)) skip(`no se encuentra el final de la lista de modelos en ${rel(select)}`)
    text = text.replace(empty, (block, pad) => `${block}${pad}{/* Local build: automatic variant cleanup switch. */}\n${pad}<LocalCleanupSwitch t={t} />\n`)
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
    "LocalLiveCodeButton } from './local-live-watch.tsx'")
  tx.replace(running, '        <TextShimmer active className={css.runningText}>{label}</TextShimmer>\n',
    '        <TextShimmer active className={css.runningText}>{label}</TextShimmer>\n'
      + '        <LocalLiveCodeButton placement="running" />\n',
    '<LocalLiveCodeButton placement="running" />')
  const processView = join(chatDir, 'chat', 'TurnProcessNodeView.tsx')
  tx.replace(processView, "import css from './TurnProcessNodeView.module.css'\n",
    "import css from './TurnProcessNodeView.module.css'\nimport { LocalLiveCodeButton } from './local-live-watch.tsx'\n",
    "LocalLiveCodeButton } from './local-live-watch.tsx'")
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

// ── 24. Reprompt: mejorar un mensaje antes de enviarlo ────────────────────────
// Botón ✨ «Reprompt» en la barra del cuadro de texto, junto al «+» y con su
// mismo aspecto: el modelo del chat (en su misma variante de contexto, así Ollama no
// lo recarga) reescribe el mensaje, o convierte un documento (PDF, DOCX o texto) en
// un prompt (lo que hay que hacer con él, y el documento debajo palabra por palabra),
// con los ficheros del proyecto a la vista para no inventar nombres y preguntando si
// falta algo. El resultado ocupa el sitio del texto dentro de la propia barra (‹ vuelve al
// tuyo); «Use» lo pone en el cuadro y enviar lo envía tal cual. Código: sistema/mejorar/.

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
      "  /** What to do with the document: implement, review, plan, explain, or the user's own words. */",
      '  readonly intent?: string',
      '  /** Only copy the key passages of the document, word for word (no prompt). */',
      '  readonly keyParts?: boolean',
      '  /** Change the previous suggestion with one sentence from the user. */',
      '  readonly refine?: { readonly previous: string; readonly request: string }',
      "  /** Translate into English, fix the grammar, or bring sentences in other languages into the main one. */",
      "  readonly transform?: { readonly kind: 'english' | 'grammar' | 'unify'; readonly text: string }",
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
      '/** Local build: the suggested prompt, questions when something is missing, a note, the document block and how long it took. */',
      'export interface SessionLocalImproveValue {',
      '  readonly text: string',
      '  readonly questions: readonly string[]',
      '  readonly note?: string',
      '  /** How the document goes under the prompt: its headings and, when asked for, its key passages. */',
      '  readonly document?: { readonly heading: string; readonly keyHeading: string; readonly key?: string }',
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
      '        ...request.intent === undefined ? {} : { intent: request.intent },',
      '        ...request.keyParts === undefined ? {} : { keyParts: request.keyParts },',
      '        ...request.refine === undefined ? {} : { refine: request.refine },',
      '        ...request.transform === undefined ? {} : { transform: request.transform },',
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
      + '          ...options?.document === undefined ? {} : {\n'
      + '            document: {\n'
      + '              name: options.document.name, text: options.document.text,\n'
      + '              ...options.document.pages === undefined ? {} : { pages: options.document.pages },\n'
      + '            },\n'
      + '          },\n'
      + '          ...options?.answers === undefined ? {} : { answers: options.answers },\n'
      + '          ...options?.style === undefined ? {} : { style: options.style },\n'
      + '          ...options?.think === undefined ? {} : { think: options.think },\n'
      + '          ...options?.jobId === undefined ? {} : { jobId: options.jobId },\n'
      + '          ...options?.intent === undefined ? {} : { intent: options.intent },\n'
      + '          ...options?.keyParts === undefined ? {} : { keyParts: options.keyParts },\n'
      + '          ...options?.refine === undefined ? {} : { refine: options.refine },\n'
      + '          ...options?.transform === undefined ? {} : { transform: options.transform },\n'
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
  // Encima del texto, el hueco de los documentos cargados para ✨ (píldoras, como los adjuntos).
  tx.replace(inputBar, '        })}\n        {/* One scrollport, one text surface:',
    '        })}\n'
      + '        {/* Local build: documents loaded for «Improve message» (LocalImprove.tsx). */}\n'
      + '        <div data-local-improve-docs />\n'
      + '        {/* One scrollport, one text surface:',
    'data-local-improve-docs')
  // En el sitio del texto, la página del resultado de Reprompt (el texto se esconde mientras).
  tx.replace(inputBar, '        <div data-local-improve-docs />\n',
    '        <div data-local-improve-docs />\n'
      + '        {/* Local build: Reprompt shows its result in place of the text (LocalImprove.tsx). */}\n'
      + '        <div data-local-improve-panel />\n',
    'data-local-improve-panel')
  // Al arrastrar un fichero, sin la capa a pantalla completa: la propia barra marca los dos destinos
  // (soltar en la barra adjunta; en ✨, prompt). Se mantiene si no hay ✨ o si no se puede adjuntar.
  const attachmentsView = join(repo, 'packages', 'client', 'ui-attachment', 'src', 'client', 'ComposerAttachments.tsx')
  tx.replace(attachmentsView, '      {dragActive && (\n        <DropOverlay',
    '      {/* Local build: with «Improve message» the composer shows the drop targets itself (LocalImprove.tsx). */}\n'
      + "      {dragActive && (!canAcceptDrop || document.querySelector('[data-local-improve]') === null) && (\n"
      + '        <DropOverlay',
    "document.querySelector('[data-local-improve]')")
  // Al enviar, los documentos que «Use» dejó adjuntos van debajo del mensaje (no se meten en el cuadro).
  const hub = join(conversationDir, 'input', 'hub.ts')
  tx.replace(hub, '    return this.conversation().sendSession(session, text, attachmentIds, mode, signal)\n',
    '    // Local build: documents attached by «Improve message» go below the message (LocalImprove.tsx).\n'
      + "    const localSend = (globalThis as Record<symbol, unknown>)[Symbol.for('dpseek-local-updater.before-send')] as\n"
      + '      ((sessionId: string, text: string) => string) | undefined\n'
      + '    const sent = localSend === undefined ? text : localSend(session.getSnapshot().sessionId, text)\n'
      + '    return this.conversation().sendSession(session, sent, attachmentIds, mode, signal)\n',
    'dpseek-local-updater.before-send')
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

// ── 29. Corrector ortográfico también en el idioma del sistema ───────────────────
// El corrector solo usaba inglés: todo lo escrito en español salía subrayado en rojo.
// Ahora usa el idioma de Windows y el inglés, con los diccionarios del propio Windows;
// la dirección de descarga de diccionarios apunta a ninguna parte, así que nunca se
// descarga nada (si Windows no tiene un idioma, ese idioma simplemente no se corrige).

optional('corrector ortográfico también en el idioma del sistema', (tx) => {
  const main = join(repo, 'apps', 'desktop', 'src', 'main.ts')
  tx.replace(main,
    '  installMicrophonePermissions(session.defaultSession, () => mainWindow?.webContents)\n',
    '  installMicrophonePermissions(session.defaultSession, () => mainWindow?.webContents)\n'
      + "  // Local build: spell check in the system language as well as English, with Windows' own\n"
      + '  // dictionaries; dictionary downloads point nowhere, so nothing is ever fetched.\n'
      + '  try {\n'
      + "    session.defaultSession.setSpellCheckerDictionaryDownloadURL('http://127.0.0.1:9/')\n"
      + '    const spellAvailable = session.defaultSession.availableSpellCheckerLanguages\n'
      + "    const spellPick = (language: string): string | undefined => spellAvailable.find(known => known === language)\n"
      + "      ?? spellAvailable.find(known => known.split('-')[0] === language.split('-')[0])\n"
      + "    const spellWanted = [...new Set([app.getSystemLocale(), app.getPreferredSystemLanguages()[0] ?? '', 'en-US']\n"
      + "      .filter(language => language !== '').map(spellPick).filter((language): language is string => language !== undefined))]\n"
      + '    if (spellWanted.length > 0) session.defaultSession.setSpellCheckerLanguages(spellWanted)\n'
      + '  } catch {\n'
      + '    // Without a spell checker the editor still works.\n'
      + '  }\n',
    'setSpellCheckerDictionaryDownloadURL')
})

// ── 30. Con la ventana cerrada, la app no retiene el modelo ──────────────────────
// Cerrar la ventana solo la esconde: la app sigue en la bandeja (para terminar lo que esté
// haciendo) y gasta poco, pero el mantenedor del modelo (contexto/precarga.cjs) lo seguía
// renovando y, si Ollama lo descargaba, lo volvía a cargar: decenas de GB de RAM y de
// gráfica ocupados con la app en segundo plano. Ahora la app anota si la ventana está a la
// vista (escritorio/local-window-state.ts); con ella cerrada más de 2 minutos, el
// mantenedor descarga el modelo y deja de cargarlo, y al volver a abrirla lo carga enseguida.

optional('con la ventana cerrada, la app no retiene el modelo', (tx) => {
  const src = join(repo, 'apps', 'desktop', 'src')
  const main = join(src, 'main.ts')
  tx.copy(join(here, 'escritorio', 'local-window-state.ts'), join(src, 'local-window-state.ts'))
  let text = tx.read(main)
  if (!text.includes("from './local-window-state.ts'")) {
    const lastImport = [...text.matchAll(/^import [^\n]*\n|^} from '[^']+'\n/gm)].pop()
    if (lastImport === undefined) skip(`no se encuentran los imports de ${rel(main)}`)
    const at = lastImport.index + lastImport[0].length
    text = text.slice(0, at) + "import { localTrackWindow } from './local-window-state.ts'\n" + text.slice(at)
    tx.write(main, text)
  }
  tx.replace(main, '    window.on(\'focus\', automaticCheck)\n',
    '    window.on(\'focus\', automaticCheck)\n'
      + '    // Local build: hidden or shown, for the model keeper (local-window-state.ts).\n'
      + '    localTrackWindow(window)\n',
    'localTrackWindow(window)')
})

// ── 31. El esfuerzo de razonamiento, un cerebro en la barra ──────────────────────
// Antes había que abrir el selector de modelo, entrar en «Effort» y elegir. Ahora un
// cerebro junto al selector cambia el modo con un clic: Pensar (lo de «Default»),
// Pensar a fondo (nivel high) y Sin pensar (off). El menú del selector ya no tiene
// la fila «Effort». Interfaz: sistema/contexto/LocalThinkButton.tsx.
// Los chats nuevos empiezan en «Pensar» (reasoning: medium del proveedor, sección 1) y el
// cambio en un chat se queda en ese chat: ya no se guarda como valor de los chats nuevos.

optional('el esfuerzo de razonamiento como un cerebro en la barra', (tx) => {
  // El modelo elegido en un chat sigue siendo el de los chats nuevos; su esfuerzo, no.
  tx.replace(join(hostDir, 'commands.ts'),
    '        void this.ctx.agentDefaultModel.saveSelection(selected).catch((error: unknown) => {\n',
    '        // Local build: new chats keep the provider\'s default effort (medium); a chat\'s effort stays in that chat.\n'
      + '        void this.ctx.agentDefaultModel.saveSelection({ provider: selected.provider, model: selected.model }).catch((error: unknown) => {\n',
    "saveSelection({ provider: selected.provider, model: selected.model })")
  const dir = join(repo, 'packages', 'client', 'ui-model-selection', 'src', 'client')
  const select = join(dir, 'ModelSelect.tsx')
  const locales = join(dir, 'locales.ts')
  tx.copy(join(here, 'contexto', 'LocalThinkButton.tsx'), join(dir, 'LocalThinkButton.tsx'))
  tx.copy(join(here, 'contexto', 'LocalThinkButton.module.css'), join(dir, 'LocalThinkButton.module.css'))
  tx.replace(select, "import css from './ModelSelect.module.css'\n",
    "import css from './ModelSelect.module.css'\n"
      + "import { LocalThinkButton } from './LocalThinkButton.tsx'\n"
      + "import localThinkCss from './LocalThinkButton.module.css'\n",
    "from './LocalThinkButton.tsx'")
  tx.replace(select, '      className={css.root}\n', '      className={clsx(css.root, localThinkCss.host)}\n', 'localThinkCss.host')
  let text = tx.read(select)
  if (!text.includes('<LocalThinkButton')) {
    // Justo después del botón del selector, dentro de su raíz (el menú se cierra al hacer clic fuera de ella).
    const trigger = text.indexOf('ref={triggerRef}')
    const end = trigger < 0 ? -1 : text.indexOf('</button>\n', trigger)
    if (end < 0) skip(`no se encuentra el botón del selector en ${rel(select)}`)
    const at = end + '</button>\n'.length
    const pad = /([ \t]*)<\/button>\n$/.exec(text.slice(0, at))?.[1] ?? '      '
    text = text.slice(0, at) + [
      `${pad}{/* Local build: reasoning effort as a brain next to the model (LocalThinkButton.tsx). */}`,
      `${pad}<LocalThinkButton`,
      `${pad}  efforts={reasoning?.efforts}`,
      `${pad}  effort={effectiveEffort}`,
      `${pad}  disabled={locked || busy || state.current === null}`,
      `${pad}  onChange={(effort) => {`,
      `${pad}    if (state.current === null) return`,
      `${pad}    const { provider, model } = state.current`,
      `${pad}    lastActionRef.current = 'select'`,
      `${pad}    void select({ provider, model, ...effort === undefined ? {} : { reasoningEffort: effort } }).then(settleSelection)`,
      `${pad}  }}`,
      `${pad}  t={t}`,
      `${pad}/>`,
      '',
    ].join('\n') + text.slice(at)
    // La fila «Effort» del menú y el nivel junto al nombre del botón: los dice el cerebro.
    const row = /^([ \t]*)\{reasoning !== undefined && \(\n[\s\S]*?drill\('effort'\)[\s\S]*?\n\1\)\}\n/m
    if (!row.test(text)) skip(`no se encuentra la fila «Effort» del menú en ${rel(select)}`)
    text = text.replace(row, '')
    text = text.replace(/^[ \t]*\{effortLabel !== undefined && <span className=\{css\.triggerEffort\}>\{effortLabel\}<\/span>\}\n/m, '')
    tx.write(select, text)
  }
  addLocaleKeys(tx, locales, 'ModelKey', {
    'local.think.off': '不思考',
    'local.think.on': '思考',
    'local.think.hard': '深度思考',
  }, {
    'local.think.off': 'No thinking',
    'local.think.on': 'Think',
    'local.think.hard': 'Think hard',
  })
  addLocaleKeys(tx, locales, 'ModelKey', {
    'local.think.none': '此模型不支持推理',
  }, {
    'local.think.none': 'This model does not reason',
  })
})

// ── 34. Un navegador de verdad para el agente ───────────────────────────────────────
// Sin esto el agente solo tiene web_fetch, que baja el HTML como texto: no puede iniciar
// sesión, pulsar botones ni ver lo que una web dibuja con JavaScript. La app trae un
// proveedor de navegador (Playwright MCP), pero la empaquetada no lo incluía: solo estaba
// en el modo desarrollo. Aquí entra en el paquete (dependencias de apps/cli y sus 6 líneas
// del fichero de bloqueo, que la compilación instala con --frozen-lockfile) y se activa con
// el Edge de Windows, sin ventana: uno compartido por todos los chats, con su propio perfil
// (las sesiones iniciadas se guardan) y visible en la barra lateral (sección 35).

/**
 * Mete paquetes del repositorio en la app empaquetada: dependencias de apps/cli (el empaquetado recorre las suyas) y sus
 * líneas del fichero de bloqueo (la compilación instala con --frozen-lockfile).
 * @param tx - transacción de la sección.
 * @param packages - [nombre, ruta en el repositorio] de cada paquete.
 */
function addCliWorkspaceDeps(tx, packages) {
  const cliPackage = join(repo, 'apps', 'cli', 'package.json')
  const lockFile = join(repo, 'pnpm-lock.yaml')
  for (const [, path] of packages) {
    if (!existsSync(join(repo, path, 'package.json'))) skip(`no está el paquete ${path}`)
  }

  // Dependencias del paquete raíz de la app: el empaquetado recorre las suyas.
  const manifest = JSON.parse(tx.read(cliPackage))
  let changed = false
  for (const [name] of packages) {
    if (manifest.dependencies?.[name] !== undefined) continue
    manifest.dependencies = { ...manifest.dependencies, [name]: 'workspace:*' }
    changed = true
  }
  if (changed) tx.write(cliPackage, JSON.stringify(manifest, null, 2) + '\n')

  // Las mismas entradas en el fichero de bloqueo, en su sitio (orden alfabético dentro de
  // las dependencias de apps/cli), como las escribiría pnpm.
  let lock = tx.read(lockFile)
  const start = lock.indexOf('\n  apps/cli:\n')
  const depsAt = start < 0 ? -1 : lock.indexOf('\n    dependencies:\n', start)
  if (depsAt < 0) skip(`no se encuentran las dependencias de apps/cli en ${rel(lockFile)}`)
  for (const [name, path] of packages) {
    const body = depsAt + '\n    dependencies:\n'.length
    // Fin del bloque: la primera línea con menos de 6 espacios.
    const rest = lock.slice(body)
    const endRel = rest.search(/\n(?! {6})/)
    const end = endRel < 0 ? lock.length : body + endRel + 1
    const block = lock.slice(body, end)
    if (block.includes(`      '${name}':\n`) || block.includes(`      ${name}:\n`)) continue
    const entry = `      '${name}':\n        specifier: workspace:*\n        version: link:../../${path}\n`
    // Antes de la primera entrada que va detrás en orden alfabético.
    const keys = [...block.matchAll(/^ {6}'?([^'\n:]+(?::[^'\n]+)?)'?:\n/gm)]
    const after = keys.find(match => (match[1] ?? '').localeCompare(name) > 0)
    const at = after === undefined ? end : body + (after.index ?? 0)
    lock = lock.slice(0, at) + entry + lock.slice(at)
  }
  tx.write(lockFile, lock)
}

const LOCAL_BROWSER_PACKAGES = [
  ['@deepseek-ai/dsh-browser-use', 'packages/browser-use/browser-use'],
  ['@deepseek-ai/dsh-experimental-browser-use-playwright-mcp', 'packages/experimental/browser-use-playwright-mcp'],
]

optional('un navegador de verdad para el agente (Playwright con Edge)', (tx) => {
  const bundle = join(repo, 'packages', 'bundle', 'web-app', 'cordis.patch.yml')
  addCliWorkspaceDeps(tx, LOCAL_BROWSER_PACKAGES)

  // Activado en la composición del escritorio (bundle dsh-web-app).
  let rows = tx.read(bundle)
  if (!rows.includes('browser-use-playwright-mcp')) {
    rows = rows.trimEnd() + '\n\n' + [
      '# Local build (dpseek-local-updater): a real browser for the agent. Playwright MCP',
      '# drives one shared headless Windows Edge with its own profile; the model reads pages as',
      '# accessibility snapshots, which a text-only local model handles.',
      '- insert:',
      '    - id: browser-use',
      "      name: '@deepseek-ai/dsh-browser-use'",
      '    - id: browser-use-playwright-mcp',
      "      name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'",
      '      config:',
      '        mode: launch',
      '        headless: true',
      "        executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'",
      '',
    ].join('\n')
    tx.write(bundle, rows)
  }

  // Un Edge compartido en vez de uno por chat: el servidor de Playwright arranca con un lanzador propio
  // (sistema/navegador/agent-browser-launcher.mjs, ejecutado con node -e) que abre ese Edge si hace falta, con su
  // perfil en <DSH_HOME>/storages/agent-browser (las sesiones iniciadas se guardan) y lo anota para la barra lateral.
  const provider = join(repo, 'packages', 'experimental', 'browser-use-playwright-mcp', 'src', 'index.ts')
  let source = tx.read(provider)
  if (!source.includes('LOCAL_AGENT_BROWSER_LAUNCHER')) {
    const launcher = readFileSync(join(here, 'navegador', 'agent-browser-launcher.mjs'), 'utf8')
    const original = [
      '  } else {',
      "    args.push('--isolated')",
      "    if (config.headless) args.push('--headless')",
      "    if (config.executablePath !== undefined) args.push('--executable-path', config.executablePath)",
      '  }',
    ].join('\n')
    if (!source.includes(original)) skip(`no se encuentra el arranque del navegador en ${rel(provider)}`)
    source = source.replace(original, [
      '  } else if (config.executablePath !== undefined) {',
      '    // Local build: one shared Edge for every Session (sign-ins kept in its own profile), started on demand by the',
      '    // launcher, which then loads the Playwright server connected to it; the app shows its pages in the sidebar.',
      "    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')",
      "    args.splice(0, args.length, '--input-type=module', '-e', LOCAL_AGENT_BROWSER_LAUNCHER, '--', cli, config.executablePath,",
      "      join(home, 'storages', 'agent-browser'), join(home, 'storages', 'local-agent-browser.json'),",
      "      join(home, 'storages', 'agent-browser-output'), join(home, 'storages', 'local-secrets.json'))",
      original.replace('  } else {', '  } else {'),
    ].join('\n'))
    source = source.replace("import { dirname, join } from 'node:path'\n",
      "import { homedir } from 'node:os'\nimport { dirname, join } from 'node:path'\n")
    source = source.trimEnd() + '\n\n'
      + '/** Local build (dpseek-local-updater): sistema/navegador/agent-browser-launcher.mjs, run with node -e. */\n'
      + `const LOCAL_AGENT_BROWSER_LAUNCHER = ${JSON.stringify(launcher)}\n`
    tx.write(provider, source)
  }

  // Menos pasos y menos contexto: la página va en línea en cada acción, solo la última queda entera en el
  // historial y el modelo recibe unas instrucciones cortas de uso (sistema/navegador/local-browser-context.ts).
  tx.copy(join(here, 'navegador', 'local-browser-context.ts'), join(dirname(provider), 'local-browser-context.ts'))
  tx.copy(join(here, 'navegador', 'local-browser-rules.ts'), join(dirname(provider), 'local-browser-rules.ts'))
  tx.replace(provider, "import type {} from '@deepseek-ai/dsh-working-directory'\n",
    "import type {} from '@deepseek-ai/dsh-working-directory'\nimport { setupLocalBrowserContext } from './local-browser-context.ts'\n",
    "import { setupLocalBrowserContext } from './local-browser-context.ts'")
  tx.replace(provider, '  mountSessionMcp(ctx, {\n',
    "  // Local build: snapshots inline, older ones pruned, short usage tips (local-browser-context.ts).\n"
      + "  setupLocalBrowserContext(ctx, 'mcp__playwright-mcp__')\n"
      + '  mountSessionMcp(ctx, {\n',
    "setupLocalBrowserContext(ctx, 'mcp__playwright-mcp__')")
})

// ── 35. Un navegador compartido por el agente y el usuario, en el panel derecho ─────
// La pestaña «Browser» de la app pasa a ser el Edge del agente en directo (los enlaces del
// chat se abren ahí): atrás, adelante, recargar y dirección editable, con «Agent»/«You»
// según quién lo maneje. Tocar la página da el control al usuario (el agente espera; vuelve
// con «Resume agent», con un mensaje en el chat o tras un rato). La flecha junto a la
// dirección despliega el paso a paso; la llave, las contraseñas guardadas (bloqueadas con
// la contraseña de Windows) y las webs con sesión. En el chat, la línea de estado del turno
// lleva solo el globo (abre la pestaña) y una flecha con el paso a paso.
// Código: sistema/navegador/ (y los pasos, en sistema/codigo-vivo/local-live-watch.tsx).

/** Sustituye el bloque entre `start` y `end` (marcas incluidas) o, si aún no está, lo pone con `insert`. */
function upsertBlock(text, start, end, block, insert) {
  const at = text.indexOf(start)
  if (at < 0) return insert(text, block)
  const stop = text.indexOf(end, at)
  if (stop < 0) skip(`bloque sin cierre (${start})`)
  return text.slice(0, at) + block + text.slice(stop + end.length)
}

/** Las llamadas del Host para el navegador compartido: nombre, petición, respuesta, si es asíncrona, cuerpo y doc. */
const SHARED_BROWSER_REMOTES = [
  ['localAgentBrowserFrame', 'SessionLocalBrowserFrameRequest', 'SessionLocalBrowserFrame', true,
    'localAgentBrowserFrame(request.after)',
    "The page of the shared browser: waits briefly for a frame newer than `after` (the browser sends one each time it paints)."],
  ['localAgentBrowserViewport', 'SessionLocalBrowserViewportRequest', 'SessionLocalBrowserViewportValue', true,
    'localAgentBrowserViewport(request)', 'Fit the page to the panel (CSS pixels and screen density), like a browser window.'],
  ['localAgentBrowserControl', 'SessionLocalBrowserControlRequest', 'SessionLocalBrowserControlValue', false,
    'localAgentBrowserControl(request.active)', "Take or give back control (touching the page already takes it; the agent's browser actions wait)."],
  ['localAgentBrowserInput', 'SessionLocalBrowserInputRequest', 'SessionLocalBrowserInputValue', true,
    'localAgentBrowserInput(request.input)', 'One mouse, wheel, key or text gesture from the panel to the page; it never reaches the chat or the model.'],
  ['localAgentBrowserNavigate', 'SessionLocalBrowserNavigateRequest', 'SessionLocalBrowserNavigateValue', true,
    'localAgentBrowserNavigate(request)', 'Address bar: open an address (starting the browser if needed), back, forward or reload.'],
  ['localAgentBrowserRepair', 'SessionLocalEmptyRequest', 'SessionLocalBrowserNavigateValue', true,
    'localAgentBrowserRepair()', 'Fix the view: show the right page again (not a popup), re-apply the panel size and take a fresh frame.'],
  ['localAgentBrowserSecrets', 'SessionLocalEmptyRequest', 'SessionLocalBrowserSecrets', false,
    'localAgentBrowserSecrets()', 'Saved passwords by name and site (never the values); empty while locked.'],
  ['localAgentBrowserUnlock', 'SessionLocalEmptyRequest', 'SessionLocalBrowserUnlockValue', true,
    'localAgentBrowserUnlock()', 'Unlock saved passwords for five minutes after Windows confirms the user (Windows Security password prompt, or Windows Hello).'],
  ['localAgentBrowserLock', 'SessionLocalEmptyRequest', 'SessionLocalBrowserLockValue', false,
    'localAgentBrowserLock()', 'Lock saved passwords again (the window was hidden or closed).'],
  ['localAgentBrowserSaveSecret', 'SessionLocalBrowserSaveSecretRequest', 'SessionLocalBrowserSaveSecretValue', true,
    'localAgentBrowserSaveSecret(request.name, request.site, request.value)', 'Save a password, encrypted with Windows DPAPI (needs unlock).'],
  ['localAgentBrowserRemoveSecret', 'SessionLocalBrowserRemoveSecretRequest', 'SessionLocalBrowserRemoveSecretValue', false,
    'localAgentBrowserRemoveSecret(request.name)', 'Remove a saved password (needs unlock).'],
  ['localAgentBrowserSites', 'SessionLocalEmptyRequest', 'SessionLocalBrowserSites', true,
    'localAgentBrowserSites()', 'Sites with a saved sign-in in the shared browser.'],
  ['localAgentBrowserForget', 'SessionLocalBrowserForgetRequest', 'SessionLocalBrowserForgetValue', true,
    'localAgentBrowserForget(request.domain)', "Sign the shared browser out of one site (its cookies and stored data)."],
  ['localAgentBrowserTabs', 'SessionLocalEmptyRequest', 'SessionLocalBrowserTabs', true,
    'localAgentBrowserTabs()', "Open tabs of the shared browser, the one shown in the panel and the agent's."],
  ['localAgentBrowserTab', 'SessionLocalBrowserTabRequest', 'SessionLocalBrowserTabValue', true,
    'localAgentBrowserTab(request)', 'Show another tab, open a new one or close one.'],
  ['localAgentBrowserCopy', 'SessionLocalEmptyRequest', 'SessionLocalBrowserCopyValue', true,
    'localAgentBrowserCopy()', 'The text selected in the page, for the Windows clipboard (never from a password field).'],
  ['localAgentBrowserFind', 'SessionLocalBrowserFindRequest', 'SessionLocalBrowserFindValue', true,
    'localAgentBrowserFind(request.text, request.backwards)', 'Find in page: select and show the next (or previous) match.'],
  ['localAgentBrowserDrop', 'SessionLocalBrowserDropRequest', 'SessionLocalBrowserDropValue', true,
    'localAgentBrowserDrop(request)', 'Files dropped on the page from the panel, dropped there like a real drag.'],
  ['localAgentBrowserSettings', 'SessionLocalBrowserSettingsRequest', 'SessionLocalBrowserSettings', true,
    'localAgentBrowserSettings(request)', 'Look-only mode and page zoom (saved between starts); without changes, just read them.'],
  ['localAgentBrowserConfirm', 'SessionLocalBrowserConfirmRequest', 'SessionLocalBrowserConfirmValue', false,
    'localAgentBrowserConfirm(request.id, request.allow, request.always)', 'Allow or decline a click of the agent that sends something on a real website.'],
  ['localAgentBrowserPending', 'SessionLocalEmptyRequest', 'SessionLocalBrowserPending', false,
    'localAgentBrowserPending()', 'The click of the agent waiting for the user, if any.'],
  ['localAgentBrowserCheck', 'SessionLocalEmptyRequest', 'SessionLocalBrowserCheck', false,
    'localAgentBrowserCheck()', 'Whether Microsoft Edge is installed and new enough for the browser.'],
  ['localAgentBrowserUnlockMethod', 'SessionLocalEmptyRequest', 'SessionLocalBrowserUnlockMethod', true,
    'localAgentBrowserUnlockMethod()', 'How saved passwords unlock on this PC: Windows Hello or the Windows password.'],
  ['localAgentBrowserExportSecrets', 'SessionLocalBrowserExportRequest', 'SessionLocalBrowserExportValue', true,
    'localAgentBrowserExportSecrets(request.passphrase)', 'Backup of the saved passwords, encrypted with a passphrase (needs unlock).'],
  ['localAgentBrowserImportSecrets', 'SessionLocalBrowserImportRequest', 'SessionLocalBrowserImportValue', true,
    'localAgentBrowserImportSecrets(request.file, request.passphrase)', 'Import a passwords backup; same names are replaced (needs unlock).'],
]

const SHARED_BROWSER_TYPES = [
  "/** Local build: the page of the shared browser (agent and user) now. */",
  'export interface SessionLocalBrowserFrame {',
  '  readonly running: boolean',
  '  readonly url: string',
  '  readonly title: string',
  '  /** Frame number; ask for the next one with `after`. */',
  '  readonly seq: number',
  '  /** JPEG in base64, or null if there is none newer than `after`. */',
  '  readonly image: string | null',
  '  /** The user is in control (the agent waits). */',
  '  readonly control: boolean',
  '  /** Page size in CSS pixels (the frame covers exactly this). */',
  '  readonly viewport: { readonly width: number; readonly height: number }',
  '  readonly canGoBack: boolean',
  '  readonly canGoForward: boolean',
  '  /** The tab shown and how many are open. */',
  '  readonly tabId: string',
  '  readonly tabCount: number',
  '  /** The agent cannot write on real websites. */',
  '  readonly lookOnly: boolean',
  '  /** Page zoom (1 = 100%). */',
  '  readonly zoom: number',
  '  /** A click of the agent waiting for the user. */',
  '  readonly confirm: SessionLocalBrowserConfirm | null',
  '}',
  '',
  '/** Local build: a click of the agent that sends something on a real website, waiting for the user. */',
  'export interface SessionLocalBrowserConfirm {',
  '  readonly id: string',
  '  readonly label: string',
  '  readonly site: string',
  '}',
  '',
  '/** Local build: the last frame number the panel has. */',
  'export interface SessionLocalBrowserFrameRequest {',
  '  readonly after?: number',
  '}',
  '',
  '/** Local build: the panel size in CSS pixels and the screen density. */',
  'export interface SessionLocalBrowserViewportRequest {',
  '  readonly width: number',
  '  readonly height: number',
  '  readonly dpr?: number',
  '}',
  '',
  '/** Local build: the page size was applied. */',
  'export interface SessionLocalBrowserViewportValue {',
  '  readonly ok: true',
  '}',
  '',
  '/** Local build: take or give back control of the shared browser. */',
  'export interface SessionLocalBrowserControlRequest {',
  '  readonly active: boolean',
  '}',
  '',
  '/** Local build: whether the user is in control now. */',
  'export interface SessionLocalBrowserControlValue {',
  '  readonly control: boolean',
  '}',
  '',
  '/** Local build: one gesture of the user on the panel; positions go from 0 to 1 over the picture. */',
  'export interface SessionLocalBrowserInputRequest {',
  '  readonly input:',
  '    | {',
  "      readonly kind: 'mouse'; readonly type: 'down' | 'up' | 'move'; readonly x: number; readonly y: number",
  "      readonly button: 'left' | 'right' | 'middle' | 'none'; readonly buttons: number; readonly clickCount: number; readonly modifiers: number",
  '    }',
  "    | { readonly kind: 'wheel'; readonly x: number; readonly y: number; readonly deltaX: number; readonly deltaY: number; readonly modifiers: number }",
  "    | { readonly kind: 'text'; readonly text: string }",
  "    | { readonly kind: 'key'; readonly key: string; readonly code: string; readonly keyCode: number; readonly modifiers: number }",
  '}',
  '',
  '/** Local build: whether the gesture reached the page, and the cursor the page shows there. */',
  'export interface SessionLocalBrowserInputValue {',
  '  readonly sent: boolean',
  '  readonly cursor?: string',
  '}',
  '',
  '/** Local build: the address bar of the shared browser. */',
  'export type SessionLocalBrowserNavigateRequest =',
  "  | { readonly action: 'url'; readonly url: string }",
  "  | { readonly action: 'back' | 'forward' | 'reload' }",
  '',
  '/** Local build: the address opened. */',
  'export interface SessionLocalBrowserNavigateValue {',
  '  readonly url: string',
  '}',
  '',
  '/** Local build: saved passwords (names and sites only, never the values), locked until Windows confirms the user. */',
  'export interface SessionLocalBrowserSecrets {',
  '  readonly locked: boolean',
  '  readonly count: number',
  '  readonly secrets: readonly { readonly name: string; readonly site: string }[]',
  '}',
  '',
  '/** Local build: whether saved passwords are unlocked now, and why not. */',
  'export interface SessionLocalBrowserUnlockValue {',
  '  readonly unlocked: boolean',
  '  readonly message?: string',
  '}',
  '',
  '/** Local build: saved passwords are locked again. */',
  'export interface SessionLocalBrowserLockValue {',
  '  readonly locked: true',
  '}',
  '',
  '/** Local build: save a password for the shared browser (stored encrypted with Windows DPAPI). */',
  'export interface SessionLocalBrowserSaveSecretRequest {',
  '  readonly name: string',
  '  readonly site: string',
  '  readonly value: string',
  '}',
  '',
  '/** Local build: the name the password was saved under. */',
  'export interface SessionLocalBrowserSaveSecretValue {',
  '  readonly name: string',
  '}',
  '',
  '/** Local build: remove a saved password. */',
  'export interface SessionLocalBrowserRemoveSecretRequest {',
  '  readonly name: string',
  '}',
  '',
  '/** Local build: whether it was removed. */',
  'export interface SessionLocalBrowserRemoveSecretValue {',
  '  readonly removed: boolean',
  '}',
  '',
  '/** Local build: sites with a saved sign-in in the shared browser. */',
  'export interface SessionLocalBrowserSites {',
  '  readonly sites: readonly { readonly domain: string; readonly cookies: number }[]',
  '}',
  '',
  "/** Local build: forget a site's sign-in in the shared browser. */",
  'export interface SessionLocalBrowserForgetRequest {',
  '  readonly domain: string',
  '}',
  '',
  '/** Local build: how many cookies were removed. */',
  'export interface SessionLocalBrowserForgetValue {',
  '  readonly removed: number',
  '}',
  '',
  '/** Local build: the open tabs of the shared browser. */',
  'export interface SessionLocalBrowserTabs {',
  '  readonly tabs: readonly { readonly id: string; readonly title: string; readonly url: string; readonly shown: boolean; readonly agent: boolean }[]',
  '}',
  '',
  '/** Local build: show, open or close a tab. */',
  'export type SessionLocalBrowserTabRequest =',
  "  | { readonly action: 'show' | 'close'; readonly id: string }",
  "  | { readonly action: 'new'; readonly url?: string }",
  '',
  '/** Local build: the tab shown, opened or closed. */',
  'export interface SessionLocalBrowserTabValue {',
  '  readonly id: string',
  '}',
  '',
  '/** Local build: the text selected in the page. */',
  'export interface SessionLocalBrowserCopyValue {',
  '  readonly text: string',
  '}',
  '',
  '/** Local build: find text in the page. */',
  'export interface SessionLocalBrowserFindRequest {',
  '  readonly text: string',
  '  readonly backwards?: boolean',
  '}',
  '',
  '/** Local build: whether it was found. */',
  'export interface SessionLocalBrowserFindValue {',
  '  readonly found: boolean',
  '}',
  '',
  '/** Local build: files dropped on the page (positions from 0 to 1 over the picture, contents in base64). */',
  'export interface SessionLocalBrowserDropRequest {',
  '  readonly x: number',
  '  readonly y: number',
  '  readonly files: readonly { readonly name: string; readonly data: string }[]',
  '}',
  '',
  '/** Local build: how many files were dropped. */',
  'export interface SessionLocalBrowserDropValue {',
  '  readonly dropped: number',
  '}',
  '',
  '/** Local build: change look-only mode or zoom (nothing: just read them). */',
  'export interface SessionLocalBrowserSettingsRequest {',
  '  readonly lookOnly?: boolean',
  '  readonly zoom?: number',
  '}',
  '',
  '/** Local build: look-only mode and zoom. */',
  'export interface SessionLocalBrowserSettings {',
  '  readonly lookOnly: boolean',
  '  readonly zoom: number',
  '}',
  '',
  '/** Local build: the answer to a click of the agent. */',
  'export interface SessionLocalBrowserConfirmRequest {',
  '  readonly id: string',
  '  readonly allow: boolean',
  '  readonly always?: boolean',
  '}',
  '',
  '/** Local build: whether the answer reached a waiting click. */',
  'export interface SessionLocalBrowserConfirmValue {',
  '  readonly answered: boolean',
  '}',
  '',
  '/** Local build: the click of the agent waiting for the user, if any. */',
  'export interface SessionLocalBrowserPending {',
  '  readonly confirm: SessionLocalBrowserConfirm | null',
  '}',
  '',
  '/** Local build: whether Microsoft Edge can run the browser. */',
  'export interface SessionLocalBrowserCheck {',
  '  readonly ok: boolean',
  '  readonly version?: string',
  '  readonly message?: string',
  '}',
  '',
  '/** Local build: how saved passwords unlock on this PC. */',
  'export interface SessionLocalBrowserUnlockMethod {',
  "  readonly method: 'hello' | 'password'",
  '}',
  '',
  '/** Local build: export saved passwords with a passphrase. */',
  'export interface SessionLocalBrowserExportRequest {',
  '  readonly passphrase: string',
  '}',
  '',
  '/** Local build: the encrypted backup and how many passwords it has. */',
  'export interface SessionLocalBrowserExportValue {',
  '  readonly file: string',
  '  readonly count: number',
  '}',
  '',
  '/** Local build: import a passwords backup. */',
  'export interface SessionLocalBrowserImportRequest {',
  '  readonly file: string',
  '  readonly passphrase: string',
  '}',
  '',
  '/** Local build: how many passwords were imported. */',
  'export interface SessionLocalBrowserImportValue {',
  '  readonly count: number',
  '}',
]

optional('un navegador compartido por el agente y el usuario en el panel derecho', (tx) => {
  const nav = join(here, 'navegador')
  const chatDir = join(repo, 'packages', 'client', 'ui-chat', 'src', 'client', 'chat')
  const deliverablesDir = join(repo, 'packages', 'client', 'ui-deliverables', 'src', 'client')
  const deliverablesIndex = join(deliverablesDir, 'index.ts')
  const provider = join(repo, 'packages', 'experimental', 'browser-use-playwright-mcp', 'src', 'index.ts')
  const bundle = join(repo, 'packages', 'bundle', 'web-app', 'cordis.patch.yml')
  if (!tx.read(provider).includes('LOCAL_AGENT_BROWSER_LAUNCHER')) skip('falta el navegador compartido (sección 34)')
  if (!existsSync(join(chatDir, 'local-live-watch.tsx'))) skip('falta el código en vivo (sección 19)')

  // Chat: el globo y la flecha del paso a paso junto a «View code», en las dos líneas de estado del turno.
  const running = join(chatDir, 'RunningStatus.tsx')
  tx.replace(running, "import { LocalLiveCodeButton } from './local-live-watch.tsx'\n",
    "import { LocalBrowserButton, LocalLiveCodeButton } from './local-live-watch.tsx'\n",
    'LocalBrowserButton, LocalLiveCodeButton }')
  tx.replace(running, '        <LocalLiveCodeButton placement="running" />\n',
    '        <LocalLiveCodeButton placement="running" />\n        <LocalBrowserButton placement="running" />\n',
    '<LocalBrowserButton placement="running" />')
  const processView = join(chatDir, 'TurnProcessNodeView.tsx')
  tx.replace(processView, "import { LocalLiveCodeButton } from './local-live-watch.tsx'\n",
    "import { LocalBrowserButton, LocalLiveCodeButton } from './local-live-watch.tsx'\n",
    'LocalBrowserButton, LocalLiveCodeButton }')
  tx.replace(processView, '      <LocalLiveCodeButton turn={node.data.turn} placement="process" />\n',
    '      <LocalLiveCodeButton turn={node.data.turn} placement="process" />\n'
      + '      <LocalBrowserButton turn={node.data.turn} placement="process" />\n',
    '<LocalBrowserButton turn={node.data.turn} placement="process" />')

  // Panel derecho: la pestaña, con el tipo `browser` de la app (la suya queda desactivada).
  tx.copy(join(nav, 'local-agent-browser-tab.tsx'), join(deliverablesDir, 'local-agent-browser-tab.tsx'))
  tx.copy(join(nav, 'local-agent-browser-tab.module.css'), join(deliverablesDir, 'local-agent-browser-tab.module.css'))
  tx.replace(deliverablesIndex, "import { setLocalLive } from './local-live-code.tsx'\n",
    "import { setLocalLive } from './local-live-code.tsx'\nimport { setLocalAgentBrowser } from './local-agent-browser-tab.tsx'\n",
    "import { setLocalAgentBrowser } from './local-agent-browser-tab.tsx'")
  tx.replace(deliverablesIndex, '  setLocalLive(ctx)\n',
    '  setLocalLive(ctx)\n  // Local build: the shared «Browser» tab (local-agent-browser-tab.tsx).\n  setLocalAgentBrowser(ctx)\n',
    'setLocalAgentBrowser(ctx)')
  tx.replace(bundle,
    "    - id: ui-sidebar-browser\n      name: '@deepseek-ai/dsh-client-ui-sidebar-browser'\n      disabled: !!js \"ctx.get('profileContext')?.name !== 'desktop'\"\n",
    "    - id: ui-sidebar-browser\n      name: '@deepseek-ai/dsh-client-ui-sidebar-browser'\n"
      + "      # local-build: the shared browser of the agent and the user (ui-deliverables) is the «Browser» tab.\n"
      + '      disabled: true\n',
    'the shared browser of the agent and the user')

  // Host: fotogramas, gestos, dirección, contraseñas y sesiones del Edge compartido.
  const hostIndex = join(hostDir, 'index.ts')
  const hostTypes = join(hostDir, 'types.ts')
  tx.copy(join(nav, 'local-agent-browser.ts'), join(hostDir, 'local-agent-browser.ts'))
  tx.addToTsconfig(join(hostDir, '..', 'tsconfig.host.json'), 'src/local-agent-browser.ts')
  tx.copy(join(nav, 'local-browser-rules.ts'), join(hostDir, 'local-browser-rules.ts'))
  tx.addToTsconfig(join(hostDir, '..', 'tsconfig.host.json'), 'src/local-browser-rules.ts')
  const typesStart = '// local-shared-browser:start\n'
  const typesEnd = '// local-shared-browser:end\n'
  tx.write(hostTypes, upsertBlock(tx.read(hostTypes), typesStart, typesEnd,
    typesStart + SHARED_BROWSER_TYPES.join('\n') + '\n' + typesEnd,
    (text, block) => text.trimEnd() + '\n\n' + block))

  const names = SHARED_BROWSER_REMOTES.map(([name]) => name)
  const typeNames = [...new Set(SHARED_BROWSER_REMOTES.flatMap(([, request, value]) => [request, value]))]
    .filter(type => type !== 'SessionLocalEmptyRequest').sort()
  const importsStart = '// local-shared-browser-imports:start\n'
  const importsEnd = '// local-shared-browser-imports:end\n'
  const imports = importsStart
    + `import {\n  ${names.join(', ')},\n} from './local-agent-browser.ts'\n`
    + `import type {\n  ${typeNames.join(', ')},\n} from './types.ts'\n`
    + importsEnd
  let host = upsertBlock(tx.read(hostIndex), importsStart, importsEnd, imports, (text, block) => {
    const anchor = "import { ApiSessionList } from './list.ts'\n"
    if (!text.includes(anchor)) skip(`no se encuentra ${anchor.trim()} en ${rel(hostIndex)}`)
    return text.replace(anchor, anchor + block)
  })
  const remotesStart = '  // local-shared-browser:start\n'
  const remotesEnd = '  // local-shared-browser:end\n'
  const remotes = remotesStart + SHARED_BROWSER_REMOTES.map(([name, request, value, isAsync, body, doc]) => [
    '  /**',
    `   * Local build: ${doc}`,
    '   * @param request - see the request type.',
    '   * @returns see the value type.',
    '   */',
    `  @Remote('${name}')`,
    `  ${isAsync ? 'async ' : ''}${name}(${body.includes('request') ? 'request' : '_request'}: ${request}): ${isAsync ? `Promise<${value}>` : value} {`,
    `    return ${body}`,
    '  }',
    '',
  ].join('\n')).join('\n') + remotesEnd
  host = upsertBlock(host, remotesStart, remotesEnd, remotes, (text, block) => {
    const at = text.indexOf("  @Remote('list')")
    const doc = at < 0 ? -1 : text.lastIndexOf('  /**', at)
    if (doc < 0) skip(`no se encuentra @Remote('list') en ${rel(hostIndex)}`)
    return text.slice(0, doc) + block + '\n' + text.slice(doc)
  })
  tx.write(hostIndex, host)
})

// ── 33. El selector de modelo, dentro de la barra ───────────────────────────────────
// El botón del selector es un chip con el modelo y el contexto («Qwen3.6 · 128K»): la
// rueda del ratón encima cambia el contexto, y al pulsarlo no se abre el menú flotante
// sino una fila dentro de la propia barra, encima del texto, con un bloque por modelo
// (el actual y los usados hace menos; «+N» abre un buscador), los tamaños de contexto a
// la derecha y, debajo, la limpieza automática. Interfaz: sistema/contexto/LocalModelDrawer.tsx.

optional('el selector de modelo dentro de la barra', (tx) => {
  const dir = join(repo, 'packages', 'client', 'ui-model-selection', 'src', 'client')
  const select = join(dir, 'ModelSelect.tsx')
  let text = tx.read(select)
  if (!text.includes('<ContextSlider') || !text.includes('<LocalCleanupSwitch')) {
    skip('necesita el contexto y las herramientas de modelos en el selector, que no se han aplicado')
  }
  tx.copy(join(here, 'contexto', 'LocalModelDrawer.tsx'), join(dir, 'LocalModelDrawer.tsx'))
  tx.copy(join(here, 'contexto', 'LocalModelDrawer.module.css'), join(dir, 'LocalModelDrawer.module.css'))
  tx.replace(select, "import css from './ModelSelect.module.css'\n",
    "import css from './ModelSelect.module.css'\n"
      + "import { LocalModelDrawer } from './LocalModelDrawer.tsx'\n"
      + "import { contextChipLabel, contextWheelStep } from './ContextSlider.tsx'\n"
      + "import { Tooltip as LocalTooltip } from '@deepseek-ai/dsh-client-ui-primitives'\n",
    "from './LocalModelDrawer.tsx'")
  text = tx.read(select)
  if (!text.includes('<LocalModelDrawer')) {
    const edits = [
      ['  const [open, setOpen] = useState(false)\n',
        '  const [open, setOpen] = useState(false)\n  // Local build: the model row inside the composer (LocalModelDrawer.tsx).\n  const [localDrawer, setLocalDrawer] = useState(false)\n'],
      [[
        '        onClick={() => {',
        '          if (open) {',
        '            close(true)',
        '          } else {',
        '            show()',
        '          }',
        '        }}',
        '',
      ].join('\n'), [
        '        // Local build: the model row opens inside the composer (Shift+click: the original menu, with its',
        '        // keyboard navigation), and the wheel steps the context.',
        '        onClick={(event) => {',
        '          if (event.shiftKey) {',
        '            setLocalDrawer(false)',
        '            if (open) close(true)',
        '            else show()',
        '            return',
        '          }',
        '          if (open) close(true)',
        '          setLocalDrawer(current => !current)',
        '        }}',
        '        onWheel={(event) => {',
        '          if (state.current === null || busy) return',
        '          const next = contextWheelStep(groups.find(group => group.id === state.current?.provider)?.models ?? [], state.current.model, event.deltaY)',
        '          if (next === undefined) return',
        '          const { provider, reasoningEffort } = state.current',
        '          choose({ provider, model: next, ...reasoningEffort === undefined ? {} : { reasoningEffort } })',
        '        }}',
        '',
      ].join('\n')],
      ['        title={triggerLabel}\n', "        data-local-chip={localDrawer ? 'open' : ''}\n"],
      ["{currentChoice === undefined ? modelLabel : renderModelLabel(currentChoice.group.provider, currentChoice.model, 'trigger', true)}",
        '{currentChoice === undefined ? modelLabel : contextChipLabel(currentChoice.model)}'],
    ]
    for (const [from, to] of edits) {
      if (!text.includes(from)) skip(`no se encuentra en ${rel(select)}: ${from.trim().split('\n')[0]}`)
      text = text.replace(from, to)
    }
    // El aviso de la app en el chip (antes, el recuadro de Windows del title).
    const start = text.indexOf('      <button\n        ref={triggerRef}')
    const end = start < 0 ? -1 : text.indexOf('      </button>\n', start)
    if (end < 0) skip(`no se encuentra el botón del selector en ${rel(select)}`)
    const close = end + '      </button>\n'.length
    text = text.slice(0, start)
      + '      <LocalTooltip label={`${triggerLabel} · Scroll: context · Click: models`} side="top" delayMs={500} disabled={localDrawer}>\n'
      + text.slice(start, close)
      + '      </LocalTooltip>\n'
      + text.slice(close)
    const portal = text.indexOf("      {/* Portaled to body (Menu primitive's portal mode)")
    if (portal < 0) skip(`no se encuentra el menú del selector en ${rel(select)}`)
    text = text.slice(0, portal) + [
      '      {/* Local build: the model row inside the composer (LocalModelDrawer.tsx). */}',
      '      <LocalModelDrawer',
      '        open={localDrawer}',
      '        onClose={() => { setLocalDrawer(false) }}',
      '        anchor={rootRef.current}',
      '        groups={groups}',
      '        current={state.current}',
      '        busy={busy}',
      '        onChoose={(provider, model) => {',
      '          choose({ provider, model })',
      '          setLocalDrawer(false)',
      '        }}',
      '        onContext={(model) => {',
      '          if (state.current === null) return',
      '          const { provider, reasoningEffort } = state.current',
      '          choose({ provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } })',
      '        }}',
      '        t={t}',
      '      />',
      '',
    ].join('\n') + text.slice(portal)
    tx.write(select, text)
  }
})

// ── 32. La barra lateral se esconde más tarde al estrechar la ventana ──────────────
// La oficial la recoge por debajo de 1024 px de la ventana (en píxeles de la app): con el
// escalado de Windows al 150 % son unos 1.500 píxeles reales, y se escondía enseguida. Cabe
// junto al chat mientras haya sitio para los dos (barra 280 + chat 400): se recoge por
// debajo de 760.

optional('la barra lateral se esconde más tarde al estrechar la ventana', (tx) => {
  const columns = join(repo, 'packages', 'client', 'ui-layout', 'src', 'client', 'columns.ts')
  tx.replace(columns, 'export const SIDEBAR_AUTO_COLLAPSE = 1024\n',
    '// Local build: collapse only when the sidebar and the chat no longer fit side by side.\nexport const SIDEBAR_AUTO_COLLAPSE = 760\n',
    'SIDEBAR_AUTO_COLLAPSE = 760')
})

// ── 36. El arranque reintenta la entrada a la interfaz ──────────────────────────────
// La app fallaba a ratos con «desktop welcome: Web authentication failed». El código HTTP (431)
// dio la causa: cookies de acceso acumuladas, una por arranque, hasta pasar el límite de
// cabeceras. Ahora se borran las viejas al arrancar; además la entrada se reintenta 30 s y, si
// falla, el aviso dice qué respondió el Host.

optional('el arranque reintenta la entrada a la interfaz', (tx) => {
  const welcome = join(repo, 'apps', 'desktop', 'src', 'welcome-backend.ts')
  tx.replace(welcome,
    [
      "  const authenticated = await send(authenticatedUrl, { credentials: 'include' })",
      '  await authenticated.body?.cancel()',
      "  if (!authenticated.ok) throw new Error('desktop welcome: Web authentication failed')",
    ].join('\n'),
    [
      '  // Local build: a Host that has just started (cold boot, freshly installed files) may hand out the cookie',
      '  // before it serves the page; ask again for a while instead of failing the whole launch.',
      '  let status = 0',
      '  for (let attempt = 0; ; attempt++) {',
      "    const authenticated = await send(authenticatedUrl, { credentials: 'include' })",
      '    await authenticated.body?.cancel()',
      '    if (authenticated.ok) break',
      '    status = authenticated.status',
      '    if (attempt >= 30) throw new Error(`desktop welcome: Web authentication failed (HTTP ${String(status)})`)',
      '    await new Promise(resolve => setTimeout(resolve, 1000))',
      '  }',
    ].join('\n'),
    'desktop welcome: Web authentication failed (HTTP')

  // La causa del 431: cada arranque deja una cookie de acceso de 30 días con el puerto del Host en el nombre, y el
  // navegador las manda todas a 127.0.0.1 sea cual sea el puerto; unas 70 pasan de los 16 KB de cabecera que acepta
  // Node. Se borran las viejas antes de entrar (el Host da una nueva en seguida).
  const main = join(repo, 'apps', 'desktop', 'src', 'main.ts')
  tx.replace(main, '        hostCookie = await authenticateWebHost(ready.url)\n',
    [
      '        // Local build: drop the access cookies earlier launches left behind (one per Host port, 30 days each);',
      '        // about 70 of them overflow the 16 KB request-header limit and the Host answers 431.',
      "        for (const cookie of await session.defaultSession.cookies.get({ domain: '127.0.0.1' })) {",
      "          if (cookie.name.startsWith('dsh-auth-')) await session.defaultSession.cookies.remove(new URL(ready.url).origin, cookie.name)",
      '        }',
      '        hostCookie = await authenticateWebHost(ready.url)',
      '',
    ].join('\n'),
    "cookie.name.startsWith('dsh-auth-')")
})

// ── 37. La app arranca con Windows, en la bandeja ─────────────────────────────────
// Para que las tareas programadas (schedule_create) se cumplan aunque no hayas abierto la
// app: al iniciar sesión en Windows arranca oculta en la bandeja (--hidden). Al abrirla tú,
// se enseña como siempre (la instancia única enfoca la que ya está en marcha).

optional('la app arranca con Windows, en la bandeja', (tx) => {
  const main = join(repo, 'apps', 'desktop', 'src', 'main.ts')
  tx.replace(main, '  let tray: DesktopTray | undefined\n',
    '  let tray: DesktopTray | undefined\n'
      + '  // Local build: start with Windows, hidden in the tray, so scheduled tasks run without opening the app.\n'
      + "  let localHiddenStart = process.argv.includes('--hidden')\n"
      + '  // Only the installed copy registers itself (not test copies started with their own profile).\n'
      + '  // The registry value needs an explicit name: the app sets no AppUserModelId, and without one nothing is written.\n'
      + "  if (app.isPackaged && process.platform === 'win32' && !process.argv.some(arg => arg.startsWith('--user-data-dir'))\n"
      + '    && /\\\\AppData\\\\Local\\\\Programs\\\\/i.test(process.execPath)) {\n'
      + "    try { app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'], name: 'DeepSeek Harness' }) } catch (error) { console.warn('local login item:', error) }\n"
      + '  }\n',
    "process.argv.includes('--hidden')")
  // El acceso directo del menú Inicio, a esta copia: Windows lo reasigna a otro .exe con el mismo nombre (una compilación
  // de la app en otra carpeta) si el destino falta un momento, por ejemplo al reinstalar, y se abría esa otra copia.
  const loginItem = "    try { app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'], name: 'DeepSeek Harness' }) } catch (error) { console.warn('local login item:', error) }\n"
  tx.replace(main, loginItem, loginItem
    + '    // The Start menu shortcut points to this copy: Windows retargets it to another exe with the same name (a build of\n'
    + '    // the app elsewhere) when the target is missing for a moment, e.g. while reinstalling.\n'
    + '    try {\n'
    + "      const link = join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DeepSeek Harness.lnk')\n"
    + '      const current = shell.readShortcutLink(link)\n'
    + '      if (current.target.toLowerCase() !== process.execPath.toLowerCase()) {\n'
    + "        shell.writeShortcutLink(link, 'update', { target: process.execPath, cwd: join(process.execPath, '..'), icon: process.execPath, iconIndex: 0 })\n"
    + '      }\n'
    + '    } catch { /* without the shortcut there is nothing to fix */ }\n',
    'The Start menu shortcut points to this copy')
  tx.replace(main, '    if (activate) window.show()\n    else window.showInactive()\n',
    '    // Local build: a start at Windows sign-in stays in the tray; the next show (tray, relaunch) is normal.\n'
      + '    if (localHiddenStart) localHiddenStart = false\n'
      + '    else if (activate) window.show()\n'
      + '    else window.showInactive()\n',
    'if (localHiddenStart) localHiddenStart = false')
})

// ── 38. Control de Windows para el agente ─────────────────────────────────────────
// Abrir apps y moverse por ellas: un servidor MCP propio (sistema/escritorio/desktop-mcp.mjs) sobre Cua Driver, que ya
// trae el repositorio con su binario de Windows. Va en su propio proceso (un fallo del controlador nativo no tumba la
// app) y ofrece 16 herramientas esenciales con definiciones recortadas: lee cada ventana como un árbol de elementos de
// texto (vale para un modelo sin visión) y pulsa o escribe por elemento, sin robar el foco.

const LOCAL_DESKTOP_PACKAGES = [
  ['@deepseek-ai/dsh-experimental-computer-use-cua-driver-native', 'packages/experimental/computer-use-cua-driver-native'],
]

optional('control de Windows para el agente (abrir apps y moverse por ellas)', (tx) => {
  const bundle = join(repo, 'packages', 'bundle', 'web-app', 'cordis.patch.yml')
  // El paquete trae @trycua/cua-driver y su binario de Windows (los .node quedan fuera del asar al empaquetar).
  addCliWorkspaceDeps(tx, LOCAL_DESKTOP_PACKAGES)
  let rows = tx.read(bundle)
  if (!rows.includes('serverName: desktop')) {
    const script = readFileSync(join(here, 'escritorio', 'desktop-mcp.mjs'), 'utf8')
    // El SDK se busca subiendo desde la entrada del Host (process.argv[1], dentro de node_modules) por cada carpeta
    // node_modules: solo se exporta para import, así que require.resolve no lo encuentra. Si no está, el servidor
    // responde con error y la app sigue sin estas herramientas.
    const args = "(() => { const path = process.getBuiltinModule('node:path'); const fs = process.getBuiltinModule('node:fs'); let sdk = ''; "
      + "try { let dir = path.dirname(process.argv[1] ?? ''); for (let i = 0; i < 14 && sdk === ''; i++) { "
      + "const candidate = path.join(dir, 'node_modules', '@trycua', 'cua-driver', 'dist', 'index.js'); "
      + "if (fs.existsSync(candidate)) sdk = candidate; const up = path.dirname(dir); if (up === dir) break; dir = up } } catch {} "
      + `return ['--input-type=module', '-e', ${JSON.stringify(script)}, '--', sdk] })()`
    rows = rows.trimEnd() + '\n\n' + [
      '# Local build (dpseek-local-updater): Windows desktop control for the agent (sistema/escritorio/desktop-mcp.mjs).',
      '- insert:',
      '    - id: local-desktop',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: desktop',
      '        transport: stdio',
      '        command: !!js process.execPath',
      `        args: !!js ${JSON.stringify(args)}`,
      '        env:',
      "          ELECTRON_RUN_AS_NODE: '1'",
      "          LOCALAPPDATA: !!js process.env.LOCALAPPDATA ?? ''",
      '        toolCallTimeoutMs: 60000',
      '',
    ].join('\n')
    tx.write(bundle, rows)
  }
})

// ── 39. Una respuesta que solo «piensa» se repite ───────────────────────────────────
// Qwen, a veces, termina una respuesta con solo su razonamiento: sin texto ni acción. La app la
// daba por buena y el turno acababa sin nada para el usuario. Ahora cuenta como respuesta vacía
// (EMPTY_RESPONSE), que la política de reintentos ya repite.

optional('una respuesta que solo piensa se repite', (tx) => {
  const stream = join(repo, 'packages', 'llm', 'llm-pi-ai', 'src', 'stream.ts')
  tx.replace(stream, '      if (message.content.length === 0) {\n',
    '      // Local build: a stop that only carries reasoning (no text, no tool call) also gives the user nothing.\n'
      + "      if (message.content.length === 0 || message.content.every(block => block.type === 'thinking')) {\n",
    "message.content.every(block => block.type === 'thinking')")
})

// ── 40. La zona de trabajo, como una tarjeta flotante ─────────────────────────────
// El chat y el panel derecho son dos tarjetas separadas del borde de la ventana por la derecha y por
// abajo (arriba ya las separa la franja del título), con las esquinas redondeadas (el radio de 16 px
// que la app usaba arriba a la izquierda) y sombras por capas en vez de borde: una cercana que dibuja
// el filo y otras cada vez más amplias y tenues. El panel derecho, con sus cuatro esquinas
// redondeadas, se apoya sobre el chat, que sigue por debajo, y le proyecta su sombra. En tema oscuro
// una sombra negra apenas se ve sobre una ventana casi negra: el chat es más claro que la barra
// lateral (33 sobre 27, como las tarjetas blancas sobre gris del tema claro) y el panel derecho es un
// tono más claro que el chat, sin la línea que lo separaba. La barra lateral conserva su color. El chat
// llega por debajo del panel al menos lo que mide la curva de sus esquinas (no asoma el fondo por ellas),
// pero su contenido y su barra de desplazamiento terminan en el borde del panel; la sombra del panel es
// un halo que sigue sus esquinas. Solo en Windows.
// El panel derecho a pantalla completa (que se sale de su columna) es también una tarjeta con el mismo
// margen y esquinas.

const FLOATING_CARD_CSS = [
  "/* local-build: floating card (dpseek-local-updater). The conversation and the right panel are two cards set off the",
  "   window edge on the right and bottom, all corners rounded; the right panel lies over the conversation. */",
  ":global([data-windows-titlebar]) .frame {",
  "  /* Radius and margin can be changed in Settings → General (local-card-rows.tsx). */",
  "  --dsh-local-card-gap: var(--dsh-local-user-card-gap, 12px);",
  "  --dsh-local-card-radius: var(--dsh-local-user-card-radius, var(--dsh-windows-content-radius));",
  "  /* Short layered shadows: a close one draws the edge and fainter ones carry it off within ~12px, so they never reach",
  "     the text next to the card and fade in steps too small to see as bands. */",
  "  --dsh-local-card-shadow: 0 0.5px 1px rgb(0 0 0 / 0.06), 0 1px 3px rgb(0 0 0 / 0.05), 0 3px 8px rgb(0 0 0 / 0.05), 0 6px 14px -2px rgb(0 0 0 / 0.05);",
  "  /* The right panel: a halo all around, not pushed down, so it follows both rounded corners over the conversation. */",
  "  --dsh-local-panel-shadow: 0 0 0.5px rgb(0 0 0 / 0.12), 0 1px 3px rgb(0 0 0 / 0.06), 0 2px 10px rgb(0 0 0 / 0.07);",
  "}",
  "",
  "/* Dark theme: a black shadow barely shows on a near-black window, so the conversation is lighter than the sidebar it",
  "   sits on (as the white cards on grey of the light theme) and the right panel is one tone lighter than the",
  "   conversation (it lies on top of it), with no line between them. The sidebar keeps its colour. */",
  ":global([data-windows-titlebar] body[data-ds-dark-theme]) .frame {",
  "  --dsh-local-card-shadow: 0 0.5px 1px rgb(0 0 0 / 0.3), 0 1px 3px rgb(0 0 0 / 0.22), 0 3px 8px rgb(0 0 0 / 0.2), 0 6px 14px -2px rgb(0 0 0 / 0.2);",
  "  --dsh-local-panel-shadow: 0 0 0.5px rgb(0 0 0 / 0.5), 0 1px 3px rgb(0 0 0 / 0.3), 0 2px 10px rgb(0 0 0 / 0.32);",
  "  --dsh-local-panel-fill: rgb(40 40 43);",
  "}",
  "",
  ":global([data-windows-titlebar] body[data-ds-dark-theme]) .centerCol {",
  "  --dsw-alias-bg-base: rgb(33 33 35);",
  "}",
  "",
  ":global([data-windows-titlebar]) .centerCol {",
  "  margin-bottom: var(--dsh-local-card-gap);",
  "  border-radius: var(--dsh-local-card-radius) 0 0 var(--dsh-local-card-radius);",
  "  box-shadow: var(--dsh-local-card-shadow);",
  "}",
  "",
  "/* With the right panel open, the conversation goes on under it at least as far as the panel's rounded corners reach",
  "   (the panel starts 12px inside it), so no background shows through those corners; its content and scrollbar end at",
  "   the panel's edge, where they can be seen and used. */",
  ":global([data-windows-titlebar]) .frame:not([data-rightbar-collapsed], [data-rightbar-fullscreen]) .centerCol {",
  "  margin-right: min(0px, calc(12px - var(--dsh-local-card-radius)));",
  "  padding-right: max(12px, var(--dsh-local-card-radius));",
  "}",
  "",
  ":global([data-windows-titlebar]) .frame[data-rightbar-collapsed] .centerCol,",
  ":global([data-windows-titlebar]) .frame[data-rightbar-fullscreen] .centerCol {",
  "  margin-right: var(--dsh-local-card-gap);",
  "  border-radius: var(--dsh-local-card-radius);",
  "}",
  "",
  ":global([data-windows-titlebar]) .frame:not([data-rightbar-collapsed], [data-rightbar-fullscreen]) .rightbarCol {",
  "  margin: 0 var(--dsh-local-card-gap) var(--dsh-local-card-gap) 0;",
  "}",
  "",
  "/* The round corners and the shadow go on the panel itself, not on its column: the panel starts 12px to the left of",
  "   the column (its own inner margin) and lies over the conversation. */",
  ":global([data-windows-titlebar]) .frame:not([data-rightbar-collapsed], [data-rightbar-fullscreen]) .rightbarCol :global([data-sidebar-right-panel='push']) {",
  "  border-radius: var(--dsh-local-card-radius);",
  "  corner-shape: round;",
  "  box-shadow: var(--dsh-local-panel-shadow);",
  "}",
  "",
  "/* Without the straight line the dock draws on the panel's left edge (it did not follow the rounded corners). */",
  ":global([data-windows-titlebar]) .frame:not([data-rightbar-collapsed]) .rightbarCol :global([data-sidebar-right-panel] [data-dockkit-host='dock'] > *) {",
  "  border-left-color: transparent;",
  "}",
  "",
  "/* Dark theme: the panel one tone lighter (only while open: closed, it stays in the page over the conversation). The",
  "   theme's base colour is the panel's inside it, so every tab painted with it (files, previews, the terminal) matches. */",
  ":global([data-windows-titlebar] body[data-ds-dark-theme]) .frame:not([data-rightbar-collapsed]) .rightbarCol :global([data-sidebar-right-panel]) {",
  "  --dsw-alias-bg-base: var(--dsh-local-panel-fill);",
  "}",
  ":global([data-windows-titlebar] body[data-ds-dark-theme]) .frame:not([data-rightbar-collapsed]) .rightbarCol :global([data-sidebar-right-panel]),",
  ":global([data-windows-titlebar] body[data-ds-dark-theme]) .frame:not([data-rightbar-collapsed]) .rightbarCol :global([data-sidebar-right-panel] [data-dockkit-host='dock'] > *) {",
  "  background-color: var(--dsh-local-panel-fill);",
  "}",
  "",
  "/* The resize handle sits on the visible edge of the right panel (12px left of its column): on the column edge it",
  "   covered the first pixels of the panel, and in the browser that left part of the page could not be clicked. */",
  ":global([data-windows-titlebar]) .frame:not([data-rightbar-collapsed], [data-rightbar-fullscreen]) .handle[data-side='rightbar'] {",
  "  margin-left: -16px;",
  "}",
  "",
  "/* The right panel in fullscreen keeps the same card shape: the gap on the right and bottom, round corners, shadow. */",
  ":global([data-windows-titlebar]) .frame[data-rightbar-fullscreen] :global([data-sidebar-right-panel='fullscreen']) {",
  "  right: var(--dsh-local-card-gap);",
  "  bottom: var(--dsh-local-card-gap);",
  "  max-width: calc(100vw - var(--dsh-windows-sidebar-width, 0px) - var(--dsh-local-card-gap));",
  "  border-radius: var(--dsh-local-card-radius);",
  "  box-shadow: var(--dsh-local-card-shadow);",
  "}",
  "/* local-build: floating card end */",
].join('\n')

const FLOATING_CARD_START = '/* local-build: floating card (dpseek-local-updater).'
const FLOATING_CARD_END = '/* local-build: floating card end */'

optional('la zona de trabajo como una tarjeta flotante', (tx) => {
  const frameCss = join(repo, 'packages', 'client', 'ui-layout', 'src', 'client', 'AppFrame.module.css')
  const css = tx.read(frameCss)
  if (!css.includes(':global([data-windows-titlebar]) .centerCol {')) skip(`no se encuentra el marco de Windows en ${rel(frameCss)}`)
  // Sustituye la versión anterior si ya estaba (las primeras no tenían marca de cierre: iban al final del fichero).
  const at = css.indexOf(FLOATING_CARD_START)
  const stop = at < 0 ? -1 : css.indexOf(FLOATING_CARD_END, at)
  const before = at < 0 ? css : css.slice(0, at)
  const after = stop < 0 ? '' : css.slice(stop + FLOATING_CARD_END.length)
  const rest = after.trim() === '' ? '' : '\n' + after.replace(/^\n+/, '')
  const next = before.trimEnd() + '\n\n' + FLOATING_CARD_CSS + '\n' + rest
  if (next !== css) tx.write(frameCss, next)

  // Radio de las esquinas y margen, en Ajustes → General (sistema/diseno/local-card-rows.tsx).
  const chatClient = join(repo, 'packages', 'client', 'ui-chat', 'src', 'client')
  tx.copy(join(here, 'diseno', 'local-card-rows.tsx'), join(chatClient, 'settings', 'local-card-rows.tsx'))
  const chatApply = join(chatClient, 'apply.ts')
  tx.replace(chatApply, "import { TranscriptViewRow, type TranscriptViewRowInjected } from './settings/TranscriptViewRow.tsx'\n",
    "import { TranscriptViewRow, type TranscriptViewRowInjected } from './settings/TranscriptViewRow.tsx'\n"
      + "import { LocalCardGapRow, LocalCardRadiusRow } from './settings/local-card-rows.tsx'\n",
    "import { LocalCardGapRow, LocalCardRadiusRow } from './settings/local-card-rows.tsx'")
  tx.replace(chatApply, '  }, TranscriptViewRow))\n',
    '  }, TranscriptViewRow))\n\n'
      + '  // Local build: corner radius and margin of the floating card (local-card-rows.tsx).\n'
      + "  ctx.slots.inject('settings.general.item', () => ctx.slots.register({\n"
      + "    name: 'settings.general.item', id: 'local-card-radius', order: 13, locale: NS,\n"
      + '  }, LocalCardRadiusRow))\n'
      + "  ctx.slots.inject('settings.general.item', () => ctx.slots.register({\n"
      + "    name: 'settings.general.item', id: 'local-card-gap', order: 14, locale: NS,\n"
      + '  }, LocalCardGapRow))\n',
    "id: 'local-card-radius'")
})

// ── 41. Doble clic en la línea entre el chat y el panel: mitad y mitad ──────────────
// El tirador del panel derecho reparte el espacio a partes iguales con un doble clic (el
// arrastre sigue igual). El ancho pasa por el mismo setRightbar, así que respeta los límites.

optional('doble clic en el tirador del panel derecho: mitad y mitad', (tx) => {
  const frame = join(repo, 'packages', 'client', 'ui-layout', 'src', 'client', 'AppFrame.tsx')
  tx.replace(frame,
    'function DragHandle(props: { side: \'sidebar\' | \'rightbar\'; left: number; onStart: () => void; onDrag: (dx: number) => void; onEnd: () => void }) {',
    'function DragHandle(props: { side: \'sidebar\' | \'rightbar\'; left: number; onStart: () => void; onDrag: (dx: number) => void; onEnd: () => void; onDoubleClick?: () => void }) {',
    'onDoubleClick?: () => void }')
  tx.replace(frame,
    '      onLostPointerCapture={onPointerCancel}\n    />',
    '      onLostPointerCapture={onPointerCancel}\n      onDoubleClick={props.onDoubleClick}\n    />',
    'onDoubleClick={props.onDoubleClick}')
  tx.replace(frame,
    '  const productTitle = process.env.DSH_CLIENT_TITLE',
    '  // Local build: a double click on the right handle splits the space beside the sidebar in half.\n'
      + '  const onRightbarHalf = useCallback(() => { actions.setRightbar((viewport - colsRef.current.sidebar) / 2) }, [actions, viewport])\n'
      + '  const productTitle = process.env.DSH_CLIENT_TITLE',
    'onRightbarHalf')
  tx.replace(frame,
    '<DragHandle side="rightbar" left={viewport - normal.rightbar} onStart={onRightbarStart} onDrag={onRightbarDrag} onEnd={onDragEnd} />',
    '<DragHandle side="rightbar" left={viewport - normal.rightbar} onStart={onRightbarStart} onDrag={onRightbarDrag} onEnd={onDragEnd} onDoubleClick={onRightbarHalf} />',
    'onDoubleClick={onRightbarHalf}')
})

// ── 42. Respuestas cortas; lo que se piensa, en el pensamiento ──────────────────────
// El prompt oficial no dice nada del estilo de las respuestas y los modelos locales narran cada
// paso («Ahora voy a…», «Veo que…») y cierran con resúmenes largos. Una sección para todos los
// chats: ir al grano, razonar en el pensamiento y no en el texto, y una línea como mucho entre
// herramientas. Va al final, junto a las referencias a ficheros (orden 9000 + 500).

const REPLY_STYLE_PROMPT = [
  '# Reply style',
  '- Be brief. Lead with the answer or the result; no preamble, no restating the question, no closing recap or offers of more help.',
  '- A question or explanation gets 2-5 sentences (under 100 words) unless the user asks for more detail; skip sections, headings and examples nobody asked for.',
  '- Your first words are the answer itself: never open with "Sure", "Of course", "Great question", "Here you go", "Here are…" or their equivalents in the user\'s language (e.g. "Claro", "Aquí tienes").',
  '- Keep your reasoning in your thinking, not in the reply: plans, options you weigh and narration of what you see or are about to do stay there.',
  '- Between tool calls, write at most one short line, or nothing.',
  '- When a task is done, say what changed and anything the user must do or know, in a few sentences. Add detail, lists or tables only when the user asks or the content truly needs them.',
].join('\n')

optional('respuestas cortas y el razonamiento en el pensamiento', (tx) => {
  const deliverables = join(repo, 'packages', 'client', 'ui-deliverables', 'src', 'index.ts')
  // Si ya estaba con un texto anterior, se cambia solo el texto.
  const current = tx.read(deliverables)
  const text = `    text: ${JSON.stringify(REPLY_STYLE_PROMPT)},\n`
  const stale = /(    name: 'local:reply-style',\n    order: [^\n]+\n)    text: "[^\n]*",\n/
  if (stale.test(current) && !current.includes(text)) tx.write(deliverables, current.replace(stale, (_, head) => head + text))
  tx.replace(deliverables,
    '  registerPresentOpen(ctx)\n',
    '  registerPresentOpen(ctx)\n'
      + '  // Local build: short replies, with the reasoning kept in the thinking (dpseek-local-updater).\n'
      + '  ctx.systemPrompt.section({\n'
      + "    name: 'local:reply-style',\n"
      + "    order: ctx.systemPrompt.getSectionOrder('DELIVERABLE_FILE_REFERENCES') + 500,\n"
      + `    text: ${JSON.stringify(REPLY_STYLE_PROMPT)},\n`
      + '    interpolate: false,\n'
      + '  })\n',
    "name: 'local:reply-style'")
})

// ── 43. Los botones de Windows, sin tapar la esquina del panel ──────────────────────
// Detrás de minimizar, maximizar y cerrar, Windows pinta una capa propia del color de la barra
// lateral, opaca y un par de píxeles más alta que la franja del título: tapaba la esquina de
// arriba a la derecha del panel (y su sombra), que se veía mellada. Transparente, se ve lo que
// pinta la app debajo (el mismo color); Windows sigue dibujando los botones y su resaltado.

optional('los botones de Windows sin tapar la esquina del panel', (tx) => {
  const main = join(repo, 'apps', 'desktop', 'src', 'main.ts')
  tx.replace(main,
    '      if (validColor(color) && validColor(symbolColor)) mainWindow.setTitleBarOverlay({ color, symbolColor })\n',
    '      // Local build: a transparent caption layer; opaque, it covered the top-right corner of the right panel.\n'
      + "      if (validColor(color) && validColor(symbolColor)) mainWindow.setTitleBarOverlay({ color: 'rgba(0, 0, 0, 0)', symbolColor })\n",
    "setTitleBarOverlay({ color: 'rgba(0, 0, 0, 0)', symbolColor })")
})

// ── 44. Contraste del texto secundario en el tema claro ─────────────────────────────
// En claro, las fechas, contadores, descripciones de ajustes y la lista de Workspaces usan un gris
// (#81858c) que sobre blanco se queda en 3,7:1, y la pestaña activa (Chat/Trajectory) un azul de
// 4,2:1; WCAG pide 4,5:1 para texto pequeño. Un gris y un azul un poco más oscuros llegan (5,7:1
// sobre blanco y 4,9:1 sobre la barra lateral; 5,4:1). El tema oscuro ya cumple y no cambia.

const CONTRAST_START = '/* local-build: light theme contrast (dpseek-local-updater) */'
const CONTRAST_END = '/* local-build: light theme contrast end */'

optional('más contraste en el texto secundario del tema claro', (tx) => {
  const tokens = join(repo, 'packages', 'client', 'ui-theme', 'src', 'styles', 'design-platform.css')
  const block = [
    CONTRAST_START,
    'body:not([data-ds-dark-theme]) {',
    '  --dsw-alias-label-tertiary: rgb(99 103 110);',
    '}',
    CONTRAST_END,
  ].join('\n')
  const css = tx.read(tokens)
  if (!css.includes('--dsw-alias-label-tertiary:')) skip(`no se encuentra el gris de los textos secundarios en ${rel(tokens)}`)
  const next = upsertBlock(css, CONTRAST_START, CONTRAST_END, block, (text, value) => `${text.trimEnd()}\n\n${value}\n`)
  if (next !== css) tx.write(tokens, next)
  const root = join(repo, 'packages', 'client', 'ui-conversation', 'src', 'client', 'skeleton', 'ConversationRoot.module.css')
  tx.replace(root, '.tabActive {\n  color: var(--dsw-alias-state-business-primary);\n}\n',
    '.tabActive {\n  color: var(--dsw-alias-state-business-primary);\n}\n\n'
      + '/* Local build: a darker blue for the label in the light theme (4.5:1 on white). */\n'
      + ':global(body:not([data-ds-dark-theme])) .tabActive {\n  color: var(--dsw-static-deepseek-600);\n}\n',
    'body:not([data-ds-dark-theme])) .tabActive')
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
