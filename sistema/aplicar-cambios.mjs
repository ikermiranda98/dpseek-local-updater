// Aplica las modificaciones locales (Ollama, sin inicio de sesión, sin telemetría,
// idioma español, eliminar chats, contexto por chat) sobre una copia del repositorio de DeepSeek Harness.
//
// Uso: node sistema/aplicar-cambios.mjs <ruta-del-repositorio>
//
// Es idempotente: se puede ejecutar varias veces sobre el mismo árbol. Edita los
// ficheros localizando cada fila por el nombre del plugin o su id (no por número
// de línea), así que sobrevive a cambios menores entre versiones. Si algo que es
// imprescindible ya no existe, se detiene con un ERROR que explica qué falta.

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

/** Modelo de "modelosManuales" (sin Ollama al arrancar) en el formato de llm-pi-ai. */
const toPiAi = (m) => {
  const ctx = m.contexto ?? contexto.porDefecto
  return {
    id: variantName(m.id, 'auto'),
    name: `${m.nombre ?? m.id.replace(/:latest$/, '')} · Auto ${ctx % 1024 === 0 ? ctx / 1024 + 'K' : ctx} (sin medir)`,
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
  const settings = {
    ollama: new URL(config.ollamaUrl).origin,
    sizes: contexto.tamanos,
    defaultCtx: contexto.porDefecto,
    maxTokens: config.maxTokensSalida,
    efforts: EFFORTS,
  }
  return [
    '((fixed) => { try {',
    `const out = process.getBuiltinModule('node:child_process').execFileSync(process.execPath, ['-e', ${JSON.stringify(startup)}],`,
    `{ env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_CTX: ${JSON.stringify(JSON.stringify(settings))}, DSH_CTX_CALIBRAR: ${JSON.stringify(calibrator)} },`,
    "timeout: 20000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });",
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

// ── 4. Idioma español ─────────────────────────────────────────────────────────

{
  const localeDir = join(repo, 'packages', 'client', 'locale', 'src')
  const index = join(localeDir, 'client', 'index.ts')
  if (!existsSync(index)) fail(`no existe ${rel(index)}; el sistema de idiomas ha cambiado`)
  copyFileSync(join(here, 'es-pack.ts'), join(localeDir, 'locales', 'es-pack.ts'))

  let text = read(index)
  if (!text.includes("from '../locales/es-pack.ts'")) {
    const anchor = text.match(/^import .*from '\.\.\/locales\/index\.ts'\r?\n/m)
    if (!anchor) fail(`no se encuentra el import de '../locales/index.ts' en ${rel(index)}`)
    text = text.replace(anchor[0], anchor[0] + "import { esPack } from '../locales/es-pack.ts'\n")
  }
  if (!text.includes('esPack)')) {
    const provide = text.match(/^(\s*)ctx\.provide\('locale', locale\)\r?\n/m)
    if (!provide) fail(`no se encuentra ctx.provide('locale', locale) en ${rel(index)}`)
    const pad = provide[1]
    text = text.replace(provide[0], [
      `${pad}// Local build: Spanish language pack; missing keys fall back to English.`,
      `${pad}locale.addLanguage({ id: 'es', label: 'Español', fallback: 'en' })`,
      `${pad}for (const [ns, dict] of Object.entries(esPack)) locale.register(ns, 'es', dict)`,
      '',
    ].join('\n') + provide[0])
  }
  write(index, text)
  done.push('idioma español añadido (Ajustes → General → Idioma)')
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

{
  const src = join(here, 'borrar-chats')
  const hostDir = join(repo, 'packages', 'api', 'session-controller', 'src')
  const hostIndex = join(hostDir, 'index.ts')
  const hostTypes = join(hostDir, 'types.ts')
  const uiDir = join(repo, 'packages', 'client', 'ui-workspace', 'src', 'client')
  const uiIndex = join(uiDir, 'index.ts')
  const uiLocales = join(uiDir, 'locales.ts')
  for (const file of [hostIndex, hostTypes, uiIndex, uiLocales]) {
    if (!existsSync(file)) fail(`no existe ${rel(file)}; no se puede añadir «Eliminar sesión»`)
  }
  if (!existsSync(join(uiDir, 'session-actions'))) fail(`no existe ${rel(join(uiDir, 'session-actions'))}`)

  // Host: método remoto session.deletePermanently y filtro de la lista.
  copyFileSync(join(src, 'local-delete.ts'), join(hostDir, 'local-delete.ts'))
  // El paquete enumera sus ficheros uno a uno: el nuevo tiene que estar en la lista.
  const hostTsconfig = join(hostDir, '..', 'tsconfig.host.json')
  if (existsSync(hostTsconfig)) {
    const tsconfig = JSON.parse(read(hostTsconfig))
    if (Array.isArray(tsconfig.files) && !tsconfig.files.includes('src/local-delete.ts')) {
      tsconfig.files.push('src/local-delete.ts')
      write(hostTsconfig, JSON.stringify(tsconfig, null, 2))
    }
  }

  let types = read(hostTypes)
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
    write(hostTypes, types)
  }

  let host = read(hostIndex)
  if (!host.includes("from './local-delete.ts'")) {
    const anchor = host.match(/^import \{ ApiSessionList \} from '\.\/list\.ts'\r?\n/m)
    if (!anchor) fail(`no se encuentra el import de './list.ts' en ${rel(hostIndex)}`)
    host = host.replace(anchor[0], anchor[0] + [
      "import { LocalSessionDeleter } from './local-delete.ts'",
      "import type { SessionRemoveRequest, SessionRemoveValue } from './types.ts'",
      '',
    ].join('\n'))
  }
  if (!host.includes("@Remote('deletePermanently')")) {
    const at = host.indexOf("  @Remote('list')")
    const doc = at < 0 ? -1 : host.lastIndexOf('  /**', at)
    if (doc < 0) fail(`no se encuentra @Remote('list') en ${rel(hostIndex)}`)
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
  }
  const listLine = 'return { items: await this.listState.list(signal) }'
  if (host.includes(listLine)) {
    host = host.replace(listLine, [
      '// Local build: first remove what the previous run left pending, then',
      '    // hide Sessions whose deletion waits for the next start.',
      '    const hidden = await this.localDeleter().hidden()',
      '    const items = await this.listState.list(signal)',
      '    return { items: hidden.size === 0 ? items : items.filter(item => !hidden.has(item.sessionId)) }',
    ].join('\n'))
  } else if (!host.includes('this.localDeleter().hidden()')) {
    warn(`no se encuentra el cuerpo de session.list en ${rel(hostIndex)}: los chats borrados con la sesión abierta se verán hasta reiniciar`)
  }
  write(hostIndex, host)

  // Interfaz: fila «Eliminar sesión» en el menú del chat y diálogo de confirmación.
  copyFileSync(join(src, 'DeleteSession.tsx'), join(uiDir, 'session-actions', 'DeleteSession.tsx'))

  let ui = read(uiIndex)
  if (!ui.includes("from './session-actions/DeleteSession.tsx'")) {
    const anchor = ui.match(/^import .* from '\.\/session-actions\/ArchiveSession\.tsx'\r?\n/m)
    if (!anchor) fail(`no se encuentra el import de ArchiveSession.tsx en ${rel(uiIndex)}`)
    ui = ui.replace(anchor[0], anchor[0] + [
      'import {',
      '  DeleteSessionMenuItem, SessionDeleteDialog,',
      '  type DeleteSessionInjected, type SessionDeleteDialogInjected, type SessionDeleteRequest,',
      "} from './session-actions/DeleteSession.tsx'",
      '',
    ].join('\n'))
  }
  if (!ui.includes("'remote.session'")) {
    const re = /^(export const inject = \[[^\]]*?)'remote',/m
    if (!re.test(ui)) fail(`no se encuentra la lista inject de ${rel(uiIndex)}`)
    ui = ui.replace(re, "$1'remote', 'remote.session',")
  }
  if (!ui.includes("id: 'local-delete'")) {
    const anchor = ui.match(/^([ \t]*)ctx\.slots\.inject\('conversation\.hero\.workspace'/m)
    if (!anchor) fail(`no se encuentra el final de apply() en ${rel(uiIndex)}`)
    for (const needed of ['uiWorkspace.archiveSession(', 'sessions.list.getSnapshot()', 'createSnapshotStore']) {
      if (!ui.includes(needed)) fail(`${rel(uiIndex)} ya no usa ${needed}; revisa «Eliminar sesión»`)
    }
    const pad = anchor[1]
    ui = ui.replace(anchor[0], [
      '// Local build: permanent delete — a menu row after Archive and its confirmation.',
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
      '    // Archiving first stops its work and leaves the view if it is open.',
      '    await uiWorkspace.archiveSession(sessionId, { stopActivity: true })',
      '    const result = await ctx.remote.session.deletePermanently({ sessionId })',
      '    if (!result.ok) throw new Error(result.error.message)',
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
    ].map((line) => (line === '' ? '' : pad + line)).join('\n') + '\n' + anchor[0])
  }
  write(uiIndex, ui)

  // Textos: chino e inglés en el diccionario oficial; el español va en es-pack.json.
  let locales = read(uiLocales)
  if (!locales.includes("'menu.deleteSession'")) {
    const zhEnd = /^\} satisfies Record<string, string>/m
    const enEnd = /^\} satisfies Record<WorkspaceKey, string>/m
    if (!zhEnd.test(locales) || !enEnd.test(locales)) fail(`no se encuentran los diccionarios zh/en en ${rel(uiLocales)}`)
    locales = locales.replace(zhEnd, [
      "  'menu.deleteSession': '删除会话',",
      "  'deleteSession.title': '删除此会话？',",
      "  'deleteSession.desc': '将永久删除“{title}”：对话、子智能体及其历史记录。工作目录中的文件不受影响。此操作无法撤销。',",
      "  'deleteSession.action': '删除',",
      "  'deleteSession.pending': '正在删除会话…',",
      '} satisfies Record<string, string>',
    ].join('\n'))
    locales = locales.replace(enEnd, [
      "  'menu.deleteSession': 'Delete session',",
      "  'deleteSession.title': 'Delete this session?',",
      "  'deleteSession.desc': '“{title}” will be permanently deleted: the conversation, its subagents and its history. Files in the working folder are not touched. This cannot be undone.',",
      "  'deleteSession.action': 'Delete',",
      "  'deleteSession.pending': 'Deleting session…',",
      '} satisfies Record<WorkspaceKey, string>',
    ].join('\n'))
    write(uiLocales, locales)
  }
  done.push('opción «Eliminar sesión» en el menú de cada chat')
}

// ── 8. Barra de contexto en el selector de modelo ─────────────────────────────
// El selector muestra una entrada por modelo y, debajo de «Modelo», una barra con
// los tamaños de contexto (sistema/contexto/ContextSlider.tsx); «Recomendado» es
// el óptimo medido para el equipo (variante automática).

{
  const dir = join(repo, 'packages', 'client', 'ui-model-selection', 'src', 'client')
  const select = join(dir, 'ModelSelect.tsx')
  const locales = join(dir, 'locales.ts')
  for (const file of [select, locales]) {
    if (!existsSync(file)) fail(`no existe ${rel(file)}; no se puede añadir la barra de contexto`)
  }
  copyFileSync(join(here, 'contexto', 'ContextSlider.tsx'), join(dir, 'ContextSlider.tsx'))
  copyFileSync(join(here, 'contexto', 'ContextSlider.module.css'), join(dir, 'ContextSlider.module.css'))

  let text = read(select)
  const edits = [
    [
      "import { orderModelProviders } from './provider-order.ts'\n",
      "import { orderModelProviders } from './provider-order.ts'\n"
        + "import { ContextSlider, contextListModels, contextTriggerName, sameContextModel } from './ContextSlider.tsx'\n",
      "from './ContextSlider.tsx'",
    ],
    [
      "models: rankByName(group.models, showSearch ? query.trim() : ''),",
      "models: rankByName(contextListModels(group.models), showSearch ? query.trim() : ''),",
      'rankByName(contextListModels(',
    ],
    [
      ': currentChoice?.model.name\n',
      ': contextTriggerName(currentChoice?.model.name)\n',
      'contextTriggerName(currentChoice',
    ],
    [
      'const selected = state.current?.provider === group.id && state.current.model === model.id',
      'const selected = state.current?.provider === group.id && sameContextModel(state.current.model, model.id)',
      'sameContextModel(state.current.model',
    ],
  ]
  for (const [from, to, marker] of edits) {
    if (text.includes(marker)) continue
    if (!text.includes(from)) fail(`no se encuentra en ${rel(select)}: ${from.trim().slice(0, 70)}`)
    text = text.replace(from, to)
  }
  if (!text.includes('<ContextSlider')) {
    const re = /(<span className=\{css\.cellLabel\}>\{t\('menu\.model'\)\}<\/span>[\s\S]*?<\/button>\r?\n)/
    if (!re.test(text)) fail(`no se encuentra la fila «Modelo» del menú en ${rel(select)}`)
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
  }
  write(select, text)

  let dict = read(locales)
  if (!dict.includes("'context.label'")) {
    const zhEnd = /^\} satisfies Record<string, string>/m
    const enEnd = /^\} satisfies Record<ModelKey, string>/m
    if (!zhEnd.test(dict) || !enEnd.test(dict)) fail(`no se encuentran los diccionarios zh/en en ${rel(locales)}`)
    dict = dict.replace(zhEnd, [
      "  'context.label': '上下文',",
      "  'context.faster': '更快',",
      "  'context.more': '更多上下文',",
      "  'context.recommended': '推荐',",
      '} satisfies Record<string, string>',
    ].join('\n'))
    dict = dict.replace(enEnd, [
      "  'context.label': 'Context',",
      "  'context.faster': 'Faster',",
      "  'context.more': 'More context',",
      "  'context.recommended': 'Recommended',",
      '} satisfies Record<ModelKey, string>',
    ].join('\n'))
    write(locales, dict)
  }
  done.push('barra de contexto en el selector de modelo')
}

console.log('\nCambios aplicados:')
for (const line of done) console.log(`  - ${line}`)
if (warnings.length > 0) {
  console.log(`\n${warnings.length} aviso(s); revisa los mensajes AVISO de arriba.`)
}
