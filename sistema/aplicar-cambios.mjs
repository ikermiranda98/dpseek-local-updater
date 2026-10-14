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
    warn(`se omite «${name}»: ${error.message}`)
    return false
  }
  for (const [from, to] of copies) copyFileSync(from, to)
  for (const [file, text] of staged) write(file, text)
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
 * de modelos. Cualquier fallo devuelve los modelos fijos.
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
    '((fixed) => { try {',
    `const out = process.getBuiltinModule('node:child_process').execFileSync(process.execPath, ['-e', ${JSON.stringify(startup)}],`,
    `{ env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_CTX: ${JSON.stringify(JSON.stringify(settings))}, DSH_CTX_CALIBRAR: ${JSON.stringify(calibrator)}, DSH_CTX_PRECARGA: ${JSON.stringify(keeper)} },`,
    "timeout: 30000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });",
    'const models = JSON.parse(out);',
    'return Array.isArray(models) && models.length > 0 ? models : fixed;',
    `} catch (error) { return fixed; } })(${JSON.stringify(fixed)})`,
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
  tx.replace(hostIndex, 'return { items: await this.listState.list(signal) }', [
    '// Local build: first remove what the previous run left pending, then',
    '    // hide Sessions whose deletion waits for the next start.',
    '    const hidden = await this.localDeleter().hidden()',
    '    const items = await this.listState.list(signal)',
    '    return { items: hidden.size === 0 ? items : items.filter(item => !hidden.has(item.sessionId)) }',
  ].join('\n'), 'this.localDeleter().hidden()')

  // Interfaz: fila «Eliminar sesión» en el menú del chat y diálogo de confirmación.
  tx.copy(join(here, 'borrar-chats', 'DeleteSession.tsx'), join(uiDir, 'session-actions', 'DeleteSession.tsx'))
  tx.replace(uiIndex, "} from './session-actions/ArchiveSession.tsx'\n", [
    "} from './session-actions/ArchiveSession.tsx'",
    'import {',
    '  DeleteSessionMenuItem, SessionDeleteDialog,',
    '  type DeleteSessionInjected, type SessionDeleteDialogInjected, type SessionDeleteRequest,',
    "} from './session-actions/DeleteSession.tsx'",
    '',
  ].join('\n'), "from './session-actions/DeleteSession.tsx'")
  let ui = tx.read(uiIndex)
  if (!ui.includes("'remote.session'")) {
    const re = /^(export const inject = \[[^\]]*?)'remote',/m
    if (!re.test(ui)) skip(`no se encuentra la lista inject de ${rel(uiIndex)}`)
    ui = ui.replace(re, "$1'remote', 'remote.session',")
  }
  if (!ui.includes("id: 'local-delete'")) {
    const anchor = ui.match(/^([ \t]*)ctx\.slots\.inject\('conversation\.hero\.workspace'/m)
    if (!anchor) skip(`no se encuentra el final de apply() en ${rel(uiIndex)}`)
    for (const needed of ['uiWorkspace.archiveSession(', 'sessions.list.getSnapshot()', 'createSnapshotStore']) {
      if (!ui.includes(needed)) skip(`${rel(uiIndex)} ya no usa ${needed}`)
    }
    const pad = anchor[1]
    ui = ui.replace(anchor[0], () => [
      '// Local build: permanent delete — a menu row after Archive and its confirmation.',
      'const localDeleteSession = async (sessionId: SessionId): Promise<void> => {',
      '  // Archiving first stops its work and leaves the view if it is open.',
      '  await uiWorkspace.archiveSession(sessionId, { stopActivity: true })',
      '  const result = await ctx.remote.session.deletePermanently({ sessionId })',
      '  if (!result.ok) throw new Error(result.error.message)',
      '}',
      'const deleteRequest = createSnapshotStore<SessionDeleteRequest | null>(null)',
      'const deleteInjected = (): DeleteSessionInjected => ({',
      '  requestSessionDelete: (sessionId) => {',
      '    const displayTitle = sessions.list.getSnapshot().byId[sessionId]?.displayTitle ?? sessionId',
      '    deleteRequest.set({ sessionId, displayTitle })',
      '  },',
      '})',
      'const deleteDialogInjected = (): SessionDeleteDialogInjected => ({',
      '  hooks: { deleteRequest },',
      '  settleSessionDelete: () => { deleteRequest.set(null) },',
      '  deleteSession: async (sessionId) => {',
      '    await localDeleteSession(sessionId)',
      '    await sessions.refresh()',
      '  },',
      '})',
      "ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register(",
      "  { name: 'sidebar.workspaces.session.menu.item', id: 'local-delete', order: 500, locale: NS, inject: deleteInjected },",
      '  DeleteSessionMenuItem,',
      '))',
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

// ── 9. Eliminar varios chats a la vez ─────────────────────────────────────────
// «Seleccionar varios» en el menú de un chat: casillas en la barra lateral y una
// barra con «Todos», «Eliminar» y «Cancelar» (sistema/borrar-chats/BulkDelete.tsx).
// Usa el borrado de la sección 7.

optional('selección de varios chats para eliminarlos a la vez', (tx) => {
  // Si DeepSeek añade la selección múltiple, se usa la suya.
  if (officialKeys(uiLocales).some((key) => /select(ed|ion)|bulk|batch|multi/i.test(key))) {
    official('la selección de varios chats')
  }
  if (!deleteApplied) skip('necesita «Eliminar sesión», que no se ha aplicado')
  tx.copy(join(here, 'borrar-chats', 'BulkDelete.tsx'), join(uiDir, 'session-actions', 'BulkDelete.tsx'))
  tx.copy(join(here, 'borrar-chats', 'BulkDelete.module.css'), join(uiDir, 'session-actions', 'BulkDelete.module.css'))
  tx.replace(uiIndex, "} from './session-actions/DeleteSession.tsx'\n", [
    "} from './session-actions/DeleteSession.tsx'",
    'import {',
    '  BulkDeleteBar, BulkSelectCheckbox, BulkSelectMenuItem,',
    '  type BulkDeleteBarInjected, type BulkSelectInjected, type BulkSelection,',
    "} from './session-actions/BulkDelete.tsx'",
    '',
  ].join('\n'), "from './session-actions/BulkDelete.tsx'")
  let ui = tx.read(uiIndex)
  if (!ui.includes("id: 'local-bulk-select'")) {
    const anchor = ui.match(/^([ \t]*)\/\/ Local build: bulk delete hook \(section 9\)\.\r?\n/m)
    if (!anchor) skip(`no se encuentra el punto de enganche de la sección 7 en ${rel(uiIndex)}`)
    if (!ui.includes('workspaces.list.getSnapshot()')) skip(`${rel(uiIndex)} ya no usa workspaces.list.getSnapshot()`)
    const pad = anchor[1]
    ui = ui.replace(anchor[0], () => [
      '// Local build: select several sessions and delete them together.',
      'const bulkSelection = createSnapshotStore<BulkSelection>({ active: false, ids: [] })',
      'const titleOf = (id: SessionId): string => sessions.list.getSnapshot().byId[id]?.displayTitle ?? id',
      'const bulkSelectInjected = (): BulkSelectInjected => ({',
      '  hooks: { selection: bulkSelection },',
      '  startSelection: (sessionId) => { bulkSelection.set({ active: true, ids: [sessionId] }) },',
      '  toggleSelected: (sessionId) => {',
      '    const { ids } = bulkSelection.getSnapshot()',
      '    bulkSelection.set({ active: true, ids: ids.includes(sessionId) ? ids.filter(id => id !== sessionId) : [...ids, sessionId] })',
      '  },',
      '})',
      'const bulkBarInjected = (): BulkDeleteBarInjected => ({',
      '  hooks: { selection: bulkSelection },',
      '  toggleAll: () => {',
      '    // Los chats que se ven en la barra lateral: ni subagentes, ni en blanco, ni archivados.',
      '    const list = sessions.list.getSnapshot()',
      '    const archived = new Set(workspaces.list.getSnapshot().archivedSessionIds)',
      '    const all = list.ids.filter((id) => {',
      '      const row = list.byId[id]',
      "      return row !== undefined && row.parentId === undefined && row.origin !== 'subagent' && !row.blank && !archived.has(id)",
      '    })',
      '    const { ids } = bulkSelection.getSnapshot()',
      '    bulkSelection.set({ active: true, ids: all.every(id => ids.includes(id)) ? [] : all })',
      '  },',
      '  cancelSelection: () => { bulkSelection.set({ active: false, ids: [] }) },',
      '  titlesOf: ids => ids.map(titleOf),',
      '  deleteMany: async (ids, progress) => {',
      '    const failed: SessionId[] = []',
      '    let done = 0',
      '    for (const id of ids) {',
      '      try { await localDeleteSession(id) } catch { failed.push(id) }',
      '      progress(++done)',
      '    }',
      '    await sessions.refresh()',
      '    // Quedan seleccionados los que no se pudieron borrar.',
      '    bulkSelection.set({ active: true, ids: failed })',
      '    return failed.map(titleOf)',
      '  },',
      '})',
      "ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register(",
      "  { name: 'sidebar.workspaces.session.menu.item', id: 'local-bulk-select', order: 450, locale: NS, inject: bulkSelectInjected },",
      '  BulkSelectMenuItem,',
      '))',
      "ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register(",
      "  { name: 'sidebar.session.row.leading', id: 'local-bulk-checkbox', order: 0, locale: NS, inject: bulkSelectInjected },",
      '  BulkSelectCheckbox,',
      '))',
      "ctx.slots.inject('shell.overlay', () => ctx.slots.register(",
      "  { name: 'shell.overlay', id: 'workspace.local-bulk-delete', locale: NS, inject: bulkBarInjected },",
      '  BulkDeleteBar,',
      '))',
    ].map((line) => (line === '' ? '' : pad + line)).join('\n') + '\n')
    tx.write(uiIndex, ui)
  }
  addLocaleKeys(tx, uiLocales, 'WorkspaceKey', {
    'local.bulk.menu': '选择多个',
    'local.bulk.select': '选择会话',
    'local.bulk.count': '已选择 {n} 个',
    'local.bulk.all': '全部',
    'local.bulk.title': '删除 {n} 个会话？',
    'local.bulk.desc': '将永久删除它们及其子智能体和历史记录。工作目录中的文件不受影响。此操作无法撤销。',
    'local.bulk.confirm': '删除 {n} 个',
    'local.bulk.more': '以及另外 {n} 个',
    'local.bulk.progress': '正在删除第 {done} 个，共 {n} 个…',
    'local.bulk.failed': '无法删除：{titles}',
  }, {
    'local.bulk.menu': 'Select several',
    'local.bulk.select': 'Select session',
    'local.bulk.count': '{n} selected',
    'local.bulk.all': 'All',
    'local.bulk.title': 'Delete {n} sessions?',
    'local.bulk.desc': 'They will be permanently deleted, with their subagents and history. Files in the working folders are not touched. This cannot be undone.',
    'local.bulk.confirm': 'Delete {n}',
    'local.bulk.more': 'and {n} more',
    'local.bulk.progress': 'Deleting {done} of {n}…',
    'local.bulk.failed': 'Could not delete: {titles}',
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
  if (sourceMatches(join(repo, 'packages', 'client'), /new Notification\(/, ['local-reply-notifications.ts'])) {
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

optional('no volver a ofrecer una versión retirada', (tx) => {
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

optional('herramientas de modelos en el selector (optimizar, limpieza y modelos sin usar)', (tx) => {
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
    ].join('\n')
    tx.write(hostTypes, types)
  }
  tx.replace(hostIndex, "import { ApiSessionList } from './list.ts'\n", [
    "import { ApiSessionList } from './list.ts'",
    'import {',
    '  localDeleteModel, localModelsInfo, localOptimizeModel as runLocalOptimize,',
    '  localOptimizeStatus as readLocalOptimizeStatus, localSetCleanup,',
    "} from './local-optimize.ts'",
    'import type {',
    '  SessionLocalCleanupRequest, SessionLocalCleanupValue, SessionLocalDeleteModelRequest,',
    '  SessionLocalDeleteModelValue, SessionLocalEmptyRequest, SessionLocalModelsValue,',
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

console.log('\nCambios aplicados:')
for (const line of done) console.log(`  - ${line}`)
if (omitted.length > 0) {
  console.log('\nFunciones omitidas en esta versión:')
  for (const line of omitted) console.log(`  - ${line}`)
}
// GitHub Actions las añade a las notas del Release.
if (process.env.DSH_LOCAL_OMITIDOS) writeFileSync(process.env.DSH_LOCAL_OMITIDOS, omitted.map((line) => `- ${line}\n`).join(''))
if (warnings.length > 0) {
  console.log(`\n${warnings.length} aviso(s); revisa los mensajes AVISO de arriba.`)
}
