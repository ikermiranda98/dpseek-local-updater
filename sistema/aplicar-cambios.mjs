// Aplica las modificaciones locales (Ollama, sin inicio de sesión, sin telemetría,
// idioma español) sobre una copia del repositorio de DeepSeek Harness.
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

// ── Modelos de Ollama ──────────────────────────────────────────────────────────
// La lista de modelos se resuelve al ARRANCAR la app: una expresión !!js de la
// configuración pregunta a Ollama (/api/tags) qué modelos hay y los añade a los de
// config.json. Así el selector muestra siempre lo que tengas descargado, aunque el
// instalador se compile en GitHub (sin Ollama). Si Ollama no responde en unos
// segundos, se usan solo los modelos de config.json.

async function buildTimeModels() {
  const manual = config.modelosManuales ?? []
  if (!config.detectarModelosDeOllama) return manual
  try {
    const response = await fetch(new URL('/api/tags', config.ollamaUrl), { signal: AbortSignal.timeout(5000) })
    const { models } = await response.json()
    const detected = models
      .filter((m) => (m.capabilities ?? ['completion']).includes('completion'))
      .map((m) => ({
        id: m.name,
        nombre: m.name.replace(/:latest$/, ''),
        contexto: Math.min(config.contextoMaximo, m.details?.context_length ?? config.contextoMaximo),
        imagenes: (m.capabilities ?? []).includes('vision'),
        razonamiento: (m.capabilities ?? []).includes('thinking'),
      }))
    const byId = new Map(detected.map((m) => [m.id, m]))
    for (const m of manual) byId.set(m.id, { ...byId.get(m.id), ...m })
    return [...byId.values()]
  } catch {
    // En GitHub Actions no hay Ollama: es lo normal, la app los consulta al arrancar.
    return manual
  }
}

const yamlString = (s) => `'${String(s).replaceAll("'", "''")}'`
const EFFORTS = { off: 'none', low: 'low', medium: 'medium', high: 'high' }

/** Modelo de config.json en el formato del adaptador llm-pi-ai. */
const toPiAi = (m) => ({
  id: m.id,
  name: m.nombre ?? m.id,
  contextWindow: m.contexto ?? config.contextoMaximo,
  maxTokens: config.maxTokensSalida,
  input: m.imagenes ? ['text', 'image'] : ['text'],
  reasoningEfforts: m.razonamiento ? EFFORTS : false,
})

/**
 * Expresión que la app evalúa al arrancar: consulta Ollama con un proceso Node
 * síncrono (la configuración no admite esperas) y devuelve los modelos fijos más
 * los descargados en Ollama. Cualquier fallo devuelve solo los fijos.
 */
function runtimeModelsExpression(fixed) {
  const tags = new URL('/api/tags', config.ollamaUrl).href
  const probe = `fetch(${JSON.stringify(tags)},{signal:AbortSignal.timeout(4000)})` +
    '.then(r=>r.json()).then(j=>process.stdout.write(JSON.stringify(j.models||[])),()=>process.exit(1))'
  const max = config.contextoMaximo
  return [
    '((fixed) => { try {',
    `const out = process.getBuiltinModule('node:child_process').execFileSync(process.execPath, ['-e', ${JSON.stringify(probe)}],`,
    "{ env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 6000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });",
    'const seen = new Set(fixed.map((m) => m.id));',
    "const found = JSON.parse(out).filter((m) => (m.capabilities || ['completion']).includes('completion') && !seen.has(m.name))",
    ".map((m) => { const caps = m.capabilities || []; return { id: m.name, name: m.name.replace(/:latest$/, ''),",
    `contextWindow: Math.min(${max}, (m.details && m.details.context_length) || ${max}),`,
    `maxTokens: ${config.maxTokensSalida}, input: caps.includes('vision') ? ['text', 'image'] : ['text'],`,
    `reasoningEfforts: caps.includes('thinking') ? ${JSON.stringify(EFFORTS)} : false }; });`,
    'return [...fixed, ...found];',
    `} catch (error) { return fixed; } })(${JSON.stringify(fixed)})`,
  ].join(' ')
}

function piAiBlock(models) {
  return [
    '# Ollama local por su API compatible con OpenAI. Ollama ignora el token;',
    '# la cabecera fija evita depender de credenciales guardadas. contextWindow',
    '# no debe superar OLLAMA_CONTEXT_LENGTH o Ollama recorta el prompt en silencio.',
    '# models: los de config.json más los descargados en Ollama (se consulta al arrancar).',
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

const models = await buildTimeModels()
if (models.length === 0) fail('no hay ningún modelo: arranca Ollama o rellena "modelosManuales" en config.json')
const defaultModel = models.find((m) => m.id === config.modeloPorDefecto) ?? models[0]
if (defaultModel.id !== config.modeloPorDefecto) warn(`el modelo por defecto "${config.modeloPorDefecto}" no está; se usa "${defaultModel.id}"`)

if (editRows((l) => rowsById(l, 'llm-pi-ai'), (l, r) => setConfig(l, r, piAiBlock(models))) === 0) {
  fail('no se encuentra la fila "llm-pi-ai" (adaptador multiproveedor) en packages/bundle; el adaptador ha cambiado de nombre')
}
done.push(`Ollama: ${models.length} modelo(s) de config.json + los que haya en Ollama al arrancar la app`)

if (editRows((l) => rowsById(l, 'agent-default-model'), (l, r) => setConfig(l, r, ['provider: ollama', `model: ${yamlString(defaultModel.id)}`])) === 0) {
  fail('no se encuentra la fila "agent-default-model" en packages/bundle')
}
done.push(`modelo por defecto: ${defaultModel.id}`)

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

console.log('\nCambios aplicados:')
for (const line of done) console.log(`  - ${line}`)
if (warnings.length > 0) {
  console.log(`\n${warnings.length} aviso(s); revisa los mensajes AVISO de arriba.`)
}
